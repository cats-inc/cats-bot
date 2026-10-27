import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { after, before, test } from 'node:test';

import { BotCore, BotInstanceRunningError } from '../../src/core/bot.ts';
import { appendJournal, readJournal } from '../../src/core/store/journal.ts';
import { writeHandoff } from '../../src/core/store/lock.ts';
import { botPathsFor, conversationFile, transcriptFile } from '../../src/core/store/paths.ts';
import { createWorkItem } from '../../src/core/queue/workItems.ts';
import type { BotHostEvent } from '../../src/core/types.ts';
import { fetchFakeState, makeTempHome, openTestBot, sendAndWait, waitForEvent, type TempHome } from '../support/harness.ts';

/**
 * The core against the fake runtime, started through the real supervisor:
 * SPEC-001 A1 behaviours that do not need a provider CLI.
 */

let home: TempHome;
before(() => {
  home = makeTempHome('cats-bots-core-');
});
after(() => home.cleanup());

const fastRetries = { turnRetry: { ownerBusyMs: 200, backgroundBusyMs: 200, runtimeUnavailableMs: 200 } };

test('an owner message becomes a completed work item with a streamed reply', async () => {
  const { core, root } = openTestBot({ botsHome: home.botsHome, id: 'basic', core: fastRetries, profile: { instructions: 'You are Mochi.' } });
  const events: BotHostEvent[] = [];
  core.subscribe((event) => events.push(event));
  await core.start();
  try {
    assert.equal(core.runtimeState(), 'ready');
    const conversations = await core.listConversations();
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0]?.role, 'home');

    const item = await sendAndWait(core, 'home', 'hello');
    assert.equal(item.state, 'completed');
    assert.equal(item.result?.text, 'echo: hello');
    assert.equal(item.configRevision, 1);
    assert.ok(item.run?.sessionId);
    assert.equal(item.notification?.deliveredAt !== null, true);

    const transcript = core.transcript('home');
    assert.deepEqual(transcript.map((entry) => [entry.kind, entry.text]), [
      ['owner', 'hello'],
      ['bot', 'echo: hello'],
    ]);
    const deltas = events.filter((event) => event.type === 'turn.delta');
    assert.ok(deltas.some((event) => event.type === 'turn.delta' && event.entry.kind === 'bot' && event.entry.text === 'echo: hello'));

    const home1 = (await core.listConversations())[0]!;
    assert.equal(home1.attachment.state, 'ready');
    assert.equal(home1.attachment.provider, 'claude');
    assert.equal(home1.unreadCount, 1, 'no view is open, so the reply is unread');
    await core.markSeen('home');
    assert.equal((await core.listConversations())[0]?.unreadCount, 0);

    const state = await fetchFakeState(core);
    const create = state.calls.find((call) => call.op === 'create') as { body: Record<string, unknown> };
    assert.equal(create.body.provider, 'claude');
    assert.equal(create.body.instructions, 'You are Mochi.', 'the first session gets the persona and no handoff');
    assert.equal(create.body.permissionMode, 'default');
    assert.equal(create.body.workspaceKind, 'source');
    assert.ok(existsSync(botPathsFor(root).journal));
    assert.ok(existsSync(transcriptFile(botPathsFor(root), home1.id)));

    const history = await core.sessionHistory('home');
    assert.deepEqual(history, [{ role: 'user', text: 'hello' }, { role: 'assistant', text: 'echo: hello' }]);
  } finally {
    await core.stop();
  }
});

