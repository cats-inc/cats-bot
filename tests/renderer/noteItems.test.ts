import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BotInteraction, TranscriptEntry, WorkItem } from '../../src/core/types.ts';
import { buildNoteItems, liveInteractions, toolSummary, upsertWorkItem, type DecisionItem, type ToolItem } from '../../src/renderer/note/transcript.ts';

/** SPEC-003 FR-4, FR-5: tool cards and the owner's decisions in the note. */

const AT = '2026-10-28T01:02:03.000Z';

function entry(seq: number, kind: TranscriptEntry['kind'], text: string, extra: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return { seq, at: AT, kind, text, origin: 'owner', ...extra };
}

function work(id: string, state: WorkItem['state'], extra: Partial<WorkItem> = {}): WorkItem {
  return {
    id, kind: 'event', source: 'owner', conversationId: 'home', prompt: 'p', createdAt: AT, admittedAt: AT,
    configRevision: 1, state, attempts: 1, updatedAt: AT, ...extra,
  };
}

test('a tool call and its result become one card, also when a CLI reuses the id in a later turn', () => {
  const items = buildNoteItems([
    entry(1, 'owner', 'read it'),
    entry(2, 'tool_use', '{"path":"file.txt"}', { toolName: 'Read', toolId: 'toolu_1', workItemId: 'w1' }),
    entry(3, 'tool_result', 'contents of file.txt', { toolName: 'Read', toolId: 'toolu_1', workItemId: 'w1' }),
    entry(4, 'bot', 'used a tool'),
    entry(5, 'tool_use', '{"path":"other.txt"}', { toolName: 'Read', toolId: 'toolu_1', workItemId: 'w2' }),
    entry(6, 'tool_result', 'denied', { toolName: 'Read', toolId: 'toolu_1', workItemId: 'w2', isError: true }),
  ], [work('w1', 'completed'), work('w2', 'completed')]);
  assert.deepEqual(items.map((item) => item.type), ['entry', 'tool', 'entry', 'tool']);
  const [first, second] = items.filter((item): item is ToolItem => item.type === 'tool');
  assert.deepEqual({ ...first }, { type: 'tool', key: 'tool:2', name: 'Read', input: '{"path":"file.txt"}', result: 'contents of file.txt', status: 'done' });
  assert.equal(second!.result, 'denied');
  assert.equal(second!.status, 'error');
  assert.notEqual(first!.key, second!.key);
});

test('a call still waiting for its result shows as running only while its turn runs', () => {
  const call = entry(2, 'tool_use', 'ls', { toolName: 'Bash', toolId: 't1', workItemId: 'w1' });
  const runningItem = buildNoteItems([call], [work('w1', 'running')])[0] as ToolItem;
  assert.equal(runningItem.status, 'running');
  assert.equal(runningItem.result, null);
  assert.equal((buildNoteItems([call], [work('w1', 'cancelled')])[0] as ToolItem).status, 'done');
});

test('a result without its call is a card of its own, and progress is never shown', () => {
  const items = buildNoteItems([entry(1, 'progress', '…'), entry(2, 'tool_result', 'orphan output', { toolName: 'Grep' })], []);
  assert.equal(items.length, 1);
  assert.deepEqual({ ...(items[0] as ToolItem) }, { type: 'tool', key: 'tool:2', name: 'Grep', input: '', result: 'orphan output', status: 'done' });
});

test('the entry that asked the owner is a decision while it waits, and shows the outcome after', () => {
  const asked = entry(7, 'system', 'Approval needed (w9): deploy?', { workItemId: 'w9' });
  const expiredLine = entry(8, 'system', 'Approval w9 expired: no answer.', { workItemId: 'w9' });
  const decision = (state: WorkItem['state'], extra: Partial<WorkItem> = {}) =>
    buildNoteItems([asked, expiredLine], [work('w9', state, { source: 'ask_owner', ...extra })]);
  const waiting = decision('awaiting_owner');
  assert.deepEqual(waiting.map((item) => item.type), ['decision', 'entry'], 'only the asking entry gets buttons');
  assert.equal((waiting[0] as DecisionItem).status, 'waiting');
  assert.equal((decision('completed', { result: { text: 'approved', completedAt: AT } })[0] as DecisionItem).status, 'approved');
  assert.equal((decision('completed', { result: { text: 'denied', completedAt: AT } })[0] as DecisionItem).status, 'denied');
  const expired = decision('failed', { error: 'no answer within a day' })[0] as DecisionItem;
  assert.equal(expired.status, 'expired');
  assert.equal(expired.detail, 'no answer within a day');
  // An interrupted turn to run again: approving completes it, denying cancels it.
  const recovery = buildNoteItems([asked], [work('w9', 'cancelled', { source: 'recovery' })])[0] as DecisionItem;
  assert.equal(recovery.status, 'denied');
});

test('system lines of other work, or of work the note does not know, stay plain entries', () => {
  const items = buildNoteItems([
    entry(1, 'system', 'Scheduled (s1)', { workItemId: 'w1' }),
    entry(2, 'system', 'Approval needed (gone)', { workItemId: 'gone' }),
  ], [work('w1', 'completed', { source: 'schedule' })]);
  assert.deepEqual(items.map((item) => item.type), ['entry', 'entry']);
});

test('a card summary is the first non-empty line; work item events replace the note copy', () => {
  const card = (input: string, result: string | null = null): ToolItem => ({ type: 'tool', key: 'k', name: 'Bash', input, result, status: 'done' });
  assert.equal(toolSummary(card('\n  npm test\nmore')), 'npm test');
  assert.equal(toolSummary(card('', 'out\n')), 'out');
  // JSON input (the Claude CLI's toolArgs) shows its most telling field.
  assert.equal(toolSummary(card('{\n  "command": "npm test\\nnpm run build",\n  "timeout": 1000\n}')), 'npm test');
  assert.equal(toolSummary(card('{\n  "limit": 5,\n  "file_path": "C:/notes.md"\n}')), 'C:/notes.md');
  assert.equal(toolSummary(card('{\n  "todos": [1, 2]\n}')), '{"todos":[1,2]}');
  // Input clipped mid-JSON is not JSON any more: its first line.
  assert.equal(toolSummary(card('{\n  "content": "yyy…')), '{');
  const before = [work('w1', 'queued'), work('w2', 'running')];
  const after = upsertWorkItem(before, work('w1', 'running'));
  assert.deepEqual(after.map((item) => `${item.id}:${item.state}`), ['w1:running', 'w2:running']);
  assert.deepEqual(upsertWorkItem(before, work('w3', 'queued')).map((item) => item.id), ['w1', 'w2', 'w3']);
  assert.equal(before[0]!.state, 'queued', 'the old list is not changed');
});

test('the note shows only requests that can still be answered, never finished receipts', () => {
  const statuses: BotInteraction['status'][] = ['resolved', 'pending', 'expired', 'responding', 'cancelled', 'interrupted', 'unsupported'];
  const interactions = statuses.map((status, index): BotInteraction => ({
    botId: 'b', conversationId: 'home', workItemId: 'w1', interactionId: `i${index}`, sessionId: 's', workerGeneration: 'g',
    executionId: 'e', revision: 1, createdAt: AT, expiresAt: AT, status, kind: 'tool_approval',
  }));
  assert.deepEqual(liveInteractions(interactions).map((i) => i.status), ['pending', 'responding']);
  assert.deepEqual(liveInteractions(interactions.filter((i) => i.status === 'resolved')), [], 'receipts alone leave the note empty');
});
