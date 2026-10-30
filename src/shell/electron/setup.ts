import { ipcMain } from 'electron';

import { listProviders, readPackagedModelCatalog } from '../../core/providers/catalog.ts';
import type { ProviderSetup } from './providerSetup.ts';
import { isLanguagePreference, resolveLocale, type LanguagePreference } from '../../shared/language.ts';
import { createPageWindow, pageUrl, type PageWindowOptions } from './settingsWindow.ts';
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
}

export function runFirstRunSetup(options: FirstRunOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const window = createPageWindow(options, { width: 560, height: 800, title: 'Set up Cats Bot' });
    let finished = false;
    let submitting = false;
    window.on('close', (event) => {
      if (options.providers.busy || submitting) event.preventDefault();
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
      for (const channel of ['setup:check', 'setup:install', 'ui:language', 'ui:setLanguage'])
        ipcMain.removeHandler(channel);
    };
    ipcMain.handle('setup:providers', (event) => (fromSetup(event) ? listProviders() : []));
    ipcMain.handle('setup:models', (event, provider: unknown) => {
      if (!fromSetup(event) || typeof provider !== 'string') return { provider: '', defaultModel: null, models: [], source: 'none' };
      return readPackagedModelCatalog(provider);
    });
    ipcMain.handle('setup:check', (event, provider: unknown) => {
      if (!fromSetup(event)) throw new Error('Unknown setup window');
      return options.providers.check(provider);
    });
    ipcMain.handle('setup:install', (event, provider: unknown, step: unknown) => {
      if (!fromSetup(event)) throw new Error('Unknown setup window');
      return options.providers.install(provider, step);
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
        const checked = await options.providers.check(input.provider);
        if (!checked.canFinish) throw new Error('Complete setup for the selected provider first');
        await options.create(input);
      } catch (error) {
        submitting = false;
        throw error;
      }
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
