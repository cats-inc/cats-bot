/**
 * SPEC-001 FR-21: five-field cron expressions evaluated in an IANA time zone
 * by the core itself (the runtime's wakeups only speak UTC). Dependency-free:
 * zoned wall-clock fields come from `Intl.DateTimeFormat`.
 */

export interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  dayRestricted: boolean;
  weekdayRestricted: boolean;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const MINUTE_MS = 60_000;
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function parseField(field: string, min: number, max: number, names: readonly string[] = []): Set<number> {
  const values = new Set<number>();
  const resolve = (token: string): number => {
    const lowered = token.toLowerCase();
    const named = names.indexOf(lowered);
    if (named !== -1) return named + min;
    if (!/^\d+$/u.test(token)) throw new Error(`Invalid cron token "${token}"`);
    return Number(token);
  };
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step "${part}"`);
    let start: number;
    let end: number;
    if (rangePart === '*' || rangePart === undefined || rangePart === '') {
      start = min;
      end = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      start = resolve(a ?? '');
      end = resolve(b ?? '');
    } else {
      start = resolve(rangePart);
      end = stepPart === undefined ? start : max;
    }
    if (start < min || end > max || start > end) throw new Error(`Cron value out of range "${part}"`);
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

export function parseCron(expression: string): CronFields {
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== 5) throw new Error('A cron expression needs five fields: minute hour day month weekday');
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  const weekdays = parseField(weekday, 0, 7, DAY_NAMES);
  if (weekdays.has(7)) {
    weekdays.delete(7);
    weekdays.add(0);
  }
  return {
    minutes: parseField(minute, 0, 59),
    hours: parseField(hour, 0, 23),
    days: parseField(day, 1, 31),
    months: parseField(month, 1, 12, MONTH_NAMES),
    weekdays,
    dayRestricted: day !== '*',
    weekdayRestricted: weekday !== '*',
  };
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const parts: Record<string, string> = {};
  for (const part of formatterFor(timeZone).formatToParts(date)) {
    parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday ?? 'Sun'] ?? 0,
  };
}

/** The instant at which the given wall-clock time occurs in `timeZone`. */
export function wallClockToInstant(
  wall: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): Date {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const offsetAt = (instant: number): number => {
    const parts = zonedParts(new Date(instant), timeZone);
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - instant;
  };
  let instant = guess - offsetAt(guess);
  // One more pass settles a guess that landed across a DST shift.
  instant = guess - offsetAt(instant);
  return new Date(instant);
}

export function cronMatches(fields: CronFields, parts: ZonedParts): boolean {
  if (!fields.minutes.has(parts.minute) || !fields.hours.has(parts.hour) || !fields.months.has(parts.month)) {
    return false;
  }
  const dayOk = fields.days.has(parts.day);
  const weekdayOk = fields.weekdays.has(parts.weekday);
  if (fields.dayRestricted && fields.weekdayRestricted) return dayOk || weekdayOk;
  if (fields.dayRestricted) return dayOk;
  if (fields.weekdayRestricted) return weekdayOk;
  return true;
}

/** The first matching minute strictly after `after`, or null within the search bound. */
export function nextCronOccurrence(
  fields: CronFields,
  after: Date,
  timeZone: string,
  boundDays = 400,
): Date | null {
  const bound = after.getTime() + boundDays * 24 * 60 * MINUTE_MS;
  let instant = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let guard = 0; guard < 600_000 && instant <= bound; guard += 1) {
    const parts = zonedParts(new Date(instant), timeZone);
    if (!fields.months.has(parts.month)) {
      const next = parts.month === 12
        ? { year: parts.year + 1, month: 1, day: 1, hour: 0, minute: 0 }
        : { year: parts.year, month: parts.month + 1, day: 1, hour: 0, minute: 0 };
      instant = wallClockToInstant(next, timeZone).getTime();
      continue;
    }
    const dayOk = fields.days.has(parts.day);
    const weekdayOk = fields.weekdays.has(parts.weekday);
    const dayMatches = fields.dayRestricted && fields.weekdayRestricted
      ? dayOk || weekdayOk
      : fields.dayRestricted ? dayOk : fields.weekdayRestricted ? weekdayOk : true;
    if (!dayMatches) {
      const tomorrow = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) + 24 * 60 * MINUTE_MS);
      instant = wallClockToInstant({
        year: tomorrow.getUTCFullYear(),
        month: tomorrow.getUTCMonth() + 1,
        day: tomorrow.getUTCDate(),
        hour: 0,
        minute: 0,
      }, timeZone).getTime();
      continue;
    }
    if (!fields.hours.has(parts.hour)) {
      instant += (60 - parts.minute) * MINUTE_MS;
      continue;
    }
    if (!fields.minutes.has(parts.minute)) {
      instant += MINUTE_MS;
      continue;
    }
    return new Date(instant);
  }
  return null;
}
