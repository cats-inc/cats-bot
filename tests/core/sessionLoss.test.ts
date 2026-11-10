import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { REBUILT_SESSION_NOTICE, isProviderSessionUnavailable } from '../../src/core/runtime/providerSession.ts';
import type { BotCore } from '../../src/core/bot.ts';
import { fetchFakeState, makeTempHome, openTestBot, sendAndWait, waitForEvent, type TempHome } from '../support/harness.ts';

/**
 * SPEC-001 FR-11 / FR-18: the conversation is the core's, the provider session
 * is only a way to continue it. When the provider session can no longer be
 * continued, the core rebuilds a Runtime session from its own transcript, in
 * the same cwd, tells the owner, and sends the turn again — once.
 */

let home: TempHome;
before(() => {
  home = makeTempHome('cats-bot-session-loss-');
});
after(() => home.cleanup());

const fastRetries = { turnRetry: { ownerBusyMs: 200, backgroundBusyMs: 200, runtimeUnavailableMs: 200 } };

type Call = { op: string; id?: string; message?: string; body?: Record<string, unknown> };

async function calls(core: BotCore): Promise<Call[]> {
  return (await fetchFakeState(core)).calls as Call[];
}

const creates = (all: Call[]) => all.filter((call) => call.op === 'create');

async function waitForClose(core: BotCore, sessionId: string | null): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await calls(core)).some((call) => call.op === 'close' && call.id === sessionId)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`session ${sessionId} was not closed`);
}

async function homeAttachment(core: BotCore) {
  return (await core.listConversations()).find((record) => record.role === 'home')!.attachment;
}

test('the typed code and the known provider texts mean the provider session is gone', () => {
  assert.equal(isProviderSessionUnavailable('anything', 'provider_session_unavailable'), true);
  assert.equal(isProviderSessionUnavailable(
    'No saved copy of session 01a1c2b4-9e24-74c1-b18d-48a11e123bb3 was found remotely. Check the id, or run `grok --resume` to pick a session.',
  ), true);
  assert.equal(isProviderSessionUnavailable('No saved copy of session abc was found. Check the id.'), true);
  assert.equal(isProviderSessionUnavailable('No conversation found with session ID: 1234'), true);
  assert.equal(isProviderSessionUnavailable('provider exploded'), false);
  assert.equal(isProviderSessionUnavailable('provider exploded', 'session_busy'), false);
  assert.equal(isProviderSessionUnavailable(null), false);
});

test('a session the CLI can no longer find is rebuilt from the transcript in the same cwd and the turn is sent again', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'lost-grok', core: fastRetries });
  await core.start();
  try {
    assert.equal((await sendAndWait(core, 'home', 'remember the kettle')).state, 'completed');
    assert.equal((await sendAndWait(core, 'home', 'forget-session:grok')).state, 'completed');
    const lost = (await homeAttachment(core)).sessionId;

    const item = await sendAndWait(core, 'home', 'are you there');
    assert.equal(item.state, 'completed', item.error);
    assert.equal(item.result?.text, 'echo: are you there');
    const attachment = await homeAttachment(core);
    assert.notEqual(attachment.sessionId, lost);
    assert.equal(attachment.state, 'ready');
    assert.equal(item.run?.sessionId, attachment.sessionId);

    const all = await calls(core);
    const made = creates(all);
    assert.equal(made.length, 2);
    const instructions = String(made[1]!.body!.instructions);
    assert.match(instructions, /Owner: remember the kettle/u, 'the rebuilt session carries the handoff pack');
    assert.doesNotMatch(instructions, /No saved copy|Error:/u, 'errors are not handed on');
    assert.doesNotMatch(instructions, /are you there/u, 'the pending prompt arrives as the message, not in the pack');
    assert.equal(made[1]!.body!.cwd, made[0]!.body!.cwd, 'the rebuilt session runs in the same cwd');
    assert.equal(all.filter((call) => call.op === 'message' && call.message === 'are you there').length, 2,
      'sent to the lost session once and to the rebuilt one once');
    await waitForClose(core, lost);

    const transcript = core.transcript('home');
    assert.equal(transcript.filter((entry) => entry.kind === 'owner' && entry.text === 'are you there').length, 1);
    assert.equal(transcript.filter((entry) => entry.kind === 'system' && entry.text === REBUILT_SESSION_NOTICE).length, 1);
    assert.equal(transcript.at(-1)?.text, 'echo: are you there');
  } finally {
    await core.stop();
  }
});

