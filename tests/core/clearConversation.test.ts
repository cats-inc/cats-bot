import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { after, before, test } from 'node:test';

import { blankJournalText } from '../../src/core/store/journal.ts';
import { botPathsFor } from '../../src/core/store/paths.ts';
import type { TranscriptEntry } from '../../src/core/types.ts';
import { fetchFakeState, makeTempHome, openTestBot, sendAndWait, waitForEvent, type TempHome } from '../support/harness.ts';

/**
 * SPEC-002 FR-5b: the direct message is cleared, never deleted; SPEC-001 FR-14: a deleted note takes its replaced
 * sessions and its words in the journal with it.
 */

let home: TempHome;
before(() => {
  home = makeTempHome('cats-bot-clear-');
});
after(() => home.cleanup());

const fastRetries = { turnRetry: { ownerBusyMs: 200, backgroundBusyMs: 200, runtimeUnavailableMs: 200 } };

function sessionDeletes(calls: Array<Record<string, unknown>>): string[] {
  return calls.filter((call) => call.op === 'delete').map((call) => String(call.id));
}

test('clearing the direct message empties it, deletes every session it had and keeps its name and schedules (FR-5b)', async () => {
  const { core, root } = openTestBot({ botsHome: home.botsHome, id: 'clear-home', core: fastRetries });
  await core.start();
  try {
    await core.renameConversation('home', 'Mochi');
    const first = await sendAndWait(core, 'home', 'remember the blue door');
    assert.equal(first.state, 'completed');
    const firstSession = core.listConversations().then((list) => list.find((record) => record.id === 'home')!.attachment.sessionId);
    const replacedId = await firstSession;
    // FR-27: a model change gives the next turn a new session; the one it replaced is remembered.
    await core.updateProfile({ executionTarget: { provider: 'claude', model: 'sonnet' } });
    assert.equal((await sendAndWait(core, 'home', 'and the red key')).state, 'completed');
    const before = (await core.listConversations()).find((record) => record.id === 'home')!;
    assert.deepEqual(before.retiredSessionIds, [replacedId]);
    const question = core.askOwner('home', 'May I tidy the downloads folder?');
    const schedule = core.createSchedule({
      conversationId: 'home', prompt: 'water the plant', kind: 'cron', cron: '0 9 * * *', createdBy: 'owner',
    });
    const lastSeq = (core.transcript('home') as TranscriptEntry[]).at(-1)!.seq;

    const createsBefore = (await fetchFakeState(core)).calls.filter((call) => call.op === 'create').length;
    const cleared = waitForEvent(core, (event) => event.type === 'conversation.cleared');
    const record = await core.clearConversation('home');
    await cleared;

    assert.equal(record.title, 'Mochi', 'it keeps its name');
    assert.equal(record.attachment.sessionId, null);
    assert.equal(record.attachment.state, 'none');
    assert.equal(record.lastOwnerMessageAt, null);
    assert.equal(record.unreadCount, 0);
    assert.equal(record.checkpoint, null);
    assert.equal(record.cleared?.throughSeq, lastSeq);
    assert.equal(record.retiredSessionIds, undefined, 'every session it had was deleted');
    assert.deepEqual((core.transcript('home') as TranscriptEntry[]), []);
    assert.deepEqual(new Set(sessionDeletes((await fetchFakeState(core)).calls)), new Set([replacedId, before.attachment.sessionId]));
    assert.equal((await core.listSchedules()).find((entry) => entry.id === schedule.id)?.state, 'active', 'its schedules stay');
    assert.equal(core.listWorkItems().find((item) => item.id === question.id)?.state, 'cancelled', 'a decision it waited for ends');
    assert.equal(core.listWorkItems().filter((item) => item.state === 'awaiting_owner').length, 0);

    // Its earlier work is no longer the conversation's, but a message accepted once stays accepted once.
    assert.deepEqual(core.listWorkItems('home'), []);
    const kept = core.listWorkItems().find((item) => item.id === first.id)!;
    assert.equal(kept.prompt, '');
    assert.equal(kept.result?.text, '');
    const journal = readFileSync(botPathsFor(root).journal, 'utf8');
    assert.doesNotMatch(journal, /blue door|red key/u);
    assert.match(journal, /water the plant/u, 'a schedule it keeps keeps its prompt');
    assert.match(journal, new RegExp(first.id, 'u'));

    // The next message starts a new session and continues after the transcript it had.
    const next = await sendAndWait(core, 'home', 'hello again');
    assert.equal(next.state, 'completed');
    const entries = core.transcript('home') as TranscriptEntry[];
    assert.ok(entries.length > 0 && entries.every((entry) => entry.seq > lastSeq));
    assert.deepEqual(core.listWorkItems('home').map((item) => item.id), [next.id]);
    const after = (await core.listConversations()).find((record) => record.id === 'home')!;
    assert.ok(after.attachment.sessionId && after.attachment.sessionId !== before.attachment.sessionId);
    const creates = (await fetchFakeState(core)).calls.filter((call) => call.op === 'create').slice(createsBefore);
    assert.equal(creates.length, 1);
    assert.doesNotMatch(String((creates[0]!.body as { instructions?: string }).instructions ?? ''), /blue door|red key/u,
      'nothing was handed over');
  } finally {
    await core.stop();
  }
});

test('only the direct message is cleared, and it is still never deleted (FR-5b)', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'clear-note', core: fastRetries });
  await core.start();
  try {
    const note = await core.createConversation('Scratch');
    await assert.rejects(core.clearConversation(note.id), /Only the direct message is cleared/u);
    await assert.rejects(core.deleteConversation('home'), /cannot be deleted/u);
  } finally {
    await core.stop();
  }
});

