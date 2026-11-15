import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TranscriptEntry, WorkItem } from '../../src/core/types.ts';
import { awaitedReplies, conversationWorkState, type AwaitedReply } from '../../src/renderer/note/workState.ts';
import { mergeWorkItems, upsertWorkItem, visibleEntries } from '../../src/renderer/note/transcript.ts';

test('busy retries stay active across queued and running states, then end on cancellation', () => {
  const item = { id: 'waiting', conversationId: 'home', error: 'session_busy' } as WorkItem;
  for (const state of ['queued', 'running', 'queued'] as const) {
    assert.deepEqual(conversationWorkState([{ ...item, state }], 'home'), { active: true, waiting: true });
  }
  assert.deepEqual(conversationWorkState([{ ...item, state: 'cancelled' }], 'home'), { active: false, waiting: false });
  assert.deepEqual(conversationWorkState([{ ...item, state: 'queued' }], 'another'), { active: false, waiting: false });
});

test('a delayed running snapshot cannot revive a completed or cancelled live work item', () => {
  const running = { id: 'w', conversationId: 'home', state: 'running', attempts: 2, updatedAt: '2026-11-01T01:00:00Z' } as WorkItem;
  for (const state of ['completed', 'cancelled'] as const) {
    const current = upsertWorkItem([running], { ...running, state, updatedAt: '2026-11-01T01:00:01Z' });
    const merged = mergeWorkItems(current, [running, { ...running, id: 'other', conversationId: 'another' }]);
    assert.equal(merged.find(w => w.id === 'w')!.state, state);
    assert.equal(conversationWorkState(merged, 'home').active, false);
    assert.equal(mergeWorkItems(current, [{ ...running, updatedAt: current[0]!.updatedAt }])[0]!.state, state);
    assert.equal(mergeWorkItems([running], [{ ...running, state }])[0]!.state, state);
  }
});

test('completed histories hide the old permanent Waiting notice without hiding owner text', () => {
  const text = 'Waiting: the session is still busy with another turn.';
  const rows = visibleEntries([
    { seq: 1, at: '', kind: 'system', origin: 'system', text },
    { seq: 2, at: '', kind: 'owner', origin: 'owner', text },
  ]);
  assert.deepEqual(rows.map(e => e.kind), ['owner']);
});

const turn = (state: WorkItem['state'], extra: Partial<WorkItem> = {}) =>
  ({ id: 'w', kind: 'owner_message', conversationId: 'home', prompt: 'hi', state, ...extra }) as WorkItem;
const owner: TranscriptEntry = { seq: 1, at: '', kind: 'owner', origin: 'owner', text: 'hi', workItemId: 'w' };
const reply = (phase: 'streaming' | 'sealed', seq = 2): TranscriptEntry => ({ seq, at: '', kind: 'bot', origin: 'owner', text: '',
  workItemId: 'w', presentation: { version: 1, id: `w:${seq}`, phase, blocks: [] } });
const awaited = (input: Partial<AwaitedReply>) => awaitedReplies({ conversationId: 'home', workItems: [], entries: [],
  streaming: false, askingOwner: false, ...input }).length > 0;

test('the waiting bubble shows under the owner message until the turn has something in the transcript', () => {
  assert.equal(awaited({}), false);
  assert.equal(awaited({ workItems: [turn('queued')] }), false, 'not before the message it answers shows');
  for (const state of ['queued', 'running'] as const) {
    assert.equal(awaited({ workItems: [turn(state)], entries: [owner] }), true, state);
  }
  assert.equal(awaited({ workItems: [turn('running', { kind: 'schedule' })] }), true, 'a turn without an owner message');
  assert.equal(awaited({ workItems: [turn('running')], entries: [owner, reply('streaming')] }), false, 'its own bubble has the dots');
  assert.equal(awaited({ workItems: [turn('running')], entries: [owner, reply('sealed')] }), false, 'sealed before reported done');
  assert.equal(awaited({ workItems: [turn('running')], entries: [owner,
    { seq: 2, at: '', kind: 'error', origin: 'owner', text: 'failed', workItemId: 'w' }] }), false);
  assert.equal(awaited({ workItems: [turn('completed')], entries: [owner] }), false);
  assert.equal(awaited({ workItems: [turn('running', { conversationId: 'other' })], entries: [owner] }), false);
});

test('the waiting bubble leaves heartbeats, streamed text and questions to the owner alone', () => {
  assert.equal(awaited({ workItems: [turn('running', { kind: 'heartbeat' })] }), false);
  const rerun = turn('running', { source: 'recovery', prompt: '[Cats heartbeat. This is not a message from your owner.]' });
  assert.equal(awaited({ workItems: [rerun], entries: [{ ...owner, text: rerun.prompt }] }), false, 'an interrupted heartbeat run again');
  assert.deepEqual(awaitedReplies({ conversationId: 'home', streaming: false, askingOwner: false,
    workItems: [turn('running', { kind: 'heartbeat' }), turn('queued', { id: 'next' })], entries: [{ ...owner, workItemId: 'next' }] }),
  ['next'], 'the waiting bubble names the turns whose reply takes its place');
  assert.equal(awaited({ workItems: [turn('running')], entries: [owner], streaming: true }), false);
  assert.equal(awaited({ workItems: [turn('running')], entries: [owner], askingOwner: true }), false);
});

test('a retried turn waits again although its failed attempt left a reply', () => {
  const failed = reply('sealed');
  assert.equal(awaited({ workItems: [turn('running')], entries: [owner, failed] }), false);
  assert.equal(awaited({ workItems: [turn('running', { attemptFromSeq: 2 })], entries: [owner, failed] }), true);
  assert.equal(awaited({ workItems: [turn('running', { attemptFromSeq: 2 })], entries: [owner, failed, reply('streaming', 3)] }), false);
});
