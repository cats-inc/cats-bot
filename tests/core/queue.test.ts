import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WorkQueue } from '../../src/core/queue/queue.ts';
import { createWorkItem, isTerminalWorkState, transitionWorkItem } from '../../src/core/queue/workItems.ts';
import { runWithSessionGate, isSessionGateHeld } from '../../src/core/queue/gate.ts';

const t0 = new Date('2026-10-27T10:00:00.000Z');
const t1 = new Date('2026-10-27T10:00:01.000Z');
const t2 = new Date('2026-10-27T10:00:02.000Z');

test('owner messages are admitted before background items, otherwise in arrival order (FR-16)', () => {
  const queue = new WorkQueue();
  const heartbeat = createWorkItem({ kind: 'heartbeat', source: 'life', conversationId: 'home', prompt: 'hb' }, t0);
  const schedule = createWorkItem({ kind: 'schedule', source: 's1', conversationId: 'home', prompt: 's', coalesceKey: 's1' }, t1);
  const owner = createWorkItem({ kind: 'owner_message', source: 'owner', conversationId: 'home', prompt: 'hi' }, t2);
  queue.enqueue(heartbeat);
  queue.enqueue(schedule);
  queue.enqueue(owner);
  queue.enqueue(owner);
  assert.equal(queue.size, 3);
  assert.equal(queue.findByCoalesceKey('s1')?.id, schedule.id);
  assert.equal(queue.take()?.id, owner.id);
  assert.equal(queue.take()?.id, heartbeat.id);
  assert.equal(queue.remove(schedule.id)?.id, schedule.id);
  assert.equal(queue.take(), undefined);
});

test('work item transitions keep the id and stamp updatedAt (FR-15)', () => {
  const item = createWorkItem({ kind: 'owner_message', source: 'owner', conversationId: 'home', prompt: 'hi' }, t0);
  assert.equal(item.state, 'queued');
  assert.equal(item.attempts, 0);
  const running = transitionWorkItem(item, 'running', t1, { admittedAt: t1.toISOString(), configRevision: 3, attempts: 1 });
  assert.equal(running.id, item.id);
  assert.equal(running.configRevision, 3);
  assert.equal(running.updatedAt, t1.toISOString());
  assert.equal(isTerminalWorkState('running'), false);
  assert.equal(isTerminalWorkState('interrupted'), true);
});

test('the session gate serializes operations on one session (FR-17)', async () => {
  const order: string[] = [];
  const first = runWithSessionGate('s', async () => {
    order.push('first start');
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push('first end');
    return 1;
  });
  assert.equal(isSessionGateHeld('s'), true);
  const second = runWithSessionGate('s', async () => {
    order.push('second start');
    return 2;
  });
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, ['first start', 'first end', 'second start']);
  assert.equal(isSessionGateHeld('s'), false);
});
