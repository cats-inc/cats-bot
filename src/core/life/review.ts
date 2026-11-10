import { oneLine } from '../../shared/botText.ts';
import type { ConversationRecord, TranscriptEntry, WorkItem } from '../types.ts';
import { describeDuration } from './heartbeat.ts';

/**
 * SPEC-011 FR-13: what an `assist` heartbeat looks over. The bot reviews all
 * of its own recent conversations (its direct message and every note) and
 * follows up in its direct message. The newest get their last lines; once the
 * budget runs short the rest keep a heading and the owner's last line. The review is excerpts only, bounded, built by the
 * core without calling the model; another bot's conversations are never in it
 * (the Boss Cat's wider review is a later step).
 */

export const REVIEW_LOOKBACK_MS = 14 * 24 * 60 * 60_000;
export const REVIEW_LINES_PER_CONVERSATION = 6;
export const REVIEW_LINE_LIMIT = 240;
export const REVIEW_TEXT_LIMIT = 6_000;

export interface ReviewSource {
  record: ConversationRecord;
  transcript(): TranscriptEntry[];
}

export interface WorkReview {
  text: string;
  /**
   * What the review saw: the newest owner, reply or error line of each
   * conversation in it. An unchanged fingerprint means nothing happened since,
   * apart from the heartbeat's own messages.
   */
  fingerprint: string;
}

function speaker(entry: TranscriptEntry): string | null {
  switch (entry.kind) {
    case 'owner':
      // SPEC-009 FR-7: another bot's message is never shown as the owner's.
      return entry.origin === 'bot' ? `${oneLine(entry.from || 'Another bot', 40)} (another bot, not the owner)` : 'Owner';
    case 'bot':
      return entry.origin === 'heartbeat' ? 'You (unprompted)' : 'You';
    case 'error':
      return 'Error';
    default:
      return null;
  }
}

function renderLine(entry: TranscriptEntry): string | null {
  const who = speaker(entry);
  const text = oneLine(entry.text, REVIEW_LINE_LIMIT);
  return who && text ? `${who}: ${text}` : null;
}

function heading(record: ConversationRecord, index: number, now: Date): string {
  const where = record.role === 'home'
    ? 'Your direct message with your owner (this conversation)'
    : `Note "${oneLine(record.title, 80)}"`;
  const since = record.lastOwnerMessageAt
    ? describeDuration(Date.parse(record.lastOwnerMessageAt), now.getTime())
    : null;
  return `${index}. ${where}; your owner last wrote there ${since ? `${since} ago` : 'just now'}.`;
}

/**
 * Null when there is nothing to review: no conversation the owner wrote in
 * within the lookback and no question waiting for the owner.
 */
export function buildWorkReview(sources: ReviewSource[], awaitingOwner: WorkItem[], now: Date): WorkReview | null {
  const since = now.getTime() - REVIEW_LOOKBACK_MS;
  const recent = sources
    .filter((source) => {
      const at = Date.parse(source.record.lastOwnerMessageAt ?? '');
      return Number.isFinite(at) && at >= since;
    })
    .sort((a, b) => Date.parse(b.record.lastOwnerMessageAt!) - Date.parse(a.record.lastOwnerMessageAt!));
  if (recent.length === 0 && awaitingOwner.length === 0) return null;

  const blocks: string[] = [];
  const seen: string[] = [];
  let length = 0;
  let left = 0;
  recent.forEach((source, index) => {
    const entries = source.transcript();
    const lines = entries
      .map((entry) => ({ entry, line: renderLine(entry) }))
      .filter((item): item is { entry: TranscriptEntry; line: string } => item.line !== null);
    const own = lines.filter((item) => !(item.entry.kind === 'bot' && item.entry.origin === 'heartbeat'));
    seen.push(`${source.record.id}@${own.at(-1)?.entry.seq ?? 0}`);
    const title = heading(source.record, index + 1, now);
    const full = [title, ...lines.slice(-REVIEW_LINES_PER_CONVERSATION).map((item) => `   ${item.line}`)].join('\n');
    const lastOwner = lines.findLast((item) => item.entry.kind === 'owner');
    const short = lastOwner ? `${title}\n   ${lastOwner.line}` : title;
    const block = [full, short].find((candidate) => length + candidate.length + 1 <= REVIEW_TEXT_LIMIT);
    if (!block) {
      left += 1;
      return;
    }
    blocks.push(block);
    length += block.length + 1;
  });
  if (left > 0) blocks.push(`(${left} more conversation${left === 1 ? '' : 's'} with recent messages left out.)`);

  const waiting = awaitingOwner.length === 0
    ? []
    : [`${awaitingOwner.length === 1 ? 'One question you asked your owner is' : `${awaitingOwner.length} questions you asked your owner are`} still waiting for an answer.`];
  return {
    text: [
      ...(blocks.length > 0
        ? ['Your recent conversations with your owner, most recent first (excerpts; earlier parts are left out):', ...blocks]
        : []),
      ...waiting,
    ].join('\n'),
    fingerprint: [...seen, ...awaitingOwner.map((item) => item.id).sort()].join(','),
  };
}
