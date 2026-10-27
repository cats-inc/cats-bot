import assert from 'node:assert/strict';
import { test } from 'node:test';

import { afterFiring, createSchedule, isDue, settleMissed } from '../../src/core/life/schedules.ts';

const now = new Date('2026-10-27T10:00:00.000Z');

test('createSchedule validates its inputs and computes the next time (FR-21)', () => {
  const once = createSchedule({ conversationId: 'home', prompt: 'remind me', kind: 'once', at: new Date('2026-10-27T10:30:00.000Z'), createdBy: 'owner' }, now);
  assert.equal(once.nextAt, '2026-10-27T10:30:00.000Z');
  assert.equal(once.missedPolicy, 'run_once');
  assert.equal(once.graceMinutes, 1_440);
  assert.match(once.receipt, /^sch-[0-9a-f]{8}@2026-10-27T10:00:00\.000Z$/u);
  const cron = createSchedule({ conversationId: 'home', prompt: 'standup', kind: 'cron', cron: '0 9 * * 1-5', timezone: 'Asia/Taipei', createdBy: 'agent' }, now);
  assert.equal(cron.missedPolicy, 'coalesce');
  assert.equal(cron.nextAt, '2026-10-28T01:00:00.000Z');
  assert.throws(() => createSchedule({ conversationId: 'home', prompt: ' ', kind: 'once', at: new Date('2026-10-27T10:30:00.000Z'), createdBy: 'owner' }, now), /needs a prompt/u);
  assert.throws(() => createSchedule({ conversationId: 'home', prompt: 'x', kind: 'once', at: new Date('2026-10-27T09:00:00.000Z'), createdBy: 'owner' }, now), /in the future/u);
  assert.throws(() => createSchedule({ conversationId: 'home', prompt: 'x', kind: 'cron', cron: '0 9 * * *', timezone: 'Mars/Olympus', createdBy: 'owner' }, now), /Unknown time zone/u);
});

test('isDue and afterFiring: once completes, cron re-arms', () => {
  const once = createSchedule({ conversationId: 'home', prompt: 'remind me', kind: 'once', at: new Date('2026-10-27T10:30:00.000Z'), createdBy: 'owner' }, now);
  assert.equal(isDue(once, now), false);
  assert.equal(isDue(once, new Date('2026-10-27T10:30:00.000Z')), true);
  const fired = afterFiring(once, new Date('2026-10-27T10:30:05.000Z'));
  assert.equal(fired.state, 'completed');
  assert.equal(fired.nextAt, null);
  const cron = createSchedule({ conversationId: 'home', prompt: 'tick', kind: 'cron', cron: '*/30 * * * *', timezone: 'UTC', createdBy: 'owner' }, now);
  assert.equal(cron.nextAt, '2026-10-27T10:30:00.000Z');
  const rearmed = afterFiring(cron, new Date('2026-10-27T10:30:00.000Z'));
  assert.equal(rearmed.state, 'active');
  assert.equal(rearmed.nextAt, '2026-10-27T11:00:00.000Z');
  assert.equal(rearmed.lastFiredAt, '2026-10-27T10:30:00.000Z');
});

test('settleMissed applies skip, coalesce and run_once with grace (FR-22)', () => {
  const cron = createSchedule({ conversationId: 'home', prompt: 'tick', kind: 'cron', cron: '0 * * * *', timezone: 'UTC', createdBy: 'owner' }, now);
  const from = new Date('2026-10-27T10:30:00.000Z');
  const later = new Date('2026-10-27T14:10:00.000Z'); // 11:00, 12:00, 13:00, 14:00 were missed
  const coalesced = settleMissed(cron, from, later);
  assert.deepEqual(coalesced.decision, { action: 'run', occurrences: 4, reason: 'coalesced' });
  assert.equal(coalesced.schedule.nextAt, '2026-10-27T15:00:00.000Z');

  const skip = settleMissed({ ...cron, missedPolicy: 'skip' }, from, later);
  assert.deepEqual(skip.decision, { action: 'skip', occurrences: 4, reason: 'policy_skip' });
  assert.equal(skip.schedule.nextAt, '2026-10-27T15:00:00.000Z');

  const once = createSchedule({ conversationId: 'home', prompt: 'remind', kind: 'once', at: new Date('2026-10-27T11:00:00.000Z'), graceMinutes: 60, createdBy: 'owner' }, now);
  const inGrace = settleMissed(once, from, new Date('2026-10-27T11:45:00.000Z'));
  assert.deepEqual(inGrace.decision, { action: 'run', occurrences: 1, reason: 'within_grace' });
  assert.equal(inGrace.schedule.state, 'completed');
  const pastGrace = settleMissed(once, from, later);
  assert.deepEqual(pastGrace.decision, { action: 'skip', occurrences: 1, reason: 'past_grace' });
  assert.equal(pastGrace.schedule.state, 'completed');

  const untouched = settleMissed(cron, new Date('2026-10-27T10:59:00.000Z'), new Date('2026-10-27T10:59:30.000Z'));
  assert.deepEqual(untouched.decision, { action: 'none' });
});
