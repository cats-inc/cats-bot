import { randomUUID } from 'node:crypto';

import type { MissedPolicy, ScheduleRecord } from '../types.ts';
import { hostTimeZone, isValidTimeZone, nextCronOccurrence, parseCron } from './cron.ts';

/**
 * SPEC-001 FR-21 / FR-22: durable schedules in the bot's journal. A schedule
 * exists only once its record was journaled; firing turns it into a work item
 * whose `coalesceKey` is the schedule id, and a gap of downtime is settled by
 * the schedule's missed policy.
 */

export const DEFAULT_GRACE_MINUTES = 1_440;
const MINUTE_MS = 60_000;

export interface CreateScheduleInput {
  conversationId: string;
  prompt: string;
  kind: 'once' | 'cron';
  at?: Date;
  cron?: string;
  timezone?: string;
  missedPolicy?: MissedPolicy;
  graceMinutes?: number;
  createdBy: 'owner' | 'agent';
}

export function createSchedule(input: CreateScheduleInput, now: Date): ScheduleRecord {
  const timezone = input.timezone?.trim() || hostTimeZone();
  if (!isValidTimeZone(timezone)) throw new Error(`Unknown time zone "${timezone}"`);
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error('A schedule needs a prompt');
  const id = `sch-${randomUUID().slice(0, 8)}`;
  const base = {
    id,
    conversationId: input.conversationId,
    timezone,
    prompt,
    graceMinutes: input.graceMinutes ?? DEFAULT_GRACE_MINUTES,
    createdBy: input.createdBy,
    receipt: `${id}@${now.toISOString()}`,
    state: 'active' as const,
    createdAt: now.toISOString(),
    lastFiredAt: null,
  };
  if (input.kind === 'once') {
    if (!input.at || Number.isNaN(input.at.getTime())) throw new Error('A one-time schedule needs a valid time');
    if (input.at.getTime() <= now.getTime()) throw new Error('A one-time schedule must be in the future');
    return {
      ...base,
      kind: 'once',
      at: input.at.toISOString(),
      missedPolicy: input.missedPolicy ?? 'run_once',
      nextAt: input.at.toISOString(),
    };
  }
  if (!input.cron) throw new Error('A recurring schedule needs a cron expression');
  const fields = parseCron(input.cron);
  const next = nextCronOccurrence(fields, now, timezone);
  if (!next) throw new Error('The cron expression never matches within the next year');
  return {
    ...base,
    kind: 'cron',
    cron: input.cron.trim(),
    missedPolicy: input.missedPolicy ?? 'coalesce',
    nextAt: next.toISOString(),
  };
}

export function nextOccurrenceAfter(schedule: ScheduleRecord, after: Date): Date | null {
  if (schedule.kind === 'once') {
    const at = schedule.at ? new Date(schedule.at) : null;
    return at && at.getTime() > after.getTime() ? at : null;
  }
  if (!schedule.cron) return null;
  return nextCronOccurrence(parseCron(schedule.cron), after, schedule.timezone);
}

export function isDue(schedule: ScheduleRecord, now: Date): boolean {
  return schedule.state === 'active' && schedule.nextAt !== null && Date.parse(schedule.nextAt) <= now.getTime();
}

/** The record after it fired at `firedAt`: `once` completes, `cron` re-arms. */
export function afterFiring(schedule: ScheduleRecord, firedAt: Date): ScheduleRecord {
  if (schedule.kind === 'once') {
    return { ...schedule, state: 'completed', lastFiredAt: firedAt.toISOString(), nextAt: null };
  }
  const next = nextOccurrenceAfter(schedule, firedAt);
  return {
    ...schedule,
    lastFiredAt: firedAt.toISOString(),
    nextAt: next ? next.toISOString() : null,
    ...(next ? {} : { state: 'completed' as const }),
  };
}

export type MissedDecision =
  | { action: 'none' }
  | { action: 'run'; occurrences: number; reason: 'coalesced' | 'within_grace' }
  | { action: 'skip'; occurrences: number; reason: 'policy_skip' | 'past_grace' };

/**
 * SPEC-001 FR-22: what to do with occurrences that fell inside a downtime gap
 * (`from`, `now`]. Never replays more than one run.
 */
export function settleMissed(schedule: ScheduleRecord, from: Date, now: Date): { schedule: ScheduleRecord; decision: MissedDecision } {
  if (schedule.state !== 'active' || schedule.nextAt === null) return { schedule, decision: { action: 'none' } };
  let occurrences = 0;
  let last: Date | null = null;
  let cursor: Date | null = new Date(schedule.nextAt);
  while (cursor && cursor.getTime() <= now.getTime() && occurrences < 10_000) {
    if (cursor.getTime() > from.getTime()) {
      occurrences += 1;
      last = cursor;
    }
    cursor = nextOccurrenceAfter(schedule, cursor);
  }
  if (occurrences === 0 || !last) return { schedule, decision: { action: 'none' } };
  const rearmed: ScheduleRecord = schedule.kind === 'once'
    ? { ...schedule, state: 'completed', nextAt: null, lastFiredAt: now.toISOString() }
    : { ...schedule, nextAt: cursor ? cursor.toISOString() : null, ...(cursor ? {} : { state: 'completed' as const }) };
  switch (schedule.missedPolicy) {
    case 'skip':
      return { schedule: rearmed, decision: { action: 'skip', occurrences, reason: 'policy_skip' } };
    case 'coalesce':
      return { schedule: { ...rearmed, lastFiredAt: now.toISOString() }, decision: { action: 'run', occurrences, reason: 'coalesced' } };
    case 'run_once':
    default: {
      const withinGrace = now.getTime() - last.getTime() <= schedule.graceMinutes * MINUTE_MS;
      return withinGrace
        ? { schedule: { ...rearmed, lastFiredAt: now.toISOString() }, decision: { action: 'run', occurrences, reason: 'within_grace' } }
        : { schedule: rearmed, decision: { action: 'skip', occurrences, reason: 'past_grace' } };
    }
  }
}

export function describeSchedule(schedule: ScheduleRecord): string {
  const when = schedule.kind === 'once'
    ? `once at ${schedule.at}`
    : `cron "${schedule.cron}" (${schedule.timezone})`;
  return `${schedule.id} ${when}: ${schedule.prompt}`;
}
