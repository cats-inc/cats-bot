import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import {
  BaseWindow,
  Menu,
  app,
  dialog,
  ipcMain,
  safeStorage,
  shell,
  type MenuItemConstructorOptions,
} from 'electron';

import { packagedHelperPath } from '../../core/desktopControl/helper.ts';
import type { ChannelHostServices } from '../../core/host-api/channel.ts';
import { HubControlServer } from '../../core/host-api/hubControl.ts';
import { readBotIdFromEnv, readProviderOverrides } from '../../core/hostEnv.ts';
import { initializeBot, readBotProfile } from '../../core/profile/initialize.ts';
import { botRootIn, deriveBotId, hubPathsFor, InvalidBotIdError, isValidBotId, resolveCatsBotHome } from '../../core/store/paths.ts';
import { isLanguagePreference, resolveLocale, translate } from '../../shared/language.ts';
import { BotPresenter, type PresenterHost } from './botPresenter.ts';
import { attachOrStartCore, CoreHostedElsewhereError } from './coreHost.ts';
import { acquireHubLock, readHubState, readOrCreateInstallationId, writeHubState, type HubState } from './hub/hubState.ts';
import {
  activeBots, addBot, DEFAULT_MAX_BOTS, emptyRegistry, listBotDirectories, readRegistry, reconcileRegistry, writeRegistry,
  type BotRegistry,
} from './hub/registry.ts';
import { HOST_COMMANDS, runHostCommand, senderMayInvoke } from './ipc.ts';
import { createHelperRunner, ProviderSetup } from './providerSetup.ts';
import { runFirstRunSetup } from './setup.ts';
import { BotTray } from './tray.ts';
import { buildTrayMenuTemplate, type TrayMenuActions, type TrayMenuModel } from './trayMenu.ts';
import { configureUpdater, createUpdaterAdapter, installDebianUpdate } from './update/adapter.ts';
import { BotUpdateController } from './update/controller.ts';
import { TrayUpdateDialog } from './update/dialog.ts';
import { BotInstallation, InstallationRecoveryRequired, processIsAlive } from './update/installation.ts';
import { isUpdateSender, updateAction } from './update/ipc.ts';
import { assertNoOtherUsers } from './update/otherUsers.ts';
import { showDesktopUpdateMessageBox } from './update/presenter.ts';
import { initialUpdateState, parseBotRelease, type BotRelease } from './update/release.ts';
import { NOTE_LAYER_LABELS, NOTE_LAYERS, readShellState, type NoteLayer } from './viewState.ts';
import { loadDesktopHost } from './win32Desktop.ts';
import { botWindowIdentity } from './windowIdentity.ts';

/**
 * PLAN-001 Phase 3 (ADR-001 §2, §8) and PLAN-009 Phase 2 (SPEC-008): the
 * hub. One Electron process per account and installation presents every bot
 * that runs, each as a core process of its own reached through its host
 * channel (ADR-008). The tray, the sticky notes, the settings windows and the
 * floating Cats are clients of `BotHostApi`; every bot's windows are bound to
 * it (FR-17). All windows closed means the bots keep running until Quit. A
 * hub without a bot registry opens the first-run page (SPEC-002 FR-1,
 * SPEC-008 FR-4). A hub that closes or crashes leaves its cores running, and
 * the next hub of this installation reattaches to them.
 */

const require = createRequire(import.meta.url);

