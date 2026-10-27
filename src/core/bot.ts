import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { ConversationStore } from './conversations/store.ts';
import { BotEventBus, type BotEventListener } from './host-api/events.ts';
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
import type { RuntimeClient, RuntimeMcpServer } from './runtime/client.ts';
import { RuntimeSupervisor, runtimeRestartDelayMs, type RuntimeSupervisorEvent } from './runtime/supervisor.ts';
import { appendJournal, readJournal } from './store/journal.ts';
import { acquireInstanceLock, readInstanceLock, takeHandoffs, type InstanceLock } from './store/lock.ts';
import { botPathsFor, resolveBotRoot, type BotPaths } from './store/paths.ts';
import type {
  BotHostApi,
  BotHostEvent,
  BotProfile,
  BotProfilePatch,
  ConversationRecord,
  JournalEntry,
  RuntimeState,
  ScheduleRecord,
  WorkItem,
} from './types.ts';

/**
 * The resident bot core (ADR-001 §2): owns the profile, conversations, the
 * work queue and journal, the runtime child and every timer. Hosts talk to it
 * only through `BotHostApi` and the event bus; it never imports Electron.
 */

export interface BotRuntimeOptions {
  nodeExecPath?: string;
  runtimeEntry?: string;
  providerCommand?: string;
  instanceExtras?: Record<string, string>;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface BotCoreOptions {
  root: string;
  now?: () => Date;
  fetch?: typeof fetch;
  runtime?: BotRuntimeOptions;
  log?: Logger;
  /** Tests may skip the runtime child and talk to this client instead. */
  runtimeClient?: RuntimeClient;
  /** SPEC-001 FR-24: the bot tool server descriptors handed to every session (Phase 2). */
  mcpServers?: () => RuntimeMcpServer[];
  handoffPollMs?: number;
  /** Tests shorten the SPEC-001 retry and restart delays; production keeps the defaults. */
  turnRetry?: Partial<TurnRetryDelays>;
  runtimeRestartDelaysMs?: number[];
}

export interface BotStatus {
  id: string;
  name: string;
  root: string;
  runtime: { state: RuntimeState; pid: number | null };
  queue: { queued: number; running: WorkItem | null };
  conversations: number;
  lock: InstanceLock | null;
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
  private readonly runner: TurnRunner;
  private supervisor: RuntimeSupervisor | null;
  private readonly views = new Set<string>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private running: RunningTurn | null = null;
  private releaseLock: (() => void) | null = null;
  private handoffTimer: NodeJS.Timeout | null = null;
  private runtimeAttempt = 0;
  private runtimeRestartTimer: NodeJS.Timeout | null = null;
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
    // Read-only hosts (status, conversations) see the records without starting anything.
    this.conversations.load();
    this.supervisor = options.runtimeClient
      ? null
      : new RuntimeSupervisor({
        runtimeDir: this.paths.runtime,
        providers: {
          provider: profile.executionTarget.provider,
          ...(options.runtime?.providerCommand ? { command: options.runtime.providerCommand } : {}),
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
    this.runner = new TurnRunner({
      client: () => this.client(),
      profile: () => this.profile,
      conversations: this.conversations,
      now: this.now,
      ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
      emit: (event) => this.bus.emit(event),
      log: this.log,
      ...(options.turnRetry ? { delays: options.turnRetry } : {}),
    });
  }

  private restartDelayMs(attempt: number): number {
    const custom = this.options.runtimeRestartDelaysMs;
    if (custom && custom.length > 0) {
      return custom[Math.min(attempt, custom.length - 1)]!;
    }
    return runtimeRestartDelayMs(attempt);
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

  private journal(entry: JournalEntry): void {
    appendJournal(this.paths, entry);
  }

  private record(item: WorkItem): WorkItem {
    this.workItems.set(item.id, item);
    this.journal({ type: 'work', at: this.now().toISOString(), item });
    this.bus.emit({ type: 'work.updated', workItem: item });
    return item;
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

  async start(): Promise<void> {
    if (this.started) throw new Error('Bot core already started');
    this.started = true;
    const lock = acquireInstanceLock(this.paths);
    if (!lock.held) throw new BotInstanceRunningError(lock.owner);
    this.releaseLock = lock.release;
    this.log(`core start bot=${this.profile.id} pid=${process.pid}`);

    this.conversations.load();
    this.conversations.home();

    // SPEC-001 FR-28: whatever was running when the core died is interrupted, never rerun.
    const journal = readJournal(this.paths);
    if (journal.corruptLines > 0) this.log(`warn journal has ${journal.corruptLines} unreadable line(s)`);
    const pending: WorkItem[] = [];
    for (const item of journal.workItems.values()) {
      this.workItems.set(item.id, item);
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

    await this.ensureRuntime();
    const pollMs = this.options.handoffPollMs ?? 1_500;
    this.handoffTimer = setInterval(() => this.drainHandoffs(), pollMs);
    this.handoffTimer.unref?.();
    this.pump();
  }

  /** SPEC-001 FR-6: start the runtime, or schedule the next attempt with backoff. */
  async ensureRuntime(): Promise<boolean> {
    if (!this.supervisor || this.stopped) return this.client() !== null;
    if (this.supervisor.state === 'ready' || this.supervisor.state === 'starting') return true;
    if (this.runtimeRestartTimer) {
      clearTimeout(this.runtimeRestartTimer);
      this.timers.delete(this.runtimeRestartTimer);
      this.runtimeRestartTimer = null;
    }
    this.journal({ type: 'runtime', at: this.now().toISOString(), event: 'started', detail: `attempt ${this.runtimeAttempt + 1}` });
    try {
      await this.supervisor.start();
      this.runtimeAttempt = 0;
      this.journal({ type: 'runtime', at: this.now().toISOString(), event: 'ready' });
      this.pump();
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.log(`runtime start failed: ${detail}`);
      this.scheduleRuntimeRestart();
      return false;
    }
  }

  private scheduleRuntimeRestart(): void {
    if (this.stopped || !this.supervisor || this.runtimeRestartTimer) return;
    const delay = this.restartDelayMs(this.runtimeAttempt);
    this.runtimeAttempt += 1;
    this.journal({ type: 'runtime', at: this.now().toISOString(), event: 'restart_scheduled', detail: `${delay}ms` });
    this.log(`runtime restart in ${delay}ms (attempt ${this.runtimeAttempt + 1})`);
    this.runtimeRestartTimer = this.schedule(delay, () => {
      this.runtimeRestartTimer = null;
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
        if (!event.expected) this.scheduleRuntimeRestart();
        break;
      case 'log':
        break;
      default:
        break;
    }
  }

  private drainHandoffs(): void {
    for (const message of takeHandoffs(this.paths)) {
      this.log(`handoff ${message.kind}`);
      this.bus.emit({ type: 'host.handoff', message });
      if (message.kind === 'say' && message.text) {
        void this.sendOwnerMessage(message.conversationId ?? 'home', message.text).catch((error: unknown) => {
          this.log(`handoff say failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.log('core stop');
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
      lock: readInstanceLock(this.paths),
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

  private resolveConversationId(idOrAlias: string): string {
    if (idOrAlias === 'home') return this.conversations.home().id;
    return this.conversations.require(idOrAlias).id;
  }

  // ---- BotHostApi -------------------------------------------------------

  async getProfile(): Promise<BotProfile> {
    return structuredClone(this.profile);
  }

  /** SPEC-001 FR-27: a target change bumps the revision and makes foreign attachments stale. */
  async updateProfile(patch: BotProfilePatch): Promise<BotProfile> {
    const result = applyProfilePatch(this.profile, patch, this.now());
    this.profile = result.profile;
    saveProfile(this.paths, this.profile);
    if (result.targetChanged) {
      this.journal({
        type: 'config',
        at: this.now().toISOString(),
        configRevision: this.profile.configRevision,
        executionTarget: this.profile.executionTarget,
      });
      this.log(`config revision ${this.profile.configRevision}: target changed`);
      for (const conversation of this.conversations.list()) {
        const { attachment } = conversation;
        const matches = attachment.provider === this.profile.executionTarget.provider
          && (attachment.model ?? null) === (this.profile.executionTarget.model ?? null);
        if (attachment.sessionId && !matches && attachment.state !== 'stale') {
          this.conversations.setAttachment(conversation.id, { state: 'stale' });
          this.conversations.append(conversation.id, {
            kind: 'system',
            origin: 'system',
            text: `The bot now runs on ${this.profile.executionTarget.provider}`
              + `${this.profile.executionTarget.model ? ` (${this.profile.executionTarget.model})` : ''}; `
              + 'this conversation continues in a new session with a handoff of what was said so far.',
          });
          this.bus.emit({ type: 'conversation.updated', conversation: this.conversations.require(conversation.id) });
        }
      }
      if (result.providerChanged && this.supervisor && this.supervisor.state !== 'stopped') {
        // The private runtime only enables one provider; it is re-created for the new one.
        this.log('provider changed: restarting the runtime for the new selection');
        void this.supervisor.stop().then(() => this.ensureRuntimeForProvider());
      }
    }
    return structuredClone(this.profile);
  }

  private async ensureRuntimeForProvider(): Promise<void> {
    if (!this.supervisor || this.stopped) return;
    const next = new RuntimeSupervisor({
      runtimeDir: this.paths.runtime,
      providers: {
        provider: this.profile.executionTarget.provider,
        ...(this.options.runtime?.providerCommand ? { command: this.options.runtime.providerCommand } : {}),
        ...(this.options.runtime?.instanceExtras ? { instanceExtras: this.options.runtime.instanceExtras } : {}),
      },
      ...(this.options.runtime?.nodeExecPath ? { nodeExecPath: this.options.runtime.nodeExecPath } : {}),
      ...(this.options.runtime?.runtimeEntry ? { runtimeEntry: this.options.runtime.runtimeEntry } : {}),
      ...(this.options.runtime?.env ? { env: this.options.runtime.env } : {}),
      ...(this.options.runtime?.readyTimeoutMs ? { readyTimeoutMs: this.options.runtime.readyTimeoutMs } : {}),
      ...(this.options.runtime?.stopTimeoutMs ? { stopTimeoutMs: this.options.runtime.stopTimeoutMs } : {}),
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      onEvent: (event) => this.onRuntimeEvent(event),
    });
    this.supervisor = next;
    await this.ensureRuntime();
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

  async sendOwnerMessage(conversationId: string, text: string): Promise<WorkItem> {
    const id = this.resolveConversationId(conversationId);
    const prompt = text.trim();
    if (!prompt) throw new Error('An owner message needs text');
    const item = createWorkItem({ kind: 'owner_message', source: 'owner', conversationId: id, prompt }, this.now());
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

  async listSchedules(): Promise<ScheduleRecord[]> {
    return [];
  }

  async cancelSchedule(scheduleId: string): Promise<void> {
    throw new Error(`Schedules are not available yet (${scheduleId})`);
  }

  async resolveApproval(workItemId: string, decision: 'approve' | 'deny'): Promise<void> {
    throw new Error(`Approvals are not available yet (${workItemId}: ${decision})`);
  }

  async quit(): Promise<void> {
    await this.stop();
  }

  // ---- queue ------------------------------------------------------------

  private pump(): void {
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
    switch (outcome.kind) {
      case 'completed': {
        const finished = this.record(transitionWorkItem(admitted, 'completed', now, {
          result: { text: outcome.text, completedAt: now.toISOString() },
          notification: { deliveredAt: now.toISOString(), seenAt: null },
          ...(admitted.run ? { run: admitted.run } : {}),
        }));
        if (conversation && outcome.text && !this.views.has(conversation.id)) {
          this.conversations.update(conversation.id, (record) => {
            record.unreadCount += 1;
          });
        }
        this.finish(finished);
        break;
      }
      case 'failed': {
        const failed = this.record(transitionWorkItem(admitted, 'failed', now, {
          error: outcome.reason,
          ...(admitted.run ? { run: admitted.run } : {}),
        }));
        if (conversation) {
          this.conversations.append(conversation.id, {
            kind: 'error',
            origin: 'system',
            text: outcome.reason,
            workItemId: failed.id,
            isError: true,
          });
        }
        this.finish(failed);
        break;
      }
      case 'interrupted':
        this.finish(this.record(transitionWorkItem(admitted, 'interrupted', now, {
          error: 'the turn ended without a result',
          ...(admitted.run ? { run: admitted.run } : {}),
        })));
        break;
      case 'cancelled':
        this.finish(this.record(transitionWorkItem(admitted, 'cancelled', now, {
          ...(admitted.run ? { run: admitted.run } : {}),
        })));
        break;
      case 'retry_later': {
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
    }
    this.bus.emit({ type: 'turn.completed', conversationId: item.conversationId, workItem: item });
  }
}