test('a view open in the background leaves a reply unread; only a focused view reads it (SPEC-002 FR-7)', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'views', core: fastRetries });
  await core.start();
  const unread = async () => (await core.listConversations()).find((record) => record.role === 'home')!.unreadCount;
  try {
    // A desktop or wallpaper note is open the whole time without the owner looking at it.
    await core.openView('home');
    await sendAndWait(core, 'home', 'one');
    assert.equal(await unread(), 1, 'open but not focused');
    await core.markSeen('home');
    await core.setViewFocused('home', true);
    await sendAndWait(core, 'home', 'two');
    assert.equal(await unread(), 0, 'focused');
    await core.setViewFocused('home', false);
    await sendAndWait(core, 'home', 'three');
    assert.equal(await unread(), 1, 'focus moved to another window');
    await core.setViewFocused('home', true);
    await core.closeView('home');
    await sendAndWait(core, 'home', 'four');
    assert.equal(await unread(), 2, 'closing the view drops its focus');
  } finally {
    await core.stop();
  }
});

test('tool events, errors and interrupted streams are classified (FR-18)', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'events', core: fastRetries });
  await core.start();
  try {
    const tool = await sendAndWait(core, 'home', 'tool please');
    assert.equal(tool.state, 'completed');
    const kinds = core.transcript('home').map((entry) => entry.kind);
    assert.deepEqual(kinds, ['owner', 'tool_use', 'tool_result', 'bot']);
    assert.equal(core.transcript('home')[1]!.text, 'Read file.txt', 'text the runtime gives is kept');

    // SPEC-003 FR-4: input that arrives only as toolArgs is kept as JSON, clipped like results.
    await sendAndWait(core, 'home', 'edit the notes');
    const call = core.transcript('home').find((entry) => entry.kind === 'tool_use' && entry.toolName === 'Write')!;
    assert.ok(call.text.startsWith('{\n  "file_path": "notes.md",\n  "content": "yyy'), call.text.slice(0, 60));
    assert.equal(call.text.length, 2001);
    assert.ok(call.text.endsWith('…'));

    const failed = await sendAndWait(core, 'home', 'error now');
    assert.equal(failed.state, 'failed');
    assert.equal(failed.error, 'provider exploded');

    const interrupted = await sendAndWait(core, 'home', 'interrupt');
    assert.equal(interrupted.state, 'interrupted');
  } finally {
    await core.stop();
  }
});

test('a busy session is retried, a lost worker is resumed and an exited worker is rebuilt (FR-17, FR-18)', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'recover', core: fastRetries });
  await core.start();
  try {
    const busy = await sendAndWait(core, 'home', 'busy-once');
    assert.equal(busy.state, 'completed', busy.error);
    assert.equal(busy.attempts, 2);
    assert.ok(core.transcript('home').some((entry) => entry.kind === 'system' && /Waiting/u.test(entry.text)));

    const before = (await core.listConversations())[0]!.attachment.sessionId;
    const resumed = await sendAndWait(core, 'home', 'noworker-once');
    assert.equal(resumed.state, 'completed');
    const state1 = await fetchFakeState(core);
    assert.ok(state1.calls.some((call) => call.op === 'resume'), 'the session was resumed, not replaced');
    assert.equal((await core.listConversations())[0]!.attachment.sessionId, before);

    const rebuilt = await sendAndWait(core, 'home', 'exit-once');
    assert.equal(rebuilt.state, 'completed');
    const after1 = (await core.listConversations())[0]!.attachment;
    assert.notEqual(after1.sessionId, before, 'a 410 replaces the session');
    const state2 = await fetchFakeState(core);
    const creates = state2.calls.filter((call) => call.op === 'create') as Array<{ body: Record<string, unknown> }>;
    assert.equal(creates.length, 2);
    assert.match(String(creates[1]!.body.instructions), /Owner: busy-once/u, 'the replacement carries the handoff pack');
  } finally {
    await core.stop();
  }
});

test('cancelTurn stops a running turn and marks it cancelled (FR-16)', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'cancel', core: fastRetries });
  await core.start();
  try {
    const running = waitForEvent(core, (event) => event.type === 'work.updated' && event.workItem.state === 'running');
    const item = await core.sendOwnerMessage('home', 'slow:10000');
    await running;
    await new Promise((resolve) => setTimeout(resolve, 150));
    const done = waitForEvent(core, (event) => event.type === 'turn.completed' && event.workItem.id === item.id);
    await core.cancelTurn('home');
    const finished = await done;
    assert.equal(finished.type === 'turn.completed' && finished.workItem.state, 'cancelled');
    const state = await fetchFakeState(core);
    assert.ok(state.calls.some((call) => call.op === 'cancel'));

    const next = await sendAndWait(core, 'home', 'after cancel');
    assert.equal(next.state, 'completed', 'the conversation continues after a cancel');
  } finally {
    await core.stop();
  }
});

