import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { BotCore } from '../../src/core/bot.ts';
import type { BotHostEvent, WorkItem } from '../../src/core/types.ts';
import { awakeNow, fakeRuntimeEntry, makeTempHome, openTestBot, sendAndWait, waitForEvent, type TempHome } from '../support/harness.ts';

/**
 * SPEC-011 on the fake runtime: the heartbeat's daily rhythm, its back-off
 * while the owner does not answer (kept across a restart), and `assist`
 * reviewing the bot's own notes into its direct message.
 */

let home: TempHome;
before(() => {
  home = makeTempHome('cats-bot-heartbeat-');
});
after(() => home.cleanup());

const fast = {
  turnRetry: { ownerBusyMs: 200, backgroundBusyMs: 200, runtimeUnavailableMs: 200 },
  runtimeRestartDelaysMs: [300, 300],
};
const MINUTE = 60_000;

function clock(start: number) {
  const began = Date.now();
  let offset = 0;
  return {
    now: () => new Date(start + offset + (Date.now() - began)),
    advance(ms: number) {
      offset += ms;
    },
  };
}

function heartbeatDone(core: BotCore): Promise<WorkItem> {
  return waitForEvent(core, (event) => event.type === 'turn.completed' && event.workItem.kind === 'heartbeat')
    .then((event) => (event as Extract<BotHostEvent, { type: 'turn.completed' }>).workItem);
}

/** One tick that queues a heartbeat, and the finished heartbeat. */
async function beat(core: BotCore): Promise<{ kind: string | undefined; item: WorkItem }> {
  const done = heartbeatDone(core);
  const report = await core.tick();
  assert.equal(report.heartbeat?.action, 'queued', JSON.stringify(report.heartbeat));
  return { kind: report.heartbeat?.kind, item: await done };
}

test('unanswered messages double the wait, survive a restart, and stop after five until the owner writes (SPEC-011 FR-9, FR-10)', async () => {
  const time = clock(Date.now());
  const rhythm = awakeNow(time.now(), { sinceWake: 60, untilBed: 20 * 60 });
  const options = {
    botsHome: home.botsHome,
    id: 'backoff',
    core: { ...fast, now: time.now, life: { random: () => 0 } },
    runtimeEnv: { FAKE_HEARTBEAT_REPLY: 'Still there? I found a thing.' },
  };
  const { core, root } = openTestBot(options);
  await core.start();
  try {
    await core.updateProfile({
      heartbeat: { mode: 'companion', wakeMinMinutes: 0, wakeMaxMinutes: 0, regularMinMinutes: 10, regularMaxMinutes: 10, ...rhythm },
    });
    const first = await beat(core);
    assert.equal(first.kind, 'wake', 'the first heartbeat of the day greets');
    let status = core.status().heartbeat;
    assert.equal(status.unanswered, 1);
    assert.equal(Date.parse(status.nextAt!) - time.now().getTime() > 19 * MINUTE, true, 'one unanswered message: twice the wait');
    for (const [count, wait] of [[2, 20], [3, 40], [4, 80], [5, 160]] as const) {
      time.advance(wait * MINUTE);
      const next = await beat(core);
      assert.equal(next.kind, 'regular');
      status = core.status().heartbeat;
      assert.equal(status.unanswered, count);
    }
    assert.equal(status.waitingForOwner, true);
    assert.equal(status.nextAt, null, 'nothing is drawn while it waits for the owner');
    time.advance(24 * 60 * MINUTE);
    assert.equal((await core.tick()).heartbeat?.action, 'waiting_for_owner');
  } finally {
    await core.stop();
  }

  // A restart is not an answer.
  const reopened = BotCore.open({
    root,
    log: () => {},
    runtime: { runtimeEntry: fakeRuntimeEntry, readyTimeoutMs: 15_000, stopTimeoutMs: 3_000, env: { ...process.env, ...options.runtimeEnv } },
    ...options.core,
    life: { startupDelayMs: 3_600_000, intervalMs: 3_600_000, random: () => 0 },
  });
  await reopened.start();
  try {
    assert.equal((await reopened.tick()).heartbeat?.action, 'waiting_for_owner', 'the count is read back from life.json');
    assert.equal(reopened.status().heartbeat.unanswered, 5);

    await sendAndWait(reopened, 'home', 'sorry, I was away');
    const answered = await reopened.tick();
    assert.notEqual(answered.heartbeat?.action, 'waiting_for_owner', 'the owner answered: heartbeats resume');
    assert.equal(reopened.status().heartbeat.unanswered, 0);
    assert.equal(reopened.status().heartbeat.waitingForOwner, false);
    const nextAt = Date.parse(reopened.status().heartbeat.nextAt!);
    assert.ok(nextAt - time.now().getTime() <= 11 * MINUTE, 'redrawn at the ordinary pace, without the back-off');
  } finally {
    await reopened.stop();
  }
});

