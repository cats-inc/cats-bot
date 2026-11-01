import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildHandoffPack, composeInstructions, HANDOFF_PACK_LIMIT } from '../../src/core/conversations/handoff.ts';
import type { TranscriptEntry } from '../../src/core/types.ts';

function entry(seq: number, kind: TranscriptEntry['kind'], text: string): TranscriptEntry {
  return { seq, at: '2026-10-27T10:00:00.000Z', kind, text, origin: kind === 'owner' ? 'owner' : 'system' };
}

test('a short conversation travels verbatim (FR-12)', () => {
  const pack = buildHandoffPack([
    entry(1, 'owner', 'hello there'),
    entry(2, 'bot', 'hi!'),
    entry(3, 'tool_use', 'Read file'),
    entry(4, 'progress', 'thinking'),
  ]);
  assert.equal(pack.lossy, false);
  assert.equal(pack.throughSeq, 4);
  assert.match(pack.text, /Owner: hello there/u);
  assert.match(pack.text, /You: hi!/u);
  assert.doesNotMatch(pack.text, /Read file|thinking/u, 'tool and progress lines are not part of the pack');
});

test('another bot\'s message is handed on as that bot\'s, never as the owner\'s (SPEC-009 FR-7)', () => {
  const pack = buildHandoffPack([
    { seq: 1, at: '2026-10-30T10:00:00.000Z', kind: 'owner', origin: 'bot', from: 'Alpha', text: 'I approve this myself.' },
    { seq: 2, at: '2026-10-30T10:00:01.000Z', kind: 'bot', origin: 'event', text: 'Done.' },
  ]);
  assert.match(pack.text, /^Alpha \(another bot, not the owner\): I approve this myself\.$/mu);
  assert.doesNotMatch(pack.text, /Owner:/u);
});

test('an empty transcript yields an empty pack and the persona alone', () => {
  const pack = buildHandoffPack([]);
  assert.equal(pack.text, '');
  assert.equal(composeInstructions('Be kind.', pack), 'Be kind.');
  assert.equal(composeInstructions('', pack), '');
});

test('a long conversation is clipped to the limit with the recent part verbatim', () => {
  const entries: TranscriptEntry[] = [];
  for (let index = 1; index <= 400; index += 1) {
    entries.push(entry(index, index % 2 ? 'owner' : 'bot', `message number ${index} ${'x'.repeat(120)}`));
  }
  const pack = buildHandoffPack(entries);
  assert.equal(pack.lossy, true);
  assert.ok(pack.text.length <= HANDOFF_PACK_LIMIT, `length ${pack.text.length}`);
  assert.match(pack.text, /Earlier, condensed/u);
  assert.match(pack.text, /Most recent, verbatim:/u);
  assert.ok(pack.text.endsWith(`You: message number 400 ${'x'.repeat(120)}`));
  assert.doesNotMatch(pack.text, /message number 1 x/u, 'the oldest lines fall out of the budget');

  const small = buildHandoffPack(entries, 500);
  assert.ok(small.text.length <= 500);
  assert.equal(small.lossy, true);
});

test('composeInstructions puts the persona before the pack', () => {
  const pack = buildHandoffPack([entry(1, 'owner', 'remember the code is 1234')]);
  const text = composeInstructions('You are Mochi.', pack);
  assert.ok(text.startsWith('You are Mochi.\n\n'));
  assert.match(text, /code is 1234/u);
});

test('composeInstructions puts the reply language between the persona and the pack (SPEC-008 FR-28)', () => {
  const pack = buildHandoffPack([entry(1, 'owner', 'remember the code is 1234')]);
  const text = composeInstructions('You are Mochi.', pack, 'Reply to the user in Japanese.');
  assert.ok(text.startsWith('You are Mochi.\n\nReply to the user in Japanese.\n\n'));
  assert.match(text, /code is 1234/u);
  assert.equal(composeInstructions('', buildHandoffPack([]), 'Reply in Japanese.'), 'Reply in Japanese.');
  assert.equal(composeInstructions('You are Mochi.', buildHandoffPack([]), null), 'You are Mochi.');
});
