import type { SessionBinder } from '../conversations/binder.ts';
import type { ConversationStore } from '../conversations/store.ts';
import { createWorkItem } from '../queue/workItems.ts';
import { RuntimeHttpError, type RuntimeClient } from '../runtime/client.ts';
import { resolveHeartbeatRhythm } from '../../shared/heartbeatRhythm.ts';
import type {
  BotHostEvent,
  BotProfile,
  EffectiveHeartbeatMode,
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
  HEARTBEAT_BEDTIME_WINDOW_MS,
  HEARTBEAT_BUSY_RETRY_MS,
  HEARTBEAT_FAILED_RETRY_MS,
  HEARTBEAT_MAX_UNANSWERED,
  HEARTBEAT_QUIET_AFTER_OWNER_MS,
  HEARTBEAT_WAKE_WINDOW_MS,
  pickHeartbeatDelayMs,
} from './heartbeat.ts';
import { buildWorkReview } from './review.ts';
import { afterFiring, isDue, settleMissed } from './schedules.ts';

/**
 * SPEC-001 FR-20 to FR-25: the reconcile tick. Every 60 seconds (5 seconds
 * after start), never overlapping and never calling the model itself, it
 * checks the runtime, settles and fires schedules, keeps the home
 * conversation's session alive by the runtime's own session status, applies
 * the idle policy to notes, and decides when the next heartbeat turn is due.
 * SPEC-011: the heartbeat follows the bot's daily rhythm and backs off while
 * the owner does not answer; that state is kept in `life.json`, so neither a
 * restart nor a reboot counts as the owner answering.
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

/** SPEC-011 FR-11: the heartbeat state that survives a restart. */
export interface HeartbeatState {
  nextAt: string | null;
  /** Unprompted messages since the owner last wrote, counted when they were sent. */
  unanswered: number;
  lastSpokeAt: string | null;
  /** The last completed wake and bedtime heartbeats: once per day each. */
  lastWakeAt: string | null;
  lastBedtimeAt: string | null;
  /** `assist`: the review fingerprint the last quiet review saw. */
  reviewedThrough: string | null;
}

export interface LifeState {
  lastTickAt: string | null;
  heartbeat?: HeartbeatState;
}

export type HeartbeatAction =
  | 'queued'
  | 'deferred_owner'
  | 'deferred_turn'
  | 'deferred_rest'
  | 'skipped_nothing_to_review'
  | 'waiting_for_owner';

export interface LifeTickReport {
  at: string;
  outcome: LifeOutcome;
  reason?: PresenceReason;
  firedSchedules: string[];
  settledSchedules: Array<{ id: string; action: 'run' | 'skip'; occurrences: number }>;
  heartbeat?: { kind: HeartbeatKind; action: HeartbeatAction };
  sleptNotes: string[];
  expiredApprovals: string[];
  downtimeMs: number | null;
}

export interface LifeLoopDependencies {
  now(): Date;
  random(): number;
  profile(): BotProfile;
  /** SPEC-011 FR-1: the profile's mode, with `auto` resolved by the Boss Cat role. */
  heartbeatMode(): EffectiveHeartbeatMode;
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
  pendingHeartbeatId: string | null;
  /** `assist`: the fingerprint of the review the pending heartbeat carries. */
  pendingReview: string | null;
  catchUpUsed: boolean;
  /** Whether this process has planned a heartbeat yet (SPEC-011 FR-11). */
  planned: boolean;
}

function emptyHeartbeatState(): HeartbeatState {
  return { nextAt: null, unanswered: 0, lastSpokeAt: null, lastWakeAt: null, lastBedtimeAt: null, reviewedThrough: null };
}

