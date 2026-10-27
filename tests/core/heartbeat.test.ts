import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildHeartbeatPrompt, isHeartbeatPrompt, parseHeartbeatReply, pickHeartbeatDelayMs } from '../../src/core/life/heartbeat.ts';
import { HEARTBEAT_DEFAULTS } from '../../src/core/profile/profile.ts';
import { reconcileInterrupted } from '../../src/core/life/recovery.ts';
import type { RuntimeClient } from '../../src/core/runtime/client.ts';
import { createWorkItem } from '../../src/core/queue/workItems.ts';
import type { TranscriptEntry, WorkItem } from '../../src/core/types.ts';

test('heartbeat delays follow the profile bounds (FR-25)', () => {
  assert.equal(pickHeartbeatDelayMs('wake', HEARTBEAT_DEFAULTS, () => 0), 2 * 60_000);
  assert.equal(pickHeartbeatDelayMs('wake', HEARTBEAT_DEFAULTS, () => 1), 10 * 60_000);
  assert.equal(pickHeartbeatDelayMs('regular', HEARTBEAT_DEFAULTS, () => 0.5), 75 * 60_000);
  assert.equal(pickHeartbeatDelayMs('regular', { ...HEARTBEAT_DEFAULTS, regularMinMinutes: 5, regularMaxMinutes: 5 }, () => 0.9), 5 * 60_000);
});

test('the heartbeat prompt states the facts and the quiet rule, and replies are parsed', () => {
  const prompt = buildHeartbeatPrompt({
    kind: 'regular',
    now: new Date('2026-10-27T10:00:00.000Z'),
    awakeSince: new Date('2026-10-27T08:30:00.000Z'),
    lastOwnerMessageAt: new Date('2026-10-27T09:40:00.000Z'),
    botName: 'Mochi',
  });
  assert.ok(isHeartbeatPrompt(prompt));
  assert.match(prompt, /awake for about 2 hours/u);
  assert.match(prompt, /last wrote to you 20 minutes ago/u);
  assert.match(prompt, /as Mochi/u);
  assert.match(prompt, /schedule tools/u);
  assert.match(prompt, /\[quiet\]/u);
  const wake = buildHeartbeatPrompt({ kind: 'wake', now: new Date(), awakeSince: null, lastOwnerMessageAt: null, botName: 'Mochi' });
  assert.match(wake, /just woken up/u);
  assert.match(wake, /has not written to you yet/u);
  assert.deepEqual(parseHeartbeatReply('  [QUIET] '), { quiet: true });
  assert.deepEqual(parseHeartbeatReply(''), { quiet: true });
  assert.deepEqual(parseHeartbeatReply(' Good morning! '), { quiet: false, body: 'Good morning!' });
});

function clientWith(messages: Array<{ role: string; text: string; timestamp?: string }> | Error): RuntimeClient {
  return {
    getHistory: async () => {
      if (messages instanceof Error) throw messages;
      return { messages };
    },
  } as unknown as RuntimeClient;
}

function interruptedItem(prompt: string, run: Partial<NonNullable<WorkItem['run']>> = {}): WorkItem {
  return {
    ...createWorkItem({ kind: 'owner_message', source: 'owner', conversationId: 'home', prompt }, new Date('2026-10-28T09:00:00.000Z')),
    admittedAt: '2026-10-28T09:00:00.000Z',
    run: { provider: 'claude', model: null, sessionId: 's1', startedAt: '2026-10-28T09:00:01.000Z', historyBaseline: 0, ...run },
  };
}

function toolEntry(item: WorkItem, kind: 'tool_use' | 'tool_result', at: string, toolId = 't1'): TranscriptEntry {
  return { seq: 0, at, kind, origin: 'owner', text: '', workItemId: item.id, toolName: 'Bash', toolId };
}

test('interrupted turns are settled by runtime evidence, never rerun (FR-28)', async () => {
  const item = interruptedItem('write the plan');
  const completed = await reconcileInterrupted(item, clientWith([
    { role: 'user', text: 'Instructions:\nbe nice\n\nUser message:\nwrite the plan' },
    { role: 'assistant', text: 'Here is the plan.' },
  ]));
  assert.deepEqual(completed, { verdict: 'completed', text: 'Here is the plan.' });
  const noReply = await reconcileInterrupted(item, clientWith([{ role: 'user', text: 'write the plan' }]));
  assert.equal(noReply.verdict, 'awaiting_owner');
  const noPrompt = await reconcileInterrupted(item, clientWith([{ role: 'user', text: 'something else' }, { role: 'assistant', text: 'ok' }]));
  assert.equal(noPrompt.verdict, 'awaiting_owner');
  const unknown = await reconcileInterrupted(item, clientWith(new Error('runtime unreachable')));
  assert.equal(unknown.verdict, 'unknown');
  const noSession = await reconcileInterrupted({ ...item, run: undefined }, clientWith([]));
  assert.equal(noSession.verdict, 'awaiting_owner');
});