test('rest hours hold heartbeats until the wake time; companion says good night once and greets in the morning (SPEC-011 FR-5 to FR-8)', async () => {
  const time = clock(Date.now());
  // Bedtime in 30 minutes, the wake time five hours ago: no greeting is due now.
  const rhythm = awakeNow(time.now(), { sinceWake: 5 * 60, untilBed: 30 });
  const { core } = openTestBot({
    botsHome: home.botsHome,
    id: 'rhythm',
    core: { ...fast, now: time.now, life: { random: () => 0 } },
    runtimeEnv: { FAKE_HEARTBEAT_REPLY: 'Good night!' },
  });
  await core.start();
  try {
    await core.updateProfile({
      heartbeat: { mode: 'companion', wakeMinMinutes: 3, wakeMaxMinutes: 3, regularMinMinutes: 600, regularMaxMinutes: 600, ...rhythm },
    });
    const awake = await core.tick();
    assert.equal(awake.heartbeat, undefined, 'the next heartbeat is ten hours away');
    assert.equal(core.status().heartbeat.phase, 'awake_hours');

    time.advance(35 * MINUTE);
    assert.equal(core.status().heartbeat.phase, 'rest_hours');
    const night = await beat(core);
    assert.equal(night.kind, 'bedtime');
    assert.equal(core.transcript('home').filter((entry) => entry.origin === 'heartbeat').length, 1, 'it said good night');
    assert.equal(core.status().heartbeat.unanswered, 0, 'a good night expects no answer');
    time.advance(5 * MINUTE);
    assert.equal((await core.tick()).heartbeat, undefined, 'one good night a night');

    time.advance(10 * 60 * MINUTE);
    const held = await core.tick();
    assert.equal(held.heartbeat?.action, 'deferred_rest', 'a heartbeat due in rest hours waits');
    const wakeAt = Date.parse(core.status().heartbeat.nextAt!);
    // Tomorrow's wake time falls at the same minute of the window, plus the wake delay.
    assert.ok(wakeAt > time.now().getTime());

    time.advance(wakeAt - time.now().getTime() + MINUTE);
    const morning = await beat(core);
    assert.equal(morning.kind, 'wake', 'the morning greeting');
  } finally {
    await core.stop();
  }

  const { core: assist } = openTestBot({
    botsHome: home.botsHome,
    id: 'rhythm-assist',
    core: { ...fast, now: time.now, life: { random: () => 0 } },
  });
  await assist.start();
  try {
    const rest = awakeNow(time.now(), { sinceWake: 5 * 60, untilBed: 1 });
    await assist.updateProfile({ heartbeat: { mode: 'assist', regularMinMinutes: 600, regularMaxMinutes: 600, ...rest } });
    await assist.tick();
    time.advance(5 * MINUTE);
    assert.equal((await assist.tick()).heartbeat, undefined, 'assist does not say good night');
  } finally {
    await assist.stop();
  }
});

