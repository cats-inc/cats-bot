import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import {
  BaseWindow,
  BrowserWindow,
  Menu,
  app,
  dialog,
  ipcMain,
  safeStorage,
  shell,
  screen,
  type MenuItemConstructorOptions,
} from 'electron';

import { packagedHelperPath } from '../../core/desktopControl/helper.ts';
import { HostChannelClient, readChannelOwner, type ChannelHostServices } from '../../core/host-api/channel.ts';
import { HubControlRefusal, HubControlServer } from '../../core/host-api/hubControl.ts';
import { readBotIdFromEnv, readProviderOverrides } from '../../core/hostEnv.ts';
import { initializeBot, readBotProfile } from '../../core/profile/initialize.ts';
import { listProviders, readPackagedModelCatalog } from '../../core/providers/catalog.ts';
import { providerCanOfferSessionTools } from '../../shared/providerTools.ts';
import { readInstanceLock } from '../../core/store/lock.ts';
import { botPathsFor, botRootIn, deriveBotId, hubPathsFor, InvalidBotIdError, isValidBotId, resolveCatsBotHome } from '../../core/store/paths.ts';
import {
  HUB_REPLY_LANGUAGE_DEFAULT,
  isHubReplyLanguage,
  isLanguagePreference,
  resolveHubReplyLanguage,
  resolveLocale,
  translate,
  type HubLanguageReport,
} from '../../shared/language.ts';
import { BotPresenter, type PresenterHost } from './botPresenter.ts';
import { attachOrStartCore, CoreHostedElsewhereError } from './coreHost.ts';
import { BotManagementError, BotManager } from './hub/botManager.ts';
import { BossCatBroker } from './hub/bossCatBroker.ts';
import { CoreRunner } from './hub/coreRunner.ts';
import { acquireHubLock, readHubState, readOrCreateInstallationId, writeHubState, type HubState } from './hub/hubState.ts';
import {
  addBot, adoptionOrder, DEFAULT_MAX_BOTS, emptyRegistry, listBotDirectories, readRegistry, withHolder, writeRegistry, type BotRegistry,
  type BossCatLimits, type RegistryBot,
} from './hub/registry.ts';
import { HOST_COMMANDS, runHostCommand, senderMayInvoke } from './ipc.ts';
import { createHelperRunner, ProviderSetup } from './providerSetup.ts';
import { createPageWindow, pageUrl, SettingsWindow } from './settingsWindow.ts';
import { runFirstRunSetup } from './setup.ts';
import { validateSetupInput } from './setupInput.ts';
import { BotTray } from './tray.ts';
import { buildHubTrayMenuTemplate, buildHubTrayTooltip, buildBotMenuTemplate, type BotMenuActions, type BotMenuModel } from './trayMenu.ts';
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
import { relaunchForLinuxWindowing } from './linuxWindowing.ts';
import { createHostLogger, observeDisplays, observeHostApp, observeHostProcess, type HostLogger } from './hostDiagnostics.ts';
import { diagnosticError } from '../../shared/diagnosticLog.ts';

/**
 * PLAN-001 Phase 3 (ADR-001 §2, §8) and PLAN-009 Phases 2 and 3 (SPEC-008):
 * the hub. One Electron process per account and installation presents every
 * bot that runs, each as a core process of its own reached through its host
 * channel (ADR-008), and manages them: Settings → Bots creates, starts,
 * stops, archives, restores and deletes bots, and a core that ends unasked is
 * started again with backoff. The tray, the sticky notes, the settings
 * windows and the floating Cats are clients of `BotHostApi`; every bot's
 * windows are bound to it (FR-17). All windows closed means the bots keep
 * running until Quit. A hub without a bot registry opens the first-run page
 * (SPEC-002 FR-1, SPEC-008 FR-4). A hub that closes or crashes leaves its
 * cores running, and the next hub of this installation reattaches to them.
 */

const require = createRequire(import.meta.url);

/** The package's appId; Electron names the login item after it (SPEC-007 FR-9). */
const APP_ID = 'io.catsinc.catsbot';
let hostLogger: HostLogger | undefined;

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

/** What Settings → Bots shows of one bot (SPEC-008 FR-5). */
interface BotRow {
  id: string;
  name: string;
  provider: string | null;
  state: 'starting' | 'running' | 'stopped' | 'failed' | 'external' | 'archived' | 'missing';
  error: string | null;
  pid: number | null;
  startAutomatically: boolean;
  bossCat: boolean;
  /** SPEC-009 FR-11: for the holder, whether its provider gives it the Boss Cat tools. */
  bossCatTools: boolean | null;
}

