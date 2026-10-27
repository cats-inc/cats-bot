import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { readJournal } from '../../src/core/store/journal.ts';
import { fetchFakeState, makeTempHome, openTestBot, sendAndWait, waitForEvent, type TempHome } from '../support/harness.ts';

/**
 * SPEC-001 A2 on the fake runtime: the reconcile tick, schedules, heartbeat
 * and approvals, driven by hand through `core.tick()` with an adjustable clock.
 */

let home: TempHome;
before(() => {
  home = makeTempHome('cats-bots-life-');
});
after(() => home.cleanup());

const fast = {
  turnRetry: { ownerBusyMs: 200, backgroundBusyMs: 200, runtimeUnavailableMs: 200 },
  runtimeRestartDelaysMs: [300, 300],
};

function clock(start = Date.now()) {
  let offset = 0;
  return {
    now: () => new Date(start + offset + (Date.now() - start)),
    advance(ms: number) {
      offset += ms;
    },
  };
}

test('the tick keeps the home session alive: creates it, leaves a live one alone, revives it after a runtime crash (FR-20, FR-6)', async () => {
  const { core } = openTestBot({
    botsHome: home.botsHome,
    id: 'alive',
    core: { ...fast, life: { random: () => 1 } },
    runtimeEnv: { FAKE_CRASH_AFTER_MS: '2500' },
  });
  await core.start();
  try {
    const first = await core.tick();
    assert.equal(first.outcome, 'rebuilt', 'a fresh bot gets its home session from the tick');
    assert.equal(first.reason, 'rebuilt');
    const home1 = (await core.listConversations())[0]!;
    assert.ok(home1.attachment.sessionId);
    const second = await core.tick();
    assert.equal(second.outcome, 'awake');
    let state = await fetchFakeState(core);
    assert.equal(state.calls.filter((call) => call.op === 'create').length, 1);
    assert.ok(readJournal(core.paths).entries.some((entry) => entry.type === 'presence' && entry.presence === 'awake'));

    await waitForEvent(core, (event) => event.type === 'runtime.status' && event.state === 'failed', 10_000);
    assert.equal((await core.listConversations())[0]!.attachment.state, 'closed');
    await waitForEvent(core, (event) => event.type === 'runtime.status' && event.state === 'ready', 10_000);
    const [revived, joined] = await Promise.all([core.tick(), core.tick()]);
    assert.equal(revived.outcome, 'rebuilt', 'the new runtime has no sessions, so home is rebuilt');
    assert.equal(joined, revived, 'a tick requested while a pass runs joins it instead of overlapping it');
    assert.equal((await core.listConversations())[0]!.attachment.state, 'initializing');
    state = await fetchFakeState(core);
    assert.equal(state.calls.filter((call) => call.op === 'create').length, 1, 'one session on the new runtime');
    const reply = await sendAndWait(core, 'home', 'still here?');
    assert.equal(reply.state, 'completed');
  } finally {
    await core.stop();
  }
});

test('a tick during a running turn neither resumes, rebuilds nor cancels (A2 busy protection)', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'busy', core: fast });
  await core.start();
  try {
    await core.tick();
    const before = await fetchFakeState(core);
    // The run is journaled right before the prompt leaves (FR-28).
    const running = waitForEvent(core, (event) => event.type === 'work.updated'
      && event.workItem.state === 'running' && event.workItem.run !== undefined);
    const slow = await core.sendOwnerMessage('home', 'slow:1500');
    await running;
    const report = await core.tick();
    assert.equal(report.outcome, 'busy_turn');
    const during = await fetchFakeState(core);
    assert.equal(during.calls.length, before.calls.length + 1, 'only the message itself reached the runtime');
    assert.ok(!during.calls.some((call) => ['resume', 'cancel', 'close'].includes(String(call.op))));
    const finished = await waitForEvent(core, (event) => event.type === 'turn.completed' && event.workItem.id === slow.id);
    assert.equal(finished.type === 'turn.completed' && finished.workItem.state, 'completed');
  } finally {
    await core.stop();
  }
});

