import { ipcMain } from 'electron';

import { listProviders, readPackagedModelCatalog } from '../../core/providers/catalog.ts';
import { createPageWindow, pageUrl, type PageWindowOptions } from './settingsWindow.ts';
import { validateSetupInput, type SetupInput } from './setupInput.ts';

/**
 * SPEC-002 FR-1: a packaged bot that has never been set up opens this page
 * instead of an error. No core exists yet, so the page gets the provider
 * list and the shipped model catalog from the setup channel, and `create`
 * initializes the bot and opens its core. Closing the page cancels.
 */

export interface FirstRunOptions extends PageWindowOptions {
  create(input: SetupInput): Promise<void>;
}

export function runFirstRunSetup(options: FirstRunOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const window = createPageWindow(options, { width: 560, height: 800, title: 'Set up Cats Bot' });
    let finished = false;
    const fromSetup = (event: Electron.IpcMainInvokeEvent) => event.sender.id === window.webContents.id;
    const cleanup = () => {
      ipcMain.removeHandler('setup:providers');
      ipcMain.removeHandler('setup:models');
      ipcMain.removeHandler('setup:finish');
    };
    ipcMain.handle('setup:providers', (event) => (fromSetup(event) ? listProviders() : []));
    ipcMain.handle('setup:models', (event, provider: unknown) => {
      if (!fromSetup(event) || typeof provider !== 'string') return { provider: '', defaultModel: null, models: [], source: 'none' };
      return readPackagedModelCatalog(provider);
    });
    ipcMain.handle('setup:finish', async (event, raw: unknown) => {
      if (!fromSetup(event) || finished) return null;
      const input = validateSetupInput(raw);
      await options.create(input);
      finished = true;
      cleanup();
      resolve(true);
      window.destroy();
      return null;
    });
    window.on('closed', () => {
      if (finished) return;
      cleanup();
      resolve(false);
    });
    void window.loadURL(pageUrl(options.rendererDir, 'settings.html', { mode: 'setup' })).then(() => window.show());
  });
}