function isoOrNull(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

/** A missing or damaged record starts afresh, field by field. */
function readHeartbeatState(value: unknown): HeartbeatState {
  if (typeof value !== 'object' || value === null) return emptyHeartbeatState();
  const record = value as Record<string, unknown>;
  const unanswered = typeof record.unanswered === 'number' && Number.isFinite(record.unanswered)
    ? Math.max(0, Math.floor(record.unanswered)) : 0;
  return {
    nextAt: isoOrNull(record.nextAt),
    unanswered,
    lastSpokeAt: isoOrNull(record.lastSpokeAt),
    lastWakeAt: isoOrNull(record.lastWakeAt),
    lastBedtimeAt: isoOrNull(record.lastBedtimeAt),
    reviewedThrough: typeof record.reviewedThrough === 'string' ? record.reviewedThrough : null,
  };
}

function ms(value: string | null): number {
  const parsed = value === null ? Number.NaN : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

export class LifeLoop {
  private readonly deps: LifeLoopDependencies;
  private readonly memory: HomeMemory = {
    backoffUntil: 0,
    failureRecorded: false,
    awakeSince: null,
    pendingHeartbeatId: null,
    pendingReview: null,
    catchUpUsed: false,
    planned: false,
  };
  private beat: HeartbeatState;
  private lastTickAt: number | null = null;
  private inFlight: Promise<LifeTickReport> | null = null;
  private stopped = false;
  private startupTimer: NodeJS.Timeout | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastReport: LifeTickReport | null = null;

  constructor(deps: LifeLoopDependencies) {
    this.deps = deps;
    const state = deps.readLifeState();
    this.lastTickAt = state?.lastTickAt ? Date.parse(state.lastTickAt) : null;
    if (this.lastTickAt !== null && Number.isNaN(this.lastTickAt)) this.lastTickAt = null;
    this.beat = readHeartbeatState(state?.heartbeat);
  }

  get report(): LifeTickReport | null {
    return this.lastReport;
  }

  get nextHeartbeatAt(): Date | null {
    return this.beat.nextAt === null ? null : new Date(this.beat.nextAt);
  }

  /** SPEC-011 FR-12: what the status shows about the heartbeat. */
  heartbeatStatus(now: Date): { phase: 'awake_hours' | 'rest_hours'; unanswered: number; waitingForOwner: boolean } {
    const profile = this.deps.profile();
    const unanswered = this.unanswered();
    return {
      phase: resolveHeartbeatRhythm(profile.heartbeat, profile.id, now).phase,
      unanswered,
      waitingForOwner: profile.heartbeat.enabled && unanswered >= HEARTBEAT_MAX_UNANSWERED,
    };
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
    this.persist();
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
    this.memory.awakeSince ??= now.getTime();
    const reason: PresenceReason = bound.how === 'resumed' ? 'resumed' : 'rebuilt';
    this.presence(home.id, 'awake', reason, now);
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

  private persist(): void {
    this.deps.writeLifeState({
      lastTickAt: this.lastTickAt === null ? null : new Date(this.lastTickAt).toISOString(),
      heartbeat: { ...this.beat },
    });
  }

  /** The owner's latest message in any conversation; another bot's message is not the owner's. */
  private lastOwnerAt(): number {
    let latest = Number.NEGATIVE_INFINITY;
    for (const record of this.deps.conversations.list()) latest = Math.max(latest, ms(record.lastOwnerMessageAt));
    return latest;
  }

  /**
   * SPEC-011 FR-9: only a message from the owner answers; a restart, a reboot
   * or an opened window does not.
   */
  private unanswered(): number {
    if (this.beat.unanswered === 0) return 0;
    return this.lastOwnerAt() > ms(this.beat.lastSpokeAt) ? 0 : this.beat.unanswered;
  }

  /** The owner wrote after an unanswered message: back to the ordinary pace, re-drawn from now. */
  private noticeOwnerAnswer(): void {
    if (this.beat.unanswered > 0 && this.unanswered() === 0) {
      this.beat.unanswered = 0;
      this.beat.nextAt = null;
    }
  }

  private scheduleHeartbeat(kind: HeartbeatKind, fromMs: number): void {
    const delay = pickHeartbeatDelayMs(kind, this.deps.profile().heartbeat, this.deps.random, this.unanswered());
    this.beat.nextAt = new Date(fromMs + delay).toISOString();
  }

  /** SPEC-011 FR-7: a wake greeting once a day, soon after the day's wake time, while the owner answers. */
  private wakeGreetingDue(now: Date, wakeAt: Date): boolean {
    return this.unanswered() === 0
      && now.getTime() >= wakeAt.getTime()
      && now.getTime() - wakeAt.getTime() < HEARTBEAT_WAKE_WINDOW_MS
      && ms(this.beat.lastWakeAt) < wakeAt.getTime();
  }

  /** SPEC-011 FR-8: `companion` says good night once, soon after bedtime, if it was awake before it. */
  private bedtimeDue(now: Date, restStartedAt: Date, mode: EffectiveHeartbeatMode): boolean {
    return mode === 'companion'
      && this.unanswered() === 0
      && now.getTime() - restStartedAt.getTime() < HEARTBEAT_BEDTIME_WINDOW_MS
      && this.memory.awakeSince !== null && this.memory.awakeSince <= restStartedAt.getTime()
      && ms(this.beat.lastBedtimeAt) < restStartedAt.getTime();
  }

  /**
   * SPEC-011 FR-6: the first heartbeat of a stretch: soon after the wake time
   * when a greeting is due, at the next wake time during rest hours, and an
   * ordinary (backed-off) wait otherwise.
   */
  private scheduleFirstHeartbeat(now: Date): void {
    const profile = this.deps.profile();
    const rhythm = resolveHeartbeatRhythm(profile.heartbeat, profile.id, now);
    if (rhythm.phase === 'rest_hours') {
      this.scheduleHeartbeat('wake', rhythm.nextWakeAt.getTime());
    } else if (this.wakeGreetingDue(now, rhythm.wakeAt)) {
      this.scheduleHeartbeat('wake', now.getTime());
    } else {
      this.scheduleHeartbeat('regular', now.getTime());
    }
  }

  /** FR-23 / FR-25 and SPEC-011: decide whether a heartbeat turn is due now. */
  private planHeartbeat(now: Date, downtimeMs: number | null, report: LifeTickReport): void {
    const profile = this.deps.profile();
    const home = this.deps.conversations.home();
    const live = home.attachment.sessionId !== null
      && (home.attachment.state === 'ready' || home.attachment.state === 'initializing');
    if (!profile.heartbeat.enabled || !live) {
      return;
    }
    if (this.memory.pendingHeartbeatId !== null || this.deps.hasQueuedWork('heartbeat')) return;
    this.noticeOwnerAnswer();
    const unanswered = this.unanswered();
    if (unanswered >= HEARTBEAT_MAX_UNANSWERED) {
      // SPEC-011 FR-10: stopped until the owner writes; nothing is drawn meanwhile.
      this.beat.nextAt = null;
      report.heartbeat = { kind: 'regular', action: 'waiting_for_owner' };
      return;
    }
    const mode = this.deps.heartbeatMode();
    const rhythm = resolveHeartbeatRhythm(profile.heartbeat, profile.id, now);
    if (!this.memory.planned) {
      // SPEC-011 FR-11: a heartbeat that fell due while the app was closed waits the wake delay,
      // so nothing is said the moment the app starts.
      this.memory.planned = true;
      if (this.beat.nextAt !== null && ms(this.beat.nextAt) <= now.getTime()) this.scheduleHeartbeat('wake', now.getTime());
    }
    if (this.beat.nextAt === null) this.scheduleFirstHeartbeat(now);
    const nextAt = ms(this.beat.nextAt);
    if (downtimeMs !== null && nextAt < now.getTime() - downtimeMs) {
      // The machine slept past the heartbeat: at most one catch-up.
      if (this.memory.catchUpUsed) {
        this.scheduleHeartbeat('regular', now.getTime());
      } else {
        this.memory.catchUpUsed = true;
        this.beat.nextAt = now.toISOString();
      }
    }

    let kind: HeartbeatKind;
    if (rhythm.phase === 'rest_hours') {
      if (!this.bedtimeDue(now, rhythm.restStartedAt, mode)) {
        // SPEC-011 FR-5: nothing is said in rest hours; a due heartbeat waits for the next wake time.
        if (ms(this.beat.nextAt) <= now.getTime()) {
          this.scheduleHeartbeat('wake', rhythm.nextWakeAt.getTime());
          report.heartbeat = { kind: 'regular', action: 'deferred_rest' };
        }
        return;
      }
      kind = 'bedtime';
    } else {
      if (now.getTime() < ms(this.beat.nextAt)) return;
      kind = this.wakeGreetingDue(now, rhythm.wakeAt) ? 'wake' : 'regular';
    }

    const lastOwnerAt = this.lastOwnerAt();
    if (now.getTime() - lastOwnerAt < HEARTBEAT_QUIET_AFTER_OWNER_MS) {
      // An owner who is talking is not interrupted; a bedtime good night waits within its window,
      // and a good morning is not said late into a conversation (as on Desktop).
      if (kind === 'wake') this.beat.lastWakeAt = now.toISOString();
      if (kind !== 'bedtime') this.scheduleHeartbeat('regular', lastOwnerAt + HEARTBEAT_QUIET_AFTER_OWNER_MS);
      report.heartbeat = { kind, action: 'deferred_owner' };
      return;
    }
    if (this.deps.isTurnRunning()) {
      if (kind !== 'bedtime') this.beat.nextAt = new Date(now.getTime() + (this.deps.busyRetryMs ?? HEARTBEAT_BUSY_RETRY_MS)).toISOString();
      report.heartbeat = { kind, action: 'deferred_turn' };
      return;
    }

    let review: string | null = null;
    let fingerprint: string | null = null;
    if (mode === 'assist') {
      // SPEC-011 FR-13 / FR-14: no turn when there is nothing to look over, or nothing new since a quiet look.
      const built = buildWorkReview(
        this.deps.conversations.list().map((record) => ({
          record,
          transcript: () => this.deps.conversations.transcript(record.id),
        })),
        this.deps.awaitingOwner(),
        now,
      );
      if (!built || built.fingerprint === this.beat.reviewedThrough) {
        if (kind === 'wake') this.beat.lastWakeAt = now.toISOString();
        this.scheduleHeartbeat('regular', now.getTime());
        report.heartbeat = { kind, action: 'skipped_nothing_to_review' };
        this.deps.log(`heartbeat ${kind} skipped: ${built ? 'nothing new since the last review' : 'nothing to review'}`);
        return;
      }
      review = built.text;
      fingerprint = built.fingerprint;
    }

    const item = createWorkItem({
      kind: 'heartbeat',
      source: `heartbeat:${kind}`,
      conversationId: home.id,
      prompt: buildHeartbeatPrompt({
        kind,
        mode,
        now,
        awakeSince: this.memory.awakeSince === null ? null : new Date(this.memory.awakeSince),
        lastOwnerMessageAt: Number.isFinite(lastOwnerAt) ? new Date(lastOwnerAt) : null,
        botName: profile.name,
        unanswered,
        review,
      }),
      coalesceKey: 'heartbeat',
    }, now);
    this.memory.pendingHeartbeatId = item.id;
    this.memory.pendingReview = fingerprint;
    this.deps.enqueue(item);
    report.heartbeat = { kind, action: 'queued' };
    this.deps.log(`heartbeat ${mode} ${kind} queued as ${item.id}`);
  }

  /** Called by the core when a heartbeat work item reached a terminal state (FR-25). */
  onHeartbeatResult(item: WorkItem, result: HeartbeatResult): void {
    if (this.memory.pendingHeartbeatId !== item.id && this.memory.pendingHeartbeatId !== null) return;
    this.memory.pendingHeartbeatId = null;
    const review = this.memory.pendingReview;
    this.memory.pendingReview = null;
    const source = item.source.replace(/^heartbeat:/u, '');
    const kind: HeartbeatKind = source === 'wake' || source === 'bedtime' ? source : 'regular';
    const now = this.deps.now();
    const nowMs = now.getTime();
    this.deps.journal({ type: 'heartbeat', at: now.toISOString(), kind, result });
    this.deps.log(`heartbeat ${kind} ${result}`);
    if (result === 'busy') {
      this.beat.nextAt = new Date(nowMs + (this.deps.busyRetryMs ?? HEARTBEAT_BUSY_RETRY_MS)).toISOString();
      this.persist();
      return;
    }
    if (result === 'failed') {
      this.beat.nextAt = new Date(nowMs + (this.deps.failedRetryMs ?? HEARTBEAT_FAILED_RETRY_MS)).toISOString();
      this.persist();
      return;
    }
    if (kind === 'wake') this.beat.lastWakeAt = now.toISOString();
    if (kind === 'bedtime') this.beat.lastBedtimeAt = now.toISOString();
    if (result === 'spoke' && kind !== 'bedtime') {
      // SPEC-011 FR-9 / FR-10: one more message the owner has not answered yet; a good night
      // goes out as the owner leaves and expects no answer.
      this.beat.unanswered = this.unanswered() + 1;
      this.beat.lastSpokeAt = now.toISOString();
    } else if (review !== null) {
      this.beat.reviewedThrough = review;
    }
    if (this.beat.unanswered >= HEARTBEAT_MAX_UNANSWERED) {
      this.beat.nextAt = null;
      this.deps.log(`heartbeat waits for the owner: ${this.beat.unanswered} unprompted messages unanswered`);
    } else {
      this.scheduleHeartbeat('regular', nowMs);
    }
    this.persist();
  }

  /**
   * FR-25: a changed heartbeat policy re-draws the next interval on the next
   * tick. SPEC-011 FR-10: turning the heartbeat back on is the owner asking
   * for it, so the unanswered count starts over.
   */
  resetHeartbeatSchedule(options: { resumed?: boolean } = {}): void {
    this.beat.nextAt = null;
    if (options.resumed) {
      this.beat.unanswered = 0;
      this.beat.reviewedThrough = null;
    }
    this.persist();
  }

  /** The home session went away (runtime exit): forget the awake state; the durable schedule stays. */
  forgetAwake(): void {
    this.memory.awakeSince = null;
    this.memory.pendingHeartbeatId = null;
    this.memory.pendingReview = null;
  }
}
