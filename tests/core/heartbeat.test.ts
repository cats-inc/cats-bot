import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildHeartbeatPrompt, isHeartbeatPrompt, parseHeartbeatReply, pickHeartbeatDelayMs } from '../../src/core/life/heartbeat.ts';
import { HEARTBEAT_DEFAULTS } from '../../src/core/profile/profile.ts';
import { reconcileInterrupted } from '../../src/core/life/recovery.ts';
import type { RuntimeClient } from '../../src/core/runtime/client.ts';
import { createWorkItem } from '../../src/core/queue/workItems.ts';

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

function clientWith(messages: Array<{ role: string; text: string }> | Error): RuntimeClient {
  return {
    getHistory: async () => {
      if (messages instanceof Error) throw messages;
      return { messages };
    },
  } as unknown as RuntimeClient;
}

test('interrupted turns are settled by runtime evidence, never rerun (FR-28)', async () => {
  const item = { ...createWorkItem({ kind: 'owner_message', source: 'owner', conversationId: 'home', prompt: 'write the plan' }, new Date()), run: { provider: 'claude', model: null, sessionId: 's1' } };
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