test('clearing during a reply cancels it, waits for it to end and refuses the owner meanwhile (FR-5b)', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'clear-running', core: fastRetries });
  await core.start();
  try {
    const running = waitForEvent(core, (event) => event.type === 'work.updated' && event.workItem.state === 'running');
    const slow = await core.sendOwnerMessage('home', 'slow:4000');
    await running;
    const clearing = core.clearConversation('home');
    await assert.rejects(core.sendOwnerMessage('home', 'too soon'), /being cleared/u);
    const record = await clearing;
    assert.equal(core.listWorkItems().find((item) => item.id === slow.id)?.state, 'cancelled');
    assert.equal(record.attachment.sessionId, null);
    // Whatever the cancelled turn wrote as it ended was written before the clear.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(core.transcript('home'), []);
    assert.equal((await core.listConversations()).find((entry) => entry.id === 'home')!.attachment.sessionId, null);
    assert.equal((await sendAndWait(core, 'home', 'after the clear')).state, 'completed');
  } finally {
    await core.stop();
  }
});

test('a session Runtime keeps is remembered for the next clear (FR-5b)', async () => {
  const { core } = openTestBot({
    botsHome: home.botsHome, id: 'clear-retained', core: fastRetries, runtimeEnv: { FAKE_DELETE_RETAINS: '1' },
  });
  await core.start();
  try {
    await sendAndWait(core, 'home', 'hello');
    const kept = (await core.listConversations()).find((record) => record.id === 'home')!.attachment.sessionId!;
    const record = await core.clearConversation('home');
    assert.equal(record.attachment.sessionId, null);
    assert.deepEqual(record.retiredSessionIds, [kept], 'not forgotten while Runtime still has it');
    await core.clearConversation('home');
    assert.equal(sessionDeletes((await fetchFakeState(core)).calls).filter((id) => id === kept).length, 2, 'asked again');
  } finally {
    await core.stop();
  }
});

test('deleting a note deletes the sessions it replaced and its words in the journal (FR-14)', async () => {
  const { core, root } = openTestBot({ botsHome: home.botsHome, id: 'delete-retired', core: fastRetries });
  await core.start();
  try {
    const note = await core.createConversation('Plans');
    await sendAndWait(core, note.id, 'the secret plan');
    const replaced = (await core.listConversations()).find((record) => record.id === note.id)!.attachment.sessionId;
    await core.updateProfile({ executionTarget: { provider: 'claude', model: 'sonnet' } });
    await sendAndWait(core, note.id, 'the second plan');
    const current = (await core.listConversations()).find((record) => record.id === note.id)!.attachment.sessionId;
    core.createSchedule({ conversationId: note.id, prompt: 'review the plan', kind: 'cron', cron: '0 9 * * *', createdBy: 'owner' });
    await core.deleteConversation(note.id);
    assert.deepEqual(new Set(sessionDeletes((await fetchFakeState(core)).calls)), new Set([replaced, current]));
    const journal = readFileSync(botPathsFor(root).journal, 'utf8');
    assert.doesNotMatch(journal, /secret plan|second plan|review the plan/u);
  } finally {
    await core.stop();
  }
});

test('blanking the journal keeps every line it cannot read and every id (FR-5b)', () => {
  const root = home.root;
  const paths = botPathsFor(`${root}/journal-only`);
  const item = (id: string, conversationId: string, prompt: string) => JSON.stringify({
    type: 'work', at: '2026-11-16T00:00:00.000Z',
    item: { id, kind: 'owner_message', source: 'telegram', sourceRef: `telegram:1:${id}`, conversationId, prompt,
      createdAt: '2026-11-16T00:00:00.000Z', state: 'completed', result: { text: `answer to ${prompt}`, completedAt: '2026-11-16T00:00:01.000Z' } },
  });
  const heartbeat = JSON.stringify({ type: 'work', at: '2026-11-16T00:00:00.000Z',
    item: { id: 'w-beat', kind: 'heartbeat', source: 'heartbeat', conversationId: 'home', prompt: '[Cats heartbeat. Say hi]', createdAt: '2026-11-16T00:00:00.000Z', state: 'completed' } });
  const later = JSON.stringify({ type: 'work', at: '2026-11-16T00:05:00.000Z',
    item: { id: 'w-later', kind: 'heartbeat', source: 'heartbeat', conversationId: 'home', prompt: 'admitted after the clear began', createdAt: '2026-11-16T00:05:00.000Z', state: 'queued' } });
  const lines = [item('w-1', 'home', 'my bank pin'), '{"type":"work", torn', item('w-2', 'conv-1', 'keep me'), heartbeat, later, ''];
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.journal, lines.join('\n'));
  assert.equal(blankJournalText(paths, 'home', { schedules: false, before: '2026-11-16T00:01:00.000Z' }), 2);
  const after = readFileSync(paths.journal, 'utf8').split('\n');
  assert.equal(after.length, lines.length);
  assert.equal(after[1], '{"type":"work", torn', 'a line it cannot read stays');
  assert.equal(after[2], lines[2], 'another conversation is untouched');
  const blanked = JSON.parse(after[0]!).item;
  assert.equal(blanked.prompt, '');
  assert.equal(blanked.result.text, '');
  assert.equal(blanked.sourceRef, 'telegram:1:w-1');
  assert.equal(JSON.parse(after[3]!).item.prompt, '[Cats heartbeat.', 'a heartbeat stays one');
  assert.equal(after[4], later, 'work admitted after the clear began keeps its prompt');
  assert.equal(blankJournalText(paths, 'home', { schedules: false, before: '2026-11-16T00:01:00.000Z' }), 0, 'nothing left to blank');
});
