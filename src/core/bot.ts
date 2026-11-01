import { delimiter } from 'node:path';

import { attachmentIsCurrent, SessionBinder, staleNotice } from './conversations/binder.ts';
import { ConversationStore } from './conversations/store.ts';
import {
  catsDesktopExecutables,
  createDesktopControlHelperClient,
  resolveDesktopControlHelper,
  type DesktopControlSpawn,
} from './desktopControl/helper.ts';
import { createDesktopLease, type DesktopLease } from './desktopControl/lease.ts';
import { DesktopControlService } from './desktopControl/service.ts';
import { DesktopControlSwitches } from './desktopControl/switches.ts';
import { DESKTOP_CONTROL_SERVER_NAME } from './desktopControl/tools.ts';
import { BotEventBus, type BotEventListener } from './host-api/events.ts';
import { BotInteractions } from './host-api/providerInteractions.ts';
import { HostChannelServer } from './host-api/channel.ts';
import { HostControlServer } from './host-api/control.ts';
import { LifeLoop, type LifeState, type LifeTickReport } from './life/loop.ts';
import { reconcileInterrupted, recordRecoveredReply } from './life/recovery.ts';
import { createSchedule as buildSchedule, describeSchedule, type CreateScheduleInput } from './life/schedules.ts';
import { createFileLogger, type Logger } from './log.ts';
import { BotNotInitializedError, readBotProfile } from './profile/initialize.ts';
import {
  listProviders,
  readLocalModelCatalog,
  type ModelCatalog,
  type ProviderInfo,
} from './providers/catalog.ts';
import {
  applyHubLanguage,
  applyProfilePatch,
  loadProfile,
  saveProfile,
  type ProfileChange,
} from './profile/profile.ts';
import type { HubLanguageReport } from '../shared/language.ts';
import { WorkQueue } from './queue/queue.ts';
import { TurnRunner, type TurnOutcome, type TurnRetryDelays } from './queue/turnRunner.ts';
import { createWorkItem, isTerminalWorkState, transitionWorkItem } from './queue/workItems.ts';
import { FileSecretStore, SECRET_TELEGRAM_TOKEN, type SecretStore } from './secrets.ts';
import {
  readTelegramLastUpdateId,
  TelegramTransport,
  writeTelegramLastUpdateId,
  type TelegramStatus,
} from './transports/telegram.ts';
import type { RuntimeClient, RuntimeMcpServer } from './runtime/client.ts';
import { RuntimeSupervisor, runtimeRestartDelayMs, type RuntimeSupervisorEvent } from './runtime/supervisor.ts';
import { readJsonFile, writeJsonAtomic } from './store/atomicFile.ts';
import { appendJournal, readJournal } from './store/journal.ts';
import { acquireInstanceLock, readInstanceLock, takeHandoffs, type InstanceLock } from './store/lock.ts';
import { botPathsFor, isValidBotId, type BotPaths } from './store/paths.ts';
import { createBotToolHandlers } from './tools/botTools.ts';
import {
  createHubToolHandlers, hubAnswer, HUB_INSTRUCTIONS, HUB_SERVER_NAME, isHubRecordId, oneLine, PROVIDERS_WITHOUT_SESSION_MCP, type HubCall,
} from './tools/hubTools.ts';
import { BotToolServer, type ToolCallResult } from './tools/server.ts';
import type {
  ApprovalDecision,
  BotDelivery,
  BotDeliveryState,
  BotHostApi,
  BotHostEvent,
  BotProfile,
  BotProfilePatch,
  BotStatus,
  ConversationRecord,
  HandoffMessage,
  JournalEntry,
  RuntimeState,
  ScheduleRecord,
  TelegramSettingsStatus,
  WorkItem,
  BotInteractionResponse,
  BotInteractionSnapshot,
  DesktopControlState,
  DesktopGrantDecision,
  SessionCapabilitiesSnapshot,
} from './types.ts';

/**
 * The resident bot core (ADR-001 §2): owns the profile, conversations, the
 * work queue and journal, schedules, the runtime child, the tool server and
 * every timer. Hosts talk to it only through `BotHostApi` and the event bus;
 * it never imports Electron.
 */

export interface BotRuntimeOptions {
  nodeExecPath?: string;
  runtimeEntry?: string;
  providerCommand?: string;
  providerLaunchArgs?: string[];
  instanceExtras?: Record<string, string>;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface BotLifeOptions {
  intervalMs?: number;
  startupDelayMs?: number;
  wakeBackoffMs?: number;
  awaitingOwnerTimeoutMs?: number;
  busyRetryMs?: number;
  failedRetryMs?: number;
  random?: () => number;
}

/** SPEC-006: where the desktop control helper is and what it must never grant. */
export interface BotDesktopControlOptions {
  /** The helper executable; null when this host offers none. Defaults to the development build in this checkout. */
  helperPath?: string | null;
  platform?: NodeJS.Platform;
  /** Added to this process's id, which the helper never grants (BDC-08). */
  selfProcessIds?: number[];
  /** Added to this process's executable and Cats Desktop's install paths (BDC-08). */
  selfExecutables?: string[];
  /** Tests replace the helper process; no file needs to exist then. */
  spawn?: DesktopControlSpawn;
  grantWaitMs?: number;
  requestTtlMs?: number;
  /** SPEC-008 FR-26: tests give each core a lease of its own; production shares the account's. */
  lease?: DesktopLease;
}

export interface BotCoreOptions {
  root: string;
  now?: () => Date;
  fetch?: typeof fetch;
  runtime?: BotRuntimeOptions;
  log?: Logger;
  /** Tests may skip the runtime child and talk to this client instead. */
  runtimeClient?: RuntimeClient;
  handoffPollMs?: number;
  /** Tests shorten the SPEC-001 retry and restart delays; production keeps the defaults. */
  turnRetry?: Partial<TurnRetryDelays>;
  runtimeRestartDelaysMs?: number[];
  life?: BotLifeOptions;
  /** SPEC-001 FR-24: set false to run without the bot tool server (tests). */
  tools?: boolean;
  /** Where secrets such as the Telegram token live; hosts with OS encryption pass a cipher-backed store. */
  secrets?: SecretStore;
  /** SPEC-001 FR-26: Telegram long polling knobs; tests point `apiBaseUrl` at a fake API. */
  telegram?: { apiBaseUrl?: string; fetch?: typeof fetch; pollTimeoutSeconds?: number };
  /** SPEC-006: desktop control helper; without `tools`, the helper is off unless this is given. */
  desktopControl?: BotDesktopControlOptions;
  /** SPEC-008 FR-12: the host channel; `manager` names the hub installation that started this core. */
  channel?: { manager?: string | null; hostRequestTimeoutMs?: number };
  /** SPEC-008 FR-20: the label of the cipher the presenting host serves over the channel. */
  hostCipher?: string;
}

export type { BotStatus } from './types.ts';
export { BotNotInitializedError, initializeBot, readBotProfile, type InitializeBotInput } from './profile/initialize.ts';

export class BotInstanceRunningError extends Error {
  readonly owner: InstanceLock;

  constructor(owner: InstanceLock) {
    super(`Another instance of this bot is running (pid ${owner.pid} since ${owner.startedAt})`);
    this.name = 'BotInstanceRunningError';
    this.owner = owner;
  }
}

interface RunningTurn {
  item: WorkItem;
  controller: AbortController;
}

const PACKAGE_VERSION = '0.1.0';

export class BotCore implements BotHostApi {
  readonly paths: BotPaths;
  private profile: BotProfile;
  private readonly options: BotCoreOptions;
  private readonly now: () => Date;
  private readonly log: Logger;
  private readonly bus = new BotEventBus();
  private readonly interactions: BotInteractions;
  private readonly control: HostControlServer;
  private readonly channel: HostChannelServer;
  private readonly stoppedSignal: Promise<void>;
  private resolveStopped: () => void = () => {};
  private readonly conversations: ConversationStore;
  private readonly queue = new WorkQueue();
  private readonly workItems = new Map<string, WorkItem>();
  private readonly schedules = new Map<string, ScheduleRecord>();
  private readonly binder: SessionBinder;
  private readonly runner: TurnRunner;
  private readonly toolServer: BotToolServer | null;
  /** SPEC-009 FR-3: the Boss Cat's `cats-hub` tools, offered only while the hub reports this bot as holder. */
  private readonly hubTools: BotToolServer | null;
  private bossCatRole = false;
  /** Sessions given `cats-hub` by their last send, so a change of role reaches them at the next send. */
  private readonly hubSessions = new Set<string>();
  private readonly desktopSwitches: DesktopControlSwitches;
  private readonly desktop: DesktopControlService;
  /** Runtime sessions whose MCP server set currently includes `cats-desktop`. */
  private readonly desktopSessions = new Set<string>();
  private readonly life: LifeLoop;
  private readonly secrets: SecretStore;
  private telegram: TelegramTransport | null = null;
  private telegramGeneration = 0;
  private supervisor: RuntimeSupervisor | null;
  private readonly views = new Set<string>();
  /** Views the owner is reading (focused); an open view in the background still counts replies as unread. */
  private readonly focusedViews = new Set<string>();
  private readonly timers = new Set<NodeJS.Timeout>();
  /** Replaced sessions waiting for their running turn to end before they are closed (FR-27). */
  private readonly retiring = new Set<string>();
  /** Work items waiting out a retry delay; cancellation and coalescing see them like queued ones. */
  private readonly deferred = new Map<string, { item: WorkItem; timer: NodeJS.Timeout }>();
  /** Only HTTP-admitted sends own a Runtime turn that Cancel may stop. */
  private readonly admittedTurns = new Set<string>();
  /** FR-27: a provider change restarts the runtime only once the running turn has ended. */
  private runtimeSwapPending = false;
  private swappingRuntime = false;
  private running: RunningTurn | null = null;
  private releaseLock: (() => void) | null = null;
  /** The tail of the profile changes in progress (`changeProfile`). */
  private profileChanges: Promise<unknown> = Promise.resolve();
  private handoffTimer: NodeJS.Timeout | null = null;
  private runtimeAttempt = 0;
  private runtimeRestartTimer: NodeJS.Timeout | null = null;
  private runtimeRestartAt: number | null = null;
  private recovering = false;
  private started = false;
  private stopped = false;