test('Runtime\'s typed code rebuilds at once, in the stream, on a send and on a resume', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'lost-typed', core: fastRetries });
  await core.start();
  try {
    await sendAndWait(core, 'home', 'hello');
    await sendAndWait(core, 'home', 'forget-session:typed');
    const inStream = await sendAndWait(core, 'home', 'still there?');
    assert.equal(inStream.state, 'completed', inStream.error);
    assert.equal(creates(await calls(core)).length, 2, 'the in-stream code rebuilt the session');

    // Runtime already closed the session and answers 410 with the code.
    await sendAndWait(core, 'home', 'gone-after-reply');
    const onSend = await sendAndWait(core, 'home', 'and now?');
    assert.equal(onSend.state, 'completed', onSend.error);
    assert.equal(creates(await calls(core)).length, 3, 'the 410 rebuilt the session');

    // The tick finds the session closed, resumes it, and Runtime's 410 on the resume rebuilds it.
    await sendAndWait(core, 'home', 'gone-after-reply');
    const closed = (await homeAttachment(core)).sessionId;
    await core.tick();
    const all = await calls(core);
    assert.ok(all.some((call) => call.op === 'resume' && call.id === closed), 'a closed session is resumed first');
    assert.equal(creates(all).length, 4, 'the failed resume rebuilt the session in the same pass');
    const attachment = await homeAttachment(core);
    assert.notEqual(attachment.sessionId, closed);
    assert.ok(attachment.state === 'ready' || attachment.state === 'initializing', attachment.state);
    const transcript = core.transcript('home');
    assert.equal(transcript.filter((entry) => entry.kind === 'system' && entry.text === REBUILT_SESSION_NOTICE).length, 3);
    assert.equal(transcript.some((entry) => entry.kind === 'error' && /Could not resume/u.test(entry.text)), false,
      'a gone provider session is not reported as a resume failure');
  } finally {
    await core.stop();
  }
});

test('the same failure twice in one session rebuilds it even when the error is unknown', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'lost-opaque', core: fastRetries });
  await core.start();
  try {
    await sendAndWait(core, 'home', 'forget-session:opaque');
    const first = await sendAndWait(core, 'home', 'first');
    assert.equal(first.state, 'failed');
    assert.equal(first.error, 'provider transport reset');
    assert.equal(creates(await calls(core)).length, 1, 'one failure is the turn\'s, not yet the session\'s');

    const second = await sendAndWait(core, 'home', 'second');
    assert.equal(second.state, 'completed', second.error);
    assert.equal(second.result?.text, 'echo: second');
    assert.equal(creates(await calls(core)).length, 2);
  } finally {
    await core.stop();
  }
});

test('a failure a rebuilt session repeats is not rebuilt again until a turn completes', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'broken-everywhere', core: fastRetries });
  await core.start();
  try {
    await sendAndWait(core, 'home', 'break-every-session');
    assert.equal((await sendAndWait(core, 'home', 'a')).state, 'failed');
    assert.equal(creates(await calls(core)).length, 1);
    assert.equal((await sendAndWait(core, 'home', 'b')).state, 'failed');
    assert.equal(creates(await calls(core)).length, 2, 'rebuilt once');
    assert.equal((await sendAndWait(core, 'home', 'c')).state, 'failed');
    assert.equal((await sendAndWait(core, 'home', 'd')).state, 'failed');
    assert.equal(creates(await calls(core)).length, 2, 'never again while the failure lasts');
    assert.equal(core.transcript('home').filter((entry) => entry.kind === 'system' && entry.text === REBUILT_SESSION_NOTICE).length, 1);

    assert.equal((await sendAndWait(core, 'home', 'repair')).state, 'completed');
    await sendAndWait(core, 'home', 'forget-session:opaque');
    await sendAndWait(core, 'home', 'x');
    assert.equal((await sendAndWait(core, 'home', 'y')).state, 'completed', 'a completed turn re-arms the rebuild');
    assert.equal(creates(await calls(core)).length, 3);
  } finally {
    await core.stop();
  }
});

test('a heartbeat rebuilds a lost session and leaves no error behind (FR-25)', async () => {
  const start = Date.now();
  let offset = 0;
  const now = () => new Date(start + offset + (Date.now() - start));
  const zeroDelay = { enabled: true, wakeMinMinutes: 0, wakeMaxMinutes: 0, regularMinMinutes: 0, regularMaxMinutes: 0 };
  const { core } = openTestBot({
    botsHome: home.botsHome,
    id: 'lost-heartbeat',
    core: { ...fastRetries, now, life: { random: () => 0 } },
  });
  await core.start();
  const heartbeat = async () => {
    offset += 11 * 60_000; // past the quiet time after an owner message
    const done = waitForEvent(core, (event) => event.type === 'turn.completed' && event.workItem.kind === 'heartbeat');
    const report = await core.tick();
    assert.equal(report.heartbeat?.action, 'queued');
    const event = await done;
    return event.type === 'turn.completed' ? event.workItem : null;
  };
  try {
    await core.updateProfile({ heartbeat: zeroDelay });
    await sendAndWait(core, 'home', 'forget-session:grok');
    const rebuilt = await heartbeat();
    assert.equal(rebuilt?.state, 'completed', rebuilt?.error);
    assert.equal(creates(await calls(core)).length, 2);

    await sendAndWait(core, 'home', 'forget-session:opaque');
    const failed = await heartbeat();
    assert.equal(failed?.state, 'failed');

    const transcript = core.transcript('home');
    assert.deepEqual(transcript.filter((entry) => entry.kind === 'error'), [], 'heartbeat failures stay out of the conversation');
    assert.equal(transcript.filter((entry) => entry.kind === 'system' && entry.text === REBUILT_SESSION_NOTICE).length, 1,
      'the owner still reads that the conversation moved to a new session');
  } finally {
    await core.stop();
  }
});
