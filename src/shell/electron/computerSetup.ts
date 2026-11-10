import { ipcMain } from 'electron';

import type { SetupLogEntry } from '../../shared/providerSetup.ts';
import { COMPUTER_SETUP_CHANNELS } from './computerSetupChannels.ts';
import type { ProviderSetup } from './providerSetup.ts';
import { logTerminal } from './setup.ts';
import { openCodexInitializationTerminal, openSignInTerminal } from './setupTerminal.ts';

/**
 * SPEC-013: the channels behind Cats Bot Settings' Agent CLIs tab. Only that window's main
 * frame may use them (FR-12), and only a fixed helper id and change cross them: never a path,
 * an argument or a command. Every run goes through the hub's one `ProviderSetup`, so one setup
 * operation runs at a time across all cat bots (SPEC-008 FR-19).
 */

export { COMPUTER_SETUP_CHANNELS };

type Event = Electron.IpcMainInvokeEvent;
type Opened = { opened: boolean; command: string | null };

export interface ComputerSetupIpcOptions {
  providers: ProviderSetup;
  /** Cats Bot Settings' own main frame. */
  fromHub(event: Event): boolean;
  /** The hub is quitting, so nothing new starts. */
  stopping(): boolean;
  /** Injectable for isolated acceptance; production opens the fixed per-provider command. */
  openTerminal?(provider: unknown): Promise<Opened>;
  initializeCodex?(): Promise<Opened>;
}

export function registerComputerSetupIpc(options: ComputerSetupIpcOptions): () => void {
  const admit = (event: Event, starting = false) => {
    if (!options.fromHub(event)) throw new Error('Agent CLIs are managed only from Cats Bot Settings');
    if (starting && options.stopping()) throw new Error('Cats Bot is stopping');
  };
  // The log goes to the window that asked, and a window going away cannot break a run.
  const logTo = (event: Event) => (entry: SetupLogEntry) => {
    try {
      if (!event.sender.isDestroyed()) event.sender.send('setup:log', entry);
    } catch {
      // Closed while the run went on.
    }
  };
  // FR-3: reading what the hub kept starts no process.
  ipcMain.handle('computer:state', (event) => {
    admit(event);
    return options.providers.computer();
  });
  ipcMain.handle('computer:check', (event) => {
    admit(event, true);
    return options.providers.checkComputer(logTo(event));
  });
  ipcMain.handle('computer:change', (event, helper: unknown, change: unknown) => {
    admit(event, true);
    return options.providers.changeComputer(helper, change, logTo(event));
  });
  // FR-10: sign-in opens a real terminal with the provider's fixed command, for a CLI that works.
  ipcMain.handle('computer:openTerminal', async (event, provider: unknown) => {
    admit(event, true);
    if (!options.providers.readyOnComputer(provider)) throw new Error('Check this computer first');
    const result = await (options.openTerminal ?? openSignInTerminal)(provider);
    if (result.command) logTerminal(logTo(event), result.command, result.opened);
    return result;
  });
  ipcMain.handle('computer:openCodexInitialization', async (event) => {
    admit(event, true);
    if (!options.providers.codexReadyOnComputer || options.providers.busy)
      throw new Error('Wait for the current setup operation to finish');
    const result = await (options.initializeCodex ?? openCodexInitializationTerminal)();
    if (result.command) logTerminal(logTo(event), result.command, result.opened);
    return result;
  });
  return () => {
    for (const channel of COMPUTER_SETUP_CHANNELS) ipcMain.removeHandler(channel);
  };
}
