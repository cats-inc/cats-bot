import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WorkItem } from '../../src/core/types.ts';
import { conversationWorkState } from '../../src/renderer/note/workState.ts';
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
