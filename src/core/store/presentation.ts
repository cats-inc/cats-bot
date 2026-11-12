import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readConversationPresentation } from '@cats-inc/platform-ui-web/contracts';
import type { TranscriptEntry } from '../types.ts';
import type { BotPaths } from './paths.ts';
import { writeFileAtomic } from './atomicFile.ts';

interface PresentationFile { version: 1; conversationId: string; responses: TranscriptEntry[] }
function fileFor(paths: BotPaths, id: string): string {
  if (!/^[\w-]+$/u.test(id)) throw new Error('Invalid presentation conversation id');
  return join(paths.root, 'presentations', `${id}.json`);
}
function parse(text: string, id: string): PresentationFile {
  const data = JSON.parse(text) as PresentationFile;
  if (data.version !== 1) throw new Error('Unsupported conversation presentation version; file preserved');
  if (data.conversationId !== id || !Array.isArray(data.responses)) throw new Error('Invalid presentation envelope');
  const ids = new Set<string>();
  for (const entry of data.responses) {
    const presentation = readConversationPresentation(entry.presentation);
    if (!presentation || ids.has(presentation.id) || entry.kind !== 'bot'
      || !Number.isSafeInteger(entry.seq) || entry.seq < 1
      || typeof entry.at !== 'string' || !Number.isFinite(Date.parse(entry.at))
      || typeof entry.text !== 'string' || typeof entry.workItemId !== 'string'
      || !['owner', 'heartbeat', 'schedule', 'event', 'system'].includes(entry.origin)
      || !Number.isSafeInteger(entry.presentationRevision) || entry.presentationRevision! < 1
      || !Array.isArray(entry.presentationSeqs)
      || !entry.presentationSeqs.every(seq => Number.isSafeInteger(seq) && seq >= entry.seq)
      || (entry.presentationTerminalSeq !== undefined
        && (!Number.isSafeInteger(entry.presentationTerminalSeq) || entry.presentationTerminalSeq < entry.seq))) {
      throw new Error('Invalid conversation presentation record');
    }
    ids.add(presentation.id);
    entry.presentation = presentation;
  }
  return data;
}

/** Additive sidecar: old transcripts and old application rollback remain readable. */
export function readPresentations(paths: BotPaths, id: string): TranscriptEntry[] {
  const file = fileFor(paths, id);
  if (!existsSync(file)) return [];
  try { return parse(readFileSync(file, 'utf8'), id).responses; }
  catch (error) {
    // Never replace or hide a future format with an older backup.
    if (error instanceof Error && error.message.startsWith('Unsupported')) throw error;
    if (!existsSync(`${file}.bak`)) throw error;
    return parse(readFileSync(`${file}.bak`, 'utf8'), id).responses;
  }
}

export function savePresentation(paths: BotPaths, id: string, entry: TranscriptEntry): void {
  const file = fileFor(paths, id);
  if (existsSync(`${file}.bak`)) {
    try {
      const backup = JSON.parse(readFileSync(`${file}.bak`, 'utf8')) as { version?: unknown };
      if (backup.version !== 1) throw new Error('Unsupported conversation presentation backup version; file preserved');
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Unsupported')) throw error;
      // A corrupt backup may be replaced only from a validated primary below.
    }
  }
  const previous = readPresentations(paths, id);
  const next = previous.filter(value => value.presentation?.id !== entry.presentation?.id);
  next.push(entry);
  const bytes = JSON.stringify({ version: 1, conversationId: id, responses: next }) + '\n';
  parse(bytes, id);
  // Both replacements are atomic; a failed write preserves the previous valid generation.
  if (existsSync(file)) {
    const backup = JSON.stringify({ version: 1, conversationId: id, responses: previous }) + '\n';
    writeFileAtomic(`${file}.bak`, backup);
  }
  writeFileAtomic(file, bytes);
}

export function deletePresentations(paths: BotPaths, id: string): void {
  const file = fileFor(paths, id);
  rmSync(file, { force: true });
  rmSync(`${file}.bak`, { force: true });
}

/** Only hide rows that the sidecar explicitly covers and still belong to this execution. */
export function projectPresentationTranscript(
  entries: readonly TranscriptEntry[], responses: readonly TranscriptEntry[], runningWorkId?: string,
): TranscriptEntry[] {
  const hidden = new Set<number>();
  const projected: TranscriptEntry[] = [];
  for (const response of responses) {
    if (!response.presentation) continue;
    const terminal = entries.find(entry => entry.seq === response.presentationTerminalSeq
      && entry.kind === 'bot' && entry.workItemId === response.workItemId && entry.text === response.text);
    // Recovery may have fallen back to a snapshot predating finalization. The unchanged
    // original transcript is authoritative; an unbound partial must not repeat its final reply.
    if (!terminal && entries.some(entry => entry.kind === 'bot'
      && entry.workItemId === response.workItemId && entry.seq >= response.seq)) continue;
    for (const seq of response.presentationSeqs ?? []) {
      const original = entries.find(entry => entry.seq === seq && entry.workItemId === response.workItemId);
      if (original && ['tool_use', 'tool_result', 'progress', 'error'].includes(original.kind)) hidden.add(seq);
    }
    if (terminal) hidden.add(terminal.seq);
    const active = runningWorkId === response.workItemId;
    projected.push({ ...response,
      presentation: !active && response.presentation.phase !== 'sealed'
        ? { ...response.presentation, phase: 'sealed', blocks: response.presentation.blocks.map(block => (
            block.status === 'streaming' ? { ...block, status: 'error' } : block)) }
        : response.presentation,
    });
  }
  return [...entries.filter(entry => !hidden.has(entry.seq)), ...projected]
    .sort((a, b) => a.seq - b.seq);
}
