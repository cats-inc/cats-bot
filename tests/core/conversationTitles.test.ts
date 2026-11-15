import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { BotCore, initializeBot } from '../../src/core/bot.ts';
import { draftTitle, readCatTitle, readTitleSource } from '../../src/core/conversations/titles.ts';
import { normalizeConversation } from '../../src/core/conversations/store.ts';
import { botPathsFor } from '../../src/core/store/paths.ts';
import { appendTranscript } from '../../src/core/store/transcript.ts';
import { attachedFilesMessage } from '../../src/shared/attachments.ts';
import { awakeNow, fakeRuntimeEntry, fetchFakeState, makeTempHome, openTestBot, sendAndWait, waitForEvent, type TempHome } from '../support/harness.ts';

/**
 * SPEC-002 FR-5a, after Cats Desktop's Catlas titles: a note reads the start of its first message, then the bot
 * names it from its first exchange in a read-only session of its own that keeps nothing. The owner's name wins.
 */

let home: TempHome;
before(() => {
  home = makeTempHome('cats-bot-titles-');
});
after(() => home.cleanup());

test('a draft is the start of the message without its files, on one line and at most 48 characters', () => {
  assert.equal(draftTitle('  plan a\n\ttrip  to Kyoto  '), 'plan a trip to Kyoto');
  assert.equal(draftTitle(attachedFilesMessage('look at this', ['.cats-attachments/a.png'])), 'look at this');
  assert.equal(draftTitle(attachedFilesMessage('', ['.cats-attachments/a.png'])), null, 'only files');
  assert.equal([...draftTitle('字'.repeat(60))!].length, 48);
  assert.equal(draftTitle('a‮b​c'), 'a b c', 'no hidden or reordering characters');
});

test('the bot\'s answer is one JSON title, also fenced; anything else is no title', () => {
  assert.equal(readCatTitle('{"title":"Kyoto trip"}'), 'Kyoto trip');
  assert.equal(readCatTitle('```json\n{"title": "「京都旅行」"}\n```'), '京都旅行');
  assert.equal(readCatTitle('{"title":"x","extra":1}'), null);
  assert.equal(readCatTitle('{"title":"   "}'), null);
  assert.equal(readCatTitle('{"title":42}'), null);
  assert.equal(readCatTitle('Kyoto trip'), null);
  assert.equal([...readCatTitle(`{"title":"${'a'.repeat(80)}"}`)!].length, 48);
});

test('a record from before titles had a source reads it from its title', () => {
  const read = (raw: Record<string, unknown>) => normalizeConversation({ id: 'conv-1', role: 'note', ...raw }, '2026-11-16T00:00:00.000Z')!;
  assert.equal(read({ title: 'Conversation 3' }).titleSource, 'default');
  assert.equal(read({ title: 'Conversation' }).titleSource, 'default');
  assert.equal(read({ title: 'Trip plans' }).titleSource, 'owner', 'only the owner renamed notes');
  assert.equal(read({ id: 'home', role: 'home', title: 'Direct message' }).titleSource, 'default');
  assert.equal(read({ title: 'Messages from Mochi', contactOf: 'mochi' }).titleSource, 'default');
  assert.equal(read({ title: 'Trip plans', titleSource: 'cat', titleAttempts: 1 }).titleSource, 'cat');
  assert.equal(read({ title: 'x', titleSource: 'robot' }).titleSource, 'owner', 'an unknown source reads like none');
  assert.equal(read({ title: 'x', titleAttempts: -1 }).titleAttempts, undefined);
  assert.equal(readTitleSource(undefined, { role: 'note', title: 'Conversation 12', contactOf: null }), 'default');
});