async function main(): Promise<void> {
  app.setName('Cats Bot');
  app.setPath('userData', app.commandLine.getSwitchValue('user-data-dir') || join(app.getPath('appData'), 'Cats Bot'));
  if (relaunchForLinuxWindowing(app)) return;
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
  // SPEC-008 FR-1: one hub per account and installation, behind one Electron
  // single-instance lock on its user data. A second launch hands its
  // arguments to the running hub and exits.
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

  if (!app.requestSingleInstanceLock({ id: requested ?? null })) {
    app.quit();
    return;
  }

  // Only the primary instance writes/rotates host.log. A second launch is recorded by it.
  hostLogger = createHostLogger(app.getPath('userData'), {
    level: process.env.CATS_BOT_LOG_LEVEL, mirror: (line) => process.stderr.write(line),
  });
  const log = hostLogger.log;
  observeHostProcess(hostLogger);
  observeHostApp(app, () => BrowserWindow.getAllWindows(), hostLogger);
  hostLogger.record('start', { version: app.getVersion(), electron: process.versions.electron,
    node: process.versions.node, platform: process.platform, arch: process.arch,
    executable: process.execPath, userData: app.getPath('userData'), home: resolveCatsBotHome(),
    packaged: app.isPackaged, level: hostLogger.level,
    launch: process.env.CATS_BOT_CANDIDATE_ROOT ? 'candidate' : 'unspecified' });

  await app.whenReady();
  observeDisplays(screen, () => BrowserWindow.getAllWindows(), hostLogger);
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
  app.on('quit', () => { try { installation?.unregister(); } catch (error) { hostLogger?.error('unregister-failed', error); } });
  // ADR-001 §2: all notes closed is not quitting; the bots keep running from the tray.
  // Registered before first-run setup, whose window closes before the first note opens.
  app.on('window-all-closed', () => undefined);

  const home = resolveCatsBotHome();
  const hubPaths = hubPathsFor(home);
  const installationId = readOrCreateInstallationId(app.getPath('userData'));
  // FR-1: two installations pointed at one root never manage the same bots.
  const hubLock = acquireHubLock(home, installationId, process.execPath);
  if (!hubLock.held) {
    dialog.showErrorBox('Cats Bot', `Another Cats Bot (${hubLock.owner.executable}, pid ${hubLock.owner.pid}) manages the bots in ${home}.\n\n`
      + `Quit it first. If no other Cats Bot runs, delete ${hubPaths.lock} and start again.`);
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
    return {
      schemaVersion: 1,
      language: shellState?.language ?? 'system',
      replyLanguage: HUB_REPLY_LANGUAGE_DEFAULT,
      openAtLogin: shellState?.openAtLogin === true,
    };
  })();
  const saveHubState = (next: HubState) => {
    hubState = next;
    try {
      writeHubState(home, hubState);
    } catch (error) {
      log(`hub state not saved: ${diagnosticError(error)}`, 'error');
    }
  };
  if (!readHubState(home)) saveHubState(hubState);
  const locale = () => resolveLocale(hubState.language, app.getLocale());
  const t = (message: string, values?: Record<string, unknown>) => translate(locale(), message, values);
  const languageState = () => ({ preference: hubState.language, locale: locale() });

  const runners = new Map<string, CoreRunner<BotPresenter>>();
  // A bot whose windows open while its runner still starts it; they talk to the hub already.
  const opening = new Map<string, BotPresenter>();
  /**
   * The registry's bots, once it is read. First-run setup runs before that, and
   * its provider checks already report CLI folders while no bot is presented.
   */
  let registryBots = (): RegistryBot[] => [];
  /** The bots presented now, in the registry's order. */
  const presented = (): BotPresenter[] => registryBots()
    .map((bot) => runners.get(bot.id)?.handle ?? opening.get(bot.id))
    .filter((presenter): presenter is BotPresenter => presenter !== null && presenter !== undefined);
  const primary = (): BotPresenter | undefined => presented()[0];
  // SPEC-008 FR-28: what every bot hears: the reply language of Cats Bot Settings,
  // with `display` resolved, and the display language in use for a bot that follows it.
  const hubLanguageReport = (): HubLanguageReport => ({
    reply: resolveHubReplyLanguage(hubState.replyLanguage, locale()),
    display: locale(),
  });
  const reportHubLanguage = (presenter: BotPresenter): Promise<void> =>
    presenter.core.setHubLanguage(hubLanguageReport()).catch((error: unknown) => {
      log(`reply language: ${diagnosticError(error)}`, 'error');
    });
  const announceHubLanguage = () => {
    for (const presenter of presented()) void reportHubLanguage(presenter);
  };

  // FR-19: one setup helper at a time for every bot; a CLI it found reaches every core's PATH,
  // a core the hub reattaches to included.
  const commandDirectories = new Set<string>();
  const providerSetup = new ProviderSetup(createHelperRunner(join(assetsDir, 'setup'), (directory) => {
    commandDirectories.add(directory);
    for (const presenter of presented()) {
      void presenter.core.useCommandDirectory(directory).catch((error: unknown) => log(`provider directory: ${diagnosticError(error)}`, 'error'));
    }
  }));
  // First-run setup precedes the hub's normal quit handler. Drain cancelled
  // probes here too, so their child processes are gone before Electron exits.
  let setupQuitPending = false;
  const quitDuringSetup = (event: Electron.Event) => {
    if (!providerSetup.busy) return;
    event.preventDefault();
    if (setupQuitPending) return;
    setupQuitPending = true;
    providerSetup.cancelCheck();
    void providerSetup.whenIdle().then(() => app.quit());
  };
  app.on('before-quit', quitDuringSetup);

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
  const hostIdentity = { pid: process.pid, executable: process.execPath, installationId };

  // FR-4: the first run creates the first bot with the provider-first flow.
  const createFirstBot = async (): Promise<string | null> => {
    if (args.provider) {
      const name = args.name ?? 'Mochi';
      const id = requested ?? deriveBotId(name);
      initializeBot(hubPaths.bots, { id, name, provider: args.provider, model: args.model ?? null });
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
  // the cap; the first is the Boss Cat.
  const createRegistry = async (): Promise<BotRegistry | null> => {
    const existing = listBotDirectories(hubPaths.bots).ids;
    let ids: string[];
    if (existing.length > 0) {
      ids = adoptionOrder(existing, requested, DEFAULT_MAX_BOTS);
    } else {
      const id = await createFirstBot();
      if (!id) return null;
      ids = [id];
    }
    let next = emptyRegistry();
    for (const id of ids) next = addBot(next, id);
    next = withHolder(next, ids[0]!, 'first-run');
    writeRegistry(home, next);
    return next;
  };
  let loaded: BotRegistry;
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
        providerSetup.cancelCheck();
        await providerSetup.whenIdle();
        app.quit();
        return;
      }
      loaded = created;
    } else {
      loaded = read.registry;
    }
  } catch (error) {
    dialog.showErrorBox('Cats Bot', errorMessage(error));
    app.quit();
    return;
  }
  // FR-11: a core that another program started, which the hub only lists and
  // attaches to so that its helper excludes the hub (FR-21).
  const externals = new Map<string, HostChannelClient>();
  /** A running core this installation started, before or after the hub's own restart (FR-10). */
  const ownCoreRunning = (id: string): boolean => {
    const root = botRootIn(hubPaths.bots, id);
    if (!existsSync(root)) return false;
    const owner = readChannelOwner(root);
    return owner !== null && owner.manager === installationId && readInstanceLock(botPathsFor(root))?.pid === owner.pid;
  };
  const externalPid = (id: string): number | null => {
    const runner = runners.get(id);
    if (runner?.handle || runner?.state === 'starting' || ownCoreRunning(id)) return null;
    const root = botRootIn(hubPaths.bots, id);
    return existsSync(root) ? readInstanceLock(botPathsFor(root))?.pid ?? null : null;
  };
  const manager = new BotManager(home, loaded, {
    stop: async (id) => { await runners.get(id)?.stop(); },
    hostedElsewhere: (id) => externalPid(id) !== null,
  });
  registryBots = () => manager.registry.bots;
  try {
    const report = manager.recover();
    for (const id of report.unregistered) log(`bot ${id} has a directory but no registry entry`);
    for (const id of report.missing) log(`bot ${id} is registered but its directory is missing`);
    for (const name of report.skipped) log(`skipped ${name}: not a valid bot id`);
  } catch (error) {
    log(`registry recovery failed: ${diagnosticError(error)}`, 'error');
  }

  let quitting = false;
  const openAtLoginAvailable = process.platform === 'win32' || process.platform === 'darwin';
  const pages = { preloadPath, rendererDir, iconPath };
  // FR-5 and D20: Cats Bot Settings, with its General and Bots tabs, also reachable when no bot runs.
  const hubSettings = new SettingsWindow(pages, { scope: 'hub' });
  let tray: BotTray | null = null;

  const listBots = (): { bots: BotRow[]; unregistered: string[]; maxBots: number; active: number; limits: BossCatLimits } => {
    const registry = manager.registry;
    const rows = registry.bots.map((bot): BotRow => {
      const archived = bot.archivedAt !== null;
      const root = join(archived ? hubPaths.archive : hubPaths.bots, bot.id);
      let profile = null;
      try {
        profile = existsSync(root) ? readBotProfile(root) : null;
      } catch { /* a corrupt profile shows as failed */ }
      const runner = runners.get(bot.id);
      const external = archived ? null : externalPid(bot.id);
      const state: BotRow['state'] = archived ? 'archived'
        : !existsSync(root) ? 'missing'
          : external !== null ? 'external'
            : runner?.state === 'external' ? 'stopped' : runner?.state ?? 'stopped';
      return {
        id: bot.id,
        name: profile?.name ?? bot.id,
        provider: profile?.executionTarget.provider ?? null,
        state,
        error: runner?.error ?? null,
        pid: runner?.handle?.hosted.pid ?? external,
        startAutomatically: bot.startAutomatically,
        bossCat: registry.bossCat.holder === bot.id,
        // SPEC-009 FR-11: a holder whose provider takes no session MCP servers keeps the role without tools.
        bossCatTools: registry.bossCat.holder === bot.id && profile !== null
          && !providerCanOfferSessionTools(profile.executionTarget.provider, profile.providerPolicy) ? false
          : null,
      };
    });
    const known = new Set(registry.bots.map((bot) => bot.id));
    return {
      bots: rows,
      unregistered: listBotDirectories(hubPaths.bots).ids.filter((id) => !known.has(id)),
      maxBots: registry.maxBots,
      active: manager.activeCount(),
      limits: registry.limits,
    };
  };
  const listBotsWithStatus = async () => {
    const listing = listBots();
    await Promise.all(listing.bots.filter(bot => bot.bossCat).map(async bot => {
      const core = runners.get(bot.id)?.handle?.core;
      if (!core) return;
      const status = await core.status().catch(() => null);
      bot.bossCatTools = status?.bossCat.holder ? status.bossCat.tools : null;
    }));
    return listing;
  };
  // SPEC-009: the role, its confirmations and the bots it may reach.
  const pendingConfirmations = new Map<AbortController, string>();
  /**
   * FR-5: the owner's answer to a request of the holder. It expires after ten
   * minutes, when the holder's channel closes, when the role moves and when
   * the hub stops; an answer given after that counts as declined.
   */
  const askOwner = async (holder: string, question: string, detail: string): Promise<boolean> => {
    const controller = new AbortController();
    pendingConfirmations.set(controller, holder);
    const deadline = Date.now() + 10 * 60_000;
    const timer = setTimeout(() => controller.abort(), deadline - Date.now());
    try {
      const options: Electron.MessageBoxOptions = {
        type: 'question',
        title: 'Cats Bot',
        message: question,
        detail: [detail, t('Only you can allow this. The request expires in 10 minutes.')].filter(Boolean).join('\n\n'),
        buttons: [t('Decline'), t('Allow')],
        defaultId: 0,
        cancelId: 0,
        signal: controller.signal,
      };
      // On macOS a message box without a window blocks the hub and ignores its signal,
      // so the request shows as a sheet on the Bots tab of Cats Bot Settings there.
      let parent: BrowserWindow | null = null;
      if (process.platform === 'darwin') {
        await hubSettings.open('bots').catch((error: unknown) => log(`open settings failed: ${diagnosticError(error)}`, 'error'));
        parent = hubSettings.browserWindow;
        // Without a window to hold the sheet the request is declined rather than blocking the hub.
        if (!parent) return false;
        if (!parent.isVisible()) parent.show();
      }
      const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
      return response === 1 && !controller.signal.aborted && Date.now() < deadline;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      pendingConfirmations.delete(controller);
    }
  };
  /** FR-3: every running core hears whether it holds the role. */
  const announceHolder = () => {
    const holder = manager.registry.bossCat.holder;
    // FR-5: a request of a bot that no longer holds the role expires.
    for (const [controller, asker] of pendingConfirmations) if (asker !== holder) controller.abort();
    for (const presenter of presented()) {
      void presenter.core.setBossCat(presenter.botId === holder).catch((error: unknown) => log(`Boss Cat: ${diagnosticError(error)}`, 'error'));
    }
    botsChanged();
  };
  // FR-5: a new bot is created with the provider-first page.
  let createWindow: BrowserWindow | null = null;
  // Opens the New bot window for a Boss Cat's request; set once that window's handlers exist below.
  let askOwnerToSetUp = (_request: { name: string; persona: string; provider: string }): 'opened' | 'busy' => 'busy';
  // SPEC-009 FR-4: whether the hub's PATH has the provider; a fixture CLI override stands for every one.
  const providerOnPath = (provider: string) =>
    Boolean(readProviderOverrides().providerCommand) || listProviders().some((entry) => entry.id === provider && entry.installed);
  const bossCat = new BossCatBroker({
    home,
    holder: () => manager.registry.bossCat.holder,
    limits: () => manager.registry.limits,
    bots: () => listBots().bots.filter((bot) => bot.state !== 'archived').map(({ id, name, state }) => ({ id, name, state })),
    core: (id) => runners.get(id)?.handle?.core ?? null,
    atBotCap: () => manager.activeCount() >= manager.registry.maxBots,
    setupNeeded: (provider) => {
      if (providerOnPath(provider)) return 'none';
      return createWindow && !createWindow.isDestroyed() ? 'busy' : 'window';
    },
    createBot: async ({ name, persona, provider }) => {
      if (quitting) throw new Error('Cats Bot is stopping.');
      // SPEC-009 FR-4: a provider this computer does not have yet is set up by the owner first.
      if (!providerOnPath(provider)) return { setup: askOwnerToSetUp({ name, persona, provider }) };
      const id = await manager.create({ name, provider, model: null, ...(persona ? { instructions: persona } : {}) });
      botsChanged();
      await runnerFor(id).start();
      return { id };
    },
    // D26: a bot that failed is restarted by its runner within its budget, and after that only by the owner.
    startBlocked: (id) => (externalPid(id) !== null ? 'It runs in another program.' : runners.get(id)?.startAgainRefusal() ?? null),
    startBot: async (id) => {
      if (manager.entry(id)?.archivedAt !== null) throw new Error(`Bot ${id} is not active.`);
      const runner = runnerFor(id);
      if (!await runner.startAgain()) {
        throw new Error(runner.state === 'external' ? 'It runs in another program.' : `It did not start: ${runner.error ?? 'unknown error'}`);
      }
    },
    stopBot: async (id) => {
      await runners.get(id)?.stop();
      botsChanged();
    },
    setHolder: async (id) => {
      await manager.setHolder(id, 'confirmed-proposal');
      announceHolder();
    },
    confirm: askOwner,
    log,
  });
  const botsChanged = () => {
    void refreshTray();
    hubSettings.browserWindow?.webContents.send('hub:botsChanged');
  };

  const trayModel = async (presenter: BotPresenter): Promise<BotMenuModel> => ({
    ...(await presenter.trayModel()),
    locale: locale(),
  });
  let refreshing = false;
  let refreshAgain = false;
  const refreshTray = async (): Promise<void> => {
    if (!tray || quitting) return;
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    refreshing = true;
    try {
      const bots = [];
      for (const presenter of presented()) {
        try {
          bots.push(await trayModel(presenter));
        } catch (error) {
          bots.push(null);
          // A core may be stopping; the next event refreshes the tray again.
          if (!quitting) log(`tray refresh for ${presenter.botId} failed: ${diagnosticError(error)}`, 'error');
        }
      }
      const model = { locale: locale(), bots, openAtLogin: hubState.openAtLogin, openAtLoginAvailable };
      if (!quitting) tray?.update(buildHubTrayMenuTemplate(model, hubTrayActions), buildHubTrayTooltip(model));
    } finally {
      refreshing = false;
      if (refreshAgain) {
        refreshAgain = false;
        void refreshTray();
      }
    }
  };

  const closeAll = () => {
    for (const controller of pendingConfirmations.keys()) controller.abort();
    for (const presenter of presented()) presenter.close();
    hubSettings.destroy();
    tray?.dispose();
    for (const client of externals.values()) client.close();
    void hubControl.stop();
    app.quit();
  };
  /**
   * FR-10: every core this hub manages, reattached ones and ones still starting
   * included; external ones are left running. Nothing starts once the hub is
   * quitting, so one pass reaches every runner.
   */
  const stopAll = () => Promise.allSettled([...runners.values()].map((runner) => runner.stop()));
  const quit = () => {
    if (quitting) return;
    quitting = true;
    for (const presenter of presented()) presenter.remember();
    providerSetup.cancelCheck();
    void providerSetup
      .whenIdle()
      .then(stopAll)
      .catch((error: unknown) => log(`core stop failed: ${diagnosticError(error)}`, 'error'))
      .finally(closeAll);
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
    // SPEC-009 FR-8: a bot that finished a Boss Cat's message answers it.
    event: (presenter, event) => {
      if (event.type === 'turn.completed') {
        void bossCat.turnCompleted(presenter.botId, event.workItem).catch((error: unknown) => log(`Boss Cat: ${diagnosticError(error)}`, 'error'));
      }
    },
    // `cats-bot quit` stops that bot; with one bot the hub ends with it, as the shell did.
    quitRequested: (presenter) => {
      // A second quit for a bot that is already stopping changes nothing.
      if (!presented().includes(presenter)) return;
      if (presented().length <= 1) {
        quit();
        return;
      }
      void runners.get(presenter.botId)?.stop().finally(botsChanged);
    },
  };

  // FR-11 and FR-21: a core another program runs gets the hub's identity, and nothing else.
  const attachExternal = async (id: string): Promise<void> => {
    if (externals.has(id)) return;
    const client = await HostChannelClient.connect(botRootIn(hubPaths.bots, id), { host: hostIdentity });
    externals.set(id, client);
    client.onClose(() => {
      if (externals.get(id) === client) externals.delete(id);
      botsChanged();
    });
  };

  const startBot = async (botId: string): Promise<BotPresenter> => {
    const root = botRootIn(hubPaths.bots, botId);
    const profile = readBotProfile(root);
    if (!profile) throw new Error(`Bot ${botId} has no profile at ${root}.`);
    const runtimeEntry = resolvePackagedRuntimeEntry();
    let hosted;
    try {
      hosted = await attachOrStartCore(root, {
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
      // SPEC-009: the channel names the bot that calls the Boss Cat tools; its claims count for nothing.
      }, { host: hostIdentity, services: { ...services, hub: (call) => bossCat.handle(botId, call) } });
    } catch (error) {
      if (error instanceof CoreHostedElsewhereError) {
        await attachExternal(botId).catch((attachError: unknown) => log(`attach to ${botId}: ${diagnosticError(attachError)}`, 'error'));
      }
      throw error;
    }
    hostLogger?.record(hosted.started ? 'core-started' : 'core-reattached', { botId, pid: hosted.pid });
    const identity = botWindowIdentity({ appId: APP_ID, botId, botName: profile.name, executable: process.execPath, packaged: app.isPackaged });
    const slot = Math.max(0, manager.registry.bots.filter((bot) => bot.archivedAt === null).findIndex((bot) => bot.id === botId));
    const presenter = new BotPresenter(presenterHost, botId, root, hosted, identity, slot);
    for (const directory of commandDirectories) {
      void presenter.core.useCommandDirectory(directory).catch((error: unknown) => log(`provider directory: ${diagnosticError(error)}`, 'error'));
    }
    opening.set(botId, presenter);
    try {
      // FR-28: the core learns its reply language first; one that refuses the report still opens.
      await reportHubLanguage(presenter);
      await presenter.start();
      // SPEC-009 FR-3: the core learns whether it holds the role before its next send.
      await presenter.core.setBossCat(manager.registry.bossCat.holder === botId);
    } catch (error) {
      presenter.close();
      await hosted.stop().catch(() => undefined);
      throw error;
    } finally {
      opening.delete(botId);
    }
    // FR-12: once the runner holds it, what waits for this bot is sent and its finished replies collected.
    setImmediate(() => {
      void bossCat.attached(botId).catch((error: unknown) => log(`Boss Cat: ${diagnosticError(error)}`, 'error'));
    });
    return presenter;
  };
  // FR-9: each bot's core is supervised on its own.
  const runnerFor = (id: string): CoreRunner<BotPresenter> => {
    let runner = runners.get(id);
    if (!runner) {
      const created: CoreRunner<BotPresenter> = new CoreRunner<BotPresenter>(id, {
        start: () => startBot(id),
        stop: async (presenter) => {
          try {
            await presenter.stop();
          } finally {
            presenter.close();
          }
        },
        onLost: (presenter, listener) => {
          presenter.hosted.client.onClose(() => {
            // SPEC-009 FR-5: what the holder asked the owner expires with its channel.
            for (const [controller, holder] of pendingConfirmations) if (holder === id) controller.abort();
            if (!quitting && created.handle === presenter) {
              presenter.remember();
              presenter.close();
            }
            listener();
          });
        },
        isExternal: (error) => error instanceof CoreHostedElsewhereError,
        changed: () => {
          botsChanged();
        },
        // D18: the owner hears once when a bot is no longer restarted.
        gaveUp: () => {
          if (quitting) return;
          // SPEC-009 FR-12: what waits for a bot that can no longer run returns to its sender as failed.
          void bossCat.targetGone(id, 'it kept failing and is not restarted', { archived: false })
            .catch((error: unknown) => log(`Boss Cat: ${diagnosticError(error)}`, 'error'));
          void dialog.showMessageBox({
            type: 'error',
            title: 'Cats Bot',
            message: t('The Bot core stopped unexpectedly.'),
            detail: `${id}: ${created.error ?? ''}\n${join(botRootIn(hubPaths.bots, id), 'logs', 'core.log')}`,
          });
        },
        log,
      });
      runner = created;
      runners.set(id, runner);
    }
    return runner;
  };

  const hubStatus = () => ({
    pid: process.pid,
    installationId,
    executable: process.execPath,
    home,
    bossCat: manager.registry.bossCat.holder,
    bots: listBots().bots.map((bot) => ({ id: bot.id, state: bot.state, pid: bot.pid, startAutomatically: bot.startAutomatically })),
  });
  const hubControl = new HubControlServer(home, installationId, {
    // FR-25: the owner CLI's view of the hub.
    status: hubStatus,
    // SPEC-009 FR-2: the owner assigns or clears the role from the CLI too.
    setBossCat: async (body) => {
      const bot = body.bot;
      if (bot !== null && (typeof bot !== 'string' || !isValidBotId(bot))) throw new HubControlRefusal('Name a bot by its id, or clear the role.');
      try {
        await manager.setHolder(bot, 'owner');
      } catch (error) {
        throw new HubControlRefusal(error instanceof Error ? error.message : 'The role was not changed.');
      }
      announceHolder();
      return hubStatus();
    },
  });

  const applyLoginItem = (enabled: boolean) => {
    try {
      app.setLoginItemSettings({ openAtLogin: enabled, args: [] });
    } catch (error) {
      log(`login item failed: ${diagnosticError(error)}`, 'error');
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
        // SPEC-008 FR-22: the hub stops its own cores; one another program runs could lose its files.
        const external = manager.registry.bots.filter((bot) => externalPid(bot.id) !== null).map((bot) => bot.id);
        if (external.length > 0) {
          throw new Error(`Stop ${external.join(', ')} first: running in another program, which the update would interrupt.`);
        }
        assertNoOtherUsers(process.execPath);
        return installation.acquire(version);
      },
      drain: async () => {
        // Stopping a runner closes its presenter, so its notes are hidden, destroyed and reported to the desktop
        // host (ADR-011) before the installer quits the app; a note Electron closes itself is reported as it closes.
        quitting = true;
        for (const presenter of presented()) presenter.remember();
        // FR-22: the bots that ran start again after the update.
        saveHubState({ ...hubState, resume: presented().map((presenter) => presenter.botId) });
        providerSetup.cancelCheck();
        await providerSetup.whenIdle();
        const processes = await Promise.all(presented().map(async (presenter) =>
          [presenter.hosted.pid, (await presenter.core.status().catch(() => null))?.runtime.pid ?? null] as const));
        await stopAll();
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
        hubSettings.browserWindow?.webContents.send('shell:update', state);
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
        createActivationWindow: (options) => new BaseWindow(options),
        focusApp: () => app.focus({ steal: true }),
        isShuttingDown: () => quitting,
        showMessageBox: (options) => dialog.showMessageBox(options),
      }),
  });
  // D20: the hub's Settings: the app language, start at login, version and updates, and the Bots tab.
  const openHubSettings = (tab?: 'general' | 'bots') => {
    void hubSettings.open(tab).catch((error: unknown) => log(`open settings failed: ${diagnosticError(error)}`, 'error'));
  };
  // The floating Cat menu can act only on its own bot.
  const botMenuActionsFor = (target: () => BotPresenter | undefined): BotMenuActions => ({
    onOpenConversation: (conversationId) => {
      void target()?.windows
        .open(conversationId)
        .then(refreshTray)
        .catch((error: unknown) => log(`open conversation failed: ${diagnosticError(error)}`, 'error'));
    },
    onNewNote: () => {
      const presenter = target();
      void presenter?.core.createConversation().then((record) => presenter.windows.open(record.id)).then(refreshTray);
    },
    onOpenSettings: (tab) => target()?.openSettings(tab),
    onToggleHeartbeat: (enabled) => {
      void target()?.core.updateProfile({ heartbeat: { enabled } }).then(refreshTray);
    },
    onToggleFloating: (visible) => target()?.setFloatingVisible(visible),
    // SPEC-006 BDC-10 / SPEC-133 DC-12: every conversation; grants are revoked and helper work is cancelled.
    onStopDesktopControl: () => {
      void target()?.core.stopAllDesktopControl().then(refreshTray).catch((error: unknown) => {
        log(`stop desktop control failed: ${diagnosticError(error)}`, 'error');
      });
    },
  });
  const hubTrayActions = {
    onShowFloatingCats: () => {
      for (const presenter of presented()) presenter.setFloatingVisible(true);
    },
    onStopAllDesktopControl: () => {
      for (const presenter of presented()) botMenuActionsFor(() => presenter).onStopDesktopControl();
    },
    onOpenSettings: () => openHubSettings(),
    onCheckForUpdates: () => {
      void trayUpdates.open().catch((error) => log(diagnosticError(error), 'error'));
    },
    onToggleOpenAtLogin: setOpenAtLogin,
    onQuit: quit,
  };

  // FR-17: every message from a renderer is answered for the bot whose window sent it.
  const senderOf = (event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => {
    for (const presenter of presented()) {
      const role = presenter.roleOf(event.sender.id);
      if (role) return { presenter, role };
    }
    return null;
  };
  const fromSettings = (event: Electron.IpcMainInvokeEvent) => {
    const from = senderOf(event);
    return from?.role === 'settings' ? from.presenter : null;
  };
  const fromHubSettings = (event: Electron.IpcMainInvokeEvent) => hubSettings.owns(event.sender.id);
  const fromCreate = (event: Electron.IpcMainInvokeEvent) =>
    createWindow !== null && !createWindow.isDestroyed() && event.sender.id === createWindow.webContents.id;
  const ownedMainFrame = (event: Electron.IpcMainInvokeEvent) =>
    event.senderFrame === event.sender.mainFrame;
  ipcMain.handle('ui:language', (event) => {
    if (!ownedMainFrame(event) || (!senderOf(event) && !fromHubSettings(event) && !fromCreate(event))) throw new Error('Unknown window');
    return languageState();
  });
  ipcMain.handle('ui:setLanguage', (event, value: unknown) => {
    if (!ownedMainFrame(event) || (!fromHubSettings(event) && !fromCreate(event)) || !isLanguagePreference(value))
      throw new Error('Invalid display language');
    saveHubState({ ...hubState, language: value });
    for (const presenter of presented()) presenter.sendLanguage(languageState());
    // FR-28: a reply language that follows the display language follows it here too.
    announceHubLanguage();
    for (const window of [hubSettings.browserWindow, createWindow]) {
      if (window && !window.isDestroyed()) window.webContents.send('ui:languageChanged', languageState());
    }
    void refreshTray();
    return languageState();
  });
  ipcMain.handle('ui:replyLanguage', (event) => {
    if (!ownedMainFrame(event) || !fromHubSettings(event)) throw new Error('The reply language is set only in Cats Bot Settings');
    return hubState.replyLanguage;
  });
  ipcMain.handle('ui:setReplyLanguage', (event, value: unknown) => {
    if (!ownedMainFrame(event) || !fromHubSettings(event) || !isHubReplyLanguage(value))
      throw new Error('Invalid reply language');
    saveHubState({ ...hubState, replyLanguage: value });
    announceHubLanguage();
    return hubState.replyLanguage;
  });
  ipcMain.handle('setup:check', (event, provider: unknown) => {
    if (quitting) throw new Error('Cats Bot is stopping');
    if (!ownedMainFrame(event) || (!fromSettings(event) && !fromCreate(event)))
      throw new Error('Provider setup is available only from Settings');
    return providerSetup.check(provider, fromCreate(event) ? createChecks?.signal : undefined);
  });
  ipcMain.handle('setup:install', (event, provider: unknown, step: unknown) => {
    if (quitting) throw new Error('Cats Bot is stopping');
    if (!ownedMainFrame(event) || (!fromSettings(event) && !fromCreate(event)))
      throw new Error('Provider setup is available only from Settings');
    return providerSetup.install(provider, step);
  });
  ipcMain.handle('setup:providers', (event) => (ownedMainFrame(event) && fromCreate(event) ? listProviders() : []));
  ipcMain.handle('setup:models', (event, provider: unknown) => {
    if (!ownedMainFrame(event) || !fromCreate(event) || typeof provider !== 'string') return { provider: '', defaultModel: null, models: [], source: 'none' };
    return readPackagedModelCatalog(provider);
  });
  let finishing = false;
  let creating = false;
  let createChecks: AbortController | null = null;
  ipcMain.handle('setup:finish', async (event, raw: unknown) => {
    const window = createWindow;
    const checks = createChecks;
    if (quitting || !ownedMainFrame(event) || !fromCreate(event) || !window || !checks || finishing) throw new Error('Setup is already finishing');
    const input = validateSetupInput(raw);
    finishing = true;
    try {
      const checked = await providerSetup.check(input.provider, checks.signal);
      checks.signal.throwIfAborted();
      if (quitting) throw new Error('Cats Bot is stopping');
      if (!checked.canFinish) throw new Error('Complete setup for the selected provider first');
      creating = true;
      const id = await manager.create({
        name: input.name,
        provider: input.provider,
        model: input.model,
        ...(input.modelSelection ? { modelSelection: input.modelSelection } : {}),
        ...(input.instructions ? { instructions: input.instructions } : {}),
      });
      window.destroy();
      botsChanged();
      if (!quitting) void runnerFor(id).start().then((presenter) => presenter?.windows.open('home'));
    } catch (error) {
      throw new Error(error instanceof BotManagementError ? error.message : errorMessage(error));
    } finally {
      finishing = false;
      creating = false;
    }
    return null;
  });
  // SPEC-009 FR-4: a Boss Cat's request the New bot window starts from, read once by that window.
  let createPrefill: { name: string; persona: string; provider: string } | null = null;
  ipcMain.handle('setup:prefill', (event) => {
    if (!ownedMainFrame(event) || !fromCreate(event)) return null;
    const request = createPrefill;
    createPrefill = null;
    return request;
  });
  const openCreateWindow = () => {
    if (createWindow && !createWindow.isDestroyed()) {
      createWindow.show();
      createWindow.focus();
      return;
    }
    const window = createPageWindow(pages, { width: 560, height: 800, title: 'New bot' });
    createWindow = window;
    const checks = new AbortController();
    createChecks = checks;
    window.on('close', (event) => {
      if (providerSetup.installing || creating) event.preventDefault();
    });
    window.on('closed', () => {
      checks.abort();
      if (createWindow === window) {
        createWindow = null;
        createChecks = null;
        createPrefill = null;
      }
    });
    void window.loadURL(pageUrl(rendererDir, 'settings.html', { mode: 'setup', purpose: 'create' })).then(() => {
      if (!window.isDestroyed()) window.show();
    }).catch((error: unknown) => {
      if (!window.isDestroyed()) {
        log(`New bot page failed: ${diagnosticError(error)}`, 'error');
        window.close();
      }
    });
  };
  askOwnerToSetUp = (request) => {
    // An open New bot window holds the owner's own work; it is not replaced.
    if (createWindow && !createWindow.isDestroyed()) return 'busy';
    createPrefill = request;
    openCreateWindow();
    return 'opened';
  };

  // FR-5: Settings → Bots. Archive and delete each ask the owner here, in the hub.
  const confirm = async (owner: BrowserWindow | null, message: string, detail: string, action: string): Promise<boolean> => {
    const options = { type: 'warning' as const, title: 'Cats Bot', message, detail, buttons: [t('Cancel'), action], defaultId: 0, cancelId: 0 };
    return (owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options)).response === 1;
  };
  ipcMain.handle('hub:bots', (event) => {
    if (!ownedMainFrame(event) || !fromHubSettings(event)) throw new Error('Bots are managed only from Cats Bot Settings');
    return listBotsWithStatus();
  });
  // SPEC-009 FR-8: the owner's limits on Boss Cat messages.
  ipcMain.handle('hub:setLimits', async (event, limits: unknown) => {
    if (!ownedMainFrame(event) || !fromHubSettings(event)) throw new Error('Bots are managed only from Cats Bot Settings');
    const value = limits && typeof limits === 'object' ? limits as Record<string, unknown> : {};
    try {
      await manager.setLimits({ hopsPerChain: Number(value.hopsPerChain), messagesPerHour: Number(value.messagesPerHour) });
    } catch (error) {
      throw new Error(error instanceof BotManagementError ? error.message : errorMessage(error));
    }
    botsChanged();
    return listBotsWithStatus();
  });
  ipcMain.handle('hub:createBot', (event) => {
    if (!ownedMainFrame(event) || !fromHubSettings(event)) throw new Error('Bots are managed only from Cats Bot Settings');
    if (manager.activeCount() >= manager.registry.maxBots) {
      throw new Error(`Cats Bot runs at most ${manager.registry.maxBots} bots. Archive one first.`);
    }
    openCreateWindow();
    return null;
  });
  ipcMain.handle('hub:botAction', async (event, action: unknown, id: unknown, value: unknown) => {
    if (!ownedMainFrame(event) || !fromHubSettings(event)) throw new Error('Bots are managed only from Cats Bot Settings');
    if (quitting) throw new Error('Cats Bot is stopping');
    if (typeof id !== 'string' || !isValidBotId(id)) throw new Error('Unknown bot');
    const owner = hubSettings.browserWindow;
    const name = listBots().bots.find((bot) => bot.id === id)?.name ?? id;
    try {
      switch (action) {
        case 'start':
          if (manager.entry(id)?.archivedAt !== null) throw new BotManagementError(`Bot ${id} is not active.`);
          await runnerFor(id).start();
          break;
        case 'stop':
          await runners.get(id)?.stop();
          break;
        case 'makeBossCat':
          await manager.setHolder(id, 'owner');
          announceHolder();
          break;
        case 'clearBossCat':
          if (manager.registry.bossCat.holder === id) await manager.setHolder(null, 'owner');
          announceHolder();
          break;
        case 'startAutomatically':
          if (typeof value !== 'boolean') throw new Error('Invalid value');
          await manager.setStartAutomatically(id, value);
          break;
        case 'moveUp':
        case 'moveDown': {
          const ids = manager.registry.bots.filter((bot) => bot.archivedAt === null).map((bot) => bot.id);
          const index = ids.indexOf(id);
          const other = index + (action === 'moveUp' ? -1 : 1);
          if (index < 0 || other < 0 || other >= ids.length) break;
          [ids[index], ids[other]] = [ids[other]!, ids[index]!];
          await manager.reorder(ids);
          break;
        }
        case 'register':
          await manager.register(id);
          break;
        case 'archive':
          if (!await confirm(owner, t('Archive {name}?', { name: `${name} (${id})` }),
            t('The bot stops and moves to the archive with its conversations. You can restore it later.'), t('Archive'))) return listBotsWithStatus();
          await manager.archive(id);
          runners.delete(id);
          announceHolder();
          // SPEC-009 FR-12: what waited for it returns to the Boss Cat as failed.
          void bossCat.targetGone(id, 'the bot was archived', { archived: true }).catch((error: unknown) => log(`Boss Cat: ${diagnosticError(error)}`, 'error'));
          break;
        case 'restore':
          await manager.restore(id);
          break;
        case 'delete':
          if (!await confirm(owner, t('Delete {name} permanently?', { name: `${name} (${id})` }),
            t('Its conversations, settings and stored secrets are removed. This cannot be undone. The provider CLI folders are kept.'),
            t('Delete'))) return listBotsWithStatus();
          await manager.delete(id);
          break;
        default:
          throw new Error('Unknown bot action');
      }
    } catch (error) {
      throw new Error(error instanceof BotManagementError ? error.message : errorMessage(error));
    } finally {
      botsChanged();
    }
    return listBotsWithStatus();
  });

  const isSettingsWindow = (id: number) => hubSettings.owns(id);
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
            message: t('Stop every bot and install the downloaded update?'),
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
    if (command === 'updateProfile') botsChanged();
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
  ipcMain.handle('window:state', async (event) => {
    const presenter = senderOf(event)?.presenter;
    const owner = presenter?.windows.windowFor(event.sender.id);
    return {
      layer: presenter && owner ? presenter.windows.layerOf(owner.conversationId) : 'normal',
      layers: presenter?.windows.availableLayers() ?? ['normal'],
      // FR-17: a window shows the name of the bot it belongs to.
      botName: (presenter ? (await presenter.core.getProfile().catch(() => null))?.name : null) ?? app.getName(),
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
  // A bot's settings get its own items; the hub's Settings get the app's (D20), with no bot.
  ipcMain.handle('shell:state', (event) => {
    const presenter = fromSettings(event);
    if (!presenter && !fromHubSettings(event)) return null;
    return {
      botId: presenter?.botId ?? null,
      openAtLogin: hubState.openAtLogin,
      openAtLoginAvailable,
      floatingVisible: presenter ? presenter.windows.shellState.floatingBot.visible : false,
      version: app.getVersion(),
      root: presenter ? presenter.root : home,
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
  ipcMain.on('floating:regions', (event, regions: unknown) => {
    fromFloating(event)?.floating.setInputRegions(regions);
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
    const template = buildBotMenuTemplate(await trayModel(presenter), botMenuActionsFor(() => presenter)) as MenuItemConstructorOptions[];
    Menu.buildFromTemplate(template).popup({ window: owner });
    return null;
  });
  ipcMain.handle('shell:setOpenAtLogin', (event, enabled: unknown) => {
    if (!fromHubSettings(event) || typeof enabled !== 'boolean') return null;
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
    if (!presenter && !fromHubSettings(event)) return null;
    await shell.openPath(presenter ? presenter.root : home);
    return null;
  });
  ipcMain.handle('shell:openSettings', (event, tab: unknown) => {
    const from = senderOf(event);
    if (!from || from.role === 'floating') return null;
    from.presenter.openSettings(typeof tab === 'string' ? tab : undefined);
    return null;
  });

  // A launch that names a bot set up outside the hub (`cats-bot init`) takes it in, within the cap.
  const adoptRequested = async (id: string): Promise<boolean> => {
    if (manager.entry(id)) return true;
    if (!listBotDirectories(hubPaths.bots).ids.includes(id)) return false;
    try {
      await manager.register(id);
      botsChanged();
      return true;
    } catch (error) {
      log(`bot ${id} was not added: ${diagnosticError(error)}`, 'error');
      openHubSettings('bots');
      return false;
    }
  };
  app.on('second-instance', (_event, _argv, _cwd, data) => {
    const id = (data as { id?: unknown } | null)?.id;
    void (async () => {
      if (typeof id === 'string' && isValidBotId(id) && await adoptRequested(id)) {
        const entry = manager.entry(id);
        if (entry && entry.archivedAt === null) {
          const presenter = runners.get(id)?.handle ?? (quitting ? null : await runnerFor(id).start());
          if (presenter) {
            await presenter.windows.open('home');
            return;
          }
        }
      }
      const presenter = primary();
      if (presenter) await presenter.windows.open('home');
      else openHubSettings('bots');
    })().catch((error: unknown) => log(`second launch: ${diagnosticError(error)}`, 'error'));
  });
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quit();
  });
  app.removeListener('before-quit', quitDuringSetup);

  tray = new BotTray({
    assetsDir,
    onClick: () => openHubSettings('bots'),
  });
  await hubControl.start().catch((error: unknown) => log(`hub control endpoint failed: ${diagnosticError(error)}`, 'error'));

  if (requested) await adoptRequested(requested);
  // FR-10 and FR-22: this installation's cores that still run are taken back whatever their
  // start setting, and the bots that ran before an update start again.
  const resume = new Set(hubState.resume ?? []);
  if (resume.size > 0) saveHubState({ ...hubState, resume: [] });
  const starting = manager.registry.bots.filter((bot) => bot.archivedAt === null && existsSync(join(hubPaths.bots, bot.id))
    && (bot.startAutomatically || bot.id === requested || resume.has(bot.id) || ownCoreRunning(bot.id)));
  // A new core inherits the hub's PATH, so each provider CLI is found first.
  if (!readProviderOverrides().providerCommand) {
    const providers = new Set(starting.map((bot) => {
      try {
        return readBotProfile(botRootIn(hubPaths.bots, bot.id))?.executionTarget.provider;
      } catch {
        return undefined;
      }
    }).filter((provider): provider is string => typeof provider === 'string'));
    for (const provider of providers) {
      if (quitting) break;
      await providerSetup.prepareEnvironment(provider).catch((error) => log(`Provider environment: ${diagnosticError(error)}`, 'error'));
    }
  }
  if (quitting) return;
  for (const bot of starting) {
    if (quitting) break;
    await runnerFor(bot.id).start();
  }
  // Bots another program runs are listed, and attached to only for the hub's identity.
  for (const bot of manager.registry.bots) {
    if (quitting) return;
    if (externalPid(bot.id) !== null) await attachExternal(bot.id).catch(() => undefined);
  }
  if (quitting) return;
  await refreshTray();
  if (presented().length === 0) openHubSettings('bots');
}

main().catch((error: unknown) => {
  if (hostLogger) hostLogger.error('startup-failed', error);
  else { try { process.stderr.write(`${diagnosticError(error)}\n`); } catch { /* no console */ } }
  // The owner sees why Cats Bot did not start; this is safe before the app is ready.
  dialog.showErrorBox('Cats Bot', error instanceof Error ? error.message : String(error));
  app.exit(1);
});
