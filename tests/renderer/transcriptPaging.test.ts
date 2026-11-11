import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TranscriptEntry, TranscriptPage } from '../../src/core/types.ts';
import {
  addEntry,
  entriesWithinNewest,
  localEntry,
  mergeTranscriptEntries,
  newestStoredSeq,
  readNewestPages,
  visibleEntries,
} from '../../src/renderer/note/transcript.ts';

/**
 * SPEC-014 FR-10: the note reads the newest page, older ones as the owner scrolls up, and
 * the newest ones again after a turn, back to what it already holds.
 */

function entry(
  seq: number,
  kind: TranscriptEntry['kind'] = 'owner',
  extra: Partial<TranscriptEntry> = {},
): TranscriptEntry {
  return {
    seq,
    at: '2026-11-12T01:02:03.000Z',
    kind,
    text: `entry ${seq}`,
    origin: 'owner',
    ...extra,
  };
}

function streaming(revision: number, phase: 'streaming' | 'sealed' = 'streaming'): TranscriptEntry {
  return entry(41, 'bot', {
    text: `reply at revision ${revision}`,
    workItemId: 'w-live',
    presentationRevision: revision,
    presentationSeqs: [41],
    ...(phase === 'sealed' ? { presentationTerminalSeq: 42 } : {}),
    presentation: { version: 1, id: 'w-live:execution', phase, blocks: [] },
  });
}

/** A conversation of `count` entries read a page of `size` at a time, newest first. */
function pagesOf(count: number, size: number) {
  const reads: Array<number | undefined> = [];
  const read = async (beforeSeq?: number): Promise<TranscriptPage> => {
    reads.push(beforeSeq);
    const upper = beforeSeq ?? count + 1;
    const floor = Math.max(1, upper - size);
    const entries = Array.from({ length: upper - floor }, (_, index) => entry(floor + index));
    return { entries, olderBeforeSeq: floor > 1 ? floor : null };
  };
  return { read, reads };
}

test('the newest pages are read back to what the note holds, or once when it holds nothing', async () => {
  const first = pagesOf(250, 100);
  assert.deepEqual(
    await readNewestPages(first.read, null).then((pages) => ({
      seqs: [pages.entries[0]!.seq, pages.entries.at(-1)!.seq],
      olderBeforeSeq: pages.olderBeforeSeq,
      joined: pages.joined,
    })),
    { seqs: [151, 250], olderBeforeSeq: 151, joined: true },
  );
  assert.deepEqual(first.reads, [undefined]);

  // 120 entries came while the note held up to 130: two pages reach it.
  const later = pagesOf(250, 100);
  const pages = await readNewestPages(later.read, 130);
  assert.deepEqual(later.reads, [undefined, 151]);
  assert.deepEqual(
    [pages.entries[0]!.seq, pages.entries.at(-1)!.seq, pages.entries.length],
    [51, 250, 200],
  );
  assert.equal(pages.joined, true);
  // A page that starts just after the newest entry held joins it.
  assert.equal((await readNewestPages(pagesOf(250, 100).read, 150)).joined, true);
  // The start joins anything.
  assert.deepEqual(
    await readNewestPages(pagesOf(30, 100).read, 5).then((read) => [
      read.olderBeforeSeq,
      read.joined,
    ]),
    [null, true],
  );

  // Too far to reach: the note keeps only what was read.
  const far = pagesOf(5000, 100);
  const cut = await readNewestPages(far.read, 10, 3);
  assert.deepEqual([cut.entries.length, cut.olderBeforeSeq, cut.joined], [300, 4701, false]);
  const held = [entry(10), entry(4800), localEntry('error', 'could not send')];
  assert.deepEqual(
    entriesWithinNewest(held, cut.olderBeforeSeq).map((item) =>
      item.seq > 0 ? item.seq : 'local',
    ),
    [4800, 'local'],
  );
});

test('the newest entry held is a transcript entry, not a presentation or a line of the note', () => {
  assert.equal(newestStoredSeq([]), null);
  assert.equal(newestStoredSeq([localEntry('error', 'x')]), null);
  assert.equal(
    newestStoredSeq([entry(3), streaming(1), entry(7, 'tool_use'), localEntry('error', 'x')]),
    7,
  );
});

test('paging back while a reply streams loses and repeats nothing', () => {
  // The newest page, a live revision of the streaming reply, and a line of the note.
  let shown = mergeTranscriptEntries([], visibleEntries([entry(39), entry(40), streaming(2)]));
  shown = addEntry(shown, streaming(3));
  shown = [...shown, localEntry('error', 'could not take a screenshot')];

  // The owner scrolls up: the page before comes in while the reply goes on.
  const older = visibleEntries([
    entry(36),
    entry(37, 'progress'),
    entry(38, 'tool_use'),
  ]);
  shown = mergeTranscriptEntries(shown, older);
  shown = addEntry(shown, streaming(4));
  assert.deepEqual(
    shown.map((item) =>
      item.presentation ? `reply ${item.presentationRevision}` : item.seq > 0 ? item.seq : 'local',
    ),
    [36, 38, 39, 40, 'reply 4', 'local'],
  );

  // A reading of the newest page taken before the last revision does not bring it back.
  shown = mergeTranscriptEntries(shown, visibleEntries([entry(39), entry(40), streaming(3)]));
  assert.equal(shown.filter((item) => item.presentation).length, 1);
  assert.equal(shown.find((item) => item.presentation)!.presentationRevision, 4);

  // The turn ends: the sealed reply covers its final entry, once.
  const final = entry(42, 'bot', { text: 'reply at revision 5', workItemId: 'w-live' });
  shown = mergeTranscriptEntries(
    shown,
    visibleEntries([entry(40), { ...streaming(5, 'sealed'), text: 'reply at revision 5' }, final]),
  );
  assert.deepEqual(
    shown.map((item) =>
      item.presentation ? `reply ${item.presentationRevision}` : item.seq > 0 ? item.seq : 'local',
    ),
    [36, 38, 39, 40, 'reply 5', 'local'],
  );
  // An older page read again changes nothing.
  assert.deepEqual(mergeTranscriptEntries(shown, older), shown);
});
