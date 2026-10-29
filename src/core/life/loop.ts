import type { SessionBinder } from '../conversations/binder.ts';
import type { ConversationStore } from '../conversations/store.ts';
import { createWorkItem } from '../queue/workItems.ts';
import { RuntimeHttpError, type RuntimeClient } from '../runtime/client.ts';
import type {
  BotHostEvent,
  BotProfile,
  HeartbeatKind,
  HeartbeatResult,
  JournalEntry,
  PresenceReason,
  PresenceState,
  RuntimeState,
  ScheduleRecord,
  WorkItem,
} from '../types.ts';
import {
  buildHeartbeatPrompt,
  HEARTBEAT_BUSY_RETRY_MS,
  HEARTBEAT_FAILED_RETRY_MS,
  HEARTBEAT_QUIET_AFTER_OWNER_MS,
  HEARTBEAT_WAKE_WINDOW_MS,
  pickHeartbeatDelayMs,
} from './heartbeat.ts';
import { afterFiring, isDue, settleMissed } from './schedules.ts';

/**
 * SPEC-001 FR-20 to FR-25: the reconcile tick. Every 60 seconds (5 seconds
 * after start), never overlapping and never calling the model itself, it
 * checks the runtime, settles and fires schedules, keeps the home
 * conversation's session alive by the runtime's own session status, applies
 * the idle policy to notes, and decides when the next heartbeat turn is due.
 *
 * Shape adapted from cats-platform `src/products/chat/companion/life/loop.ts`
 * at revision 595e9ca (MIT), per ADR-001 §1.
 */

export const LIFE_TICK_INTERVAL_MS = 60_000;
export const LIFE_STARTUP_DELAY_MS = 5_000;
export const LIFE_WAKE_BACKOFF_MS = 5 * 60_000;
export const AWAITING_OWNER_TIMEOUT_MS = 24 * 60 * 60_000;

export type LifeOutcome =
  | 'awake'
  | 'busy_turn'
  | 'resumed'
  | 'rebuilt'
  | 'wake_failed'
  | 'backoff'
  | 'runtime_unknown'
  | 'runtime_down';

export interface LifeState {
  lastTickAt: string | null;
}

export interface LifeTickReport {
  at: string;
  outcome: LifeOutcome;
  reason?: PresenceReason;
  firedSchedules: string[];
  settledSchedules: Array<{ id: string; action: 'run' | 'skip'; occurrences: number }>;
  heartbeat?: { kind: HeartbeatKind; action: 'queued' | 'deferred_owner' | 'deferred_turn' };
  sleptNotes: string[];
  expiredApprovals: string[];
  downtimeMs: number | null;
}

export interface LifeLoopDependencies {
  now(): Date;
  random(): number;
  profile(): BotProfile;
  conversations: ConversationStore;
  binder: SessionBinder;
  client(): RuntimeClient | null;
  runtimeState(): RuntimeState;
  ensureRuntime(): Promise<boolean>;
  isTurnRunning(conversationId?: string): boolean;
  hasQueuedWork(coalesceKey: string): boolean;
  enqueue(item: WorkItem): void;
  schedules(): ScheduleRecord[];
  saveSchedule(schedule: ScheduleRecord): void;
  awaitingOwner(): WorkItem[];
  expireWorkItem(item: WorkItem, reason: string): void;
  journal(entry: JournalEntry): void;
  emit(event: BotHostEvent): void;
  log(line: string): void;
  readLifeState(): LifeState | null;
  writeLifeState(state: LifeState): void;
  intervalMs?: number;
  startupDelayMs?: number;
  wakeBackoffMs?: number;
  awaitingOwnerTimeoutMs?: number;
  busyRetryMs?: number;
  failedRetryMs?: number;
}

interface HomeMemory {
  backoffUntil: number;
  failureRecorded: boolean;
  awakeSince: number | null;
  nextHeartbeatAt: number | null;
  heartbeatKind: HeartbeatKind;
  pendingHeartbeatId: string | null;
  wakeHeartbeatDone: boolean;
  catchUpUsed: boolean;
}

