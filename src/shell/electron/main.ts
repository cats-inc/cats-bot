import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { app, dialog, ipcMain, safeStorage, shell } from 'electron';

import { BotCore, BotInstanceRunningError, BotNotInitializedError, initializeBot } from '../../core/bot.ts';
import { readBotIdFromEnv, readProviderOverrides } from '../../core/hostEnv.ts';
import { FileSecretStore, type SecretCipher } from '../../core/secrets.ts';
import { resolveBotRoot, resolveBotsHome } from '../../core/store/paths.ts';
import type { BotHostEvent } from '../../core/types.ts';
import { HOST_COMMANDS, runHostCommand } from './ipc.ts';
import { SettingsWindow } from './settingsWindow.ts';
import { runFirstRunSetup } from './setup.ts';
import { BotTray } from './tray.ts';
import { NoteWindows } from './windows.ts';

/**
 * PLAN-001 Phase 3 (ADR-001 §2, §8): the first presentation host. The bot
 * core is mounted in the Electron main process; every timer lives here; the
 * tray, the sticky-note windows and the settings window are clients of
 * `BotHostApi`. All windows closed means the bot keeps running until Quit. A
 * bot that was never set up opens the first-run page (SPEC-002 FR-1).
 */

const require = createRequire(import.meta.url);

function parseArgs(argv: string[]): { id?: string; provider?: string; name?: string; model?: string } {
  const result: { id?: string; provider?: string; name?: string; model?: string } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = argv[index + 1];
    if (arg === '--id' && next) result.id = next;
    else if (arg.startsWith('--id=')) result.id = arg.slice(5);
    else if (arg === '--provider' && next) result.provider = next;
    else if (arg.startsWith('--provider=')) result.provider = arg.slice(11);
    else if (arg === '--name' && next) result.name = next;
    else if (arg.startsWith('--name=')) result.name = arg.slice(7);
    else if (arg === '--model' && next) result.model = next;
    else if (arg.startsWith('--model=')) result.model = arg.slice(8);
  }
  return result;
}

