import { mkdirSync } from 'node:fs';

import { attachmentIsCurrent, SessionBinder, staleNotice } from './conversations/binder.ts';
import { ConversationStore } from './conversations/store.ts';
import { BotEventBus, type BotEventListener } from './host-api/events.ts';
import { LifeLoop, type LifeState, type LifeTickReport } from './life/loop.ts';
import { reconcileInterrupted, recordRecoveredReply } from './life/recovery.ts';
import { createSchedule as buildSchedule, describeSchedule, type CreateScheduleInput } from './life/schedules.ts';
import { createFileLogger, type Logger } from './log.ts';
import {
  applyProfilePatch,
  createProfile,
  loadProfile,
  saveProfile,
  type CreateProfileInput,
} from './profile/profile.ts';
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
import { botPathsFor, resolveBotRoot, type BotPaths } from './store/paths.ts';
import { createBotToolHandlers } from './tools/botTools.ts';
import { BotToolServer } from './tools/server.ts';
import type {
  ApprovalDecision,
  BotHostApi,
  BotHostEvent,
  BotProfile,
  BotProfilePatch,
  ConversationRecord,
  HandoffMessage,
  JournalEntry,
  RuntimeState,
  ScheduleRecord,
  WorkItem,
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
}

export interface BotStatus {
  id: string;
  name: string;
  root: string;
  runtime: { state: RuntimeState; pid: number | null };
  queue: { queued: number; running: WorkItem | null };
  conversations: number;
  schedules: number;
  heartbeat: { enabled: boolean; nextAt: string | null };
  lastTickAt: string | null;
  lock: InstanceLock | null;
  telegram: { enabled: boolean; polling: boolean; ownerChatId: number | null };
}

export class BotNotInitializedError extends Error {
  constructor(root: string) {
    super(`No bot profile at ${root}; run init first`);
    this.name = 'BotNotInitializedError';
  }
}

export class BotInstanceRunningError extends Error {
  readonly owner: InstanceLock;

  constructor(owner: InstanceLock) {
    super(`Another instance of this bot is running (pid ${owner.pid} since ${owner.startedAt})`);
    this.name = 'BotInstanceRunningError';
    this.owner = owner;
  }
}

export interface InitializeBotInput extends Omit<CreateProfileInput, 'cwd' | 'id'> {
  id: string;
  cwd?: string;
}