export class LifeLoop {
  private readonly deps: LifeLoopDependencies;
  private readonly memory: HomeMemory = {
    backoffUntil: 0,
    failureRecorded: false,
    awakeSince: null,
    nextHeartbeatAt: null,
    heartbeatKind: 'regular',
    pendingHeartbeatId: null,
    wakeHeartbeatDone: false,
    catchUpUsed: false,
  };
  private lastTickAt: number | null = null;
  private inFlight: Promise<LifeTickReport> | null = null;
  private stopped = false;
  private startupTimer: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastReport: LifeTickReport | null = null;

  constructor(deps: LifeLoopDependencies) {
    this.deps = deps;
    this.lastTickAt = deps.readLifeState()?.lastTickAt ? Date.parse(deps.readLifeState()!.lastTickAt!) : null;
    if (this.lastTickAt !== null && Number.isNaN(this.lastTickAt)) this.lastTickAt = null;
  }

  get report(): LifeTickReport | null {
    return this.lastReport;
  }

  get nextHeartbeatAt(): Date | null {
    return this.memory.nextHeartbeatAt === null ? null : new Date(this.memory.nextHeartbeatAt);
  }

  get awakeSince(): Date | null {
    return this.memory.awakeSince === null ? null : new Date(this.memory.awakeSince);
  }

  /** SPEC-001 FR-20: first pass shortly after start, then every minute, never overlapping. */
  start(): void {
    this.stopped = false;
    this.startupTimer = setTimeout(() => {
      void this.runTick();
    }, this.deps.startupDelayMs ?? LIFE_STARTUP_DELAY_MS);
    this.startupTimer.unref?.();
    this.timer = setInterval(() => {
      void this.runTick();
    }, this.deps.intervalMs ?? LIFE_TICK_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.timer) clearInterval(this.timer);
    this.startupTimer = null;
    this.timer = null;
  }

  get isIdle(): boolean {
    return this.inFlight === null;
  }

