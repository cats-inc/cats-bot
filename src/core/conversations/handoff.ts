import type { TranscriptEntry } from '../types.ts';

/**
 * SPEC-001 FR-12: what a new or replacement session receives about the
 * conversation so far. Short conversations travel verbatim; long ones become
 * a lossy digest of the older part plus the recent part verbatim. The result
 * never exceeds `limit` characters.
 */

export const HANDOFF_PACK_LIMIT = 12_000;
const RECENT_SHARE = 0.6;
const DIGEST_LINE_LIMIT = 160;

function speaker(entry: TranscriptEntry): string | null {
  switch (entry.kind) {
    case 'owner':
      // SPEC-009 FR-7: another bot's message is never handed on as the owner's.
      return entry.origin === 'bot'
        ? `${(entry.from || 'Another bot').replace(/\s+/gu, ' ').trim()} (another bot, not the owner)`
        : 'Owner';
    case 'bot':
      return entry.origin === 'heartbeat' ? 'You (unprompted)' : 'You';
    case 'system':
      return 'System';
    case 'error':
      return 'Error';
    default:
      return null;
  }
}

function renderLine(entry: TranscriptEntry): string | null {
  const who = speaker(entry);
  if (!who) return null;
  const text = entry.text.replace(/\s+/gu, ' ').trim();
  if (!text) return null;
  return `${who}: ${text}`;
}

function clip(line: string, limit: number): string {
  return line.length <= limit ? line : `${line.slice(0, Math.max(0, limit - 1))}…`;
}

export interface HandoffPack {
  text: string;
  /** Whether the older part was digested rather than copied. */
  lossy: boolean;
  /** Sequence number of the last transcript entry represented. */
  throughSeq: number;
}

export function buildHandoffPack(entries: TranscriptEntry[], limit: number = HANDOFF_PACK_LIMIT): HandoffPack {
  const lines = entries
    .map((entry) => ({ seq: entry.seq, line: renderLine(entry) }))
    .filter((item): item is { seq: number; line: string } => item.line !== null);
  const throughSeq = entries.at(-1)?.seq ?? 0;
  if (lines.length === 0) return { text: '', lossy: false, throughSeq };

  const header = 'Conversation so far, oldest first:';
  const verbatim = [header, ...lines.map((item) => item.line)].join('\n');
  if (verbatim.length <= limit) {
    return { text: verbatim, lossy: false, throughSeq };
  }

  // Recent part: as many trailing lines as fit the recent share, verbatim.
  const recentBudget = Math.floor(limit * RECENT_SHARE);
  const recent: string[] = [];
  let recentLength = 0;
  let index = lines.length - 1;
  for (; index >= 0; index -= 1) {
    const line = clip(lines[index]!.line, recentBudget);
    if (recentLength + line.length + 1 > recentBudget) break;
    recent.unshift(line);
    recentLength += line.length + 1;
  }
  // Older part: clipped lines, newest first until the remaining budget is spent.
  const digestHeader = 'Earlier, condensed (details were lost):';
  const recentHeader = 'Most recent, verbatim:';
  const olderBudget = limit - recentLength - header.length - digestHeader.length - recentHeader.length - 8;
  const older: string[] = [];
  let olderLength = 0;
  for (let olderIndex = index; olderIndex >= 0; olderIndex -= 1) {
    const line = clip(lines[olderIndex]!.line, DIGEST_LINE_LIMIT);
    if (olderLength + line.length + 1 > olderBudget) break;
    older.unshift(line);
    olderLength += line.length + 1;
  }
  const text = [header, digestHeader, ...older, '', recentHeader, ...recent].join('\n');
  return { text: text.length <= limit ? text : text.slice(0, limit), lossy: true, throughSeq };
}

/** Session bootstrap instructions: the persona first, then the handoff pack (FR-11). */
export function composeInstructions(persona: string, pack: HandoffPack): string {
  const trimmed = persona.trim();
  if (!pack.text) return trimmed;
  return trimmed ? `${trimmed}\n\n${pack.text}` : pack.text;
}
