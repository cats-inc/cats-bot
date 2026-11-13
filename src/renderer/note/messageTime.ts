import { languageSnapshot, t } from '../localeStore.ts';

/**
 * SPEC-003 FR-13: when a message was sent. A message shows its time to the minute; the transcript marks each
 * new day with a divider (Today, Yesterday, then the date), and the time's tooltip gives the full date and time.
 * These show whatever the live progress details and verbose messages switches say.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const locale = languageSnapshot().locale;
  const key = `${locale}|${JSON.stringify(options)}`;
  let cached = formatters.get(key);
  if (!cached) {
    cached = new Intl.DateTimeFormat(locale, options);
    formatters.set(key, cached);
  }
  return cached;
}

/** The time under a bubble: hours and minutes, "上午7:00" or "7:00 AM". */
export function messageTime(at: Date): string {
  return formatter({ hour: 'numeric', minute: '2-digit' }).format(at);
}

/**
 * The time's tooltip: the whole date and time, to the second. Spelled out field by field, so it says "上午"
 * like the bubble; Chinese `timeStyle` would say "清晨" or "凌晨" instead.
 */
export function messageTimestamp(at: Date): string {
  const time: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit', second: '2-digit' };
  if (languageSnapshot().locale.startsWith('zh')) {
    const date = formatter({ year: 'numeric', month: 'long', day: 'numeric' }).format(at);
    return `${date} ${formatter({ weekday: 'long' }).format(at)} ${formatter(time).format(at)}`;
  }
  return formatter({ year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', ...time }).format(at);
}

/** The local calendar day a message belongs to, for telling where a new day starts. */
export function dayKey(at: Date): string {
  return `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`;
}

// ---- The day clock: Today and Yesterday change at local midnight. Only the day dividers listen to it, so a
// note left open overnight relabels its dividers and nothing else in the transcript redraws.

/** The note's window and document, typed only as far as the day clock uses them (no DOM types in core tests). */
interface EventHost {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}
const host = globalThis as { window?: EventHost; document?: EventHost & { visibilityState?: string } };

let today = dayKey(new Date());
const dayListeners = new Set<() => void>();
let midnight: ReturnType<typeof setTimeout> | null = null;

/** Milliseconds from `now` to just after the next local midnight. */
export function msUntilNextDay(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1).getTime() - now.getTime();
}

/** Tells the listeners when the local day has changed since they last heard; a check on the same day is free. */
function checkDay(): void {
  const next = dayKey(new Date());
  if (next === today) return;
  today = next;
  for (const listener of dayListeners) listener();
}

function armMidnight(): void {
  midnight = setTimeout(() => {
    checkDay();
    armMidnight();
  }, msUntilNextDay(new Date()));
}

/** Waking from sleep can run a timer late: the day is checked again when the note is focused or shown. */
function onVisible(): void {
  if (host.document?.visibilityState !== 'hidden') checkDay();
}

/** `useSyncExternalStore` subscription for the current local day; one timer for the whole note. */
export function subscribeDay(listener: () => void): () => void {
  dayListeners.add(listener);
  if (dayListeners.size === 1) {
    checkDay();
    armMidnight();
    host.window?.addEventListener('focus', onVisible);
    host.document?.addEventListener('visibilitychange', onVisible);
  }
  return () => {
    dayListeners.delete(listener);
    if (dayListeners.size > 0) return;
    if (midnight) clearTimeout(midnight);
    midnight = null;
    host.window?.removeEventListener('focus', onVisible);
    host.document?.removeEventListener('visibilitychange', onVisible);
  };
}

/** The current local day, as the day clock last saw it. */
export function currentDayKey(): string {
  return today;
}

/** The divider's label for the day of `at`, seen on the day of `now`. */
export function dayLabel(at: Date, now: Date = new Date()): string {
  if (dayKey(at) === dayKey(now)) return t('Today');
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (dayKey(at) === dayKey(yesterday)) return t('Yesterday');
  const date: Intl.DateTimeFormatOptions = at.getFullYear() === now.getFullYear()
    ? { month: 'long', day: 'numeric' }
    : { year: 'numeric', month: 'long', day: 'numeric' };
  // Chinese runs the weekday into the date ("11月12日星期四"); a space reads better, as chat apps write it.
  if (languageSnapshot().locale.startsWith('zh')) {
    return `${formatter(date).format(at)} ${formatter({ weekday: 'long' }).format(at)}`;
  }
  return formatter({ ...date, weekday: 'long' }).format(at);
}
