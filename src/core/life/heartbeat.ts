import type { HeartbeatKind, HeartbeatPolicy } from '../types.ts';

/**
 * SPEC-001 FR-25: the heartbeat is one hidden turn in the home conversation.
 * The bot decides whether to speak; `[quiet]` is dropped by the core.
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
/** A wake greeting only makes sense this soon after waking. */
export const HEARTBEAT_WAKE_WINDOW_MS = 3 * 60 * 60_000;

const MINUTE_MS = 60_000;

export function pickHeartbeatDelayMs(kind: HeartbeatKind, policy: HeartbeatPolicy, random: () => number): number {
  const [min, max] = kind === 'wake'
    ? [policy.wakeMinMinutes, policy.wakeMaxMinutes]
    : [policy.regularMinMinutes, policy.regularMaxMinutes];
  const span = Math.max(0, max - min);
  return Math.round((min + span * random()) * MINUTE_MS);
}

function describeDuration(fromMs: number, toMs: number): string | null {
  const minutes = Math.max(0, Math.round((toMs - fromMs) / MINUTE_MS));
  if (minutes < 1) return null;
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

function describeLocalTime(now: Date): string {
  const date = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  return `${date}, ${hours}:${minutes}`;
}

export interface HeartbeatPromptInput {
  kind: HeartbeatKind;
  now: Date;
  awakeSince: Date | null;
  lastOwnerMessageAt: Date | null;
  botName: string;
}

export function buildHeartbeatPrompt(input: HeartbeatPromptInput): string {
  const awakeFor = input.awakeSince ? describeDuration(input.awakeSince.getTime(), input.now.getTime()) : null;
  const sinceOwner = input.lastOwnerMessageAt
    ? describeDuration(input.lastOwnerMessageAt.getTime(), input.now.getTime())
    : null;
  return [
    `${HEARTBEAT_PROMPT_PREFIX} This is not a message from your owner, and your owner cannot see it.]`,
    `Local time: ${describeLocalTime(input.now)}.`,
    input.kind === 'wake'
      ? 'You have just woken up.'
      : awakeFor ? `You have been awake for about ${awakeFor}.` : 'You are awake.',
    input.lastOwnerMessageAt
      ? `Your owner last wrote to you ${sinceOwner ? `${sinceOwner} ago` : 'just now'}.`
      : 'Your owner has not written to you yet in this conversation.',
    'If you feel like saying something to your owner right now (a greeting, a passing thought,',
    'something you noticed, a reminder you promised), reply with only that message, in your own',
    `voice as ${input.botName}, one to three short sentences. It is sent to your owner exactly as you write it.`,
    'To remind yourself of something later, use your schedule tools; a promise in words alone does not schedule anything.',
    `If you would rather stay quiet, reply with exactly ${HEARTBEAT_QUIET_TOKEN} and nothing else.`,
  ].join('\n');
}

export function isHeartbeatPrompt(prompt: string): boolean {
  return prompt.startsWith(HEARTBEAT_PROMPT_PREFIX);
}

export function parseHeartbeatReply(text: string): { quiet: true } | { quiet: false; body: string } {
  const body = text.trim();
  return body.length === 0 || body.toLowerCase() === HEARTBEAT_QUIET_TOKEN ? { quiet: true } : { quiet: false, body };
}
