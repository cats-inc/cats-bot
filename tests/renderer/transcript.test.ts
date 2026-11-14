import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TranscriptEntry } from '../../src/core/types.ts';
import { addEntry, appendDelta, entryClass, entryMeta, entryText, errorText, visibleEntries } from '../../src/renderer/note/transcript.ts';
import { acceptLanguage } from '../../src/renderer/localeStore.ts';

/** SPEC-001 FR-33, SPEC-003: what the note shows from the transcript and the live events. */

function entry(seq: number, kind: TranscriptEntry['kind'], text: string, extra: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return { seq, at: '2026-10-28T01:02:03.000Z', kind, text, origin: 'owner', ...extra };
}

test('progress lines are hidden and a live entry the transcript already holds is not added twice', () => {
  const read = visibleEntries([entry(1, 'owner', 'hi'), entry(2, 'progress', '…'), entry(3, 'tool_use', 'file.txt', { toolName: 'Read' })]);
  assert.deepEqual(read.map((item) => item.seq), [1, 3]);
  assert.deepEqual(addEntry(read, entry(3, 'tool_use', 'file.txt')).map((item) => item.seq), [1, 3]);
  assert.deepEqual(addEntry(read, entry(4, 'tool_result', 'contents')).map((item) => item.seq), [1, 3, 4]);
  assert.deepEqual(addEntry(read, entry(5, 'progress', '…')).map((item) => item.seq), [1, 3]);
});

test('streamed text joins one reply per work item', () => {
  let pending = appendDelta(null, 'w1', '**Hel');
  pending = appendDelta(pending, 'w1', 'lo**');
  assert.deepEqual(pending, { workItemId: 'w1', text: '**Hello**' });
  assert.deepEqual(appendDelta(pending, 'w2', 'next'), { workItemId: 'w2', text: 'next' });
});

test('entries keep their look: classes, tool lines, times and what the cat says on its own', () => {
  assert.equal(entryClass('owner'), 'entry entry-owner');
  assert.equal(entryClass('tool_result'), 'entry entry-tool');
  assert.equal(entryClass('system'), 'entry entry-system');
  assert.equal(entryText(entry(1, 'tool_use', 'file.txt', { toolName: 'Read' })), '⚙ Read file.txt');
  assert.equal(entryText(entry(1, 'tool_use', '')), '⚙ tool');
  assert.equal(entryText(entry(1, 'tool_result', 'contents')), '↳ contents');
  const time = () => '09:02';
  assert.equal(entryMeta(entry(1, 'owner', 'hi'), time), '09:02');
  assert.equal(entryMeta(entry(1, 'bot', 'hey', { origin: 'heartbeat' }), time), 'On its own initiative · 09:02');
  // Another cat's name is over its bubble now (speakers.ts), not in the time.
  assert.equal(entryMeta(entry(1, 'owner', 'hello', { origin: 'bot', from: 'Mochi' }), time), '09:02');
  try {
    acceptLanguage({ preference: 'zh-TW', locale: 'zh-TW' });
    // The words of the Cat's "own initiative" menu (自主活動).
    assert.equal(entryMeta(entry(1, 'bot', 'hey', { origin: 'heartbeat' }), time), '自主訊息 · 09:02');
  } finally {
    acceptLanguage({ preference: 'en', locale: 'en' });
  }
  assert.equal(entryMeta(entry(1, 'system', 'note'), time), null);
  // A corrupt time shows no time rather than breaking the note.
  assert.equal(entryMeta({ ...entry(1, 'owner', 'hi'), at: 'garbage' }), null);
});

test('a refused invoke reads as the core\'s own message', () => {
  assert.equal(errorText(new Error("Error invoking remote method 'bot:invoke': Error: An owner message needs text")), 'An owner message needs text');
});