test('a restart marks running work interrupted and never reruns it (FR-28)', async () => {
  const { core, root } = openTestBot({ botsHome: home.botsHome, id: 'restart', core: fastRetries });
  await core.start();
  const first = await sendAndWait(core, 'home', 'before restart');
  assert.equal(first.state, 'completed');
  await core.stop();

  const paths = botPathsFor(root);
  const stale = createWorkItem({ kind: 'owner_message', source: 'owner', conversationId: first.conversationId, prompt: 'lost turn' }, new Date());
  appendJournal(paths, { type: 'work', at: new Date().toISOString(), item: { ...stale, state: 'running', attempts: 1 } });
  const queued = createWorkItem({ kind: 'owner_message', source: 'owner', conversationId: first.conversationId, prompt: 'still queued' }, new Date());
  appendJournal(paths, { type: 'work', at: new Date().toISOString(), item: queued });

  const reopened = BotCore.open({ root, log: () => {}, runtime: { runtimeEntry: (await import('../support/harness.ts')).fakeRuntimeEntry, readyTimeoutMs: 15_000, stopTimeoutMs: 3_000 }, life: { startupDelayMs: 3_600_000, intervalMs: 3_600_000 }, ...fastRetries });
  const done = waitForEvent(reopened, (event) => event.type === 'turn.completed' && event.workItem.id === queued.id);
  const recovered = waitForEvent(reopened, (event) => event.type === 'work.awaitingOwner' && event.workItem.id === stale.id);
  await reopened.start();
  try {
    const finished = await done;
    assert.equal(finished.type === 'turn.completed' && finished.workItem.state, 'completed', 'queued work survives a restart');
    // FR-28: the new runtime has no evidence of the lost turn, so the owner decides; it is never rerun.
    await recovered;
    assert.equal(reopened.getWorkItem(stale.id)?.state, 'awaiting_owner');
    const journal = readJournal(paths);
    assert.equal(journal.workItems.get(stale.id)?.state, 'awaiting_owner');
    assert.ok(journal.entries.some((entry) => entry.type === 'work' && entry.item.id === stale.id && entry.item.state === 'interrupted'), 'it passed through interrupted first');
    const state = await fetchFakeState(reopened);
    assert.ok(!state.calls.some((call) => call.op === 'message' && call.message === 'lost turn'), 'the interrupted turn was not replayed');
    const home1 = (await reopened.listConversations())[0]!;
    assert.equal(home1.attachment.state, 'ready');
    const texts = reopened.transcript('home').filter((entry) => entry.kind !== 'system').map((entry) => entry.text);
    assert.deepEqual(texts, ['before restart', 'echo: before restart', 'echo: still queued']);
  } finally {
    await reopened.stop();
  }
});

test('the run is journaled before the prompt is sent, with its history baseline (FR-28)', async () => {
  const { core, root } = openTestBot({ botsHome: home.botsHome, id: 'run-journal', core: fastRetries });
  await core.start();
  try {
    const first = await sendAndWait(core, 'home', 'first turn');
    assert.equal(first.run?.historyBaseline, 0, 'a new session starts with an empty history');
    const running = waitForEvent(core, (event) => event.type === 'work.updated'
      && event.workItem.state === 'running' && event.workItem.run !== undefined);
    const slow = await core.sendOwnerMessage('home', 'slow:800');
    await running;
    const done = waitForEvent(core, (event) => event.type === 'turn.completed' && event.workItem.id === slow.id);
    const journaled = readJournal(botPathsFor(root)).workItems.get(slow.id);
    assert.equal(journaled?.state, 'running');
    assert.equal(journaled?.run?.sessionId, first.run?.sessionId, 'a crash now would still know the session');
    assert.equal(journaled?.run?.historyBaseline, 2, 'the first turn left two messages before this prompt');
    assert.ok(journaled?.run?.startedAt);
    await done;
  } finally {
    await core.stop();
  }
});