test('a quiet heartbeat leaves a journal entry but no message; a spoken one is a bot message with a notification (FR-25)', async () => {
  const zeroDelay = { enabled: true, wakeMinMinutes: 0, wakeMaxMinutes: 0, regularMinMinutes: 0, regularMaxMinutes: 0 };
  const { core: quiet } = openTestBot({ botsHome: home.botsHome, id: 'quiet', core: { ...fast, life: { random: () => 0 } } });
  await quiet.start();
  try {
    await quiet.updateProfile({ heartbeat: zeroDelay });
    const done = waitForEvent(quiet, (event) => event.type === 'turn.completed' && event.workItem.kind === 'heartbeat');
    const report = await quiet.tick();
    assert.equal(report.heartbeat?.action, 'queued');
    assert.equal(report.heartbeat?.kind, 'wake', 'the first heartbeat after waking greets');
    const item = await done;
    assert.equal(item.type === 'turn.completed' && item.workItem.state, 'completed');
    assert.equal(quiet.transcript('home').filter((entry) => entry.kind === 'bot').length, 0, 'quiet leaves no message');
    const entries = readJournal(quiet.paths).entries.filter((entry) => entry.type === 'heartbeat');
    assert.deepEqual(entries.map((entry) => entry.type === 'heartbeat' ? [entry.kind, entry.result] : []), [['wake', 'quiet']]);
    assert.equal((await quiet.listConversations())[0]!.unreadCount, 0);
    assert.equal((await quiet.listConversations())[0]!.attachment.state, 'ready', 'the heartbeat brought the initializing session to ready');
    const next = await quiet.tick();
    assert.equal(next.heartbeat?.kind, 'regular', 'after the wake greeting, heartbeats are regular');
  } finally {
    await quiet.stop();
  }

  const { core: spoken } = openTestBot({
    botsHome: home.botsHome,
    id: 'spoken',
    core: { ...fast, life: { random: () => 0 } },
    runtimeEnv: { FAKE_HEARTBEAT_REPLY: 'Good morning! The plants look thirsty.' },
  });
  await spoken.start();
  try {
    await spoken.updateProfile({ heartbeat: zeroDelay });
    const done = waitForEvent(spoken, (event) => event.type === 'turn.completed' && event.workItem.kind === 'heartbeat');
    await spoken.tick();
    const item = await done;
    assert.equal(item.type === 'turn.completed' && item.workItem.result?.text, 'Good morning! The plants look thirsty.');
    const bot = spoken.transcript('home').filter((entry) => entry.kind === 'bot');
    assert.equal(bot.length, 1);
    assert.equal(bot[0]?.origin, 'heartbeat');
    const home1 = (await spoken.listConversations())[0]!;
    assert.equal(home1.unreadCount, 1);
    assert.ok(item.type === 'turn.completed' && item.workItem.notification?.deliveredAt);

    await spoken.sendOwnerMessage('home', 'hi there');
    await waitForEvent(spoken, (event) => event.type === 'turn.completed' && event.workItem.kind === 'owner_message');
    const deferred = await spoken.tick();
    assert.equal(deferred.heartbeat?.action, 'deferred_owner', 'an owner who just spoke is not interrupted');
  } finally {
    await spoken.stop();
  }
});

test('heartbeats pause with the profile and the status shows the next one', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'pause', core: { ...fast, life: { random: () => 0.5 } } });
  await core.start();
  try {
    await core.tick();
    assert.ok(core.status().heartbeat.nextAt, 'a live home session schedules the next heartbeat');
    await core.updateProfile({ heartbeat: { enabled: false } });
    const report = await core.tick();
    assert.equal(report.heartbeat, undefined);
    assert.equal(core.status().heartbeat.enabled, false);
  } finally {
    await core.stop();
  }
});