test('assist looks over its own notes and follows up in its direct message; nothing new means no turn (SPEC-011 FR-13, FR-14)', async () => {
  const time = clock(Date.now());
  const { core } = openTestBot({
    botsHome: home.botsHome,
    id: 'assist',
    core: { ...fast, now: time.now, life: { random: () => 0 } },
  });
  await core.start();
  try {
    await core.updateProfile({
      heartbeat: { mode: 'auto', wakeMinMinutes: 0, wakeMaxMinutes: 0, regularMinMinutes: 0, regularMaxMinutes: 0, ...awakeNow(time.now(), { sinceWake: 5 * 60 }) },
    });
    assert.equal(core.status().heartbeat.mode, 'companion', 'auto keeps company for an ordinary cat bot');
    core.setBossCat(true);
    assert.equal(core.status().heartbeat.mode, 'assist', 'auto assists for the Boss Cat');

    const empty = await core.tick();
    assert.equal(empty.heartbeat?.action, 'skipped_nothing_to_review', 'nothing to look over: no turn');

    const note = await core.createConversation('Parser refactor');
    await sendAndWait(core, note.id, 'please split the parser into lexer and grammar files');
    time.advance(11 * MINUTE);
    const looked = await beat(core);
    assert.equal(looked.item.conversationId, 'home', 'the follow-up goes to the direct message');
    assert.match(looked.item.prompt, /not for small talk/u);
    assert.match(looked.item.prompt, /Note "Parser refactor"/u);
    assert.match(looked.item.prompt, /Owner: please split the parser into lexer and grammar files/u);
    assert.equal(core.transcript('home').filter((entry) => entry.kind === 'bot').length, 0, 'a quiet review leaves no message');

    time.advance(MINUTE);
    assert.equal((await core.tick()).heartbeat?.action, 'skipped_nothing_to_review', 'nothing new since a quiet review');

    await sendAndWait(core, note.id, 'also add tests for the lexer');
    time.advance(11 * MINUTE);
    const again = await beat(core);
    assert.match(again.item.prompt, /also add tests for the lexer/u);
  } finally {
    await core.stop();
  }
});

test('a restart keeps the count and the schedule: an overdue heartbeat waits the wake delay and greets no second time (SPEC-011 FR-7, FR-11)', async () => {
  const time = clock(Date.now());
  const options = {
    botsHome: home.botsHome,
    id: 'restart',
    core: { ...fast, now: time.now, life: { random: () => 0 } },
    runtimeEnv: { FAKE_HEARTBEAT_REPLY: 'Morning! Shall we go on with the parser?' },
  };
  const { core, root } = openTestBot(options);
  await core.start();
  try {
    await core.updateProfile({
      heartbeat: { mode: 'companion', wakeMinMinutes: 0, wakeMaxMinutes: 0, regularMinMinutes: 10, regularMaxMinutes: 10, ...awakeNow(time.now(), { untilBed: 20 * 60 }) },
    });
    assert.equal((await beat(core)).kind, 'wake');
    assert.equal(core.status().heartbeat.unanswered, 1);
    await core.updateProfile({ heartbeat: { wakeMinMinutes: 3, wakeMaxMinutes: 3 } });
    await core.tick();
  } finally {
    await core.stop();
  }

  // Closed for an hour: the heartbeat due 20 minutes after the greeting is overdue.
  time.advance(60 * MINUTE);
  const reopened = BotCore.open({
    root,
    log: () => {},
    runtime: { runtimeEntry: fakeRuntimeEntry, readyTimeoutMs: 15_000, stopTimeoutMs: 3_000, env: { ...process.env, ...options.runtimeEnv } },
    ...options.core,
    life: { startupDelayMs: 3_600_000, intervalMs: 3_600_000, random: () => 0 },
  });
  await reopened.start();
  try {
    assert.equal(reopened.status().heartbeat.unanswered, 1, 'the count is read back');
    const launch = await reopened.tick();
    assert.equal(launch.heartbeat, undefined, 'nothing is said the moment the app starts');
    const heldUntil = Date.parse(reopened.status().heartbeat.nextAt!);
    assert.ok(heldUntil - time.now().getTime() > 2 * MINUTE && heldUntil - time.now().getTime() <= 3 * MINUTE);
    time.advance(3 * MINUTE + 1_000);
    const later = await beat(reopened);
    assert.equal(later.kind, 'regular', 'one greeting a day, and none while a message is unanswered');
    assert.equal(reopened.status().heartbeat.unanswered, 2);
  } finally {
    await reopened.stop();
  }
});

test('a good morning deferred because the owner is talking is not said later (SPEC-011 FR-7)', async () => {
  const time = clock(Date.now());
  const { core } = openTestBot({
    botsHome: home.botsHome,
    id: 'deferred-wake',
    core: { ...fast, now: time.now, life: { random: () => 0 } },
  });
  await core.start();
  try {
    await core.updateProfile({
      heartbeat: { mode: 'companion', wakeMinMinutes: 0, wakeMaxMinutes: 0, regularMinMinutes: 0, regularMaxMinutes: 0, ...awakeNow(time.now()) },
    });
    await sendAndWait(core, 'home', 'morning, I am already here');
    const deferred = await core.tick();
    assert.deepEqual(deferred.heartbeat, { kind: 'wake', action: 'deferred_owner' });
    time.advance(11 * MINUTE);
    assert.equal((await beat(core)).kind, 'regular');
  } finally {
    await core.stop();
  }
});