/** `cats-bot init`: writes the profile and the directory layout, never over an existing bot. */
export function initializeBot(
  botsHome: string,
  input: InitializeBotInput,
  env: NodeJS.ProcessEnv = process.env,
): { profile: BotProfile; root: string } {
  const root = resolveBotRoot(input.id, { ...env, CATS_BOTS_HOME: botsHome });
  const paths = botPathsFor(root);
  const placeholder = createProfile({ id: input.id, name: input.name, provider: input.provider, cwd: root });
  const existing = loadProfile(paths, placeholder);
  if (existing.ok) {
    throw new Error(`Bot ${input.id} already exists at ${root}`);
  }
  if (existing.reason === 'corrupt') {
    throw new Error(`Bot ${input.id} has a corrupt profile at ${paths.profile}: ${existing.error}`);
  }
  for (const dir of [paths.root, paths.conversations, paths.transcripts, paths.runtime, paths.logs, paths.workspace]) {
    mkdirSync(dir, { recursive: true });
  }
  const profile = createProfile({ ...input, cwd: input.cwd ?? paths.workspace });
  saveProfile(paths, profile);
  return { profile, root };
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
  private readonly conversations: ConversationStore;
  private readonly queue = new WorkQueue();
  private readonly workItems = new Map<string, WorkItem>();
  private readonly schedules = new Map<string, ScheduleRecord>();
  private readonly binder: SessionBinder;
  private readonly runner: TurnRunner;
  private readonly toolServer: BotToolServer | null;
  private readonly life: LifeLoop;
  private readonly secrets: SecretStore;
  private telegram: TelegramTransport | null = null;
  private supervisor: RuntimeSupervisor | null;
  private readonly views = new Set<string>();
  private readonly timers = new Set<NodeJS.Timeout>();
  /** Replaced sessions waiting for their running turn to end before they are closed (FR-27). */
  private readonly retiring = new Set<string>();
  private running: RunningTurn | null = null;
  private releaseLock: (() => void) | null = null;
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
    this.conversations = new ConversationStore({
      paths: this.paths,
      now: this.now,
      warn: (message) => this.log(`warn ${message}`),
    });
    // Read-only hosts (status, conversations, schedule list) see the records without starting anything.
    this.conversations.load();
    this.loadJournal();
    this.secrets = options.secrets ?? new FileSecretStore(this.paths.root, { warn: (line) => this.log(`warn ${line}`) });
    this.supervisor = options.runtimeClient ? null : this.createSupervisor();
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
    this.binder = new SessionBinder({
      client: () => this.client(),
      profile: () => this.profile,
      conversations: this.conversations,
      now: this.now,
      mcpServers: (conversationId) => this.mcpServersFor(conversationId),
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
      runtimeState: () => this.runtimeState(),
      ensureRuntime: () => this.ensureRuntime(),
      isTurnRunning: (conversationId) => this.isTurnRunning(conversationId),
      hasQueuedWork: (key) => this.queue.findByCoalesceKey(key) !== undefined || this.running?.item.coalesceKey === key,
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
    const paths = botPathsFor(options.root);
    const placeholder = createProfile({ id: 'bot', name: 'bot', provider: 'claude', cwd: paths.workspace });
    const loaded = loadProfile(paths, placeholder);
    if (!loaded.ok) {
      if (loaded.reason === 'missing') throw new BotNotInitializedError(options.root);
      throw new Error(`Corrupt profile at ${paths.profile}: ${loaded.error}`);
    }
    return new BotCore(options, loaded.profile);
  }

  private createSupervisor(): RuntimeSupervisor {
    const { options } = this;
    return new RuntimeSupervisor({
      runtimeDir: this.paths.runtime,
      providers: {
        provider: this.profile.executionTarget.provider,
        ...(options.runtime?.providerCommand ? { command: options.runtime.providerCommand } : {}),
        ...(options.runtime?.providerLaunchArgs ? { launchArgs: options.runtime.providerLaunchArgs } : {}),
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

  private mcpServersFor(conversationId: string): RuntimeMcpServer[] {
    return this.toolServer?.descriptorFor(conversationId) ?? [];
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
    this.started = true;
    const lock = acquireInstanceLock(this.paths);
    if (!lock.held) throw new BotInstanceRunningError(lock.owner);
    this.releaseLock = lock.release;
    this.log(`core start bot=${this.profile.id} pid=${process.pid}`);

    this.conversations.load();
    this.conversations.home();
    this.loadJournal();

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

    if (this.toolServer) {
      await this.toolServer.start();
      this.log('tool server listening on loopback');
    }
    await this.ensureRuntime();
    const pollMs = this.options.handoffPollMs ?? 1_500;
    this.handoffTimer = setInterval(() => this.drainHandoffs(), pollMs);
    this.handoffTimer.unref?.();
    this.life.start();
    this.startTelegram();
    this.pump();
  }

  // ---- Telegram (SPEC-001 FR-19, FR-26) ---------------------------------

  private startTelegram(): void {
    if (this.telegram || this.stopped || !this.started) return;
    if (!this.profile.telegram.enabled) return;
    const token = this.secrets.get(SECRET_TELEGRAM_TOKEN);
    if (!token) {
      this.log('telegram enabled but no token is stored; polling not started');
      return;
    }
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
        await this.sendOwnerMessage('home', message.text, 'telegram');
      },
    });
    this.telegram = transport;
    transport.start();
  }

  private async stopTelegram(): Promise<void> {
    const transport = this.telegram;
    this.telegram = null;
    if (transport) await transport.stop();
  }

  /** Stores (or clears) the token in the secret store; polling follows the profile flag. */
  async setTelegramToken(token: string | null): Promise<void> {
    if (token && token.trim()) this.secrets.set(SECRET_TELEGRAM_TOKEN, token.trim());
    else this.secrets.delete(SECRET_TELEGRAM_TOKEN);
    this.log(`telegram token ${token ? 'stored' : 'cleared'} (${this.secrets.protection()} protection)`);
    await this.stopTelegram();
    this.startTelegram();
  }

  /** Re-stores secrets a host without a cipher (the CLI) wrote, when this host has one. */
  protectSecretsAtRest(): number {
    const upgraded = this.secrets.protectAtRest();
    if (upgraded > 0) this.log(`re-stored ${upgraded} secret(s) with ${this.secrets.protection()} protection`);
    return upgraded;
  }

  /** `protection` is how the stored token is protected; without a token, what this host would use. */
  telegramStatus(): { enabled: boolean; tokenStored: boolean; protection: 'os' | 'file'; transport: TelegramStatus | null } {
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
      void this.recoverInterrupted();
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
      void this.ensureRuntime();
    });
  }

  private onRuntimeEvent(event: RuntimeSupervisorEvent): void {
    switch (event.type) {
      case 'state':
        this.bus.emit({ type: 'runtime.status', state: event.state, ...(event.detail ? { detail: event.detail } : {}) });
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
          this.protectSecretsAtRest();
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
    this.life.stop();
    await this.stopTelegram();
    if (this.handoffTimer) clearInterval(this.handoffTimer);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    const running = this.running;
    if (running) {
      running.controller.abort();
      const sessionId = running.item.run?.sessionId;
      const client = this.client();
      if (sessionId && client) {
        await client.cancelSession(sessionId).catch(() => undefined);
      }
    }
    if (this.supervisor) await this.supervisor.stop();
    if (this.toolServer) await this.toolServer.stop();
    this.releaseLock?.();
    this.releaseLock = null;
  }

  status(): BotStatus {
    return {
      id: this.profile.id,
      name: this.profile.name,
      root: this.paths.root,
      runtime: { state: this.runtimeState(), pid: this.supervisor?.pid ?? null },
      queue: { queued: this.queue.size, running: this.running?.item ?? null },
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

  listWorkItems(): WorkItem[] {
    return [...this.workItems.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getWorkItem(id: string): WorkItem | undefined {
    return this.workItems.get(id);
  }

  transcript(conversationId: string) {
    return this.conversations.transcript(this.resolveConversationId(conversationId));
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
    if (schedule.state !== 'active') return schedule;
    const cancelled = this.saveSchedule({ ...schedule, state: 'cancelled', nextAt: null });
    const queued = this.queue.findByCoalesceKey(id);
    if (queued) {
      this.queue.remove(queued.id);
      this.record(transitionWorkItem(queued, 'cancelled', this.now(), { error: 'schedule cancelled' }));
    }
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
        await this.sendOwnerMessage(item.conversationId, item.prompt);
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
        const verdict = await reconcileInterrupted(item, client);
        const now = this.now();
        if (verdict.verdict === 'completed') {
          recordRecoveredReply(this.conversations, item, verdict.text);
          this.finish(this.record(transitionWorkItem(item, 'completed', now, {
            result: { text: verdict.text, completedAt: now.toISOString() },
            notification: { deliveredAt: now.toISOString(), seenAt: null },
          })));
          this.log(`recovery ${item.id}: completed by runtime evidence`);
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
    const result = applyProfilePatch(this.profile, patch, this.now());
    this.profile = result.profile;
    saveProfile(this.paths, this.profile);
    if (result.sessionChanged) {
      this.journal({
        type: 'config',
        at: this.now().toISOString(),
        configRevision: this.profile.configRevision,
        executionTarget: this.profile.executionTarget,
      });
      this.log(`config revision ${this.profile.configRevision}: ${result.targetChanged ? 'target' : 'session settings'} changed`);
      for (const conversation of this.conversations.list()) {
        const { attachment } = conversation;
        if (attachment.sessionId && !attachmentIsCurrent(conversation, this.profile) && attachment.state !== 'stale') {
          this.conversations.setAttachment(conversation.id, { state: 'stale' });
          this.conversations.append(conversation.id, {
            kind: 'system',
            origin: 'system',
            text: staleNotice(attachment, this.profile),
          });
          this.bus.emit({ type: 'conversation.updated', conversation: this.conversations.require(conversation.id) });
        }
      }
      if (result.providerChanged && this.supervisor && this.supervisor.state !== 'stopped') {
        // The private runtime only enables one provider; it is re-created for the new one.
        this.log('provider changed: restarting the runtime for the new selection');
        void this.supervisor.stop().then(() => {
          if (this.stopped) return;
          this.supervisor = this.createSupervisor();
          return this.ensureRuntime();
        });
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

  async createConversation(title?: string): Promise<ConversationRecord> {
    const record = this.conversations.create(title ?? `Note ${this.conversations.list().length}`);
    this.bus.emit({ type: 'conversation.updated', conversation: record });
    return structuredClone(record);
  }

  /** SPEC-001 FR-14: close, delete the runtime session, then remove the record and transcript. */
  async deleteConversation(conversationId: string): Promise<void> {
    const record = this.conversations.require(conversationId);
    if (record.role === 'home') throw new Error('The home conversation cannot be deleted');
    if (this.running?.item.conversationId === record.id) await this.cancelTurn(record.id);
    for (const item of this.queue.list()) {
      if (item.conversationId === record.id) {
        this.queue.remove(item.id);
        this.record(transitionWorkItem(item, 'cancelled', this.now(), { error: 'conversation deleted' }));
      }
    }
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
    this.conversations.remove(record.id);
    this.views.delete(record.id);
    this.log(`conversation ${record.id} deleted`);
  }

  async openView(conversationId: string): Promise<void> {
    this.views.add(this.resolveConversationId(conversationId));
  }

  async closeView(conversationId: string): Promise<void> {
    this.views.delete(this.resolveConversationId(conversationId));
  }

  listViews(): string[] {
    return [...this.views];
  }

  async sendOwnerMessage(conversationId: string, text: string, source: 'owner' | 'telegram' = 'owner'): Promise<WorkItem> {
    const id = this.resolveConversationId(conversationId);
    const prompt = text.trim();
    if (!prompt) throw new Error('An owner message needs text');
    const item = createWorkItem({ kind: 'owner_message', source, conversationId: id, prompt }, this.now());
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
    const running = this.running;
    if (!running || running.item.conversationId !== id) return;
    this.log(`turn ${running.item.id} cancelled by the owner`);
    running.controller.abort();
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
    if (this.running || this.stopped || !this.started) return;
    const item = this.queue.take();
    if (!item) return;
    const controller = new AbortController();
    this.running = { item, controller };
    void this.runItem(item, controller).finally(() => {
      if (this.running?.item.id === item.id) this.running = null;
      this.pump();
    });
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
          result: { text: outcome.text, completedAt: now.toISOString() },
          ...(outcome.text ? { notification: { deliveredAt: now.toISOString(), seenAt: null } } : {}),
          ...(admitted.run ? { run: admitted.run } : {}),
        }));
        if (conversation && outcome.text && !this.views.has(conversation.id)) {
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
        if (conversation && outcome.reason === 'session_busy' && admitted.attempts === 1) {
          this.conversations.append(conversation.id, {
            kind: 'system',
            origin: 'system',
            text: 'Waiting: the session is still busy with another turn.',
            workItemId: waiting.id,
          });
        }
        this.log(`turn ${waiting.id} deferred (${outcome.reason}) for ${outcome.retryAfterMs}ms`);
        this.schedule(outcome.retryAfterMs, () => {
          this.queue.enqueue(waiting);
          this.pump();
        });
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
