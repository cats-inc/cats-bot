import { ipcMain } from 'electron';

import { fixedProviders, readPackagedModelCatalog } from '../../core/providers/catalog.ts';
import type { ProviderSetup } from './providerSetup.ts';
import { botNameProblem, normalizeBotName } from '../../shared/botText.ts';
import type { SetupDraft, SetupEnvironment, SetupLogEntry } from '../../shared/providerSetup.ts';
import { openCodexInitializationTerminal, openSignInTerminal } from './setupTerminal.ts';
import { isLanguagePreference, resolveLocale, type LanguagePreference } from '../../shared/language.ts';
import { createPageWindow, pageUrl, SETUP_WINDOW_SIZE, type PageWindowOptions } from './settingsWindow.ts';
import { validateSetupInput, type SetupInput } from './setupInput.ts';

/**
 * SPEC-002 FR-1 and SPEC-008 FR-4: the hub's first run opens this page
 * instead of an error. No bot exists yet, so the page gets the provider list
 * and the shipped model catalog from the setup channel, and `create`
 * initializes the first bot. Closing the page cancels. The display language
 * chosen here is the hub's (FR-18).
 */

export interface FirstRunOptions extends PageWindowOptions {
  create(input: SetupInput): Promise<void>;
  language: { read(): LanguagePreference; write(value: LanguagePreference): void };
  systemLocale: string;
  providers: ProviderSetup;
  /** SPEC-010 FR-17: this copy can start at login, so the page offers it. */
  startAtLoginOffered?: boolean;
  /** The folder a bot of this name would get. */
  botFolder?(name: string): string;
  /** FR-13: the input a restart kept, once. */
  takeDraft?(): SetupDraft | null;
  /** FR-13: keeps the input and restarts Cats Bot. */
  restart?(draft: unknown): boolean;
  /** Injectable for isolated acceptance; production always opens the fixed Codex command. */
  initializeCodex?(): Promise<{ opened: boolean; command: string | null }>;
}

let terminalRuns = 0;
/** SPEC-010 FR-14: a terminal opened for sign-in, as the page's log shows it. */
export function logTerminal(send: (entry: SetupLogEntry) => void, command: string, opened: boolean): void {
  const at = new Date().toISOString();
  terminalRuns += 1;
  send({ run: -terminalRuns, phase: 'end', at, kind: 'terminal', helper: 'terminal', file: 'terminal', command, status: opened ? 'opened' : 'not_found', durationMs: 0 });
}

export function runFirstRunSetup(options: FirstRunOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const window = createPageWindow(options, { ...SETUP_WINDOW_SIZE, title: 'Set up Cats Bot' });
    let finished = false;
    let submitting = false;
    let creating = false;
    const checks = new AbortController();
    window.on('close', (event) => {
      if (options.providers.installing || creating) event.preventDefault();
    });
    const fromSetup = (event: Electron.IpcMainInvokeEvent) =>
      event.sender.id === window.webContents.id && event.senderFrame === event.sender.mainFrame;
    const language = () => ({
      preference: options.language.read(),
      locale: resolveLocale(options.language.read(), options.systemLocale),
    });
    const cleanup = () => {
      ipcMain.removeHandler('setup:providers');
      ipcMain.removeHandler('setup:models');
      ipcMain.removeHandler('setup:finish');
      for (const channel of ['setup:check', 'setup:install', 'setup:cancel', 'setup:openTerminal', 'setup:openCodexInitialization', 'setup:environment', 'setup:folder', 'setup:draft', 'setup:restart', 'ui:language', 'ui:setLanguage'])
        ipcMain.removeHandler(channel);
    };
    const sendLog = (entry: SetupLogEntry) => {
      if (!window.isDestroyed()) window.webContents.send('setup:log', entry);
    };
    ipcMain.handle('setup:providers', (event) => (fromSetup(event) ? fixedProviders() : []));
    ipcMain.handle('setup:models', (event, provider: unknown) => {
      if (!fromSetup(event) || typeof provider !== 'string') return { provider: '', defaultModel: null, models: [], source: 'none' };
      return readPackagedModelCatalog(provider);
    });
    ipcMain.handle('setup:check', (event, provider: unknown) => {
      if (!fromSetup(event)) throw new Error('Unknown setup window');
      return options.providers.check(provider, checks.signal, sendLog);
    });
    ipcMain.handle('setup:install', (event, provider: unknown, step: unknown) => {
      if (!fromSetup(event)) throw new Error('Unknown setup window');
      return options.providers.install(provider, step, sendLog);
    });
    ipcMain.handle('setup:cancel', async (event) => {
      if (!fromSetup(event)) return;
      options.providers.cancelCheck();
      await options.providers.whenIdle();
    });
    ipcMain.handle('setup:openTerminal', async (event, provider: unknown) => {
      if (!fromSetup(event)) throw new Error('Unknown setup window');
      const result = await openSignInTerminal(provider);
      if (result.command) logTerminal(sendLog, result.command, result.opened);
      return result;
    });
    ipcMain.handle('setup:environment', (event): SetupEnvironment => {
      if (!fromSetup(event)) throw new Error('Unknown setup window');
      return { platform: process.platform, startAtLoginOffered: options.startAtLoginOffered === true };
    });
    ipcMain.handle('setup:openCodexInitialization', async (event) => {
      if (!fromSetup(event) || !options.providers.codexSelected || options.providers.busy || submitting) throw new Error('Wait for the current setup operation to finish');
      const result = await (options.initializeCodex ?? openCodexInitializationTerminal)();
      if (result.command) logTerminal(sendLog, result.command, result.opened);
      return result;
    });
    ipcMain.handle('setup:folder', (event, name: unknown) => {
      if (!fromSetup(event) || typeof name !== 'string') return null;
      const normalized = normalizeBotName(name);
      return botNameProblem(normalized) ? null : options.botFolder?.(normalized) ?? null;
    });
    ipcMain.handle('setup:draft', (event) => (fromSetup(event) ? options.takeDraft?.() ?? null : null));
    ipcMain.handle('setup:restart', (event, draft: unknown) => {
      if (!fromSetup(event) || submitting || options.providers.busy) throw new Error('Wait for the current setup operation to finish');
      return options.restart?.(draft) ?? false;
    });
    ipcMain.handle('ui:language', (event) => {
      if (!fromSetup(event)) throw new Error('Unknown setup window');
      return language();
    });
    ipcMain.handle('ui:setLanguage', (event, value: unknown) => {
      if (!fromSetup(event) || !isLanguagePreference(value))
        throw new Error('Invalid display language');
      options.language.write(value);
      window.webContents.send('ui:languageChanged', language());
      return language();
    });
    ipcMain.handle('setup:finish', async (event, raw: unknown) => {
      if (!fromSetup(event) || finished || submitting)
        throw new Error('Setup is already finishing');
      const input = validateSetupInput(raw);
      submitting = true;
      try {
        await options.providers.checkForCreation(input.provider, checks.signal, sendLog);
        checks.signal.throwIfAborted();
        creating = true;
        await options.create(input);
      } catch (error) {
        submitting = false;
        throw error;
      } finally {
        creating = false;
      }
      finished = true;
      cleanup();
      resolve(true);
      window.destroy();
      return null;
    });
    window.on('closed', () => {
      checks.abort();
      if (finished) return;
      cleanup();
      resolve(false);
    });
    void window.loadURL(pageUrl(options.rendererDir, 'settings.html', { mode: 'setup' })).then(() => {
      if (!window.isDestroyed()) window.show();
    }).catch(() => {
      if (!window.isDestroyed()) window.close();
    });
  });
}
