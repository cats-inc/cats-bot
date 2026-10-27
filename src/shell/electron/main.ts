import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { app, dialog, ipcMain, safeStorage } from 'electron';

import { BotCore, BotInstanceRunningError, BotNotInitializedError, initializeBot } from '../../core/bot.ts';
import { readBotIdFromEnv, readProviderOverrides } from '../../core/hostEnv.ts';
import { FileSecretStore, type SecretCipher } from '../../core/secrets.ts';
import { resolveBotRoot, resolveBotsHome } from '../../core/store/paths.ts';
import type { BotHostEvent } from '../../core/types.ts';
import { HOST_COMMANDS, runHostCommand } from './ipc.ts';
import { BotTray } from './tray.ts';
import { NoteWindows } from './windows.ts';

/**
 * PLAN-001 Phase 3 (ADR-001 §2, §8): the first presentation host. The bot
 * core is mounted in the Electron main process; every timer lives here; the
 * tray and the sticky-note windows are clients of `BotHostApi`. All windows
 * closed means the bot keeps running until Quit.
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
  // SPEC-001 NFR security: the shell keeps secrets encrypted with the OS facility when it has one.
  const cipher: SecretCipher | undefined = safeStorage.isEncryptionAvailable()
    ? {
      label: 'os-safe-storage',
      encrypt: (plain) => safeStorage.encryptString(plain),
      decrypt: (buffer) => safeStorage.decryptString(buffer),
    }
    : undefined;
  const openCore = () => BotCore.open({
    root,
    runtime: { ...readProviderOverrides(), runtimeEntry: resolvePackagedRuntimeEntry() },
    secrets: new FileSecretStore(root, { ...(cipher ? { cipher } : {}), warn: (line) => process.stderr.write(`${line}\n`) }),
    log: (line) => process.stderr.write(`${line}\n`),
  });
  let core: BotCore;
  try {
    core = openCore();
  } catch (error) {
    if (error instanceof BotNotInitializedError && args.provider) {
      initializeBot(botsHome, { id: botId, name: args.name ?? botId, provider: args.provider, model: args.model ?? null });
      core = openCore();
    } else {
      dialog.showErrorBox(
        'Cats Bot',
        `${error instanceof Error ? error.message : String(error)}\n\nInitialize the bot first: cats-bot init --name <name> --provider <provider>`
          + `\nor launch with --provider <provider> [--name <name>] [--id ${botId}].`,
      );
      app.quit();
      return;
    }
  }

  const appPath = app.getAppPath();
  const assetsDir = join(appPath, 'assets');
  const rendererDir = join(assetsDir, 'renderer');
  const preloadPath = join(assetsDir, 'preload.cjs');

  let quitting = false;
  const windows = new NoteWindows({ core, botRoot: root, preloadPath, rendererDir, isQuitting: () => quitting });

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

  const quit = () => {
    if (quitting) return;
    quitting = true;
    void core.stop().finally(() => {
      windows.destroyAll();
      tray?.dispose();
      app.quit();
    });
  };

  const tray: BotTray | null = new BotTray({
    assetsDir,
    onOpenConversation: (conversationId) => {
      void windows.open(conversationId).then(refreshTray).catch((error: unknown) => {
        process.stderr.write(`open note failed: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    },
    onNewNote: () => {
      void core.createConversation().then((record) => windows.open(record.id)).then(refreshTray);
    },
    onToggleHeartbeat: (enabled) => {
      void core.updateProfile({ heartbeat: { enabled } }).then(refreshTray);
    },
    onToggleOpenAtLogin: (enabled) => {
      windows.setOpenAtLogin(enabled);
      try {
        app.setLoginItemSettings({ openAtLogin: enabled, args: ['--id', botId] });
      } catch (error) {
        process.stderr.write(`login item failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
      void refreshTray();
    },
    onQuit: quit,
  });

  ipcMain.handle('bot:invoke', async (event, command: unknown, args: unknown) => {
    if (typeof command !== 'string' || !HOST_COMMANDS.includes(command as never)) {
      throw new Error(`Unknown host command ${String(command)}`);
    }
    const owner = windows.windowFor(event.sender.id);
    if (!owner) {
      // A note that is being torn down may still flush a markSeen; nothing to do.
      if (quitting) return null;
      throw new Error('Command from an unknown window');
    }
    const result = await runHostCommand(core, command, Array.isArray(args) ? args : []);
    if (command === 'markSeen' || command === 'sendOwnerMessage' || command === 'updateProfile' || command === 'deleteConversation') {
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
    if (!windows.windowFor(event.sender.id) || typeof conversationId !== 'string') return null;
    await windows.open(conversationId);
    return null;
  });

  core.subscribe((event: BotHostEvent) => {
    windows.broadcast(event);
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
  app.on('window-all-closed', () => {
    // ADR-001 §2: all notes closed is not quitting; the bot keeps running from the tray.
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
      process.stderr.write(`reopen note failed: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  app.exit(1);
});