test('a global target change makes the attachment stale and rebuilds with a handoff (FR-27)', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'retarget', core: fastRetries });
  await core.start();
  try {
    await sendAndWait(core, 'home', 'the secret word is pumpkin');
    const first = (await core.listConversations())[0]!.attachment;
    const profile = await core.updateProfile({ executionTarget: { provider: 'claude', model: 'sonnet' } });
    assert.equal(profile.configRevision, 2);
    assert.equal((await core.listConversations())[0]!.attachment.state, 'stale');
    const item = await sendAndWait(core, 'home', 'instructions?');
    assert.equal(item.state, 'completed');
    assert.equal(item.configRevision, 2);
    assert.match(item.result?.text ?? '', /pumpkin/u, 'the new session received the handoff pack');
    const second = (await core.listConversations())[0]!.attachment;
    assert.notEqual(second.sessionId, first.sessionId);
    assert.equal(second.model, 'sonnet');
    const state = await fetchFakeState(core);
    assert.ok(!state.calls.some((call) => call.op === 'resume'), 'a stale attachment is never resumed');
    assert.ok(core.transcript('home').some((entry) => entry.kind === 'system' && /now runs on claude \(sonnet\)/u.test(entry.text)));
  } finally {
    await core.stop();
  }
});

test('a second instance is refused and can hand a message to the running one (FR-3)', async () => {
  const { core, root } = openTestBot({ botsHome: home.botsHome, id: 'single', core: fastRetries });
  await core.start();
  try {
    const second = BotCore.open({ root, log: () => {} });
    await assert.rejects(second.start(), BotInstanceRunningError);
    const done = waitForEvent(core, (event) => event.type === 'turn.completed');
    writeHandoff(botPathsFor(root), { kind: 'say', conversationId: 'home', text: 'via handoff' });
    const finished = await done;
    assert.equal(finished.type === 'turn.completed' && finished.workItem.result?.text, 'echo: via handoff');
  } finally {
    await core.stop();
  }
});

test('notes are separate conversations and deleting one removes its session and files (FR-14)', async () => {
  const { core, root } = openTestBot({ botsHome: home.botsHome, id: 'notes', core: fastRetries });
  await core.start();
  try {
    const note = await core.createConversation('Scratch');
    const item = await sendAndWait(core, note.id, 'in the note');
    assert.equal(item.state, 'completed');
    const sessions = (await core.listConversations()).map((record) => record.attachment.sessionId);
    assert.equal(sessions.length, 2);
    await assert.rejects(core.deleteConversation('home'), /cannot be deleted/u);
    await core.deleteConversation(note.id);
    assert.equal((await core.listConversations()).length, 1);
    assert.equal(existsSync(conversationFile(botPathsFor(root), note.id)), false);
    assert.equal(existsSync(transcriptFile(botPathsFor(root), note.id)), false);
    const state = await fetchFakeState(core);
    assert.ok(state.calls.some((call) => call.op === 'close'));
    assert.ok(state.calls.some((call) => call.op === 'delete'));
  } finally {
    await core.stop();
  }
});