  private constructor(options: BotCoreOptions, profile: BotProfile) {
    this.options = options;
    this.paths = botPathsFor(options.root);
    this.profile = profile;
    this.now = options.now ?? (() => new Date());
    this.log = createFileLogger(this.paths.logs, options.log);
    this.interactions = new BotInteractions(
      this.paths.root,
      profile.id,
      (conversationId, pending, notify) => {
        this.bus.emit({ type: 'provider.interactions', conversationId, pending, ...(notify ? { notify } : {}) });
        if (notify && this.telegram && this.conversations.get(conversationId)?.role === 'home') {
          void this.telegram.send(
            'The provider is waiting for your response. Open the Bot conversation or use cats-bot interactions; Telegram text cannot approve this request.',
          );
        }
      },
    );
    this.control = new HostControlServer(this.paths.root, this);
    this.channel = new HostChannelServer(this.paths.root, this, {
      manager: options.channel?.manager ?? null,
      ...(options.channel?.hostRequestTimeoutMs ? { hostRequestTimeoutMs: options.channel.hostRequestTimeoutMs } : {}),
      // SPEC-008 FR-21: the shell (later the hub) runs outside this process now.
      onHostsChanged: (hosts) => {
        this.log(`channel hosts: ${hosts.map((host) => `pid ${host.pid}`).join(', ') || 'none'}`);
        this.desktop.setHosts(hosts);
        // A token that waited for a host's cipher is read once one attaches.
        if (hosts.length > 0) this.startTelegram();
      },
    });
    this.stoppedSignal = new Promise<void>((resolve) => { this.resolveStopped = resolve; });
    this.conversations = new ConversationStore({
      paths: this.paths,
      now: this.now,
      warn: (message) => this.log(`warn ${message}`),
    });
    // Read-only hosts (status, conversations, schedule list) see the records without starting anything.
    this.conversations.load();
    this.loadJournal();
    this.secrets = options.secrets ?? new FileSecretStore(this.paths.root, {
      ...(options.hostCipher ? { asyncCipher: this.channel.cipher(options.hostCipher) } : {}),
      warn: (line) => this.log(`warn ${line}`),
    });
    this.supervisor = options.runtimeClient ? null : this.createSupervisor();
    this.hubTools = options.tools === false
      ? null
      : new BotToolServer({
        name: HUB_SERVER_NAME,
        instructions: HUB_INSTRUCTIONS,
        serverVersion: PACKAGE_VERSION,
        maxBodyBytes: 96 * 1024,
        handlers: createHubToolHandlers((call) => this.callHub(call)),
      });
    this.toolServer = options.tools === false
      ? null
      : new BotToolServer({
        serverVersion: PACKAGE_VERSION,
        handlers: createBotToolHandlers({
          createSchedule: (input) => this.createSchedule(input),
          listSchedules: () => this.scheduleRecords(),
          cancelSchedule: (id) => this.cancelScheduleRecord(id),
          askOwner: (conversationId, question) => this.askOwner(conversationId, question),
          now: this.now,
        }),
      });
    this.desktopSwitches = new DesktopControlSwitches(this.paths.desktopControl, (line) => this.log(`warn ${line}`));
    this.desktop = this.createDesktopControl();
    this.binder = new SessionBinder({
      client: () => this.client(),
      profile: () => this.profile,
      conversations: this.conversations,
      now: this.now,
      mcpServers: (conversationId, sessionId) => this.sessionMcpServers(conversationId, sessionId),
      isPendingWorkItem: (workItemId) => {
        const state = this.workItems.get(workItemId)?.state;
        return state === 'queued' || state === 'running';
      },
      retireSession: (sessionId) => this.retireSession(sessionId),
      log: this.log,
    });
    this.runner = new TurnRunner({
      client: () => this.client(),
      binder: this.binder,
      conversations: this.conversations,
      now: this.now,
      emit: (event) => this.bus.emit(event),
      persistRun: (item) => {
        this.record({ ...item, ...(item.run ? { run: { ...item.run } } : {}) });
        const client = this.client();
        if (client) this.interactions.track(item, client);
      },
      providerEvent: (item, event) => this.interactions.notice(item, event),
      accepted: item => {
        if (this.running?.item.id !== item.id || this.running.controller.signal.aborted) return;
        this.admittedTurns.add(item.id);
        if (item.error) {
          item.error = undefined;
          this.record({ ...item, error: undefined });
        }
      },
      prepareSend: (item, sessionId) => this.prepareSend(item.conversationId, sessionId),
      log: this.log,
      ...(options.turnRetry ? { delays: options.turnRetry } : {}),
    });
    const life = options.life ?? {};
    this.life = new LifeLoop({
      now: this.now,
      random: life.random ?? Math.random,
      profile: () => this.profile,
      conversations: this.conversations,
      binder: this.binder,
      client: () => this.client(),
      // While the runtime is being replaced for a new provider the tick leaves it alone.
      runtimeState: () => (this.runtimeSwitching() ? 'starting' : this.runtimeState()),
      ensureRuntime: async () => (this.runtimeSwitching() ? false : this.ensureRuntime()),
      // BDC-09: a grant request waiting for the owner keeps the session busy for the life loop.
      isTurnRunning: (conversationId) => this.isTurnRunning(conversationId) || this.desktop.pendingRequests(conversationId) > 0,
      hasQueuedWork: (key) => this.queue.findByCoalesceKey(key) !== undefined
        || this.running?.item.coalesceKey === key
        || [...this.deferred.values()].some((entry) => entry.item.coalesceKey === key),
      enqueue: (item) => {
        this.enqueueWorkItem(item);
      },
      schedules: () => this.scheduleRecords(),
      saveSchedule: (schedule) => this.saveSchedule(schedule),
      awaitingOwner: () => this.listWorkItems().filter((item) => item.state === 'awaiting_owner'),
      expireWorkItem: (item, reason) => this.expireWorkItem(item, reason),
      journal: (entry) => this.journal(entry),
      emit: (event) => this.bus.emit(event),
      log: this.log,
      readLifeState: () => this.readLifeState(),
      writeLifeState: (state) => writeJsonAtomic(this.paths.life, state),
      ...(life.intervalMs !== undefined ? { intervalMs: life.intervalMs } : {}),
      ...(life.startupDelayMs !== undefined ? { startupDelayMs: life.startupDelayMs } : {}),
      ...(life.wakeBackoffMs !== undefined ? { wakeBackoffMs: life.wakeBackoffMs } : {}),
      ...(life.awaitingOwnerTimeoutMs !== undefined ? { awaitingOwnerTimeoutMs: life.awaitingOwnerTimeoutMs } : {}),
      ...(life.busyRetryMs !== undefined ? { busyRetryMs: life.busyRetryMs } : {}),
      ...(life.failedRetryMs !== undefined ? { failedRetryMs: life.failedRetryMs } : {}),
    });
  }

  /** Loads an initialized bot without starting anything. */
  static open(options: BotCoreOptions): BotCore {
    const profile = readBotProfile(options.root);
    if (!profile) throw new BotNotInitializedError(options.root);
    return new BotCore(options, profile);
  }