/** The package's appId; Electron names the login item after it (SPEC-007 FR-9). */
const APP_ID = 'io.catsinc.catsbot';

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
  // A launch may name the bot whose notes to open. SPEC-008 FR-27: refuse an
  // invalid id before it reaches any path.
  const requested = args.id ?? readBotIdFromEnv();
  if (requested !== undefined && !isValidBotId(requested)) {
    dialog.showErrorBox('Cats Bot', new InvalidBotIdError(requested).message);
    app.exit(2);
    return;
  }
  const installation = app.isPackaged ? new BotInstallation(app.getPath('appData'), process.execPath, app.getVersion()) : null;
  app.setName('Cats Bot');
  // SPEC-008 FR-1: one hub per account and installation, behind one Electron
  // single-instance lock on its user data. A second launch hands its
  // arguments to the running hub and exits.
  app.setPath('userData', app.commandLine.getSwitchValue('user-data-dir') || join(app.getPath('appData'), 'Cats Bot'));
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

  if (!app.requestSingleInstanceLock({ id: requested ?? null })) {
    app.quit();
    return;
  }

  await app.whenReady();
  try {
    // The hub relaunches after an update without naming a bot.
    installation?.register('');
  } catch (error) {
    if (error instanceof InstallationRecoveryRequired && dialog.showMessageBoxSync({ type: 'warning', title: 'Cats Bot update',
      message: error.message, buttons: ['Keep closed', 'Installer finished — reopen'], defaultId: 0, cancelId: 0 }) === 1) {
      installation!.acknowledgeFinishedInstaller();
      installation!.register('');
    } else {
      if (!(error instanceof InstallationRecoveryRequired)) dialog.showErrorBox('Cats Bot update', errorMessage(error));
      app.quit(); return;
    }
  }
  app.on('quit', () => { try { installation?.unregister(); } catch (error) { process.stderr.write(`${errorMessage(error)}\n`); } });
  // ADR-001 §2: all notes closed is not quitting; the bots keep running from the tray.
  // Registered before first-run setup, whose window closes before the first note opens.
  app.on('window-all-closed', () => undefined);

  const log = (line: string) => process.stderr.write(`${line}\n`);
  const home = resolveCatsBotHome();
  const hubPaths = hubPathsFor(home);
  const installationId = readOrCreateInstallationId(app.getPath('userData'));
  // FR-1: two installations pointed at one root never manage the same bots.
  const hubLock = acquireHubLock(home, installationId, process.execPath);
  if (!hubLock.held) {
    dialog.showErrorBox('Cats Bot', `Another Cats Bot (${hubLock.owner.executable}, pid ${hubLock.owner.pid}) manages the bots in ${home}.\n\nQuit it first.`);
    app.quit();
    return;
  }
  app.on('quit', () => hubLock.release());

  const appPath = app.getAppPath();
  const assetsDir = join(appPath, 'assets');
  // ADR-003: the pages are built by Vite; the preload and the icons stay plain files in assets/.
  const rendererDir = join(appPath, 'dist', 'renderer');
  const preloadPath = join(assetsDir, 'preload.cjs');
  const iconPath = join(assetsDir, 'icon.png');

  // FR-18: display language and start at login belong to the hub. A hub's
  // first start takes them from the bot that a development shell presented.
  let hubState: HubState = readHubState(home) ?? (() => {
    const first = requested ?? listBotDirectories(hubPaths.bots).ids[0];
    const shellState = first ? readShellState(botRootIn(hubPaths.bots, first)) : null;
    return { schemaVersion: 1, language: shellState?.language ?? 'system', openAtLogin: shellState?.openAtLogin === true };
  })();
  const saveHubState = (next: HubState) => {
    hubState = next;
    try {
      writeHubState(home, hubState);
    } catch (error) {
      log(`hub state not saved: ${errorMessage(error)}`);
    }
  };
  if (!readHubState(home)) saveHubState(hubState);
  const locale = () => resolveLocale(hubState.language, app.getLocale());
  const t = (message: string) => translate(locale(), message);
  const languageState = () => ({ preference: hubState.language, locale: locale() });

  const presenters = new Map<string, BotPresenter>();
  // FR-19: one setup helper at a time for every bot; a CLI it found reaches every core's PATH.
  const providerSetup = new ProviderSetup(createHelperRunner(join(assetsDir, 'setup'), (directory) => {
    for (const presenter of presenters.values()) {
      void presenter.core.useCommandDirectory(directory).catch((error: unknown) => log(`provider directory: ${errorMessage(error)}`));
    }
  }));

  // SPEC-001 NFR security and SPEC-008 FR-20: the cores keep secrets encrypted with the
  // OS facility, which the hub serves them over the channel when it has one.
  const services: ChannelHostServices = safeStorage.isEncryptionAvailable()
    ? {
      cipher: {
        label: 'os-safe-storage',
        encrypt: (plain) => safeStorage.encryptString(plain),
        decrypt: (buffer) => safeStorage.decryptString(buffer),
      },
    }
    : {};

  // FR-4: the first run creates the first bot with the provider-first flow.
  const createFirstBot = async (): Promise<string | null> => {
    if (args.provider) {
      const id = requested ?? deriveBotId(args.name ?? 'mochi');
      initializeBot(hubPaths.bots, { id, name: args.name ?? id, provider: args.provider, model: args.model ?? null });
      return id;
    }
    let created: string | null = null;
    const done = await runFirstRunSetup({
      language: { read: () => hubState.language, write: (value) => saveHubState({ ...hubState, language: value }) },
      systemLocale: app.getLocale(),
      providers: providerSetup,
      preloadPath,
      rendererDir,
      iconPath,
      create: async (input) => {
        const id = requested ?? deriveBotId(input.name);
        initializeBot(hubPaths.bots, {
          id,
          name: input.name,
          provider: input.provider,
          model: input.model,
          ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
          ...(input.instructions ? { instructions: input.instructions } : {}),
        });
        created = id;
      },
    });
    return done ? created : null;
  };
  // FR-2 to FR-4: the registry, created on the first run. Bots set up before
  // there was a hub (`cats-bot init`, a development shell) are taken in, up to
  // the cap; the first is the coordinator holder.
  const createRegistry = async (): Promise<BotRegistry | null> => {
    const existing = listBotDirectories(hubPaths.bots).ids;
    let ids: string[];
    if (existing.length > 0) {
      ids = [...(requested && existing.includes(requested) ? [requested] : []), ...existing.filter((id) => id !== requested)]
        .slice(0, DEFAULT_MAX_BOTS);
    } else {
      const id = await createFirstBot();
      if (!id) return null;
      ids = [id];
    }
    let next = emptyRegistry();
    for (const id of ids) next = addBot(next, id);
    next = { ...next, coordinator: { holder: ids[0]! } };
    writeRegistry(home, next);
    return next;
  };
  let registry: BotRegistry;
  try {
    const read = readRegistry(home);
    if (read.state === 'corrupt') {
      dialog.showErrorBox('Cats Bot', `The bot registry ${hubPaths.registry} could not be read and was kept as it is.\n\n${read.error}`);
      app.quit();
      return;
    }
    if (read.state === 'missing') {
      const created = await createRegistry();
      if (!created) {
        app.quit();
        return;
      }
      registry = created;
    } else {
      const reconciled = reconcileRegistry(home, read.registry);
      registry = reconciled.registry;
      if (reconciled.changed) writeRegistry(home, registry);
      for (const id of reconciled.unregistered) log(`bot ${id} has a directory but no registry entry`);
      for (const id of reconciled.missing) log(`bot ${id} is registered but its directory is missing`);
      for (const name of reconciled.skipped) log(`skipped ${name}: not a valid bot id`);
    }
  } catch (error) {
    dialog.showErrorBox('Cats Bot', errorMessage(error));
    app.quit();
    return;
  }

  let quitting = false;
  const openAtLoginAvailable = process.platform === 'win32' || process.platform === 'darwin';
  const primary = (): BotPresenter | undefined => presenters.values().next().value;
  let tray: BotTray | null = null;
  const trayModel = async (presenter: BotPresenter): Promise<TrayMenuModel> => ({
    ...(await presenter.trayModel()),
    locale: locale(),
    openAtLogin: hubState.openAtLogin,
    openAtLoginAvailable,
  });
  const refreshTray = async () => {
    const presenter = primary();
    if (!tray || !presenter || quitting) return;
    try {
      tray.update(await trayModel(presenter));
    } catch (error) {
      // A core may be stopping; the next event refreshes the tray again.
      if (!quitting) log(`tray refresh failed: ${errorMessage(error)}`);
    }
  };

  const closeAll = () => {
    for (const presenter of presenters.values()) presenter.close();
    tray?.dispose();
    void hubControl.stop();
    app.quit();
  };
  const quit = () => {
    if (quitting) return;
    quitting = true;
    for (const presenter of presenters.values()) presenter.remember();
    void providerSetup
      .whenIdle()
      .then(() => Promise.allSettled([...presenters.values()].map((presenter) => presenter.stop())))
      .catch((error: unknown) => log(`core stop failed: ${errorMessage(error)}`))
      .finally(closeAll);
  };
  // Until Phase 3 supervises cores, a core that ends unasked restarts with the hub.
  const coreLost = (presenter: BotPresenter) => {
    if (quitting) return;
    quitting = true;
    log(`The Bot core of ${presenter.botId} stopped unexpectedly; see ${presenter.hosted.logFile}`);
    void dialog.showMessageBox({
      type: 'error',
      title: 'Cats Bot',
      message: t('The Bot core stopped unexpectedly.'),
      detail: presenter.hosted.logFile,
      buttons: [t('Restart Cats Bot'), t('Quit')],
      defaultId: 0,
      cancelId: 1,
    }).then(async ({ response }) => {
      await Promise.allSettled([...presenters.values()].filter((other) => other !== presenter).map((other) => other.stop()));
      if (response === 0) app.relaunch({ args: process.argv.slice(1) });
    }).finally(closeAll);
  };
  const presenterHost: PresenterHost = {
    preloadPath,
    rendererDir,
    iconPath,
    desktop: loadDesktopHost(log),
    log,
    isQuitting: () => quitting,
    locale,
    refreshTray: () => { void refreshTray(); },
    // `cats-bot quit` stops that bot; with one bot the hub ends with it, as the shell did.
    quitRequested: (presenter) => {
      if (presenters.size <= 1) {
        quit();
        return;
      }
      presenters.delete(presenter.botId);
      presenter.close();
      void presenter.hosted.stop().finally(() => { void refreshTray(); });
    },
    coreLost,
  };

  const startBot = async (botId: string): Promise<BotPresenter> => {
    const root = botRootIn(hubPaths.bots, botId);
    const profile = readBotProfile(root);
    if (!profile) throw new Error(`Bot ${botId} has no profile at ${root}.`);
    const runtimeEntry = resolvePackagedRuntimeEntry();
    const hosted = await attachOrStartCore(root, {
      execPath: process.execPath,
      runAsNode: true,
      entry: join(appPath, 'dist', 'cli', 'main.js'),
      catsBotHome: home,
      botId,
      // FR-12: the hub's installation is the manager of the cores it starts.
      manager: installationId,
      ...(services.cipher ? { hostCipher: services.cipher.label } : {}),
      ...(runtimeEntry ? { runtimeEntry } : {}),
      // SPEC-006 BDC-11: Windows packages carry the helper as an extra resource; a checkout uses its own build.
      ...(app.isPackaged ? { helperPath: packagedHelperPath(process.resourcesPath) } : {}),
    }, { host: { pid: process.pid, executable: process.execPath, installationId }, services });
    const identity = botWindowIdentity({ appId: APP_ID, botId, botName: profile.name, executable: process.execPath, packaged: app.isPackaged });
    const presenter = new BotPresenter(presenterHost, botId, root, hosted, identity);
    presenters.set(botId, presenter);
    return presenter;
  };

  const starting = activeBots(registry, home).filter((bot) => bot.startAutomatically);
  // A new core inherits the hub's PATH, so each provider CLI is found first.
  if (!readProviderOverrides().providerCommand) {
    const providers = new Set(starting.map((bot) => readBotProfile(botRootIn(hubPaths.bots, bot.id))?.executionTarget.provider)
      .filter((provider): provider is string => typeof provider === 'string'));
    for (const provider of providers) {
      await providerSetup.prepareEnvironment(provider).catch((error) => log(`Provider environment: ${errorMessage(error)}`));
    }
  }
  const failures: string[] = [];
  for (const bot of starting) {
    try {
      await startBot(bot.id);
    } catch (error) {
      failures.push(error instanceof CoreHostedElsewhereError
        ? `${bot.id}: ${error.message}\n\nStop the other instance (for example cats-bot run) first.`
        : `${bot.id}: ${errorMessage(error)}`);
    }
  }
  if (presenters.size === 0) {
    dialog.showErrorBox('Cats Bot', failures[0] ?? `No bot in ${home} is set to start.`);
    app.quit();
    return;
  }
  if (failures.length > 0) void dialog.showMessageBox({ type: 'warning', title: 'Cats Bot', message: failures.join('\n\n') });

  const hubControl = new HubControlServer(home, installationId, {
    // FR-25: the owner CLI's view of the hub.
    status: () => ({
      pid: process.pid,
      installationId,
      executable: process.execPath,
      home,
      coordinator: registry.coordinator.holder,
      bots: registry.bots.map((bot) => ({
        id: bot.id,
        state: presenters.has(bot.id) ? 'running' : bot.archivedAt ? 'archived' : 'stopped',
        pid: presenters.get(bot.id)?.hosted.pid ?? null,
        startAutomatically: bot.startAutomatically,
      })),
    }),
  });
  await hubControl.start().catch((error: unknown) => log(`hub control endpoint failed: ${errorMessage(error)}`));

  const applyLoginItem = (enabled: boolean) => {
    try {
      app.setLoginItemSettings({ openAtLogin: enabled, args: [] });
    } catch (error) {
      log(`login item failed: ${errorMessage(error)}`);
    }
  };
  // SPEC-007 FR-9 and SPEC-008 FR-23: one login item starts the hub. An
  // uninstall that keeps the data deletes it, and a reinstall may sit in
  // another folder, so an installed Windows copy registers the owner's choice
  // again when no entry starts it. An entry disabled in Task Manager still
  // exists and stays disabled; a portable copy runs from a temporary folder
  // and never registers itself.
  if (process.platform === 'win32' && app.isPackaged && !process.env.PORTABLE_EXECUTABLE_FILE
    && hubState.openAtLogin && !app.getLoginItemSettings({ args: [] }).openAtLogin) applyLoginItem(true);

  const setOpenAtLogin = (enabled: boolean) => {
    saveHubState({ ...hubState, openAtLogin: enabled });
    applyLoginItem(enabled);
    void refreshTray();
  };

  let release: BotRelease | null = null;
  try {
    const contents = readFileSync(join(process.resourcesPath, 'bot-release.json'), 'utf8');
    if (contents.length <= 16_384) release = parseBotRelease(JSON.parse(contents), app.getVersion(), process.platform, process.arch);
  } catch { /* Missing or invalid identity leaves local builds update-disabled. */ }
  const initialUpdate = initialUpdateState({ packaged: app.isPackaged, version: app.getVersion(), release,
    portable: process.platform === 'win32' && Boolean(process.env.PORTABLE_EXECUTABLE_FILE) });
  const autoUpdater = initialUpdate.canCheck ? (require('electron-updater') as typeof import('electron-updater')).autoUpdater : null;
  if (autoUpdater) configureUpdater(autoUpdater);
  const updates = new BotUpdateController(
    initialUpdate,
    autoUpdater
      ? createUpdaterAdapter(autoUpdater, {
          onQuit: (listener) => {
            app.once('quit', listener);
            return () => { app.removeListener('quit', listener); };
          },
          ...(process.platform === 'linux'
            ? {
                installDeb: (file: string) =>
                  installDebianUpdate(file, () => {
                    app.relaunch({ args: process.argv.slice(1) });
                    app.quit();
                  }),
              }
            : {}),
        })
      : null,
    {
      acquireInstall: (version) => {
        if (!installation) throw new Error('This installation cannot update itself.');
        assertNoOtherUsers(process.execPath);
        return installation.acquire(version);
      },
      drain: async () => {
        quitting = true;
        for (const presenter of presenters.values()) presenter.remember();
        await providerSetup.whenIdle();
        const processes = await Promise.all([...presenters.values()].map(async (presenter) =>
          [presenter.hosted.pid, (await presenter.core.status().catch(() => null))?.runtime.pid ?? null] as const));
        await Promise.all([...presenters.values()].map((presenter) => presenter.stop()));
        if (processes.some(([corePid, runtimePid]) => processIsAlive(corePid) || (runtimePid && processIsAlive(runtimePid)))) {
          throw new Error('A Bot Runtime has not stopped; installation was cancelled.');
        }
        assertNoOtherUsers(process.execPath);
      },
      recover: async (uncertain, error) => {
        dialog.showErrorBox('Cats Bot update', `${error.message}\n\n${uncertain
        ? 'Check the installer before reopening Cats Bot.' : 'Cats Bot will restart the current installation.'}`);
        if (!uncertain) app.relaunch({ args: process.argv.slice(1) });
        app.quit();
      },
      openRelease: (url) => shell.openExternal(url),
      changed: (state) => {
        for (const presenter of presenters.values()) presenter.settings.browserWindow?.webContents.send('shell:update', state);
      },
    },
  );

  const trayUpdates = new TrayUpdateDialog({
    controller: updates,
    locale,
    stopping: () => quitting,
    show: (dialogSpec) =>
      showDesktopUpdateMessageBox({
        platform: process.platform,
        dialogSpec,
        createOwner: (options) => new BaseWindow(options),
        focusApp: () => app.focus({ steal: true }),
        showMessageBox: (options, owner) =>
          owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options),
      }),
  });
  // FR-16: with one bot the tray menu is today's; its items act on that bot.
  const trayActionsFor = (target: () => BotPresenter | undefined): TrayMenuActions => ({
    onOpenConversation: (conversationId) => {
      void target()?.windows
        .open(conversationId)
        .then(refreshTray)
        .catch((error: unknown) => log(`open conversation failed: ${errorMessage(error)}`));
    },
    onNewNote: () => {
      const presenter = target();
      void presenter?.core.createConversation().then((record) => presenter.windows.open(record.id)).then(refreshTray);
    },
    onOpenSettings: (tab) => target()?.openSettings(tab),
    onCheckForUpdates: () => {
      void trayUpdates.open().catch((error) => log(errorMessage(error)));
    },
    onToggleHeartbeat: (enabled) => {
      void target()?.core.updateProfile({ heartbeat: { enabled } }).then(refreshTray);
    },
    onToggleOpenAtLogin: (enabled) => setOpenAtLogin(enabled),
    onToggleFloating: (visible) => target()?.setFloatingVisible(visible),
    // SPEC-006 BDC-10 / SPEC-133 DC-12: every conversation; grants are revoked and helper work is cancelled.
    onStopDesktopControl: () => {
      void target()?.core.stopAllDesktopControl().then(refreshTray).catch((error: unknown) => {
        log(`stop desktop control failed: ${errorMessage(error)}`);
      });
    },
    onQuit: quit,
  });
  tray = new BotTray({ assetsDir, ...trayActionsFor(primary) });

  // FR-17: every message from a renderer is answered for the bot whose window sent it.
  const senderOf = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => {
    for (const presenter of presenters.values()) {
      const role = presenter.roleOf(event.sender.id);
      if (role) return { presenter, role };
    }
    return null;
  };
  const fromSettings = (event: Electron.IpcMainInvokeEvent) => {
    const from = senderOf(event);
    return from?.role === 'settings' ? from.presenter : null;
  };
  const ownedMainFrame = (event: Electron.IpcMainInvokeEvent) =>
    event.senderFrame === event.sender.mainFrame;
  ipcMain.handle('ui:language', (event) => {
    if (!ownedMainFrame(event) || !senderOf(event)) throw new Error('Unknown window');
    return languageState();
  });
  ipcMain.handle('ui:setLanguage', (event, value: unknown) => {
    if (!ownedMainFrame(event) || !fromSettings(event) || !isLanguagePreference(value))
      throw new Error('Invalid display language');
    saveHubState({ ...hubState, language: value });
    for (const presenter of presenters.values()) presenter.sendLanguage(languageState());
    void refreshTray();
    return languageState();
  });
  ipcMain.handle('setup:check', (event, provider: unknown) => {
    if (quitting) throw new Error('Cats Bot is stopping');
    if (!ownedMainFrame(event) || !fromSettings(event))
      throw new Error('Provider setup is available only from Settings');
    return providerSetup.check(provider);
  });
  ipcMain.handle('setup:install', (event, provider: unknown, step: unknown) => {
    if (quitting) throw new Error('Cats Bot is stopping');
    if (!ownedMainFrame(event) || !fromSettings(event))
      throw new Error('Provider setup is available only from Settings');
    return providerSetup.install(provider, step);
  });

  const isSettingsWindow = (id: number) => [...presenters.values()].some((presenter) => presenter.settings.owns(id));
  ipcMain.handle('shell:updateState', (event) => {
    if (!isUpdateSender(event, isSettingsWindow)) throw new Error('Updates are available only from Settings.');
    return updates.snapshot();
  });
  ipcMain.handle('shell:updateAction', (event, action: unknown) => {
    if (!isUpdateSender(event, isSettingsWindow)) throw new Error('Updates are available only from Settings.');
    return updateAction(
      updates,
      action,
      async () =>
        (
          await dialog.showMessageBox({
            type: 'question',
            title: t('Install Cats Bot update'),
            message: t('Stop this bot and install the downloaded update?'),
            detail: t(
              'The current task will be interrupted. Quit other Cats Bot instances first. On a shared computer, all users must keep Cats Bot closed until installation finishes.',
            ),
            buttons: [t('Cancel'), t('Restart and install')],
            defaultId: 0,
            cancelId: 0,
          })
        ).response === 1,
    );
  });

  ipcMain.handle('bot:invoke', async (event, command: unknown, args: unknown) => {
    if (quitting) throw new Error('Cats Bot is shutting down.');
    if (typeof command !== 'string' || !HOST_COMMANDS.includes(command as never)) {
      throw new Error(`Unknown host command ${String(command)}`);
    }
    const from = senderOf(event);
    if (!from) {
      // A note that is being torn down may still flush a markSeen; nothing to do.
      if (quitting) return null;
      throw new Error('Command from an unknown window');
    }
    const { presenter } = from;
    const list = Array.isArray(args) ? args : [];
    // Provider requests and desktop control belong to one note (SPEC-004, SPEC-006 BDC-07).
    const sender = {
      note: presenter.windows.windowFor(event.sender.id)?.conversationId ?? null,
      settings: from.role === 'settings',
      floating: from.role === 'floating',
    };
    if (!senderMayInvoke(command, list, sender))
      throw new Error('This request belongs to another conversation.');
    const result = await runHostCommand(presenter.core, command, list, (url) => shell.openExternal(url));
    if (command === 'deleteConversation' && typeof list[0] === 'string') presenter.windows.forget(list[0]);
    if (command === 'markSeen' || command === 'sendOwnerMessage' || command === 'updateProfile' || command === 'deleteConversation'
      || command === 'renameConversation' || command === 'createConversation') {
      void refreshTray();
    }
    return result;
  });
  ipcMain.handle('window:hide', (event) => {
    const presenter = senderOf(event)?.presenter;
    const owner = presenter?.windows.windowFor(event.sender.id);
    if (presenter && owner) presenter.windows.hide(owner.conversationId);
    void refreshTray();
    return null;
  });
  // SPEC-002 FR-8: a note's layer, chosen from its own header or from the settings page.
  const isLayer = (value: unknown): value is NoteLayer => typeof value === 'string' && NOTE_LAYERS.includes(value as NoteLayer);
  ipcMain.handle('window:state', (event) => {
    const presenter = senderOf(event)?.presenter;
    const owner = presenter?.windows.windowFor(event.sender.id);
    return {
      layer: presenter && owner ? presenter.windows.layerOf(owner.conversationId) : 'normal',
      layers: presenter?.windows.availableLayers() ?? ['normal'],
      botName: app.getName(),
    };
  });
  ipcMain.handle('window:layerMenu', (event) => {
    const presenter = senderOf(event)?.presenter;
    const owner = presenter?.windows.windowFor(event.sender.id);
    if (!presenter || !owner) return null;
    const current = presenter.windows.layerOf(owner.conversationId);
    const template: MenuItemConstructorOptions[] = presenter.windows.availableLayers().map((layer) => ({
      label: t(NOTE_LAYER_LABELS[layer]),
      type: 'radio',
      checked: layer === current,
      click: () => {
        presenter.windows.setLayer(owner.conversationId, layer);
      },
    }));
    Menu.buildFromTemplate(template).popup({ window: owner.window });
    return null;
  });
  ipcMain.handle('shell:noteLayers', (event) => {
    const presenter = fromSettings(event);
    if (!presenter) return null;
    return { layers: presenter.windows.availableLayers(), labels: NOTE_LAYER_LABELS, views: presenter.windows.layers() };
  });
  ipcMain.handle('shell:setNoteLayer', async (event, conversationId: unknown, layer: unknown) => {
    const presenter = fromSettings(event);
    if (!presenter || typeof conversationId !== 'string' || !isLayer(layer)) return null;
    presenter.windows.setLayer(conversationId, layer);
    return layer;
  });
  ipcMain.handle('window:open', async (event, conversationId: unknown) => {
    const presenter = senderOf(event)?.presenter;
    if (!presenter || typeof conversationId !== 'string') return null;
    await presenter.windows.open(conversationId);
    void refreshTray();
    return null;
  });
  // SPEC-002 FR-4: shell preferences and helpers the settings page uses.
  ipcMain.handle('shell:state', (event) => {
    const presenter = fromSettings(event);
    if (!presenter) return null;
    return {
      botId: presenter.botId,
      openAtLogin: hubState.openAtLogin,
      openAtLoginAvailable,
      floatingVisible: presenter.windows.shellState.floatingBot.visible,
      version: app.getVersion(),
    };
  });
  ipcMain.handle('shell:setFloatingVisible', (event, visible: unknown) => {
    const presenter = fromSettings(event);
    if (!presenter || typeof visible !== 'boolean') return null;
    presenter.setFloatingVisible(visible);
    return visible;
  });
  // SPEC-002 FR-7: the floating bot's own channel.
  const fromFloating = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => {
    const from = senderOf(event);
    return from?.role === 'floating' ? from.presenter : null;
  };
  ipcMain.on('floating:interactive', (event, interactive: unknown) => {
    fromFloating(event)?.floating.setInteractive(interactive === true);
  });
  ipcMain.on('floating:moveTo', (event, x: unknown, y: unknown) => {
    if (typeof x === 'number' && typeof y === 'number') fromFloating(event)?.floating.moveTo(x, y);
  });
  ipcMain.on('floating:dragEnd', (event) => {
    fromFloating(event)?.floating.remember();
  });
  ipcMain.handle('floating:activate', async (event) => {
    const presenter = fromFloating(event);
    if (!presenter) return null;
    await presenter.windows.open('home');
    void refreshTray();
    return null;
  });
  ipcMain.handle('floating:menu', async (event) => {
    const presenter = fromFloating(event);
    const owner = presenter?.floating.browserWindow;
    if (!presenter || !owner) return null;
    const template = buildTrayMenuTemplate(await trayModel(presenter), trayActionsFor(() => presenter)) as MenuItemConstructorOptions[];
    Menu.buildFromTemplate(template).popup({ window: owner });
    return null;
  });
  ipcMain.handle('shell:setOpenAtLogin', (event, enabled: unknown) => {
    if (!fromSettings(event) || typeof enabled !== 'boolean') return null;
    setOpenAtLogin(enabled);
    return enabled;
  });
  ipcMain.handle('shell:chooseFolder', async (event, current: unknown) => {
    const owner = fromSettings(event)?.settings.browserWindow;
    if (!owner) return null;
    const result = await dialog.showOpenDialog(owner, {
      title: t('Workspace folder'),
      properties: ['openDirectory', 'createDirectory'],
      ...(typeof current === 'string' && current ? { defaultPath: current } : {}),
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle('shell:openDataFolder', async (event) => {
    const presenter = fromSettings(event);
    if (!presenter) return null;
    await shell.openPath(presenter.root);
    return null;
  });
  ipcMain.handle('shell:openSettings', (event, tab: unknown) => {
    const from = senderOf(event);
    if (!from || from.role === 'floating') return null;
    from.presenter.openSettings(typeof tab === 'string' ? tab : undefined);
    return null;
  });

  app.on('second-instance', (_event, _argv, _cwd, data) => {
    const id = (data as { id?: unknown } | null)?.id;
    const presenter = (typeof id === 'string' ? presenters.get(id) : undefined) ?? primary();
    void presenter?.windows.open('home');
  });
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quit();
  });

  for (const presenter of presenters.values()) await presenter.start();
  await refreshTray();
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  app.exit(1);
});