test('a new note reads its first message, then the bot names it in a read-only session it closes and deletes', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'namer' });
  await core.start();
  try {
    const note = await core.createConversation();
    assert.equal(note.titleSource, 'default');
    const completed = waitForEvent(core, (event) => event.type === 'turn.completed' && event.conversationId === note.id);
    await core.sendOwnerMessage(note.id, 'plan a trip to Kyoto next week');
    const drafted = (await core.listConversations()).find((record) => record.id === note.id)!;
    assert.deepEqual([drafted.title, drafted.titleSource], ['plan a trip to Kyoto next week', 'draft']);
    await completed;
    await core.namingIdle();
    const named = (await core.listConversations()).find((record) => record.id === note.id)!;
    assert.deepEqual([named.title, named.titleSource, named.titleAttempts], ['About plan a trip to Kyoto', 'cat', 1]);
    assert.equal(named.attachment.lastError, undefined, 'naming leaves nothing on the note');

    const { calls, sessions } = await fetchFakeState(core);
    const naming = calls.find((call) => call.op === 'create'
      && String((call.body as Record<string, unknown>).instructions).startsWith('You name one conversation'));
    const body = naming!.body as Record<string, unknown>;
    assert.deepEqual([body.workspaceKind, body.workspaceAccess, body.permissionMode, body.mcpServers, body.cwd],
      ['sandbox', 'read_only', 'default', [], undefined]);
    const namingId = sessions.find((session) => session.instructions === body.instructions)?.id;
    assert.equal(namingId, undefined, 'the naming session was deleted');
    assert.ok(calls.some((call) => call.op === 'close') && calls.filter((call) => call.op === 'delete').length >= 1);
    const message = calls.filter((call) => call.op === 'message').at(-1)!.message as string;
    assert.deepEqual(JSON.parse(message), { ownerMessage: 'plan a trip to Kyoto next week', reply: 'echo: plan a trip to Kyoto next week' });

    // Named once: a later turn asks nothing.
    const creates = calls.filter((call) => call.op === 'create').length;
    assert.equal((await sendAndWait(core, note.id, 'and the hotels?')).state, 'completed');
    await core.namingIdle();
    assert.equal((await fetchFakeState(core)).calls.filter((call) => call.op === 'create').length, creates);
  } finally {
    await core.stop();
  }
});

test('the bot is asked twice at most, and the owner\'s name is never replaced', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'untitled' });
  await core.start();
  try {
    const note = await core.createConversation();
    const namings = async () => (await fetchFakeState(core)).calls.filter((call) => call.op === 'create'
      && String((call.body as Record<string, unknown>).instructions).startsWith('You name one conversation')).length;
    for (const text of ['untitled first', 'second', 'third']) {
      assert.equal((await sendAndWait(core, note.id, text)).state, 'completed');
      await core.namingIdle();
    }
    const record = (await core.listConversations()).find((item) => item.id === note.id)!;
    // The bot names from the first exchange, which keeps getting no title.
    assert.deepEqual([record.title, record.titleSource, record.titleAttempts, await namings()], ['untitled first', 'draft', 2, 2]);

    const renamed = await core.createConversation();
    await core.sendOwnerMessage(renamed.id, 'what to cook tonight');
    await core.renameConversation(renamed.id, 'Dinner');
    assert.equal((await sendAndWait(core, renamed.id, 'something warm')).state, 'completed');
    await core.namingIdle();
    const kept = (await core.listConversations()).find((item) => item.id === renamed.id)!;
    assert.deepEqual([kept.title, kept.titleSource], ['Dinner', 'owner']);

    const given = await core.createConversation('Taxes');
    assert.equal(given.titleSource, 'owner', 'a name given when the note is made is the owner\'s');
    assert.equal((await sendAndWait(core, given.id, 'receipts')).state, 'completed');
    assert.equal((await sendAndWait(core, 'home', 'hello')).state, 'completed');
    await core.namingIdle();
    const after = await core.listConversations();
    assert.equal(after.find((item) => item.id === given.id)!.title, 'Taxes');
    assert.equal(after.find((item) => item.role === 'home')!.titleSource, 'default', 'the direct message is never named');
    assert.equal(await namings(), 2);
  } finally {
    await core.stop();
  }
});

test('an older note still called what it was made with is drafted from its first message, not the latest', async () => {
  const { root } = initializeBot(home.botsHome, { id: 'older', name: 'Older Bot', provider: 'claude' });
  const paths = botPathsFor(root);
  const at = '2026-11-15T00:00:00.000Z';
  // As an earlier version left it: no title source, and a talk already under way.
  writeFileSync(join(paths.conversations, 'conv-old.json'), JSON.stringify({ schemaVersion: 1, id: 'conv-old', role: 'note',
    title: 'Conversation 1', createdAt: at, updatedAt: at, unreadCount: 0, lastOwnerMessageAt: at, lastBotMessageAt: at, checkpoint: null }));
  appendTranscript(paths, 'conv-old', { seq: 1, at, kind: 'owner', origin: 'owner', text: 'garden layout ideas' });
  appendTranscript(paths, 'conv-old', { seq: 2, at, kind: 'bot', origin: 'owner', text: 'Raised beds.' });
  const core = BotCore.open({
    root, log: () => {},
    runtime: { runtimeEntry: fakeRuntimeEntry, readyTimeoutMs: 15_000, stopTimeoutMs: 3_000, env: { ...process.env } },
    life: { startupDelayMs: 3_600_000, intervalMs: 3_600_000 },
  });
  await core.updateProfile({ heartbeat: awakeNow() });
  await core.start();
  try {
    assert.equal((await core.listConversations()).find((record) => record.id === 'conv-old')!.titleSource, 'default');
    assert.equal((await sendAndWait(core, 'conv-old', '繼續')).state, 'completed');
    await core.namingIdle();
    const record = (await core.listConversations()).find((item) => item.id === 'conv-old')!;
    assert.deepEqual([record.title, record.titleSource], ['About garden layout ideas', 'cat']);
  } finally {
    await core.stop();
  }
});