test('a crashed runtime is restarted with backoff and the home session is rebuilt (FR-6)', async () => {
  const { core } = openTestBot({
    botsHome: home.botsHome,
    id: 'crash',
    core: { ...fastRetries, runtimeRestartDelaysMs: [300, 300] },
    runtimeEnv: { FAKE_CRASH_AFTER_MS: '1500' },
  });
  await core.start();
  try {
    const first = await sendAndWait(core, 'home', 'before crash');
    assert.equal(first.state, 'completed');
    await waitForEvent(core, (event) => event.type === 'runtime.status' && event.state === 'failed', 10_000);
    assert.equal((await core.listConversations())[0]!.attachment.state, 'closed');
    await waitForEvent(core, (event) => event.type === 'runtime.status' && event.state === 'ready', 10_000);
    const second = await sendAndWait(core, 'home', 'after crash');
    assert.equal(second.state, 'completed', second.error);
    const state = await fetchFakeState(core);
    assert.equal(state.calls.filter((call) => call.op === 'create').length, 1, 'the new runtime got a fresh session');
    assert.ok(!state.calls.some((call) => call.op === 'resume'), 'nothing of the dead runtime was resumed');
    const journal = readJournal(core.paths);
    const runtimeEvents = journal.entries.filter((entry) => entry.type === 'runtime').map((entry) => entry.type === 'runtime' ? entry.event : '');
    assert.deepEqual(runtimeEvents.slice(0, 5), ['started', 'ready', 'exited', 'restart_scheduled', 'started']);
  } finally {
    await core.stop();
  }
});

test('a running turn finishes under its admitted target and the next one uses the new target (FR-27, A4)', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'retarget-midturn', core: fastRetries });
  await core.start();
  try {
    const running = waitForEvent(core, (event) => event.type === 'work.updated' && event.workItem.state === 'running');
    const slow = await core.sendOwnerMessage('home', 'slow:1500');
    await running;
    await new Promise((resolve) => setTimeout(resolve, 200));
    const done = waitForEvent(core, (event) => event.type === 'turn.completed' && event.workItem.id === slow.id);
    await core.updateProfile({ executionTarget: { provider: 'claude', model: 'sonnet' } });
    const finished = await done;
    assert.equal(finished.type === 'turn.completed' && finished.workItem.state, 'completed', 'the in-flight turn was not interrupted');
    assert.equal(finished.type === 'turn.completed' && finished.workItem.run?.model, null, 'it ran under the target it was admitted with');
    assert.equal(finished.type === 'turn.completed' && finished.workItem.configRevision, 1);

    const next = await sendAndWait(core, 'home', 'after retarget');
    assert.equal(next.state, 'completed');
    assert.equal(next.run?.model, 'sonnet');
    assert.equal(next.configRevision, 2);
    const state = await fetchFakeState(core);
    const creates = state.calls.filter((call) => call.op === 'create') as Array<{ body: Record<string, unknown> }>;
    assert.equal(creates.length, 2);
    assert.equal(creates[1]!.body.model, 'sonnet');
    assert.ok(!state.calls.some((call) => call.op === 'resume'), 'the old attachment was never resumed');
    const replaced = finished.type === 'turn.completed' ? finished.workItem.run?.sessionId : undefined;
    assert.ok(
      state.calls.some((call) => call.op === 'close' && call.id === replaced),
      'the replaced session was closed once its turn had ended',
    );
  } finally {
    await core.stop();
  }
});

test('a provider change lets the running turn finish before the runtime restarts (FR-27)', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'provider-midturn', core: fastRetries });
  await core.start();
  try {
    const pidBefore = core.status().runtime.pid;
    const running = waitForEvent(core, (event) => event.type === 'work.updated'
      && event.workItem.state === 'running' && event.workItem.run !== undefined);
    const slow = await core.sendOwnerMessage('home', 'slow:1200');
    await running;
    const done = waitForEvent(core, (event) => event.type === 'turn.completed' && event.workItem.id === slow.id);
    await core.updateProfile({ executionTarget: { provider: 'codex', model: null } });
    assert.equal(core.status().runtime.pid, pidBefore, 'the runtime stays up for the turn in flight');
    const waiting = await core.sendOwnerMessage('home', 'after the switch');
    const next = waitForEvent(core, (event) => event.type === 'turn.completed' && event.workItem.id === waiting.id);
    const finished = await done;
    assert.equal(finished.type === 'turn.completed' && finished.workItem.state, 'completed', 'the turn in flight was not terminated');
    assert.equal(finished.type === 'turn.completed' && finished.workItem.run?.provider, 'claude');
    const after = await next;
    assert.equal(after.type === 'turn.completed' && after.workItem.state, 'completed', 'work admitted after the switch runs');
    assert.equal(after.type === 'turn.completed' && after.workItem.run?.provider, 'codex');
    assert.notEqual(core.status().runtime.pid, pidBefore, 'the runtime was replaced for the new provider');
  } finally {
    await core.stop();
  }
});