test('recovery only counts messages of this run and earns completion (FR-28)', async () => {
  const yesterday = [
    { role: 'user', text: 'back up the photos', timestamp: '2026-10-27T09:00:00.000Z' },
    { role: 'assistant', text: 'Starting the backup now.', timestamp: '2026-10-27T09:00:05.000Z' },
    { role: 'assistant', text: 'Backup finished.', timestamp: '2026-10-27T09:03:00.000Z' },
  ];
  // Today's prompt never reached the session: yesterday's identical prompt is before the baseline.
  const today = interruptedItem('back up the photos', { historyBaseline: 3 });
  const notThisRun = await reconcileInterrupted(today, clientWith(yesterday));
  assert.equal(notThisRun.verdict, 'awaiting_owner');

  // It did reach it: only what follows today's prompt counts, every reply of the turn is kept.
  const ran = await reconcileInterrupted(today, clientWith([
    ...yesterday,
    { role: 'user', text: 'back up the photos', timestamp: '2026-10-28T09:00:02.000Z' },
    { role: 'assistant', text: 'Starting the backup now.', timestamp: '2026-10-28T09:00:05.000Z' },
    { role: 'assistant', text: 'Backup finished.', timestamp: '2026-10-28T09:04:00.000Z' },
    { role: 'user', text: 'thanks', timestamp: '2026-10-28T09:05:00.000Z' },
    { role: 'assistant', text: 'You are welcome.', timestamp: '2026-10-28T09:05:02.000Z' },
  ]));
  assert.deepEqual(ran, { verdict: 'completed', text: 'Starting the backup now.\n\nBackup finished.' });

  // A tool call the core saw without its result: the reply so far may be partial.
  const midTool = [
    ...yesterday,
    { role: 'user', text: 'back up the photos', timestamp: '2026-10-28T09:00:02.000Z' },
    { role: 'assistant', text: 'Starting the backup now.', timestamp: '2026-10-28T09:00:05.000Z' },
  ];
  const open = await reconcileInterrupted(today, clientWith(midTool), [toolEntry(today, 'tool_use', '2026-10-28T09:00:06.000Z')]);
  assert.equal(open.verdict, 'awaiting_owner');
  assert.match(open.verdict === 'awaiting_owner' ? open.evidence : '', /no result.*Starting the backup now/u);

  // The tool finished but no reply came after its result.
  const tools = [toolEntry(today, 'tool_use', '2026-10-28T09:00:06.000Z'), toolEntry(today, 'tool_result', '2026-10-28T09:03:00.000Z')];
  const beforeResult = await reconcileInterrupted(today, clientWith(midTool), tools);
  assert.equal(beforeResult.verdict, 'awaiting_owner');
  const afterResult = await reconcileInterrupted(today, clientWith([
    ...midTool,
    { role: 'assistant', text: 'Backup finished.', timestamp: '2026-10-28T09:03:10.000Z' },
  ]), tools);
  assert.equal(afterResult.verdict, 'completed');
  const untimed = await reconcileInterrupted(today, clientWith([
    ...midTool.map(({ role, text }) => ({ role, text })),
    { role: 'assistant', text: 'Backup finished.' },
  ]), tools);
  assert.equal(untimed.verdict, 'awaiting_owner', 'without timestamps a reply cannot be placed after the tool result');

  // A run journaled before baselines existed: only a timestamp ties the prompt to it.
  const legacy = interruptedItem('back up the photos', { historyBaseline: undefined });
  const untied = await reconcileInterrupted(legacy, clientWith(yesterday.map(({ role, text }) => ({ role, text }))));
  assert.equal(untied.verdict, 'awaiting_owner');
  const oldTimes = await reconcileInterrupted(legacy, clientWith(yesterday));
  assert.equal(oldTimes.verdict, 'awaiting_owner', "yesterday's prompt is older than this run");
  const tied = await reconcileInterrupted(legacy, clientWith([
    ...yesterday,
    { role: 'user', text: 'back up the photos', timestamp: '2026-10-28T09:00:02.000Z' },
    { role: 'assistant', text: 'Backup finished.', timestamp: '2026-10-28T09:04:00.000Z' },
  ]));
  assert.deepEqual(tied, { verdict: 'completed', text: 'Backup finished.' });
});
