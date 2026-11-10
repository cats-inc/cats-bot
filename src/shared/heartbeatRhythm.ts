/**
 * SPEC-011 FR-3 to FR-6: a cat bot's daily rhythm, the same one Cats Desktop's
 * companion life follows (cats-platform SPEC-124 FR-4 to FR-6), so a bot and a
 * Desktop Cat with the same times wake and go to bed alike. All clock math is
 * host-local time: Cats Bot runs on the owner's machine, so its local day is
 * the owner's day. No renderer or Node imports: the settings page validates
 * with the same rules.
 *
 * Adapted from cats-platform `src/products/chat/companion/life/rhythm.ts` and
 * `profile.ts` at revision 6b0ece0 (MIT), per ADR-001 §1.
 */

/** Cats Desktop's defaults (its SPEC-124 FR-1). */
export const HEARTBEAT_RHYTHM_DEFAULTS = {
  bedtime: '23:00',
  wakeWindowStart: '07:00',
  wakeWindowEnd: '09:00',
} as const;

export interface HeartbeatRhythmTimes {
  bedtime: string;
  wakeWindowStart: string;
  wakeWindowEnd: string;
}

export type RhythmPhase = 'awake_hours' | 'rest_hours';

export interface HeartbeatRhythm {
  phase: RhythmPhase;
  /** Today's wake time. */
  wakeAt: Date;
  /** The next wake time strictly after `now`. */
  nextWakeAt: Date;
  /** The most recent bedtime at or before `now`. */
  restStartedAt: Date;
}

const CLOCK_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/u;

/** Minutes since local midnight for an `HH:MM` value, or null when malformed. */
export function parseClockMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = CLOCK_PATTERN.exec(value.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** A stored clock value, or the fallback when it is not `HH:MM`. */
export function clockOr(value: unknown, fallback: string): string {
  return parseClockMinutes(value) === null ? fallback : (value as string).trim();
}

/**
 * Cats Desktop's rule (its SPEC-124 FR-3): the wake window must not end before
 * it starts, and bedtime must fall outside it. Returns null when the times are fine.
 */
export function heartbeatRhythmProblem(times: HeartbeatRhythmTimes): string | null {
  const start = parseClockMinutes(times.wakeWindowStart);
  const end = parseClockMinutes(times.wakeWindowEnd);
  const bedtime = parseClockMinutes(times.bedtime);
  if (start === null || end === null || bedtime === null) return 'Times must be HH:MM';
  if (end < start || (bedtime >= start && bedtime <= end)) {
    return 'Check the times: bedtime must fall outside the wake window, and the window must not end before it starts.';
  }
  return null;
}

function clockMinutesOrDefault(value: string, fallback: string): number {
  return parseClockMinutes(value) ?? parseClockMinutes(fallback)!;
}

function localDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** FNV-1a: a stable, dependency-free spread for the daily wake offset. */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function atLocalMinutes(day: Date, minutes: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(minutes / 60), minutes % 60);
}

/** FR-4: the same bot wakes at the same minute all day, so a restart never re-rolls it. */
export function resolveWakeTime(times: HeartbeatRhythmTimes, botId: string, day: Date): Date {
  const start = clockMinutesOrDefault(times.wakeWindowStart, HEARTBEAT_RHYTHM_DEFAULTS.wakeWindowStart);
  const end = Math.max(start, clockMinutesOrDefault(times.wakeWindowEnd, HEARTBEAT_RHYTHM_DEFAULTS.wakeWindowEnd));
  const offset = hashString(`${botId}:${localDateKey(day)}`) % (end - start + 1);
  return atLocalMinutes(day, start + offset);
}

/** The most recent local bedtime at or before `now`. */
export function resolveRestStartedAt(bedtime: string, now: Date): Date {
  const today = atLocalMinutes(now, clockMinutesOrDefault(bedtime, HEARTBEAT_RHYTHM_DEFAULTS.bedtime));
  return today <= now
    ? today
    : new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, today.getHours(), today.getMinutes());
}

/** FR-5 / FR-6. */
export function resolveHeartbeatRhythm(times: HeartbeatRhythmTimes, botId: string, now: Date): HeartbeatRhythm {
  const wakeAt = resolveWakeTime(times, botId, now);
  const wakeMinutes = wakeAt.getHours() * 60 + wakeAt.getMinutes();
  const bedtime = clockMinutesOrDefault(times.bedtime, HEARTBEAT_RHYTHM_DEFAULTS.bedtime);
  const minutes = now.getHours() * 60 + now.getMinutes();
  // A bedtime at or before the wake minute means bedtime is after midnight.
  const awake = bedtime > wakeMinutes
    ? minutes >= wakeMinutes && minutes < bedtime
    : minutes >= wakeMinutes || minutes < bedtime;
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return {
    phase: awake ? 'awake_hours' : 'rest_hours',
    wakeAt,
    nextWakeAt: now < wakeAt ? wakeAt : resolveWakeTime(times, botId, tomorrow),
    restStartedAt: resolveRestStartedAt(times.bedtime, now),
  };
}