test('a due schedule runs with no view open, its result persists and duplicates coalesce (FR-21, A2)', async () => {
  const time = clock();
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'sched', core: { ...fast, now: time.now } });
  await core.start();
  try {
    await core.tick();
    const schedule = core.createSchedule({
      conversationId: 'home',
      prompt: 'water the plants',
      kind: 'once',
      at: new Date(time.now().getTime() + 30 * 60_000),
      createdBy: 'owner',
    });
    assert.ok(core.transcript('home').some((entry) => entry.kind === 'system' && entry.text.includes(schedule.receipt)), 'the receipt is in the conversation');
    const early = await core.tick();
    assert.deepEqual(early.firedSchedules, []);
    time.advance(31 * 60_000);
    const done = waitForEvent(core, (event) => event.type === 'turn.completed' && event.workItem.kind === 'schedule');
    const due = await core.tick();
    assert.deepEqual(due.firedSchedules, [schedule.id]);
    const item = await done;
    assert.equal(item.type === 'turn.completed' && item.workItem.state, 'completed');
    assert.equal(item.type === 'turn.completed' && item.workItem.result?.text, 'echo: water the plants');
    assert.equal(item.type === 'turn.completed' && item.workItem.coalesceKey, schedule.id);
    assert.ok(item.type === 'turn.completed' && item.workItem.notification?.deliveredAt, 'a notification was produced');
    assert.equal((await core.listSchedules()).find((record) => record.id === schedule.id)?.state, 'completed');
    assert.equal((await core.listConversations())[0]!.unreadCount, 1);

    const cron = core.createSchedule({ conversationId: 'home', prompt: 'every minute', kind: 'cron', cron: '* * * * *', timezone: 'UTC', createdBy: 'agent' });
    const blocker = waitForEvent(core, (event) => event.type === 'work.updated' && event.workItem.state === 'running' && event.workItem.prompt === 'slow:2500');
    await core.sendOwnerMessage('home', 'slow:2500');
    await blocker;
    time.advance(61_000);
    const fired = await core.tick();
    assert.deepEqual(fired.firedSchedules, [cron.id]);
    time.advance(61_000);
    const again = await core.tick();
    assert.deepEqual(again.firedSchedules, [], 'a still-queued occurrence coalesces (FR-21)');
    await core.cancelSchedule(cron.id);
    assert.equal((await core.listSchedules()).find((record) => record.id === cron.id)?.state, 'cancelled');
    assert.equal(core.listWorkItems().filter((record) => record.coalesceKey === cron.id && record.state === 'cancelled').length, 1, 'the queued occurrence was dropped with the schedule');
  } finally {
    await core.stop();
  }
});

test('cancelling a schedule also cancels its occurrence waiting out a busy retry (FR-21)', async () => {
  const time = clock();
  const { core } = openTestBot({
    botsHome: home.botsHome,
    id: 'sched-retry',
    core: { ...fast, turnRetry: { ...fast.turnRetry, backgroundBusyMs: 700 }, now: time.now },
  });
  await core.start();
  try {
    await core.tick();
    const cron = core.createSchedule({ conversationId: 'home', prompt: 'busy-once stretch', kind: 'cron', cron: '* * * * *', timezone: 'UTC', createdBy: 'agent' });
    const deferred = waitForEvent(core, (event) => event.type === 'work.updated' && event.workItem.coalesceKey === cron.id
      && event.workItem.state === 'queued' && event.workItem.attempts === 1);
    time.advance(61_000);
    assert.deepEqual((await core.tick()).firedSchedules, [cron.id]);
    const waiting = await deferred;
    const itemId = waiting.type === 'work.updated' ? waiting.workItem.id : '';
    time.advance(61_000);
    assert.deepEqual((await core.tick()).firedSchedules, [], 'the occurrence waiting out its retry still coalesces');
    await core.cancelSchedule(cron.id);
    assert.equal(core.getWorkItem(itemId)?.state, 'cancelled');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal(core.getWorkItem(itemId)?.state, 'cancelled', 'the retry timer did not bring it back');
    const state = await fetchFakeState(core);
    assert.equal(state.calls.filter((call) => call.op === 'message' && call.message === 'busy-once stretch').length, 1, 'the retry never ran');
    assert.equal((await core.listSchedules()).find((record) => record.id === cron.id)?.state, 'cancelled');
  } finally {
    await core.stop();
  }
});