  private createSupervisor(): RuntimeSupervisor {
    const { options } = this;
    const target = this.profile.executionTarget;
    // Claude in Chrome needs `--chrome` on every Claude Code launch the runtime makes.
    const launchArgs = [...(options.runtime?.providerLaunchArgs ?? []),
      ...(target.provider === 'claude' && target.claudeInChrome ? ['--chrome'] : [])];
    return new RuntimeSupervisor({
      runtimeDir: this.paths.runtime,
      providers: {
        provider: this.profile.executionTarget.provider,
        ...(options.runtime?.providerCommand ? { command: options.runtime.providerCommand } : {}),
        ...(launchArgs.length ? { launchArgs } : {}),
        ...(options.runtime?.instanceExtras ? { instanceExtras: options.runtime.instanceExtras } : {}),
      },
      ...(options.runtime?.nodeExecPath ? { nodeExecPath: options.runtime.nodeExecPath } : {}),
      ...(options.runtime?.runtimeEntry ? { runtimeEntry: options.runtime.runtimeEntry } : {}),
      ...(options.runtime?.env ? { env: options.runtime.env } : {}),
      ...(options.runtime?.readyTimeoutMs ? { readyTimeoutMs: options.runtime.readyTimeoutMs } : {}),
      ...(options.runtime?.stopTimeoutMs ? { stopTimeoutMs: options.runtime.stopTimeoutMs } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      onEvent: (event) => this.onRuntimeEvent(event),
    });
  }

  private loadJournal(): void {
    const journal = readJournal(this.paths);
    if (journal.corruptLines > 0) this.log(`warn journal has ${journal.corruptLines} unreadable line(s)`);
    this.workItems.clear();
    this.schedules.clear();
    for (const item of journal.workItems.values()) this.workItems.set(item.id, item);
    for (const schedule of journal.schedules.values()) this.schedules.set(schedule.id, schedule);
  }

  private readLifeState(): LifeState | null {
    const read = readJsonFile<LifeState>(this.paths.life);
    return read.ok && typeof read.value === 'object' && read.value !== null ? read.value : null;
  }

  subscribe(listener: BotEventListener): () => void {
    return this.bus.subscribe(listener);
  }

  get isStarted(): boolean {
    return this.started && !this.stopped;
  }

  runtimeState(): RuntimeState {
    if (this.options.runtimeClient) return 'ready';
    return this.supervisor?.state ?? 'stopped';
  }

  private client(): RuntimeClient | null {
    return this.options.runtimeClient ?? this.supervisor?.client ?? null;
  }

  /**
   * SPEC-001 FR-24 and SPEC-006 BDC-04: `cats-bot`, plus `cats-desktop` once the conversation's
   * session qualified on its capability snapshot. A session about to be created (no id yet)
   * has no snapshot, so it never starts with `cats-desktop`.
   */
  private mcpServersFor(conversationId: string, sessionId: string | null = null): RuntimeMcpServer[] {
    return [
      ...(this.toolServer?.descriptorFor(conversationId) ?? []),
      ...this.desktop.descriptorFor(conversationId, sessionId),
      ...(this.hubToolsOffered() ? this.hubTools?.descriptorFor(conversationId) ?? [] : []),
    ];
  }

  /**
   * SPEC-009 FR-3 and FR-11: the holder's sessions get `cats-hub` when their
   * provider takes session MCP servers. Otherwise the bot keeps the role
   * without the tools.
   */
  private hubToolsOffered(): boolean {
    return this.bossCatRole && !PROVIDERS_WITHOUT_SESSION_MCP.includes(this.profile.executionTarget.provider);
  }

  /** SPEC-009 FR-3: the hub's word on whether this bot holds the Boss Cat role. */
  setBossCat(holder: boolean): void {
    if (this.bossCatRole === holder) return;
    this.bossCatRole = holder;
    this.log(holder ? 'Boss Cat role held' : 'Boss Cat role not held');
    // The notes show the role (FR-10).
    for (const conversation of this.conversations.list()) this.bus.emit({ type: 'conversation.updated', conversation });
  }

  /**
   * SPEC-009: one `cats-hub` call, carried out by the hub, which decides from
   * the channel which bot calls. The holder's journal records the call and
   * its outcome, never its text (FR-9).
   */
  private async callHub(call: HubCall): Promise<ToolCallResult> {
    let result: ToolCallResult;
    if (!this.bossCatRole) {
      result = { text: 'This bot does not hold the Boss Cat role.', isError: true };
    } else {
      try {
        result = hubAnswer(await this.channel.hubCall({ ...call, conversationId: this.resolveConversationId(call.conversationId) }));
      } catch (error) {
        result = { text: `The hub could not be reached: ${error instanceof Error ? error.message : 'error'}`, isError: true };
      }
    }
    // Only ids go to the journal: the model's arguments are neither trusted nor kept (FR-9).
    const chain = result.structuredContent?.chain ?? call.args.chain;
    const target = call.args.bot;
    this.journal({
      type: 'bossCat',
      at: this.now().toISOString(),
      tool: oneLine(call.tool, 64),
      ...(typeof target === 'string' && isValidBotId(target) ? { target } : {}),
      ...(isHubRecordId(chain) ? { chain } : {}),
      outcome: result.isError ? `refused: ${oneLine(result.text, 200)}` : 'done',
    });
    return result;
  }

  /**
   * SPEC-009 FR-7 and FR-12: a delivery from another bot, through the hub. It
   * is admitted once per delivery id as background work, runs under this bot's
   * own target and policy, and is never an owner turn. A message goes to the
   * conversation this bot keeps for that sender (FR-6); a reply goes to the
   * conversation that asked.
   */
  admitBotMessage(delivery: BotDelivery): WorkItem {
    if (!isValidBotId(delivery.from)) throw new Error('A delivery names its sender by bot id.');
    const sourceRef = `bot:${delivery.deliveryId}`;
    const existing = [...this.workItems.values()].find((item) => item.sourceRef === sourceRef);
    if (existing) return structuredClone(existing);
    const fromName = oneLine(delivery.fromName, 80) || delivery.from;
    // A reply whose conversation the owner deleted goes to its sender's conversation, never to the direct message.
    const conversationId = delivery.kind === 'reply' && delivery.conversationId && this.conversations.get(delivery.conversationId)
      ? delivery.conversationId
      : this.senderConversation(delivery.from, fromName);
    const prompt = delivery.kind === 'message'
      ? `A message from ${fromName}, the owner's Boss Cat, through the Cats Bot hub. `
        + `It is not from the owner. Your answer goes back to ${fromName}.\n\n${delivery.text}`
      : `${fromName} answered your message through the Cats Bot hub (chain ${delivery.chainId}). `
        + `It is not from the owner.\n\n${delivery.text}`;
    const item: WorkItem = {
      ...createWorkItem({ kind: 'event', source: 'bot', conversationId, prompt }, this.now()),
      sourceRef,
      chain: {
        id: delivery.chainId, hop: delivery.hop, deliveryId: delivery.deliveryId,
        kind: delivery.kind, from: delivery.from, fromName,
      },
    };
    this.conversations.append(conversationId, { kind: 'owner', origin: 'bot', from: fromName, text: delivery.text, workItemId: item.id });
    // FR-12: journaled before the hub hears it was admitted.
    this.record(item);
    this.log(`delivery ${delivery.deliveryId} admitted as ${item.id} (chain ${delivery.chainId}, hop ${delivery.hop})`);
    this.bus.emit({ type: 'conversation.updated', conversation: this.conversations.require(conversationId) });
    this.queue.enqueue(item);
    this.pump();
    return structuredClone(item);
  }

  /**
   * SPEC-009 FR-6: the conversation this bot keeps for one sender's messages.
   * It has a session of its own, so the sender's work never shares the
   * context of what the owner wrote, and it is not mirrored to Telegram.
   */
  private senderConversation(from: string, fromName: string): string {
    const id = `bot-${from}`;
    const existing = this.conversations.get(id);
    if (existing) return existing.id;
    const created = this.conversations.create(`Messages from ${fromName}`, 'note', id);
    this.log(`conversation ${id} created for messages from bot ${from}`);
    return created.id;
  }

  /** SPEC-009 FR-12: how the named deliveries stand, from the journal, so a reply finished while the hub was away is found. */
  botDeliveries(deliveryIds: string[]): BotDeliveryState[] {
    const wanted = new Set(deliveryIds);
    const states: BotDeliveryState[] = [];
    for (const item of this.workItems.values()) {
      const deliveryId = item.chain?.deliveryId;
      if (!deliveryId || !wanted.has(deliveryId)) continue;
      states.push({
        deliveryId,
        workItemId: item.id,
        state: item.state,
        reply: item.state === 'completed' ? item.result?.text ?? '' : null,
        error: item.error ?? null,
      });
    }
    return states;
  }

  /** The set a session is given on resume or send; remembers which sessions carry `cats-desktop` and `cats-hub`. */
  private sessionMcpServers(conversationId: string, sessionId: string | null): RuntimeMcpServer[] {
    const servers = this.mcpServersFor(conversationId, sessionId);
    if (sessionId) {
      if (servers.some((server) => server.name === DESKTOP_CONTROL_SERVER_NAME)) this.desktopSessions.add(sessionId);
      else this.desktopSessions.delete(sessionId);
      if (servers.some((server) => server.name === HUB_SERVER_NAME)) this.hubSessions.add(sessionId);
      else this.hubSessions.delete(sessionId);
    }
    return servers;
  }

  /**
   * SPEC-006 BDC-04 / BDC-05: re-decided before every send. A qualifying conversation sends
   * the same set each turn, so Runtime recycles its worker only when the set changes; the
   * turn's owner-presence is decided when a tool is called, not here.
   */
  private async prepareSend(conversationId: string, sessionId: string): Promise<{ mcpServers?: RuntimeMcpServer[] }> {
    const carried = this.desktopSessions.has(sessionId);
    try {
      await this.desktop.refresh(conversationId, sessionId);
    } catch (error) {
      this.log(`desktop control: eligibility check failed: ${error instanceof Error ? error.name : 'error'}`);
    }
    // SPEC-009 FR-3: a change of role reaches the session at its next send.
    const hubChanged = this.hubSessions.has(sessionId) !== (this.hubToolsOffered() && this.hubTools !== null);
    if (!carried && !hubChanged && !this.desktop.isAttached(conversationId, sessionId) && !this.profile.desktopControl.enabled) return {};
    return { mcpServers: this.sessionMcpServers(conversationId, sessionId) };
  }

  private createDesktopControl(): DesktopControlService {
    const options = this.options.desktopControl;
    const resolution = this.options.tools === false && !options
      ? { path: null, unavailableReason: 'no_helper' }
      : resolveDesktopControlHelper({
        ...(options?.platform ? { platform: options.platform } : {}),
        ...(options?.helperPath !== undefined ? { helperPath: options.helperPath } : {}),
        skipExistenceCheck: Boolean(options?.spawn),
      });
    // BDC-08: this process and its executable cover the core and the runtime child, which
    // runs the same executable. The shell (the same executable as a packaged core) and any
    // other attached host are added as they attach (SPEC-008 FR-21).
    const selfExecutables = [process.execPath, ...catsDesktopExecutables(), ...(options?.selfExecutables ?? [])];
    const helper = resolution.path === null ? null : createDesktopControlHelperClient({
      path: resolution.path,
      selfProcessIds: [process.pid, ...(options?.selfProcessIds ?? [])],
      selfExecutables,
      ...(options?.spawn ? { spawn: options.spawn } : {}),
      // Exception types and stack frames only (BDC-12); the next call restarts the helper.
      onExit: ({ code, summary }) => this.log(`desktop control helper exited unexpectedly (code ${code})`
        + `${summary ? `: ${summary.replace(/\n/gu, ' | ')}` : ''}`),
    });
    return new DesktopControlService({
      helper,
      // SPEC-008 FR-26: one bot at a time controls this account's desktop.
      ...(helper ? { lease: options?.lease ?? createDesktopLease() } : {}),
      unavailableReason: resolution.unavailableReason,
      switches: this.desktopSwitches,
      profileEnabled: () => this.profile.desktopControl.enabled,
      capabilities: async (sessionId) => {
        const client = this.client();
        if (!client) return null;
        const snapshot = await client.capabilities(sessionId);
        return snapshot?.version === 1 ? snapshot : null;
      },
      turn: (conversationId) => {
        const running = this.running;
        if (!running || this.stopped || running.item.conversationId !== conversationId || running.controller.signal.aborted) {
          return null;
        }
        return {
          sessionId: running.item.run?.sessionId ?? null,
          workItemId: running.item.id,
          ownerPresent: running.item.kind === 'owner_message' && running.item.source === 'owner',
        };
      },
      changed: (change) => {
        this.bus.emit({ type: 'desktop.control', ...change });
        // BDC-07 / BDC-12: Telegram only learns that something waits, never what or how to answer.
        if (
          change.notify &&
          this.telegram &&
          change.conversationId &&
          this.conversations.get(change.conversationId)?.role === 'home'
        ) {
          void this.telegram.send(
            'A desktop control request is waiting for you. Open the Bot conversation or use cats-bot desktop; ' +
              'Telegram cannot answer it.',
          );
        }
        // BDC-09: background work held for a waiting grant request resumes once it is answered.
        this.pump();
      },
      log: this.log,
      serverVersion: PACKAGE_VERSION,
      selfExecutables,
      ...(options?.grantWaitMs !== undefined ? { grantWaitMs: options.grantWaitMs } : {}),
      ...(options?.requestTtlMs !== undefined ? { requestTtlMs: options.requestTtlMs } : {}),
    });
  }

  private journal(entry: JournalEntry): void {
    appendJournal(this.paths, entry);
  }

  private record(item: WorkItem): WorkItem {
    this.workItems.set(item.id, item);
    this.journal({ type: 'work', at: this.now().toISOString(), item });
    this.bus.emit({ type: 'work.updated', workItem: item });
    return item;
  }

  private saveSchedule(schedule: ScheduleRecord): ScheduleRecord {
    this.schedules.set(schedule.id, schedule);
    this.journal({ type: 'schedule', at: this.now().toISOString(), schedule });
    return schedule;
  }

  private schedule(delayMs: number, fn: () => void): NodeJS.Timeout {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.stopped) fn();
    }, delayMs);
    timer.unref?.();
    this.timers.add(timer);
    return timer;
  }

  private isTurnRunning(conversationId?: string): boolean {
    if (!this.running) return false;
    return conversationId === undefined || this.running.item.conversationId === conversationId;
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('Bot core already started');
    const lock = acquireInstanceLock(this.paths);
    if (!lock.held) throw new BotInstanceRunningError(lock.owner);
    this.started = true;
    this.releaseLock = lock.release;
    try {
    const loaded = loadProfile(this.paths, this.profile, true);
    if (!loaded.ok) {
      this.releaseLock(); this.releaseLock = null; this.started = false;
      throw new Error('Profile upgrade failed; original data and backup were preserved.');
    }
    this.profile = loaded.profile;
    if (!this.options.runtimeClient) this.supervisor = this.createSupervisor();
    this.log(`core start bot=${this.profile.id} pid=${process.pid}`);
    await this.control.start();
    await this.channel.start();
    // A host may stop the core over the channel while it is still starting.
    if (this.stopped) return;

    this.conversations.load();
    this.conversations.home();
    this.loadJournal();
    this.desktopSwitches.load();

    // SPEC-001 FR-28: whatever was running when the core died is interrupted, never rerun.
    const pending: WorkItem[] = [];
    for (const item of [...this.workItems.values()]) {
      if (item.state === 'running') {
        this.record(transitionWorkItem(item, 'interrupted', this.now(), { error: 'core restarted during this turn' }));
      } else if (item.state === 'queued') {
        pending.push(item);
      }
    }
    for (const conversation of this.conversations.list()) {
      const { attachment } = conversation;
      // Sessions of the previous runtime are gone with it; resume or rebuild lazily (FR-6).
      if (!this.options.runtimeClient && attachment.sessionId && (attachment.state === 'ready' || attachment.state === 'initializing')) {
        this.conversations.setAttachment(conversation.id, { state: 'closed' });
      }
    }
    for (const item of pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      this.queue.enqueue(item);
    }

    await this.hubTools?.start();
    if (this.toolServer) {
      await this.toolServer.start();
      this.log('tool server listening on loopback');
    }
    if (this.stopped) return;
    await this.ensureRuntime();
    if (this.stopped) return;
    const pollMs = this.options.handoffPollMs ?? 1_500;
    this.handoffTimer = setInterval(() => this.drainHandoffs(), pollMs);
    this.handoffTimer.unref?.();
    this.life.start();
    this.startTelegram();
    this.pump();
    } catch (error) {
      // A stop that raced this start cleans up itself.
      if (this.stopped) {
        await this.whenStopped();
        return;
      }
      try { await this.stop(); }
      finally {
        await this.control.stop();
        await this.channel.stop();
        this.releaseLock?.(); this.releaseLock = null;
      }
      throw error;
    }
  }

  // ---- Telegram (SPEC-001 FR-19, FR-26) ---------------------------------

  /**
   * Reading the token may wait for the host's cipher (SPEC-008 FR-20), so polling starts once it
   * is read. A later start or a stop supersedes an attempt still reading.
   */
  private startTelegram(): void {
    if (this.telegram || this.stopped || !this.started) return;
    if (!this.profile.telegram.enabled) return;
    const generation = ++this.telegramGeneration;
    void this.secrets.getAsync(SECRET_TELEGRAM_TOKEN).then((token) => {
      if (generation !== this.telegramGeneration || this.telegram || this.stopped || !this.profile.telegram.enabled) return;
      if (!token) {
        this.log(this.secrets.has(SECRET_TELEGRAM_TOKEN)
          ? 'telegram token could not be opened; polling starts when a host serves its cipher'
          : 'telegram enabled but no token is stored; polling not started');
        return;
      }
      this.beginTelegram(token);
    }, (error: unknown) => this.log(`warn telegram token unavailable: ${error instanceof Error ? error.message : String(error)}`));
  }

  private beginTelegram(token: string): void {
    const transport = new TelegramTransport({
      token,
      botName: this.profile.name,
      ownerChatId: this.profile.telegram.ownerChatId,
      ...(this.options.telegram?.apiBaseUrl ? { apiBaseUrl: this.options.telegram.apiBaseUrl } : {}),
      ...(this.options.telegram?.fetch ? { fetch: this.options.telegram.fetch } : {}),
      ...(this.options.telegram?.pollTimeoutSeconds !== undefined
        ? { pollTimeoutSeconds: this.options.telegram.pollTimeoutSeconds }
        : {}),
      now: this.now,
      log: this.log,
      lastUpdateId: readTelegramLastUpdateId(this.paths.telegramState, token),
      onUpdateAccepted: (updateId) => writeTelegramLastUpdateId(this.paths.telegramState, token, updateId),
      onOwnerBound: (chatId) => {
        this.profile = { ...this.profile, telegram: { ...this.profile.telegram, ownerChatId: chatId }, updatedAt: this.now().toISOString() };
        saveProfile(this.paths, this.profile);
        this.log('telegram owner chat bound and saved');
      },
      onOwnerMessage: async (message) => {
        // A redelivered update whose work item was journaled before a crash is not accepted twice.
        const sourceRef = `telegram:${message.chatId}:${message.messageId}`;
        if (this.listWorkItems().some((item) => item.sourceRef === sourceRef)) {
          this.log('telegram: an already accepted message was delivered again; skipped');
          return;
        }
        await this.sendOwnerMessage('home', message.text, 'telegram', sourceRef);
      },
    });
    this.telegram = transport;
    transport.start();
  }

  private async stopTelegram(): Promise<void> {
    this.telegramGeneration += 1;
    const transport = this.telegram;
    this.telegram = null;
    if (transport) await transport.stop();
  }

  /** Stores (or clears) the token in the secret store; polling follows the profile flag. */
  async setTelegramToken(token: string | null): Promise<void> {
    if (token && token.trim()) await this.secrets.setAsync(SECRET_TELEGRAM_TOKEN, token.trim());
    else this.secrets.delete(SECRET_TELEGRAM_TOKEN);
    this.log(`telegram token ${token ? 'stored' : 'cleared'} (${this.secrets.protection()} protection)`);
    await this.stopTelegram();
    this.startTelegram();
  }

  /** Re-stores secrets a host without a cipher (the CLI) wrote, when this host has one. */
  async protectSecretsAtRest(): Promise<number> {
    const upgraded = await this.secrets.protectAtRestAsync();
    if (upgraded > 0) this.log(`re-stored ${upgraded} secret(s) with ${this.secrets.protection()} protection`);
    return upgraded;
  }

  /** `protection` is how the stored token is protected; without a token, what this host would use. */
  telegramStatus(): TelegramSettingsStatus {
    return {
      enabled: this.profile.telegram.enabled,
      tokenStored: this.secrets.has(SECRET_TELEGRAM_TOKEN),
      protection: this.secrets.protectionOf(SECRET_TELEGRAM_TOKEN) ?? this.secrets.protection(),
      transport: this.telegram?.status() ?? null,
    };
  }

  /** SPEC-001 FR-6: start the runtime, or wait for the scheduled attempt with backoff. */
  async ensureRuntime(): Promise<boolean> {
    if (!this.supervisor || this.stopped) return this.client() !== null;
    if (this.supervisor.state === 'ready') return true;
    if (this.supervisor.state === 'starting') return false;
    if (this.runtimeRestartAt !== null && this.now().getTime() < this.runtimeRestartAt) return false;
    if (this.runtimeRestartTimer) {
      clearTimeout(this.runtimeRestartTimer);
      this.timers.delete(this.runtimeRestartTimer);
      this.runtimeRestartTimer = null;
    }
    this.runtimeRestartAt = null;
    this.journal({ type: 'runtime', at: this.now().toISOString(), event: 'started', detail: `attempt ${this.runtimeAttempt + 1}` });
    try {
      await this.supervisor.start();
      this.runtimeAttempt = 0;
      this.journal({ type: 'runtime', at: this.now().toISOString(), event: 'ready' });
      void this.recoverInterrupted().catch((error: unknown) => this.log(`recovery failed: ${error instanceof Error ? error.message : 'error'}`));
      this.pump();
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log(`runtime start failed: ${detail}`);
      this.scheduleRuntimeRestart();
      return false;
    }
  }

  private restartDelayMs(attempt: number): number {
    const custom = this.options.runtimeRestartDelaysMs;
    if (custom && custom.length > 0) {
      return custom[Math.min(attempt, custom.length - 1)]!;
    }
    return runtimeRestartDelayMs(attempt);
  }

  private scheduleRuntimeRestart(): void {
    if (this.stopped || !this.supervisor || this.runtimeRestartTimer) return;
    const delay = this.restartDelayMs(this.runtimeAttempt);
    this.runtimeAttempt += 1;
    this.runtimeRestartAt = this.now().getTime() + delay;
    this.journal({ type: 'runtime', at: this.now().toISOString(), event: 'restart_scheduled', detail: `${delay}ms` });
    this.log(`runtime restart in ${delay}ms (attempt ${this.runtimeAttempt + 1})`);
    this.runtimeRestartTimer = this.schedule(delay, () => {
      this.runtimeRestartTimer = null;
      this.runtimeRestartAt = null;
      void this.ensureRuntime().catch((error: unknown) => this.log(`runtime restart failed: ${error instanceof Error ? error.message : 'error'}`));
    });
  }

  private onRuntimeEvent(event: RuntimeSupervisorEvent): void {
    switch (event.type) {
      case 'state':
        this.bus.emit({ type: 'runtime.status', state: event.state, ...(event.detail ? { detail: event.detail } : {}) });
        if (event.state === 'ready') this.retryRuntimeDeferred();
        break;
      case 'exit':
        this.log(`runtime exited code=${event.code ?? ''} signal=${event.signal ?? ''} expected=${event.expected}`);
        this.journal({ type: 'runtime', at: this.now().toISOString(), event: 'exited', detail: `${event.code ?? event.signal}` });
        for (const conversation of this.conversations.list()) {
          const { attachment } = conversation;
          if (attachment.sessionId && (attachment.state === 'ready' || attachment.state === 'initializing')) {
            const updated = this.conversations.setAttachment(conversation.id, { state: 'closed' });
            this.bus.emit({ type: 'conversation.updated', conversation: updated });
          }
        }
        this.life.forgetAwake();
        if (!event.expected) this.scheduleRuntimeRestart();
        break;
      default:
        break;
    }
  }

  /**
   * A turn sent while the Runtime was still starting (a host attaches before
   * that) runs once it is ready, not when its retry delay ends.
   */
  private retryRuntimeDeferred(): void {
    let woke = false;
    for (const [id, entry] of [...this.deferred]) {
      const current = this.workItems.get(id);
      if (current?.state !== 'queued' || current.error !== 'runtime_unavailable') continue;
      clearTimeout(entry.timer);
      this.timers.delete(entry.timer);
      this.deferred.delete(id);
      this.queue.enqueue(current);
      woke = true;
    }
    if (woke) this.pump();
  }

  private drainHandoffs(): void {
    for (const message of takeHandoffs(this.paths)) {
      this.log(`handoff ${message.kind}`);
      this.bus.emit({ type: 'host.handoff', message });
      void this.applyHandoff(message).catch((error: unknown) => {
        this.log(`handoff ${message.kind} failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  private async applyHandoff(message: HandoffMessage): Promise<void> {
    const payload = message.payload ?? {};
    switch (message.kind) {
      case 'say':
        if (message.text) await this.sendOwnerMessage(message.conversationId ?? 'home', message.text);
        break;
      case 'schedule_create': {
        const { at, ...input } = payload as unknown as Omit<CreateScheduleInput, 'at'> & { at?: string };
        this.createSchedule({
          ...input,
          conversationId: this.resolveConversationId(input.conversationId ?? message.conversationId ?? 'home'),
          ...(at ? { at: new Date(at) } : {}),
        });
        break;
      }
      case 'schedule_cancel':
        if (typeof payload.id === 'string') await this.cancelSchedule(payload.id);
        break;
      case 'approve':
        if (typeof payload.workItemId === 'string' && (payload.decision === 'approve' || payload.decision === 'deny')) {
          await this.resolveApproval(payload.workItemId, payload.decision);
        }
        break;
      case 'heartbeat':
        if (typeof payload.enabled === 'boolean') await this.updateProfile({ heartbeat: { enabled: payload.enabled } });
        break;
      case 'telegram':
        // The CLI wrote the token to the secret store itself; the core re-reads it and,
        // when this host has a cipher, re-stores it encrypted.
        if (typeof payload.enabled === 'boolean') await this.updateProfile({ telegram: { enabled: payload.enabled } });
        if (payload.reloadToken === true) {
          // Re-storing waits for the host's cipher; the reload does not (SPEC-008 FR-15).
          await this.protectSecretsAtRest().catch((error: unknown) =>
            this.log(`secret re-store deferred: ${error instanceof Error ? error.message : 'error'}`));
          await this.stopTelegram();
          this.startTelegram();
        }
        break;
      default:
        break;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.log('core stop');
    const running = this.running;
    try {
    this.life.stop();
    await this.stopTelegram();
    if (this.handoffTimer) clearInterval(this.handoffTimer);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.deferred.clear();
    if (running) {
      running.controller.abort();
      const sessionId = running.item.run?.sessionId;
      const client = this.client();
      if (sessionId && client) {
        await client.cancelSession(sessionId).catch(() => undefined);
      }
    }
    if (running) this.interactions.end(running.item.id, 'bot_stopped');
    } finally {
      running?.controller.abort();
      // BDC-07: grants live in memory only; the helper ends with the core.
      this.desktop.close();
      try {
        await Promise.allSettled([
          Promise.resolve().then(() => this.supervisor?.stop()),
          Promise.resolve().then(() => this.toolServer?.stop()),
          Promise.resolve().then(() => this.hubTools?.stop()),
          Promise.resolve().then(() => this.desktop.stopServer()),
          Promise.resolve().then(() => this.control.stop()),
          Promise.resolve().then(() => this.channel.stop()),
        ]);
      } finally {
        this.releaseLock?.(); this.releaseLock = null;
        this.resolveStopped();
      }
    }
  }

  /** Settles once `stop` has finished, however it was asked for (a signal, a handoff or the channel). */
  whenStopped(): Promise<void> {
    return this.stoppedSignal;
  }

  status(): BotStatus {
    return {
      id: this.profile.id,
      name: this.profile.name,
      root: this.paths.root,
      runtime: { state: this.runtimeState(), pid: this.supervisor?.pid ?? null },
      queue: { queued: this.queue.size + this.deferred.size, running: this.running?.item ?? null },
      pendingInteractions: this.interactions.pending(),
      awaitingOwner: [...this.workItems.values()].filter((item) => item.state === 'awaiting_owner').length,
      bossCat: { holder: this.bossCatRole, tools: this.hubToolsOffered() && this.hubTools !== null },
      conversations: this.conversations.list().length,
      schedules: this.scheduleRecords().filter((schedule) => schedule.state === 'active').length,
      heartbeat: { enabled: this.profile.heartbeat.enabled, nextAt: this.life.nextHeartbeatAt?.toISOString() ?? null },
      lastTickAt: this.readLifeState()?.lastTickAt ?? null,
      lock: readInstanceLock(this.paths),
      telegram: {
        enabled: this.profile.telegram.enabled,
        polling: this.telegram?.status().polling ?? false,
        ownerChatId: this.profile.telegram.ownerChatId,
      },
    };
  }

  listWorkItems(conversationId?: string): WorkItem[] {
    const id = conversationId === undefined ? undefined : this.resolveConversationId(conversationId);
    return [...this.workItems.values()]
      .filter((item) => id === undefined || item.conversationId === id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  providerInteractions(conversationId: string): Promise<BotInteractionSnapshot> {
    const record = this.conversations.require(this.resolveConversationId(conversationId));
    return this.interactions.snapshot(record.id);
  }

  async respondProviderInteraction(conversationId: string, interactionId: string, response: BotInteractionResponse): Promise<void> {
    const record = this.conversations.require(this.resolveConversationId(conversationId));
    if (this.stopped || this.running?.item.conversationId !== record.id || this.running.controller.signal.aborted) {
      throw new Error('No live provider turn in this conversation.');
    }
    await this.interactions.respond(record.id, interactionId, response);
  }

  async sessionCapabilities(conversationId: string, refresh = false): Promise<SessionCapabilitiesSnapshot> {
    const record = this.conversations.require(this.resolveConversationId(conversationId));
    const sessionId = record.attachment.sessionId;
    const client = this.client();
    const unavailable = (reason: string): SessionCapabilitiesSnapshot => ({ version: 1, sessionId: sessionId ?? '',
      workerGeneration: null, supported: false, reason, desktopControl: this.desktop.capability(record.id, sessionId) });
    if (!sessionId || !client) return unavailable('no_live_session');
    try {
      const result = await client.capabilities(sessionId, refresh);
      if (this.client() !== client || this.conversations.get(record.id)?.attachment.sessionId !== sessionId) return unavailable('session_changed');
      if (result.version !== 1) return unavailable('unsupported_runtime');
      // BDC-13: a Bot entry beside Runtime's observation; provider computer use stays in `dependencies`.
      return { ...result, desktopControl: this.desktop.capability(record.id, sessionId, result) };
    } catch { return unavailable('runtime_or_capability_unavailable'); }
  }

  // ---- desktop control (SPEC-006) ------------------------------------------

  async desktopControlState(conversationId?: string): Promise<DesktopControlState> {
    if (!conversationId) return this.desktop.state();
    const record = this.conversations.require(this.resolveConversationId(conversationId));
    return this.desktop.state(record.id, record.attachment.sessionId);
  }

  async setConversationDesktopControl(conversationId: string, enabled: boolean): Promise<DesktopControlState> {
    if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false');
    const id = this.resolveConversationId(conversationId);
    this.withWriteLock(() => this.desktop.setConversation(id, enabled));
    return this.desktopControlState(id);
  }

  async respondDesktopGrant(conversationId: string, requestId: string, decision: DesktopGrantDecision): Promise<void> {
    if (decision !== 'allow' && decision !== 'deny') throw new Error('decision must be allow or deny');
    const id = this.resolveConversationId(conversationId);
    if (!this.desktop.decide(id, requestId, decision)) {
      throw new Error('No desktop control grant request with that id waits in this conversation.');
    }
  }

  async stopDesktopControl(conversationId?: string): Promise<void> {
    this.desktop.stop(conversationId ? this.resolveConversationId(conversationId) : undefined);
  }

  /** A write a host makes while no core runs takes the instance lock for its duration, like `updateProfile`. */
  private withWriteLock(write: () => void): void {
    if (this.releaseLock) {
      write();
      return;
    }
    const lock = acquireInstanceLock(this.paths);
    if (!lock.held) throw new BotInstanceRunningError(lock.owner);
    try {
      this.desktopSwitches.load();
      write();
    } finally { lock.release(); }
  }

  getWorkItem(id: string): WorkItem | undefined {
    return this.workItems.get(id);
  }

  transcript(conversationId: string) {
    return this.conversations.transcript(this.resolveConversationId(conversationId));
  }

  conversationTranscript(conversationId: string) {
    const id = this.resolveConversationId(conversationId);
    const running = [...this.workItems.values()].find(item => item.conversationId === id && item.state === 'running');
    return this.conversations.presentationTranscript(id, running?.id);
  }

  /** The runtime's own transcript of the conversation's session (SPEC-001 A1, FR-28 evidence). */
  async sessionHistory(conversationId: string): Promise<Array<{ role: string; text: string }>> {
    const record = this.conversations.require(this.resolveConversationId(conversationId));
    const client = this.client();
    if (!record.attachment.sessionId || !client) return [];
    const history = await client.getHistory(record.attachment.sessionId);
    return Array.isArray(history.messages) ? history.messages : [];
  }

  /** One reconcile pass now (SPEC-001 FR-20); the loop also runs it on its own timer. */
  tick(): Promise<LifeTickReport> {
    return this.life.tick();
  }

  get lastTick(): LifeTickReport | null {
    return this.life.report;
  }

  private resolveConversationId(idOrAlias: string): string {
    if (idOrAlias === 'home') return this.conversations.home().id;
    return this.conversations.require(idOrAlias).id;
  }

  // ---- schedules (SPEC-001 FR-21, FR-24) ---------------------------------

  scheduleRecords(): ScheduleRecord[] {
    return [...this.schedules.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  createSchedule(input: CreateScheduleInput): ScheduleRecord {
    const conversationId = this.resolveConversationId(input.conversationId);
    const schedule = this.saveSchedule(buildSchedule({ ...input, conversationId }, this.now()));
    this.conversations.append(conversationId, {
      kind: 'system',
      origin: 'schedule',
      text: `Schedule created: ${describeSchedule(schedule)}. Next: ${schedule.nextAt}. Receipt: ${schedule.receipt}`,
    });
    this.log(`schedule ${schedule.id} created (${schedule.kind}, by ${schedule.createdBy})`);
    this.bus.emit({ type: 'conversation.updated', conversation: this.conversations.require(conversationId) });
    return schedule;
  }

  private cancelScheduleRecord(id: string): ScheduleRecord {
    const schedule = this.schedules.get(id);
    if (!schedule) throw new Error(`Unknown schedule ${id}`);
    // A fired occurrence still waiting in the queue or out a retry delay goes with the schedule.
    const dropped = this.dropPendingWork((item) => item.coalesceKey === id, 'schedule cancelled');
    if (schedule.state !== 'active' && dropped === 0) return schedule;
    const cancelled = this.saveSchedule({ ...schedule, state: 'cancelled', nextAt: null });
    if (this.conversations.get(cancelled.conversationId)) {
      this.conversations.append(cancelled.conversationId, {
        kind: 'system',
        origin: 'schedule',
        text: `Schedule cancelled: ${cancelled.id}. Receipt: ${cancelled.receipt}`,
      });
    }
    this.log(`schedule ${id} cancelled`);
    return cancelled;
  }

  async listSchedules(): Promise<ScheduleRecord[]> {
    return this.scheduleRecords().map((schedule) => structuredClone(schedule));
  }

  async cancelSchedule(scheduleId: string): Promise<void> {
    this.cancelScheduleRecord(scheduleId);
  }

  // ---- approvals (SPEC-001 FR-28, FR-30) ---------------------------------

  askOwner(conversationId: string, question: string): WorkItem {
    const id = this.resolveConversationId(conversationId);
    const item = createWorkItem({ kind: 'event', source: 'ask_owner', conversationId: id, prompt: question.trim() }, this.now());
    const waiting = this.record(transitionWorkItem(item, 'awaiting_owner', this.now(), {
      notification: { deliveredAt: this.now().toISOString(), seenAt: null },
    }));
    this.conversations.append(id, {
      kind: 'system',
      origin: 'event',
      text: `Approval needed (${waiting.id}): ${waiting.prompt}`,
      workItemId: waiting.id,
    });
    this.conversations.update(id, (record) => {
      record.unreadCount += 1;
    });
    this.bus.emit({ type: 'work.awaitingOwner', workItem: waiting });
    this.bus.emit({ type: 'conversation.updated', conversation: this.conversations.require(id) });
    this.log(`approval ${waiting.id} awaits the owner`);
    return waiting;
  }

  async resolveApproval(workItemId: string, decision: ApprovalDecision): Promise<void> {
    const item = this.workItems.get(workItemId);
    if (!item) throw new Error(`Unknown work item ${workItemId}`);
    if (item.state !== 'awaiting_owner') throw new Error(`Work item ${workItemId} is ${item.state}, not awaiting the owner`);
    const now = this.now();
    const answer = decision === 'approve' ? 'approved' : 'denied';
    if (item.source === 'recovery') {
      if (decision === 'approve') {
        this.record(transitionWorkItem(item, 'completed', now, { result: { text: `owner asked to rerun`, completedAt: now.toISOString() } }));
        // The rerun is not a message the owner sent, so it is not an owner-present turn (SPEC-006 BDC-05).
        await this.sendOwnerMessage(item.conversationId, item.prompt, 'recovery');
      } else {
        this.record(transitionWorkItem(item, 'cancelled', now, { error: 'owner declined to rerun the interrupted turn' }));
      }
      this.log(`approval ${item.id} ${answer} (recovery)`);
      return;
    }
    this.record(transitionWorkItem(item, 'completed', now, {
      result: { text: answer, completedAt: now.toISOString() },
      notification: { ...(item.notification ?? { deliveredAt: now.toISOString() }), seenAt: now.toISOString() },
    }));
    this.log(`approval ${item.id} ${answer}`);
    await this.sendOwnerMessage(item.conversationId, `Decision on your question "${item.prompt}": ${answer}.`);
  }

  private expireWorkItem(item: WorkItem, reason: string): void {
    this.record(transitionWorkItem(item, 'failed', this.now(), { error: reason }));
    this.conversations.append(item.conversationId, {
      kind: 'system',
      origin: 'event',
      text: `Approval ${item.id} expired: ${reason}.`,
      workItemId: item.id,
    });
    this.log(`approval ${item.id} expired`);
  }

  /** SPEC-001 FR-28: settle interrupted turns by runtime evidence, never by rerunning. */
  async recoverInterrupted(): Promise<void> {
    if (this.recovering || this.stopped) return;
    const client = this.client();
    if (!client) return;
    this.recovering = true;
    try {
      for (const item of this.listWorkItems()) {
        if (item.state !== 'interrupted') continue;
        const own = this.conversations.get(item.conversationId) ? this.conversations.transcript(item.conversationId) : [];
        const verdict = await reconcileInterrupted(item, client, own);
        const now = this.now();
        if (verdict.verdict === 'completed') {
          recordRecoveredReply(this.conversations, item, verdict.text);
          this.finish(this.record(transitionWorkItem(item, 'completed', now, {
            result: { text: verdict.text, completedAt: now.toISOString() },
            notification: { deliveredAt: now.toISOString(), seenAt: null },
          })));
          this.log(`recovery ${item.id}: completed by runtime evidence`);
        } else if (verdict.verdict === 'awaiting_owner' && item.source === 'bot') {
          // SPEC-009 FR-7: another bot's message is not the owner's to rerun; it ends, and the hub tells its sender.
          this.finish(this.record(transitionWorkItem(item, 'failed', now, {
            error: `the turn was interrupted (${verdict.evidence}) and is not run again`,
          })));
          this.log(`recovery ${item.id}: a message from another bot ended interrupted (${verdict.evidence})`);
        } else if (verdict.verdict === 'awaiting_owner') {
          const waiting = this.record(transitionWorkItem(item, 'awaiting_owner', now, {
            source: 'recovery',
            error: verdict.evidence,
            notification: { deliveredAt: now.toISOString(), seenAt: null },
          }));
          this.conversations.append(item.conversationId, {
            kind: 'system',
            origin: 'event',
            text: `Approval needed (${waiting.id}): the turn "${waiting.prompt.slice(0, 80)}" was interrupted (${verdict.evidence}). Approve to run it again, deny to drop it.`,
            workItemId: waiting.id,
          });
          this.bus.emit({ type: 'work.awaitingOwner', workItem: waiting });
          this.log(`recovery ${item.id}: awaiting the owner (${verdict.evidence})`);
        } else {
          this.log(`recovery ${item.id}: no verdict yet (${verdict.reason})`);
        }
      }
    } finally {
      this.recovering = false;
    }
  }

  // ---- BotHostApi -------------------------------------------------------

  async getProfile(): Promise<BotProfile> {
    return structuredClone(this.profile);
  }

  /**
   * SPEC-001 FR-27: a change to the target, instructions or permissions bumps
   * the revision and makes attachments of older revisions stale.
   */
  async updateProfile(patch: BotProfilePatch): Promise<BotProfile> {
    return this.changeProfile(() => applyProfilePatch(this.profile, patch, this.now()), patch);
  }

  /**
   * SPEC-008 FR-28: the hub's reply language and display language. A report
   * that changes the language this bot replies in moves its conversations to
   * new sessions with a handoff, like any other session setting.
   */
  async setHubLanguage(report: HubLanguageReport): Promise<void> {
    await this.changeProfile(() => applyHubLanguage(this.profile, report, this.now()), {});
  }

  /**
   * One profile change at a time. A change can wait on the runtime's session
   * controls, and a hub report arriving meanwhile must not be saved over.
   */
  private changeProfile(change: () => ProfileChange | null, patch: BotProfilePatch): Promise<BotProfile> {
    const next = this.profileChanges.then(() => this.runProfileChange(change, patch));
    this.profileChanges = next.catch(() => undefined);
    return next;
  }

  private async runProfileChange(change: () => ProfileChange | null, patch: BotProfilePatch): Promise<BotProfile> {
    if (!this.releaseLock) {
      const lock = acquireInstanceLock(this.paths);
      if (!lock.held) throw new BotInstanceRunningError(lock.owner);
      this.releaseLock = lock.release;
      try {
        const loaded = loadProfile(this.paths, this.profile, true);
        if (!loaded.ok) throw new Error('Profile upgrade failed; original data and backup were preserved.');
        this.profile = loaded.profile;
        return await this.runProfileChange(change, patch);
      } finally { this.releaseLock(); this.releaseLock = null; }
    }
    const result = change();
    if (!result) return structuredClone(this.profile);
    const policy = result.profile.providerPolicy;
    const client = this.client();
    // Refuse a ceiling the running provider cannot enforce now, not at the next session.
    if (policy && JSON.stringify(policy) !== JSON.stringify(this.profile.providerPolicy) && client
      && !result.providerChanged && this.runtimeState() === 'ready') {
      await client.sessionControls(result.profile.executionTarget.provider, policy);
    }
    const desktopWas = this.profile.desktopControl.enabled;
    saveProfile(this.paths, result.profile);
    this.profile = result.profile;
    if (this.profile.desktopControl.enabled !== desktopWas) {
      this.log(`desktop control ${this.profile.desktopControl.enabled ? 'enabled' : 'disabled'} in the profile`);
      this.desktop.profileChanged(this.profile.desktopControl.enabled);
    }
    if (result.sessionChanged) {
      this.journal({
        type: 'config',
        at: this.now().toISOString(),
        configRevision: this.profile.configRevision,
        executionTarget: this.profile.executionTarget,
      });
      const languageOnly = result.replyLanguageOnly;
      this.log(`config revision ${this.profile.configRevision}: ${
        result.targetChanged ? 'target' : languageOnly ? 'reply language' : 'session settings'} changed`);
      for (const conversation of this.conversations.list()) {
        const { attachment } = conversation;
        if (attachment.sessionId && !attachmentIsCurrent(conversation, this.profile) && attachment.state !== 'stale') {
          this.conversations.setAttachment(conversation.id, { state: 'stale' });
          this.conversations.append(conversation.id, {
            kind: 'system',
            origin: 'system',
            text: staleNotice(attachment, this.profile, languageOnly),
          });
          this.bus.emit({ type: 'conversation.updated', conversation: this.conversations.require(conversation.id) });
        }
      }
      if (result.providerChanged && this.supervisor && this.supervisor.state !== 'stopped') {
        // The private runtime only enables one provider; it is re-created for the new one once
        // the running turn has finished under the target it was admitted with (FR-27).
        this.runtimeSwapPending = true;
        if (this.running) this.log('provider changed: the runtime restarts once the running turn ends');
        this.pump();
      }
    }
    if (patch.heartbeat) {
      this.life.resetHeartbeatSchedule();
      this.log(`heartbeat ${this.profile.heartbeat.enabled ? 'enabled' : 'paused'}; next interval is re-drawn`);
    }
    if (patch.telegram) {
      await this.stopTelegram();
      this.startTelegram();
    }
    return structuredClone(this.profile);
  }

  async listConversations(): Promise<ConversationRecord[]> {
    return this.conversations.list().map((record) => structuredClone(record));
  }

  /** SPEC-002 FR-3: the CLI providers a settings page offers, with whether each command is on PATH. */
  listProviders(): ProviderInfo[] {
    return listProviders();
  }

  /**
   * SPEC-002 FR-3: the models of a provider. The running runtime answers for
   * the bot's own provider (it only enables that one); any other provider, or
   * a runtime that is not ready, falls back to the catalog the runtime package ships.
   */
  async listModels(provider: string): Promise<ModelCatalog> {
    const client = this.client();
    if (
      client &&
      provider === this.profile.executionTarget.provider &&
      this.runtimeState() === 'ready'
    ) {
      try {
        const catalog = await client.providerAdvancedModels(provider);
        const models = (catalog.entries ?? [])
          .filter((model) => typeof model.id === 'string' && model.id)
          .map((model) => ({
            ...model,
            id: model.id,
            label: model.label || model.id,
            default: model.default === true,
          }));
        if (models.length > 0) {
          return {
            provider,
            defaultModel: catalog.defaultModel ?? models.find((model) => model.default)?.id ?? null,
            models,
            source: 'runtime',
            catalogRevision: catalog.catalogRevision,
            controls: catalog.controls,
            defaultSelection: catalog.defaultSelection,
          };
        }
      } catch (error) {
        this.log(`model catalog for ${provider} from the runtime failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return readLocalModelCatalog(provider, this.paths.runtime);
  }

  /** SPEC-002 FR-5: a note's title is the owner's to choose; the home conversation keeps its role. */
  async renameConversation(conversationId: string, title: string): Promise<ConversationRecord> {
    const trimmed = title.trim();
    if (!trimmed) throw new Error('A title cannot be empty');
    const record = this.conversations.update(this.resolveConversationId(conversationId), (next) => {
      next.title = trimmed.slice(0, 80);
    });
    this.bus.emit({ type: 'conversation.updated', conversation: record });
    return structuredClone(record);
  }

  async createConversation(title?: string): Promise<ConversationRecord> {
    const record = this.conversations.create(
      title ?? `Conversation ${this.conversations.list().length}`,
    );
    this.bus.emit({ type: 'conversation.updated', conversation: record });
    return structuredClone(record);
  }

  /** SPEC-001 FR-14: close, delete the runtime session, then remove the record and transcript. */
  async deleteConversation(conversationId: string): Promise<void> {
    const record = this.conversations.require(conversationId);
    if (record.role === 'home') throw new Error('The direct message cannot be deleted');
    if (this.running?.item.conversationId === record.id) await this.cancelTurn(record.id);
    this.dropPendingWork((item) => item.conversationId === record.id, 'conversation deleted');
    for (const schedule of this.scheduleRecords()) {
      if (schedule.conversationId === record.id && schedule.state === 'active') {
        this.saveSchedule({ ...schedule, state: 'cancelled', nextAt: null });
      }
    }
    const client = this.client();
    if (record.attachment.sessionId && client) {
      await client.closeSession(record.attachment.sessionId).catch(() => undefined);
      await client.deleteSession(record.attachment.sessionId).catch(() => undefined);
    }
    try {
      this.desktop.forget(record.id);
    } catch (error) {
      this.log(`desktop control switch of deleted conversation ${record.id} kept: ${error instanceof Error ? error.message : 'error'}`);
    }
    this.conversations.remove(record.id);
    this.views.delete(record.id);
    this.focusedViews.delete(record.id);
    this.log(`conversation ${record.id} deleted`);
  }

  async openView(conversationId: string): Promise<void> {
    this.views.add(this.resolveConversationId(conversationId));
  }

  async closeView(conversationId: string): Promise<void> {
    const id = this.resolveConversationId(conversationId);
    this.views.delete(id);
    this.focusedViews.delete(id);
  }

  /** Whether the owner is reading a conversation's view; only then is a new reply already read. */
  async setViewFocused(conversationId: string, focused: boolean): Promise<void> {
    const id = this.resolveConversationId(conversationId);
    if (focused) this.focusedViews.add(id);
    else this.focusedViews.delete(id);
  }

  listViews(): string[] {
    return [...this.views];
  }

  /**
   * ADR-006: a provider CLI the host's setup found or installed. Runtime
   * launches after this find it on PATH without restarting the core.
   */
  useCommandDirectory(directory: string): void {
    const current = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
    process.env.PATH = [...new Set([directory, ...current])].join(delimiter);
  }

  async sendOwnerMessage(
    conversationId: string,
    text: string,
    source: 'owner' | 'telegram' | 'recovery' = 'owner',
    sourceRef?: string,
  ): Promise<WorkItem> {
    const id = this.resolveConversationId(conversationId);
    const prompt = text.trim();
    if (!prompt) throw new Error('An owner message needs text');
    const item: WorkItem = {
      ...createWorkItem({ kind: 'owner_message', source, conversationId: id, prompt }, this.now()),
      ...(sourceRef ? { sourceRef } : {}),
    };
    this.conversations.append(id, { kind: 'owner', origin: 'owner', text: prompt, workItemId: item.id });
    this.record(item);
    this.bus.emit({ type: 'conversation.updated', conversation: this.conversations.require(id) });
    this.queue.enqueue(item);
    this.pump();
    return structuredClone(item);
  }

  /** Enqueues a background work item (schedules, heartbeats and events use this). */
  enqueueWorkItem(item: WorkItem): WorkItem {
    if (!this.workItems.has(item.id)) this.record(item);
    this.queue.enqueue(item);
    this.pump();
    return item;
  }

  async cancelTurn(conversationId: string): Promise<void> {
    const id = this.resolveConversationId(conversationId);
    this.dropPendingWork(item => item.conversationId === id, 'cancelled by the owner');
    const running = this.running;
    if (!running || running.item.conversationId !== id) return;
    // A rejected send can still be unwinding while its work is deferred. It
    // owns no Runtime turn: cancelling it must not cancel the other turn.
    if (this.workItems.get(running.item.id)?.state !== 'running') return;
    this.log(`turn ${running.item.id} cancelled by the owner`);
    running.controller.abort();
    if (!this.admittedTurns.has(running.item.id)) return;
    const sessionId = running.item.run?.sessionId;
    const client = this.client();
    if (sessionId && client) {
        await client.cancelSession(sessionId).catch(() => undefined);
      }
  }

  async markSeen(conversationId: string): Promise<void> {
    const id = this.resolveConversationId(conversationId);
    const updated = this.conversations.update(id, (record) => {
      record.unreadCount = 0;
    });
    const seenAt = this.now().toISOString();
    for (const item of this.workItems.values()) {
      if (item.conversationId === id && item.notification && !item.notification.seenAt) {
        this.record({ ...item, notification: { ...item.notification, seenAt } });
      }
    }
    this.bus.emit({ type: 'conversation.updated', conversation: updated });
  }

  async quit(): Promise<void> {
    await this.stop();
  }

  // ---- queue ------------------------------------------------------------

  private runtimeSwitching(): boolean {
    return this.runtimeSwapPending || this.swappingRuntime;
  }

  /** FR-27: replace the runtime for the new provider; the queue waits until it is up. */
  private async swapRuntime(): Promise<void> {
    if (this.swappingRuntime || !this.supervisor) return;
    this.swappingRuntime = true;
    this.runtimeSwapPending = false;
    try {
      this.log('provider changed: restarting the runtime for the new selection');
      await this.supervisor.stop();
      if (this.stopped) return;
      this.supervisor = this.createSupervisor();
      await this.ensureRuntime();
    } finally {
      this.swappingRuntime = false;
      this.pump();
    }
  }

  /** Cancels queued and retry-delayed work matching `match`; returns how many items were dropped. */
  private dropPendingWork(match: (item: WorkItem) => boolean, reason: string): number {
    let dropped = 0;
    // Whoever waits for a dropped item hears that it ended, as the hub does for another bot's message (SPEC-009 FR-12).
    const cancel = (item: WorkItem) => {
      const cancelled = this.record(transitionWorkItem(item, 'cancelled', this.now(), { error: reason }));
      this.bus.emit({ type: 'turn.completed', conversationId: cancelled.conversationId, workItem: cancelled });
      dropped += 1;
    };
    for (const item of this.queue.list()) {
      if (!match(item)) continue;
      this.queue.remove(item.id);
      cancel(item);
    }
    for (const [id, entry] of [...this.deferred]) {
      const current = this.workItems.get(id) ?? entry.item;
      if (!match(current)) continue;
      clearTimeout(entry.timer);
      this.timers.delete(entry.timer);
      this.deferred.delete(id);
      if (current.state === 'queued') cancel(current);
    }
    return dropped;
  }

  /** FR-27: close a replaced session now, or after the turn still running in it. */
  private retireSession(sessionId: string): void {
    if (this.running?.item.run?.sessionId === sessionId) {
      this.retiring.add(sessionId);
      return;
    }
    this.retiring.delete(sessionId);
    const client = this.client();
    if (!client) return;
    this.log(`closing replaced session ${sessionId}`);
    void client.closeSession(sessionId).catch((error: unknown) => {
      this.log(`close of replaced session ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private pump(): void {
    for (const sessionId of [...this.retiring]) {
      if (this.running?.item.run?.sessionId !== sessionId) this.retireSession(sessionId);
    }
    if (this.running || this.stopped || !this.started || this.swappingRuntime) return;
    if (this.runtimeSwapPending) {
      void this.swapRuntime().catch((error: unknown) => this.log(`runtime swap failed: ${error instanceof Error ? error.message : 'error'}`));
      return;
    }
    // SPEC-006 BDC-09: while a desktop grant request waits for the owner, only owner messages
    // run (they sort first); heartbeats, schedules and events wait until it is answered or expires.
    if (this.desktop.pendingRequests() > 0 && this.queue.peek()?.kind !== 'owner_message') return;
    const item = this.queue.take();
    if (!item) return;
    const controller = new AbortController();
    this.running = { item, controller };
    void this.runItem(item, controller).finally(() => {
      this.admittedTurns.delete(item.id);
      try { this.interactions.end(item.id); }
      finally {
        if (this.running?.item.id === item.id) this.running = null;
        // SPEC-133 DC-11: the end of the turn releases the desktop control it held.
        this.desktop.turnEnded(item.conversationId, item.id);
        this.pump();
      }
    }).catch(() => this.log('turn finalization failed; provider interaction receipts may need recovery'));
  }

  private async runItem(queued: WorkItem, controller: AbortController): Promise<void> {
    const admitted = this.record(transitionWorkItem(queued, 'running', this.now(), {
      admittedAt: this.now().toISOString(),
      configRevision: this.profile.configRevision,
      attempts: queued.attempts + 1,
    }));
    if (this.running?.item.id === admitted.id) this.running = { item: admitted, controller };
    let outcome: TurnOutcome;
    try {
      outcome = await this.runner.run(admitted, controller);
    } catch (error) {
      outcome = { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
    }
    const now = this.now();
    const conversation = this.conversations.get(admitted.conversationId);
    const isHeartbeat = admitted.kind === 'heartbeat';
    switch (outcome.kind) {
      case 'completed': {
        const finished = this.record(transitionWorkItem(admitted, 'completed', now, {
          error: undefined,
          result: { text: outcome.text, completedAt: now.toISOString() },
          ...(outcome.text ? { notification: { deliveredAt: now.toISOString(), seenAt: null } } : {}),
          ...(admitted.run ? { run: admitted.run } : {}),
        }));
        if (conversation && outcome.text && !this.focusedViews.has(conversation.id)) {
          this.conversations.update(conversation.id, (record) => {
            record.unreadCount += 1;
          });
        }
        if (isHeartbeat) this.life.onHeartbeatResult(finished, outcome.quiet ? 'quiet' : 'spoke');
        this.finish(finished);
        break;
      }
      case 'failed': {
        const failed = this.record(transitionWorkItem(admitted, 'failed', now, {
          error: outcome.reason,
          ...(admitted.run ? { run: admitted.run } : {}),
        }));
        if (conversation && !isHeartbeat) {
          this.conversations.append(conversation.id, {
            kind: 'error',
            origin: 'system',
            text: outcome.reason,
            workItemId: failed.id,
            isError: true,
          });
        }
        if (isHeartbeat) this.life.onHeartbeatResult(failed, 'failed');
        this.finish(failed);
        break;
      }
      case 'interrupted': {
        const interrupted = this.record(transitionWorkItem(admitted, 'interrupted', now, {
          error: 'the turn ended without a result',
          ...(admitted.run ? { run: admitted.run } : {}),
        }));
        if (isHeartbeat) this.life.onHeartbeatResult(interrupted, 'failed');
        this.finish(interrupted);
        break;
      }
      case 'cancelled': {
        const cancelled = this.record(transitionWorkItem(admitted, 'cancelled', now, {
          ...(admitted.run ? { run: admitted.run } : {}),
        }));
        if (isHeartbeat) this.life.onHeartbeatResult(cancelled, 'failed');
        this.finish(cancelled);
        break;
      }
      case 'retry_later': {
        if (isHeartbeat) {
          // FR-25: the loop retries the same heartbeat later instead of keeping it queued.
          const dropped = this.record(transitionWorkItem(admitted, 'cancelled', now, { error: outcome.reason }));
          this.life.onHeartbeatResult(dropped, outcome.reason === 'session_busy' ? 'busy' : 'failed');
          break;
        }
        const waiting = this.record(transitionWorkItem(admitted, 'queued', now, {
          error: outcome.reason,
          ...(admitted.run ? { run: admitted.run } : {}),
        }));
        this.log(`turn ${waiting.id} deferred (${outcome.reason}) for ${outcome.retryAfterMs}ms`);
        const timer = this.schedule(outcome.retryAfterMs, () => {
          this.deferred.delete(waiting.id);
          // Cancelled, deleted or settled meanwhile: nothing to retry.
          const current = this.workItems.get(waiting.id);
          if (current?.state !== 'queued') return;
          this.queue.enqueue(current);
          this.pump();
        });
        this.deferred.set(waiting.id, { item: waiting, timer });
        break;
      }
      default:
        break;
    }
  }

  private finish(item: WorkItem): void {
    if (!isTerminalWorkState(item.state)) return;
    const conversation = this.conversations.get(item.conversationId);
    if (conversation) {
      this.bus.emit({ type: 'conversation.updated', conversation: this.conversations.require(conversation.id) });
      // FR-26: the home conversation is mirrored to Telegram, replies in order (FR-19).
      if (this.telegram && conversation.role === 'home' && item.state === 'completed' && item.result?.text) {
        void this.telegram.send(item.result.text);
      }
    }
    this.bus.emit({ type: 'turn.completed', conversationId: item.conversationId, workItem: item });
  }
}
