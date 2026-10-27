import type { TranscriptEntry } from '../types.ts';
import { appendJsonLine, readJsonLines } from './atomicFile.ts';
import { transcriptFile, type BotPaths } from './paths.ts';

/** SPEC-001 FR-12: the bot keeps its own transcript, independent of the provider. */

export function readTranscript(paths: BotPaths, conversationId: string): TranscriptEntry[] {
  return readJsonLines<TranscriptEntry>(transcriptFile(paths, conversationId)).entries;
}

export function appendTranscript(paths: BotPaths, conversationId: string, entry: TranscriptEntry): void {
  appendJsonLine(transcriptFile(paths, conversationId), entry);
}

export function lastTranscriptSeq(paths: BotPaths, conversationId: string): number {
  const entries = readTranscript(paths, conversationId);
  const last = entries.at(-1);
  return last ? last.seq : 0;
}