test('downtime settles missed schedules by policy and allows one catch-up heartbeat (FR-22, FR-23)', async () => {
  const time = clock();
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'missed', core: { ...fast, now: time.now, life: { intervalMs: 60_000, random: () => 0 } } });
  await core.start();
  try {
    await core.tick();
    const runOnce = core.createSchedule({ conversationId: 'home', prompt: 'take the medicine', kind: 'once', at: new Date(time.now().getTime() + 10 * 60_000), graceMinutes: 240, createdBy: 'owner' });
    const skipper = core.createSchedule({ conversationId: 'home', prompt: 'hourly check', kind: 'cron', cron: '0 * * * *', timezone: 'UTC', missedPolicy: 'skip', createdBy: 'owner' });
    const late = core.createSchedule({ conversationId: 'home', prompt: 'too late', kind: 'once', at: new Date(time.now().getTime() + 5 * 60_000), graceMinutes: 30, createdBy: 'owner' });
    time.advance(3 * 60 * 60_000);
    const done = waitForEvent(core, (event) => event.type === 'turn.completed' && event.workItem.prompt === 'take the medicine');
    const report = await core.tick();
    assert.ok(report.downtimeMs !== null && report.downtimeMs >= 3 * 60 * 60_000);
    const settled = Object.fromEntries(report.settledSchedules.map((entry) => [entry.id, entry.action]));
    assert.equal(settled[runOnce.id], 'run', 'run_once within grace runs once');
    assert.equal(settled[skipper.id], 'skip', 'skip policy skips');
    assert.equal(settled[late.id], 'skip', 'run_once past grace skips');
    assert.ok(core.transcript('home').some((entry) => entry.kind === 'system' && /Skipped \d+ missed run\(s\) of schedule/u.test(entry.text)));
    const item = await done;
    assert.equal(item.type === 'turn.completed' && item.workItem.state, 'completed');
    assert.equal(report.firedSchedules.filter((id) => id === runOnce.id).length, 1, 'never more than one run');
  } finally {
    await core.stop();
  }
});

test('ask_owner waits for the owner, a decision continues the conversation, and silence times out (FR-30)', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'approve', core: { ...fast, life: { awaitingOwnerTimeoutMs: 50 } } });
  await core.start();
  try {
    const waiting = core.askOwner('home', 'May I delete the cache?');
    assert.equal(waiting.state, 'awaiting_owner');
    assert.equal((await core.listConversations())[0]!.unreadCount, 1);
    const done = waitForEvent(core, (event) => event.type === 'turn.completed' && event.workItem.kind === 'owner_message');
    await core.resolveApproval(waiting.id, 'approve');
    assert.equal(core.getWorkItem(waiting.id)?.state, 'completed');
    const followUp = await done;
    assert.match(followUp.type === 'turn.completed' ? followUp.workItem.prompt : '', /Decision on your question "May I delete the cache\?": approved/u);
    await assert.rejects(core.resolveApproval(waiting.id, 'deny'), /not awaiting/u);

    const expiring = core.askOwner('home', 'Second question?');
    await new Promise((resolve) => setTimeout(resolve, 80));
    const report = await core.tick();
    assert.deepEqual(report.expiredApprovals, [expiring.id]);
    assert.equal(core.getWorkItem(expiring.id)?.state, 'failed');
    assert.equal((await core.listSchedules()).length, 0, 'nothing was scheduled by talking about it');
  } finally {
    await core.stop();
  }
});

test('idle notes give their worker back and resume on the next message (FR-13)', async () => {
  const time = clock();
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'idle', core: { ...fast, now: time.now } });
  await core.start();
  try {
    const note = await core.createConversation('Scratch');
    await sendAndWait(core, note.id, 'hello note');
    time.advance(16 * 60_000);
    const report = await core.tick();
    assert.deepEqual(report.sleptNotes, [note.id]);
    assert.equal((await core.listConversations()).find((record) => record.id === note.id)?.attachment.state, 'sleeping');
    const resumed = await sendAndWait(core, note.id, 'back again');
    assert.equal(resumed.state, 'completed');
    const state = await fetchFakeState(core);
    assert.ok(state.calls.some((call) => call.op === 'resume'));
    assert.equal(state.calls.filter((call) => call.op === 'create').length, 2, 'home and the note, nothing rebuilt');
  } finally {
    await core.stop();
  }
});
