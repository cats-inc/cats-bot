import { oneLine } from '../../shared/botText.ts';
import type { EffectiveHeartbeatMode, HeartbeatKind, HeartbeatPolicy } from '../types.ts';

/**
 * SPEC-001 FR-25 and SPEC-011: the heartbeat is one hidden turn in the home
 * conversation (the bot's direct message with its owner). The bot decides
 * whether to speak; `[quiet]` is dropped by the core. In `companion` mode it
 * keeps the owner company on a daily rhythm; in `assist` mode it looks over
 * its own recent conversations for work the owner left unfinished.
 *
 * Prompt shape and timing adapted from cats-platform
 * `src/products/chat/companion/life/heartbeat.ts` at revision 595e9ca (MIT),
 * per ADR-001 §1.
 */

export const HEARTBEAT_QUIET_TOKEN = '[quiet]';
export const HEARTBEAT_PROMPT_PREFIX = '[Cats heartbeat.';
/** FR-25: an owner message this recent defers the heartbeat. */
export const HEARTBEAT_QUIET_AFTER_OWNER_MS = 10 * 60_000;
export const HEARTBEAT_BUSY_RETRY_MS = 4 * 60_000;
export const HEARTBEAT_FAILED_RETRY_MS = 30 * 60_000;
/** SPEC-011 FR-7: a wake greeting only makes sense this soon after the day's wake time. */
export const HEARTBEAT_WAKE_WINDOW_MS = 3 * 60 * 60_000;
/** SPEC-011 FR-8: a good night only makes sense this soon after bedtime. */
export const HEARTBEAT_BEDTIME_WINDOW_MS = 60 * 60_000;
/**
 * SPEC-011 FR-10: each unprompted message the owner leaves unanswered doubles
 * the wait before the next; after this many in a row the heartbeat waits for
 * the owner to write.
 */
export const HEARTBEAT_MAX_UNANSWERED = 5;

const MINUTE_MS = 60_000;

/** SPEC-011 FR-10: the regular wait doubles with each unanswered message; wake waits do not. */
export function pickHeartbeatDelayMs(
  kind: HeartbeatKind,
  policy: HeartbeatPolicy,
  random: () => number,
  unanswered = 0,
): number {
  const [min, max] = kind === 'wake'
    ? [policy.wakeMinMinutes, policy.wakeMaxMinutes]
    : [policy.regularMinMinutes, policy.regularMaxMinutes];
  const span = Math.max(0, max - min);
  const factor = kind === 'wake' ? 1 : 2 ** Math.max(0, Math.min(unanswered, HEARTBEAT_MAX_UNANSWERED - 1));
  return Math.round((min + span * random()) * MINUTE_MS * factor);
}

export function describeDuration(fromMs: number, toMs: number): string | null {
  const minutes = Math.max(0, Math.round((toMs - fromMs) / MINUTE_MS));
  if (minutes < 1) return null;
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}

function describeLocalTime(now: Date): string {
  const date = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  return `${date}, ${hours}:${minutes}`;
}

export interface HeartbeatPromptInput {
  kind: HeartbeatKind;
  /** SPEC-011 FR-1; absent reads as `companion`. */
  mode?: EffectiveHeartbeatMode;
  now: Date;
  awakeSince: Date | null;
  /** The owner's latest message in any of this bot's conversations. */
  lastOwnerMessageAt: Date | null;
  botName: string;
  /** SPEC-011 FR-10: unprompted messages since the owner last wrote. */
  unanswered?: number;
  /** SPEC-011 FR-13: `assist` only, the excerpts of the bot's recent conversations. */
  review?: string | null;
}

function describeMoment(input: HeartbeatPromptInput): string {
  if (input.kind === 'wake') return 'You have just woken up for the day.';
  if (input.kind === 'bedtime') return 'It is your bedtime; you are about to go to sleep.';
  const awakeFor = input.awakeSince ? describeDuration(input.awakeSince.getTime(), input.now.getTime()) : null;
  return awakeFor ? `You have been awake for about ${awakeFor}.` : 'You are awake.';
}

function describeOwner(input: HeartbeatPromptInput): string {
  if (!input.lastOwnerMessageAt) return 'Your owner has not written to you yet.';
  const since = describeDuration(input.lastOwnerMessageAt.getTime(), input.now.getTime());
  return `Your owner last wrote to you ${since ? `${since} ago` : 'just now'}.`;
}

function describeUnanswered(unanswered: number): string | null {
  if (unanswered <= 0) return null;
  return unanswered === 1
    ? 'Your owner has not answered the last unprompted message you sent. Only speak again if it is worth it.'
    : `Your owner has not answered the last ${unanswered} unprompted messages you sent. Only speak again if it is clearly worth it.`;
}

export function buildHeartbeatPrompt(input: HeartbeatPromptInput): string {
  const name = oneLine(input.botName, 80);
  const unanswered = describeUnanswered(input.unanswered ?? 0);
  const facts = [
    `${HEARTBEAT_PROMPT_PREFIX} This is not a message from your owner, and your owner cannot see it.]`,
    `Local time: ${describeLocalTime(input.now)}.`,
    describeMoment(input),
    describeOwner(input),
    ...(unanswered ? [unanswered] : []),
  ];
  const closing = [
    'To remind yourself of something later, use your schedule tools; a promise in words alone does not schedule anything.',
    `If you would rather stay quiet, reply with exactly ${HEARTBEAT_QUIET_TOKEN} and nothing else.`,
  ];
  if (input.mode === 'assist') {
    return [
      ...facts,
      'This heartbeat is for helping your owner get their work done, not for small talk.',
      ...(input.review ? ['', input.review, ''] : []),
      'Look for something your owner asked for or started that is not finished: work you stopped part-way,',
      'a turn that failed or was interrupted, a question still waiting for an answer, or something they said',
      'they would come back to. If you find one, reply with only a short message (one to three sentences) that',
      'names it, suggests one concrete next step and offers to continue; name the note when it is in a note.',
      `Write it in your own voice as ${name}. It is sent to your owner exactly as you write it.`,
      'Do not start the work now, and do not repeat a suggestion you already made unless something changed.',
      `If nothing is unfinished, or you would only repeat yourself, reply with exactly ${HEARTBEAT_QUIET_TOKEN}.`,
      ...closing,
    ].join('\n');
  }
  return [
    ...facts,
    'If you feel like saying something to your owner right now (a greeting, a passing thought,',
    'something you noticed, a reminder you promised), reply with only that message, in your own',
    `voice as ${name}, one to three short sentences. It is sent to your owner exactly as you write it.`,
    'Do not repeat what you already said in an earlier unprompted message.',
    ...closing,
  ].join('\n');
}

export function isHeartbeatPrompt(prompt: string): boolean {
  return prompt.startsWith(HEARTBEAT_PROMPT_PREFIX);
}

export function parseHeartbeatReply(text: string): { quiet: true } | { quiet: false; body: string } {
  const body = text.trim();
  return body.length === 0 || body.toLowerCase() === HEARTBEAT_QUIET_TOKEN ? { quiet: true } : { quiet: false, body };
}