test('a tick and an owner message racing for the home session bind it once (FR-11)', async () => {
  const { core } = openTestBot({
    botsHome: home.botsHome,
    id: 'bind-race',
    core: fastRetries,
    runtimeEnv: { FAKE_CREATE_DELAY_MS: '400' },
  });
  await core.start();
  try {
    const [, item] = await Promise.all([core.tick(), sendAndWait(core, 'home', 'remember the kettle')]);
    assert.equal(item.state, 'completed');
    const state = await fetchFakeState(core);
    const creates = state.calls.filter((call) => call.op === 'create') as Array<{ body: Record<string, unknown> }>;
    assert.equal(creates.length, 1, 'one session for one conversation');
    assert.ok(
      !String(creates[0]!.body.instructions ?? '').includes('remember the kettle'),
      'a prompt still waiting for its turn is sent as the message, not in the handoff pack',
    );
    const homeRecord = (await core.listConversations()).find((record) => record.role === 'home')!;
    assert.equal(homeRecord.attachment.sessionId, item.run?.sessionId, 'the attachment is the session the turn ran in');
    const followUp = await sendAndWait(core, 'home', 'and the follow-up');
    assert.equal(followUp.run?.sessionId, item.run?.sessionId, 'the next turn continues in the same session');
  } finally {
    await core.stop();
  }
});

test('tightened permissions or new instructions replace the session before the next turn (FR-27)', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'tighten', core: fastRetries });
  await core.start();
  try {
    const first = await sendAndWait(core, 'home', 'the password hint is teapot');
    const before = first.run?.sessionId;
    const profile = await core.updateProfile({ permissions: { workspaceAccess: 'read_only' } });
    assert.equal(profile.configRevision, 2);
    assert.equal((await core.listConversations()).find((record) => record.role === 'home')!.attachment.state, 'stale');
    const second = await sendAndWait(core, 'home', 'instructions?');
    assert.equal(second.configRevision, 2);
    assert.notEqual(second.run?.sessionId, before, 'the read_write session was not reused');
    assert.match(second.result?.text ?? '', /teapot/u, 'the new session received the handoff pack');
    let state = await fetchFakeState(core);
    let creates = state.calls.filter((call) => call.op === 'create') as Array<{ body: Record<string, unknown> }>;
    assert.equal(creates.at(-1)!.body.workspaceAccess, 'read_only');
    assert.ok(state.calls.some((call) => call.op === 'close' && call.id === before), 'the old session was closed');
    assert.ok(core.transcript('home').some((entry) => entry.kind === 'system' && /instructions or permissions changed/u.test(entry.text)));

    await core.updateProfile({ instructions: 'You are Kettle.' });
    const third = await sendAndWait(core, 'home', 'instructions?');
    assert.notEqual(third.run?.sessionId, second.run?.sessionId);
    assert.match(third.result?.text ?? '', /You are Kettle\./u);
    state = await fetchFakeState(core);
    creates = state.calls.filter((call) => call.op === 'create') as Array<{ body: Record<string, unknown> }>;
    assert.equal(creates.length, 3);

    await core.updateProfile({ name: 'Renamed', heartbeat: { enabled: false } });
    const fourth = await sendAndWait(core, 'home', 'still here?');
    assert.equal(fourth.run?.sessionId, third.run?.sessionId, 'a name or heartbeat change keeps the session');
  } finally {
    await core.stop();
  }
});