/** A packaged app spawns the runtime bin outside the archive; a checkout uses node_modules directly. */
function resolvePackagedRuntimeEntry(): string | undefined {
  try {
    const packageJson = require.resolve('@cats-inc/cats-runtime/package.json');
    const entry = join(dirname(packageJson), 'build', 'runtime', 'index.js');
    const unpacked = entry.replace(/app\.asar([\\/])/u, 'app.asar.unpacked$1');
    return existsSync(unpacked) ? unpacked : entry;
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(1));
  const botId = args.id ?? readBotIdFromEnv() ?? 'mochi';
  const botsHome = resolveBotsHome();
  const root = resolveBotRoot(botId);
  app.setName('Cats Bot');
  // Electron keys its single-instance lock by the userData path, so each bot
  // gets its own: two bots are two instances, a second launch of the same bot
  // is not (ADR-001 §8).
  app.setPath('userData', join(app.getPath('appData'), 'Cats Bot', 'bots', botId));
  if (process.platform === 'win32') app.setAppUserModelId(`io.catsinc.cats-bot.${botId}`);

  if (!app.requestSingleInstanceLock({ botId })) {
    app.quit();
    return;
  }

  await app.whenReady();
  // ADR-001 §2: all notes closed is not quitting; the bot keeps running from the tray.
  // Registered before first-run setup, whose window closes before the first note opens.
  app.on('window-all-closed', () => undefined);

  const appPath = app.getAppPath();
  const assetsDir = join(appPath, 'assets');
  const rendererDir = join(assetsDir, 'renderer');
  const preloadPath = join(assetsDir, 'preload.cjs');

  // SPEC-001 NFR security: the shell keeps secrets encrypted with the OS facility when it has one.
  const cipher: SecretCipher | undefined = safeStorage.isEncryptionAvailable()
    ? {
      label: 'os-safe-storage',
      encrypt: (plain) => safeStorage.encryptString(plain),
      decrypt: (buffer) => safeStorage.decryptString(buffer),
    }
    : undefined;
  const secrets = new FileSecretStore(root, { ...(cipher ? { cipher } : {}), warn: (line) => process.stderr.write(`${line}\n`) });
  const openCore = () => BotCore.open({
    root,
    runtime: { ...readProviderOverrides(), runtimeEntry: resolvePackagedRuntimeEntry() },
    secrets,
    log: (line) => process.stderr.write(`${line}\n`),
  });
  let core: BotCore;
  try {
    core = openCore();
  } catch (error) {
    if (!(error instanceof BotNotInitializedError)) {
      dialog.showErrorBox('Cats Bot', errorMessage(error));
      app.quit();
      return;
    }
    if (args.provider) {
      initializeBot(botsHome, { id: botId, name: args.name ?? botId, provider: args.provider, model: args.model ?? null });
      core = openCore();
    } else {
      const opened: { core: BotCore | null } = { core: null };
      const done = await runFirstRunSetup({
        preloadPath,
        rendererDir,
        create: async (input) => {
          initializeBot(botsHome, {
            id: botId,
            name: input.name,
            provider: input.provider,
            model: input.model,
            ...(input.instructions ? { instructions: input.instructions } : {}),
          });
          opened.core = openCore();
        },
      });
      if (!done || !opened.core) {
        app.quit();
        return;
      }
      core = opened.core;
    }
  }
  // A token the CLI stored as a file is re-stored with the OS facility before Telegram reads it.
  core.protectSecretsAtRest();

  let quitting = false;
  const windows = new NoteWindows({ core, botRoot: root, preloadPath, rendererDir, isQuitting: () => quitting });
  const settings = new SettingsWindow({ preloadPath, rendererDir });
  const openSettings = (tab?: string) => {
    void settings.open(tab).catch((error: unknown) => {
      process.stderr.write(`open settings failed: ${errorMessage(error)}\n`);
    });
  };

  const openAtLoginAvailable = process.platform === 'win32' || process.platform === 'darwin';
  const refreshTray = async () => {
    if (!tray) return;
    const [profile, conversations] = await Promise.all([core.getProfile(), core.listConversations()]);
    tray.update({
      botName: profile.name,
      status: core.status(),
      conversations,
      heartbeatEnabled: profile.heartbeat.enabled,
      openAtLogin: windows.shellState.openAtLogin,
      openAtLoginAvailable,
      awaitingOwner: core.listWorkItems().filter((item) => item.state === 'awaiting_owner').length,
    });
  };

  const setOpenAtLogin = (enabled: boolean) => {
    windows.setOpenAtLogin(enabled);
    try {
      app.setLoginItemSettings({ openAtLogin: enabled, args: ['--id', botId] });
    } catch (error) {
      process.stderr.write(`login item failed: ${errorMessage(error)}\n`);
    }
    void refreshTray();
  };

  const quit = () => {
    if (quitting) return;
    quitting = true;
    void core.stop().finally(() => {
      windows.destroyAll();
      settings.destroy();
      tray?.dispose();
      app.quit();
    });
  };

  const tray: BotTray | null = new BotTray({
    assetsDir,
    onOpenConversation: (conversationId) => {
      void windows.open(conversationId).then(refreshTray).catch((error: unknown) => {
        process.stderr.write(`open note failed: ${errorMessage(error)}\n`);
      });
    },
    onNewNote: () => {
      void core.createConversation().then((record) => windows.open(record.id)).then(refreshTray);
    },
    onOpenSettings: openSettings,
    onToggleHeartbeat: (enabled) => {
      void core.updateProfile({ heartbeat: { enabled } }).then(refreshTray);
    },
    onToggleOpenAtLogin: (enabled) => setOpenAtLogin(enabled),
    onQuit: quit,
  });

  const fromNote = (event: Electron.IpcMainInvokeEvent) => windows.windowFor(event.sender.id) !== null;
  const fromSettings = (event: Electron.IpcMainInvokeEvent) => settings.owns(event.sender.id);

  ipcMain.handle('bot:invoke', async (event, command: unknown, args: unknown) => {
    if (typeof command !== 'string' || !HOST_COMMANDS.includes(command as never)) {
      throw new Error(`Unknown host command ${String(command)}`);
    }
    if (!fromNote(event) && !fromSettings(event)) {
      // A note that is being torn down may still flush a markSeen; nothing to do.
      if (quitting) return null;
      throw new Error('Command from an unknown window');
    }
    const list = Array.isArray(args) ? args : [];
    const result = await runHostCommand(core, command, list);
    if (command === 'deleteConversation' && typeof list[0] === 'string') windows.forget(list[0]);
    if (command === 'markSeen' || command === 'sendOwnerMessage' || command === 'updateProfile' || command === 'deleteConversation'
      || command === 'renameConversation' || command === 'createConversation') {
      void refreshTray();
    }
    return result;
  });
  ipcMain.handle('window:hide', (event) => {
    const owner = windows.windowFor(event.sender.id);
    if (owner) windows.hide(owner.conversationId);
    void refreshTray();
    return null;
  });
  ipcMain.handle('window:togglePin', (event) => {
    const owner = windows.windowFor(event.sender.id);
    return owner ? windows.togglePin(owner.conversationId) : false;
  });
  ipcMain.handle('window:state', (event) => {
    const owner = windows.windowFor(event.sender.id);
    return { alwaysOnTop: owner ? windows.isPinned(owner.conversationId) : false, botName: app.getName() };
  });
  ipcMain.handle('window:open', async (event, conversationId: unknown) => {
    if ((!fromNote(event) && !fromSettings(event)) || typeof conversationId !== 'string') return null;
    await windows.open(conversationId);
    void refreshTray();
    return null;
  });
  // SPEC-002 FR-4: shell preferences and helpers the settings page uses.
  ipcMain.handle('shell:state', (event) => {
    if (!fromSettings(event)) return null;
    return { botId, openAtLogin: windows.shellState.openAtLogin, openAtLoginAvailable, version: app.getVersion() };
  });
  ipcMain.handle('shell:setOpenAtLogin', (event, enabled: unknown) => {
    if (!fromSettings(event) || typeof enabled !== 'boolean') return null;
    setOpenAtLogin(enabled);
    return enabled;
  });
  ipcMain.handle('shell:chooseFolder', async (event, current: unknown) => {
    const owner = settings.browserWindow;
    if (!fromSettings(event) || !owner) return null;
    const result = await dialog.showOpenDialog(owner, {
      title: 'Workspace folder',
      properties: ['openDirectory', 'createDirectory'],
      ...(typeof current === 'string' && current ? { defaultPath: current } : {}),
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle('shell:openDataFolder', async (event) => {
    if (!fromSettings(event)) return null;
    await shell.openPath(root);
    return null;
  });
  ipcMain.handle('shell:openSettings', (event, tab: unknown) => {
    if (!fromNote(event) && !fromSettings(event)) return null;
    openSettings(typeof tab === 'string' ? tab : undefined);
    return null;
  });

  core.subscribe((event: BotHostEvent) => {
    windows.broadcast(event);
    settings.broadcast(event);
    if (event.type === 'host.handoff' && event.message.kind === 'open') {
      void windows.open(event.message.conversationId ?? 'home');
    }
    if (event.type === 'host.handoff' && event.message.kind === 'quit') {
      quit();
    }
    if (event.type === 'conversation.updated' || event.type === 'runtime.status' || event.type === 'work.awaitingOwner'
      || event.type === 'turn.completed') {
      void refreshTray();
    }
  });

  app.on('second-instance', () => {
    void windows.open('home');
  });
  app.on('before-quit', () => {
    quitting = true;
  });

  try {
    await core.start();
  } catch (error) {
    if (error instanceof BotInstanceRunningError) {
      dialog.showErrorBox('Cats Bot', `${error.message}\n\nStop the other instance (for example cats-bot run) first.`);
      quitting = true;
      tray.dispose();
      app.quit();
      return;
    }
    throw error;
  }
  await refreshTray();
  const reopen = windows.previouslyOpen();
  for (const conversationId of reopen.length > 0 ? reopen : ['home']) {
    await windows.open(conversationId).catch((error: unknown) => {
      process.stderr.write(`reopen note failed: ${errorMessage(error)}\n`);
    });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  app.exit(1);
});