  private async runTick(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.tick();
    } catch (error) {
      this.deps.log(
        `tick failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
    }
  }

  /**
   * One pass now. A call made while a pass is running joins that pass instead
   * of starting another, so the timer, the CLI's tick and a test can never
   * reconcile the same session twice at once (one rebuild, not two).
   */
  tick(): Promise<LifeTickReport> {
    if (this.inFlight === null) {
      this.inFlight = this.pass().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async pass(): Promise<LifeTickReport> {
    const now = this.deps.now();
    const nowMs = now.getTime();
    const intervalMs = this.deps.intervalMs ?? LIFE_TICK_INTERVAL_MS;
    const previous = this.lastTickAt;
    const downtimeMs = previous !== null && nowMs - previous > 2 * intervalMs ? nowMs - previous : null;
    const report: LifeTickReport = {
      at: now.toISOString(),
      outcome: 'runtime_unknown',
      firedSchedules: [],
      settledSchedules: [],
      sleptNotes: [],
      expiredApprovals: [],
      downtimeMs,
    };
    if (downtimeMs !== null) this.deps.log(`tick: downtime of ${Math.round(downtimeMs / 1000)}s detected`);

    // Runtime first (FR-6): a dead runtime is restarted with its own backoff.
    let runtimeReady = this.deps.runtimeState() === 'ready';
    if (!runtimeReady) runtimeReady = await this.deps.ensureRuntime();

    this.settleSchedules(now, previous, downtimeMs, report);
    this.expireApprovals(now, report);

    if (!runtimeReady || !this.deps.client()) {
      report.outcome = 'runtime_down';
    } else {
      report.outcome = await this.reconcileHome(now, report);
      await this.sleepIdleNotes(now, report);
      this.planHeartbeat(now, downtimeMs, report);
    }

    this.lastTickAt = nowMs;
    this.deps.writeLifeState({ lastTickAt: now.toISOString() });
    this.lastReport = report;
    return report;
  }

  /** FR-21 / FR-22: fire due schedules; settle the ones a downtime gap swallowed. */
  private settleSchedules(now: Date, previous: number | null, downtimeMs: number | null, report: LifeTickReport): void {
    for (const schedule of this.deps.schedules()) {
      if (schedule.state !== 'active' || schedule.nextAt === null) continue;
      const nextAtMs = Date.parse(schedule.nextAt);
      if (downtimeMs !== null && previous !== null && nextAtMs <= now.getTime() && nextAtMs > previous) {
        const settled = settleMissed(schedule, new Date(previous), now);
        this.deps.saveSchedule(settled.schedule);
        if (settled.decision.action === 'run') {
          this.fire(schedule, now, report, `missed during downtime (${settled.decision.occurrences} occurrence(s), ${settled.decision.reason})`);
          report.settledSchedules.push({ id: schedule.id, action: 'run', occurrences: settled.decision.occurrences });
        } else if (settled.decision.action === 'skip') {
          this.deps.conversations.append(schedule.conversationId, {
            kind: 'system',
            origin: 'schedule',
            text: `Skipped ${settled.decision.occurrences} missed run(s) of schedule ${schedule.id} (${settled.decision.reason === 'past_grace' ? 'past its grace period' : 'policy: skip'}).`,
          });
          report.settledSchedules.push({ id: schedule.id, action: 'skip', occurrences: settled.decision.occurrences });
        }
        continue;
      }
      if (isDue(schedule, now)) {
        this.deps.saveSchedule(afterFiring(schedule, now));
        this.fire(schedule, now, report, 'due');
      }
    }
  }

  private fire(schedule: ScheduleRecord, now: Date, report: LifeTickReport, why: string): void {
    if (this.deps.hasQueuedWork(schedule.id)) {
      this.deps.log(`schedule ${schedule.id}: still queued, coalesced`);
      return;
    }
    const item = createWorkItem({
      kind: 'schedule',
      source: schedule.id,
      conversationId: schedule.conversationId,
      prompt: schedule.prompt,
      coalesceKey: schedule.id,
    }, now);
    this.deps.enqueue(item);
    this.deps.log(`schedule ${schedule.id}: queued as ${item.id} (${why})`);
    report.firedSchedules.push(schedule.id);
  }

  /** FR-30: an approval nobody answered times out with a reason. */
  private expireApprovals(now: Date, report: LifeTickReport): void {
    const timeoutMs = this.deps.awaitingOwnerTimeoutMs ?? AWAITING_OWNER_TIMEOUT_MS;
    for (const item of this.deps.awaitingOwner()) {
      const since = Date.parse(item.updatedAt);
      if (Number.isFinite(since) && now.getTime() - since > timeoutMs) {
        this.deps.expireWorkItem(item, 'no owner decision within the timeout');
        report.expiredApprovals.push(item.id);
      }
    }
  }

  /** FR-20: keep the home conversation's session alive by the runtime's own status. */
  private async reconcileHome(now: Date, report: LifeTickReport): Promise<LifeOutcome> {
    const home = this.deps.conversations.home();
    const client = this.deps.client()!;
    if (this.deps.isTurnRunning(home.id)) {
      this.memory.awakeSince ??= now.getTime();
      return 'busy_turn';
    }
    const { attachment } = home;
    let needsBind = true;
    if (attachment.sessionId && (attachment.state === 'ready' || attachment.state === 'initializing')) {
      try {
        const view = await client.getSession(attachment.sessionId);
        if (view.status === 'initializing' || view.status === 'ready' || view.status === 'busy') {
          needsBind = false;
          if (view.status === 'busy') return 'busy_turn';
        } else {
          // closing/closed: the provider session survives, so resume comes before a rebuild.
          this.deps.log(`home session ${attachment.sessionId} is ${view.status}`);
          this.deps.conversations.setAttachment(home.id, { state: 'sleeping' });
        }
      } catch (error) {
        if (error instanceof RuntimeHttpError && error.status === 404) {
          this.deps.log(`home session ${attachment.sessionId} is unknown to the runtime`);
          this.deps.conversations.setAttachment(home.id, { state: 'closed', lastError: error.message });
        } else {
          return 'runtime_unknown';
        }
      }
    }
    if (!needsBind) {
      this.memory.backoffUntil = 0;
      this.memory.failureRecorded = false;
      this.memory.awakeSince ??= now.getTime();
      return 'awake';
    }
    if (this.memory.backoffUntil > now.getTime()) return 'backoff';
    const bound = await this.deps.binder.bind(home.id);
    if (!bound.ok) {
      const reason: PresenceReason = bound.noCapacity
        ? 'no_capacity'
        : /runtime unavailable/iu.test(bound.reason) ? 'runtime_unavailable' : 'wake_failed';
      this.memory.backoffUntil = now.getTime() + (this.deps.wakeBackoffMs ?? LIFE_WAKE_BACKOFF_MS);
      if (!this.memory.failureRecorded) {
        this.memory.failureRecorded = true;
        this.presence(home.id, 'failed', reason, now);
      }
      report.reason = reason;
      return 'wake_failed';
    }
    this.memory.backoffUntil = 0;
    this.memory.failureRecorded = false;
    const firstWake = this.memory.awakeSince === null;
    this.memory.awakeSince ??= now.getTime();
    const reason: PresenceReason = bound.how === 'resumed' ? 'resumed' : 'rebuilt';
    this.presence(home.id, 'awake', reason, now);
    if (firstWake || this.memory.nextHeartbeatAt === null) this.scheduleFirstHeartbeat(now);
    report.reason = reason;
    return bound.how === 'resumed' ? 'resumed' : 'rebuilt';
  }

  private presence(conversationId: string, presence: PresenceState, reason: PresenceReason, now: Date): void {
    this.deps.journal({ type: 'presence', at: now.toISOString(), conversationId, presence, reason });
    this.deps.emit({ type: 'presence.changed', conversationId, presence, reason });
    this.deps.log(`presence ${presence} (${reason})`);
  }

  /** FR-13: notes that stayed quiet give their worker back; the session id is kept. */
  private async sleepIdleNotes(now: Date, report: LifeTickReport): Promise<void> {
    const client = this.deps.client();
    if (!client) return;
    const idleMs = this.deps.profile().idleSleepMinutes * 60_000;
    for (const note of this.deps.conversations.list()) {
      if (note.role !== 'note') continue;
      const { attachment } = note;
      if (!attachment.sessionId || (attachment.state !== 'ready' && attachment.state !== 'initializing')) continue;
      if (this.deps.isTurnRunning(note.id)) continue;
      const lastActivity = Math.max(
        Date.parse(attachment.updatedAt) || 0,
        Date.parse(note.lastOwnerMessageAt ?? '') || 0,
        Date.parse(note.lastBotMessageAt ?? '') || 0,
      );
      if (now.getTime() - lastActivity < idleMs) continue;
      try {
        await client.closeSession(attachment.sessionId);
        this.deps.conversations.setAttachment(note.id, { state: 'sleeping' });
        this.deps.log(`conversation ${note.id}: idle, session ${attachment.sessionId} closed`);
        report.sleptNotes.push(note.id);
      } catch (error) {
        this.deps.log(
          `conversation ${note.id}: idle close failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private scheduleHeartbeat(kind: HeartbeatKind, fromMs: number): void {
    this.memory.heartbeatKind = kind;
    this.memory.nextHeartbeatAt = fromMs + pickHeartbeatDelayMs(kind, this.deps.profile().heartbeat, this.deps.random);
  }

  /** FR-25: the first heartbeat after waking greets, unless the wake is already old. */
  private scheduleFirstHeartbeat(now: Date): void {
    const awakeSince = this.memory.awakeSince ?? now.getTime();
    const greetable = now.getTime() - awakeSince < HEARTBEAT_WAKE_WINDOW_MS && !this.memory.wakeHeartbeatDone;
    this.scheduleHeartbeat(greetable ? 'wake' : 'regular', now.getTime());
  }

  /** FR-23 / FR-25: decide whether a heartbeat turn is due now. */
  private planHeartbeat(now: Date, downtimeMs: number | null, report: LifeTickReport): void {
    const profile = this.deps.profile();
    const home = this.deps.conversations.home();
    const live = home.attachment.sessionId !== null
      && (home.attachment.state === 'ready' || home.attachment.state === 'initializing');
    if (!profile.heartbeat.enabled || !live) {
      return;
    }
    if (this.memory.pendingHeartbeatId !== null) return;
    if (this.memory.nextHeartbeatAt === null) {
      this.scheduleFirstHeartbeat(now);
    }
    if (downtimeMs !== null && this.memory.nextHeartbeatAt !== null && this.memory.nextHeartbeatAt < now.getTime() - downtimeMs) {
      // The machine slept past the heartbeat: at most one catch-up.
      if (this.memory.catchUpUsed) {
        this.scheduleHeartbeat('regular', now.getTime());
      } else {
        this.memory.catchUpUsed = true;
        this.memory.nextHeartbeatAt = now.getTime();
      }
    }
    if (this.memory.nextHeartbeatAt === null || now.getTime() < this.memory.nextHeartbeatAt) return;
    const lastOwnerAt = home.lastOwnerMessageAt ? Date.parse(home.lastOwnerMessageAt) : Number.NaN;
    if (Number.isFinite(lastOwnerAt) && now.getTime() - lastOwnerAt < HEARTBEAT_QUIET_AFTER_OWNER_MS) {
      this.scheduleHeartbeat('regular', lastOwnerAt + HEARTBEAT_QUIET_AFTER_OWNER_MS);
      report.heartbeat = { kind: this.memory.heartbeatKind, action: 'deferred_owner' };
      return;
    }
    if (this.deps.isTurnRunning()) {
      this.memory.nextHeartbeatAt = now.getTime() + (this.deps.busyRetryMs ?? HEARTBEAT_BUSY_RETRY_MS);
      report.heartbeat = { kind: this.memory.heartbeatKind, action: 'deferred_turn' };
      return;
    }
    const kind = this.memory.heartbeatKind;
    const item = createWorkItem({
      kind: 'heartbeat',
      source: `heartbeat:${kind}`,
      conversationId: home.id,
      prompt: buildHeartbeatPrompt({
        kind,
        now,
        awakeSince: this.memory.awakeSince === null ? null : new Date(this.memory.awakeSince),
        lastOwnerMessageAt: Number.isFinite(lastOwnerAt) ? new Date(lastOwnerAt) : null,
        botName: profile.name,
      }),
      coalesceKey: 'heartbeat',
    }, now);
    this.memory.pendingHeartbeatId = item.id;
    this.deps.enqueue(item);
    report.heartbeat = { kind, action: 'queued' };
    this.deps.log(`heartbeat ${kind} queued as ${item.id}`);
  }

  /** Called by the core when a heartbeat work item reached a terminal state (FR-25). */
  onHeartbeatResult(item: WorkItem, result: HeartbeatResult): void {
    if (this.memory.pendingHeartbeatId !== item.id && this.memory.pendingHeartbeatId !== null) return;
    this.memory.pendingHeartbeatId = null;
    const kind: HeartbeatKind = item.source === 'heartbeat:wake' ? 'wake' : 'regular';
    const nowMs = this.deps.now().getTime();
    this.deps.journal({ type: 'heartbeat', at: this.deps.now().toISOString(), kind, result });
    this.deps.log(`heartbeat ${kind} ${result}`);
    if (result === 'busy') {
      this.memory.nextHeartbeatAt = nowMs + (this.deps.busyRetryMs ?? HEARTBEAT_BUSY_RETRY_MS);
      this.memory.heartbeatKind = kind;
      return;
    }
    if (kind === 'wake' && (result === 'spoke' || result === 'quiet')) this.memory.wakeHeartbeatDone = true;
    if (result === 'failed') {
      this.memory.heartbeatKind = 'regular';
      this.memory.nextHeartbeatAt = nowMs + (this.deps.failedRetryMs ?? HEARTBEAT_FAILED_RETRY_MS);
      return;
    }
    this.scheduleHeartbeat('regular', nowMs);
  }

  /** FR-25: a changed heartbeat policy re-draws the next interval on the next tick. */
  resetHeartbeatSchedule(): void {
    this.memory.nextHeartbeatAt = null;
  }

  /** The home session went away (runtime exit): forget the awake state. */
  forgetAwake(): void {
    this.memory.awakeSince = null;
    this.memory.nextHeartbeatAt = null;
    this.memory.pendingHeartbeatId = null;
  }
}