test('a cat\'s message is not the owner\'s first message, and the naming is not of it (SPEC-009 FR-10)', async () => {
  const { root } = initializeBot(home.botsHome, { id: 'boss', name: 'Boss Bot', provider: 'claude' });
  const paths = botPathsFor(root);
  const at = '2026-11-15T00:00:00.000Z';
  writeFileSync(join(paths.conversations, 'conv-boss.json'), JSON.stringify({ schemaVersion: 1, id: 'conv-boss', role: 'note',
    title: 'Conversation 1', titleSource: 'default', createdAt: at, updatedAt: at, unreadCount: 0, lastOwnerMessageAt: null,
    lastBotMessageAt: at, checkpoint: null }));
  appendTranscript(paths, 'conv-boss', { seq: 1, at, kind: 'owner', origin: 'bot', from: 'Mochi', text: 'Mochi reports the build broke' });
  appendTranscript(paths, 'conv-boss', { seq: 2, at, kind: 'bot', origin: 'event', text: 'Thanks, Mochi.' });
  const core = BotCore.open({
    root, log: () => {},
    runtime: { runtimeEntry: fakeRuntimeEntry, readyTimeoutMs: 15_000, stopTimeoutMs: 3_000, env: { ...process.env } },
    life: { startupDelayMs: 3_600_000, intervalMs: 3_600_000 },
  });
  await core.updateProfile({ heartbeat: awakeNow() });
  await core.start();
  try {
    const completed = waitForEvent(core, (event) => event.type === 'turn.completed' && event.conversationId === 'conv-boss');
    await core.sendOwnerMessage('conv-boss', 'what is for dinner');
    assert.equal((await core.listConversations()).find((record) => record.id === 'conv-boss')!.title, 'what is for dinner');
    await completed;
    await core.namingIdle();
    const message = (await fetchFakeState(core)).calls.filter((call) => call.op === 'message').at(-1)!.message as string;
    assert.deepEqual(JSON.parse(message), { ownerMessage: 'what is for dinner', reply: 'echo: what is for dinner' });
  } finally {
    await core.stop();
  }
});

test('stopping cancels a naming in flight, and its session is closed and deleted', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'stopping' });
  await core.start();
  try {
    const note = await core.createConversation();
    assert.equal((await sendAndWait(core, note.id, 'slow-title topic')).state, 'completed');
    const asked = Date.now() + 10_000;
    while (!(await fetchFakeState(core)).calls.some((call) => call.op === 'message' && String(call.message).startsWith('{"ownerMessage"'))
      && Date.now() < asked) await new Promise((resolve) => setTimeout(resolve, 20));
    const namer = (core as unknown as { namer: { stop(): Promise<void> } }).namer;
    const started = Date.now();
    await namer.stop();
    assert.ok(Date.now() - started < 3_000, `stopped in ${Date.now() - started} ms`);
    const { calls, sessions } = await fetchFakeState(core);
    const create = calls.findIndex((call) => call.op === 'create'
      && String((call.body as Record<string, unknown>).instructions).startsWith('You name one conversation'));
    const after = calls.slice(create).map((call) => call.op);
    assert.ok(['cancel', 'close', 'delete'].every((op) => after.includes(op)), after.join(','));
    assert.ok(!sessions.some((session) => String(session.instructions).startsWith('You name one conversation')));
    const record = (await core.listConversations()).find((item) => item.id === note.id)!;
    assert.deepEqual([record.title, record.titleSource], ['slow-title topic', 'draft']);
  } finally {
    await core.stop();
  }
});
