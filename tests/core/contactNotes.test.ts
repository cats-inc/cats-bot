import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { BotCore, ContactNoteError, initializeBot } from '../../src/core/bot.ts';
import { botPathsFor, stateDatabaseFile } from '../../src/core/store/paths.ts';
import { migrationBackupDirectory } from '../../src/core/store/version1Migration.ts';
import { withStateStore } from '../support/stateData.ts';
import { appendTranscript } from '../../src/core/store/transcript.ts';
import { assertChoicesOnly } from '../../src/core/host-api/providerInteractions.ts';
import { createWorkItem } from '../../src/core/queue/workItems.ts';
import type { BotHostEvent, BotInteraction, InteractionAnswer, ScheduleRecord, WorkItem } from '../../src/core/types.ts';
import { awakeNow, fakeRuntimeEntry, fetchFakeState, makeTempHome, openTestBot, type TempHome, waitForEvent } from '../support/harness.ts';

/**
 * SPEC-012 FR-5 to FR-9 on the fake runtime: the conversation a bot keeps for
 * another bot's messages is a contact note. The owner reads it but never
 * writes in it, from any surface; the owner's decisions there go on as events;
 * and its sessions never see words the owner wrote there before.
 */

let home: TempHome;
before(() => {
  home = makeTempHome('cats-bot-contact-');
});
after(() => home.cleanup());

const OWNER_WORDS = 'OWNER-WROTE-THIS-9c1e';

function delivery(from: string, fromName: string, text: string, id: string) {
  return { deliveryId: id, chainId: `chain-${id}`, hop: 1, kind: 'message' as const, from, fromName, text };
}

function completed(core: BotCore, predicate: (item: WorkItem) => boolean): Promise<WorkItem> {
  return waitForEvent(core, (event: BotHostEvent) => event.type === 'turn.completed' && predicate(event.workItem))
    .then((event) => (event as Extract<BotHostEvent, { type: 'turn.completed' }>).workItem);
}

test('a sender conversation from before contact notes is upgraded once, backed up, and rebuilt without the owner\'s words (SPEC-012 FR-5, FR-8)', async () => {
  const { root, profile } = initializeBot(home.botsHome, { id: 'legacy', name: 'Legacy Bot', provider: 'claude' });
  const paths = botPathsFor(root);
  // A bot as 0.5 left it: version-1 files and a schema-2 profile, no database (SPEC-014).
  rmSync(stateDatabaseFile(paths));
  writeFileSync(paths.profile, JSON.stringify({ ...profile, schemaVersion: 2 }));
  mkdirSync(paths.conversations, { recursive: true });
  const at = '2026-11-01T00:00:00.000Z';
  const record = {
    schemaVersion: 1, id: 'bot-ada', role: 'note', title: 'Messages from Ada', createdAt: at, updatedAt: at,
    attachment: { state: 'ready', sessionId: 'old-session', providerSessionId: null, provider: 'claude', model: null,
      configRevision: 1, updatedAt: at, nextAt: null },
    unreadCount: 0, lastOwnerMessageAt: at, lastBotMessageAt: at, checkpoint: null,
  };
  writeFileSync(join(paths.conversations, 'bot-ada.json'), JSON.stringify(record));
  appendTranscript(paths, 'bot-ada', { seq: 1, at, kind: 'owner', origin: 'bot', from: 'Ada', text: 'Ada asks: how is the parser?' });
  appendTranscript(paths, 'bot-ada', { seq: 2, at, kind: 'owner', origin: 'owner', text: `${OWNER_WORDS} my password is hunter2` });
  appendTranscript(paths, 'bot-ada', { seq: 3, at, kind: 'bot', origin: 'owner', text: `Noted: ${OWNER_WORDS}` });
  appendTranscript(paths, 'bot-ada', { seq: 4, at, kind: 'system', origin: 'schedule', text: `Schedule created: tell Ada ${OWNER_WORDS}` });
  appendTranscript(paths, 'bot-ada', { seq: 5, at, kind: 'bot', origin: 'schedule', text: `Reminder: ${OWNER_WORDS}` });
  appendTranscript(paths, 'bot-ada', { seq: 6, at, kind: 'bot', origin: 'event', text: 'Working on it.' });

  const core = BotCore.open({
    root, log: () => {},
    runtime: { runtimeEntry: fakeRuntimeEntry, readyTimeoutMs: 15_000, stopTimeoutMs: 3_000, env: { ...process.env } },
    life: { startupDelayMs: 3_600_000, intervalMs: 3_600_000 },
  });
  // A read-only host of a bot not yet migrated reads nothing, and writes nothing.
  assert.deepEqual(await core.listConversations(), []);
  assert.equal(existsSync(stateDatabaseFile(paths)), false);
  // A profile change takes the lock and migrates first; the contact note is read as one.
  await core.updateProfile({ heartbeat: awakeNow() });
  const stored = (): Record<string, unknown> =>
    withStateStore(root, (store) => store.conversations().find((entry) => (entry as { id: string }).id === 'bot-ada') as Record<string, unknown>);
  assert.equal(stored().contactOf, undefined, 'only a running core writes the upgrade');
  await core.start();
  try {
    const upgraded = (await core.listConversations()).find((entry) => entry.id === 'bot-ada')!;
    assert.equal(upgraded.contactOf, 'ada');
    assert.equal(upgraded.contactName, 'Ada');
    assert.equal(upgraded.attachment.state, 'stale', 'a session that saw the owner\'s words is rebuilt');
    // The migration's copy of the version-1 files keeps the original.
    const [copy] = readdirSync(migrationBackupDirectory(paths));
    const backup = join(migrationBackupDirectory(paths), copy!, 'conversations', 'bot-ada.json');
    assert.equal(JSON.parse(readFileSync(backup, 'utf8')).contactOf, undefined, 'the original is kept');
    assert.equal(stored().contactOf, 'ada', 'the running core writes it');

    const done = completed(core, (item) => item.conversationId === 'bot-ada');
    core.admitBotMessage(delivery('ada', 'Ada', 'Any news?', 'd-legacy-1'));
    await done;
    const sessions = (await fetchFakeState(core)).sessions;
    const rebuilt = sessions.find((session) => String(session.instructions ?? '').includes('Ada asks: how is the parser?'));
    assert.ok(rebuilt, 'the new session was handed the other bot\'s messages');
    assert.equal(sessions.some((session) => String(session.instructions ?? '').includes(OWNER_WORDS)), false,
      'the owner\'s words never reach a contact note\'s session, nor replies or receipts that echo them');
    assert.ok(String(rebuilt.instructions).includes('Working on it.'), 'replies to the other bot are handed on');
  } finally {
    await core.stop();
  }
});

test('the owner cannot write in a contact note from any surface, and a name change follows the sender (SPEC-012 FR-5, FR-6)', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'reader' });
  await core.start();
  try {
    const done = completed(core, (item) => item.conversationId === 'bot-ada');
    core.admitBotMessage(delivery('ada', 'Ada', 'hello', 'd-r-1'));
    await done;
    const note = (await core.listConversations()).find((entry) => entry.id === 'bot-ada')!;
    assert.deepEqual({ contactOf: note.contactOf, contactName: note.contactName }, { contactOf: 'ada', contactName: 'Ada' });

    await assert.rejects(core.sendOwnerMessage('bot-ada', 'let me in'), ContactNoteError);
    await assert.rejects(core.addOwnerAttachment('bot-ada', 'a.txt', Buffer.from('x').toString('base64')), ContactNoteError);
    await assert.rejects(core.renameConversation('bot-ada', 'Mine now'), ContactNoteError);
    await assert.rejects(core.setConversationDesktopControl('bot-ada', true), ContactNoteError);
    await assert.rejects(core.retryOwnerMessage('bot-ada', 'whatever'), ContactNoteError);
    await core.setConversationDesktopControl('bot-ada', false);
    assert.equal(core.transcript('bot-ada').some((entry) => entry.kind === 'owner' && entry.origin === 'owner'), false);

    const renamed = completed(core, (item) => item.conversationId === 'bot-ada');
    core.admitBotMessage(delivery('ada', 'Ada Lovelace', 'again', 'd-r-2'));
    await renamed;
    assert.equal((await core.listConversations()).find((entry) => entry.id === 'bot-ada')!.contactName, 'Ada Lovelace');
  } finally {
    await core.stop();
  }
});

test('a decision in a contact note goes on as an event, never as the owner writing (SPEC-012 FR-7)', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'decider' });
  await core.start();
  try {
    const done = completed(core, (item) => item.conversationId === 'bot-ada');
    core.admitBotMessage(delivery('ada', 'Ada', 'hello', 'd-d-1'));
    await done;
    const question = (core as unknown as { askOwner(id: string, q: string): WorkItem }).askOwner('bot-ada', 'May I delete the old branch?');
    const followed = completed(core, (item) => item.source === 'decision');
    await core.resolveApproval(question.id, 'approve');
    const event = await followed;
    assert.equal(event.kind, 'event');
    assert.match(event.prompt, /Decision on your question "May I delete the old branch\?": approved\./u);
    const transcript = core.transcript('bot-ada');
    assert.equal(transcript.some((entry) => entry.kind === 'owner' && entry.origin === 'owner'), false, 'no owner entry');
    assert.ok(transcript.some((entry) => entry.kind === 'system' && entry.origin === 'event' && /approved/u.test(entry.text)));
    const record = (await core.listConversations()).find((entry) => entry.id === 'bot-ada')!;
    assert.equal(record.lastOwnerMessageAt, null, 'it never counts as the owner writing');
  } finally {
    await core.stop();
  }
});

test('a contact note is not the owner\'s work: no assist review and no owner answer comes from it (SPEC-012, SPEC-011 FR-9, FR-13)', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'assistant' });
  await core.start();
  try {
    await core.updateProfile({ heartbeat: { mode: 'assist', wakeMinMinutes: 0, wakeMaxMinutes: 0, regularMinMinutes: 0, regularMaxMinutes: 0 } });
    const done = completed(core, (item) => item.conversationId === 'bot-ada');
    core.admitBotMessage(delivery('ada', 'Ada', 'please review the plan', 'd-a-1'));
    await done;
    const report = await core.tick();
    assert.equal(report.heartbeat?.action, 'skipped_nothing_to_review', 'another bot\'s messages are not the owner\'s unfinished work');
  } finally {
    await core.stop();
  }
});

test('handoff writes into a contact note are refused, and an interrupted turn there ends failed (SPEC-012 FR-6, FR-7)', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'handoffs' });
  await core.start();
  try {
    const done = completed(core, (item) => item.conversationId === 'bot-ada');
    core.admitBotMessage(delivery('ada', 'Ada', 'hello', 'd-h-1'));
    await done;
    const apply = (core as unknown as { applyHandoff(message: Record<string, unknown>): Promise<void> }).applyHandoff.bind(core);
    await assert.rejects(apply({ kind: 'say', conversationId: 'bot-ada', text: 'from the CLI' }), ContactNoteError);
    await assert.rejects(apply({ kind: 'schedule_create', conversationId: 'bot-ada',
      payload: { kind: 'once', at: new Date(Date.now() + 3_600_000).toISOString(), prompt: 'later', createdBy: 'owner' } }), ContactNoteError);

    // The CLI's offline path calls the core directly.
    const later = new Date(Date.now() + 3_600_000);
    assert.throws(() => core.createSchedule({ conversationId: 'bot-ada', kind: 'once', at: later, prompt: 'later', createdBy: 'owner' } as Parameters<BotCore['createSchedule']>[0]),
      ContactNoteError);
    assert.equal(core.createSchedule({ conversationId: 'bot-ada', kind: 'once', at: later, prompt: 'check back', createdBy: 'agent' } as Parameters<BotCore['createSchedule']>[0]).createdBy, 'agent',
      'the note\'s own agent still sets reminders there');

    const internals = core as unknown as { record(item: WorkItem): WorkItem; recoverInterrupted(): Promise<void>; workItems: Map<string, WorkItem> };
    const at = new Date().toISOString();
    internals.record({
      id: 'w-interrupted', kind: 'schedule', source: 'sched-x', conversationId: 'bot-ada', prompt: 'a reminder',
      state: 'interrupted', createdAt: at, updatedAt: at,
    } as WorkItem);
    await internals.recoverInterrupted();
    const after = internals.workItems.get('w-interrupted')!;
    assert.equal(after.state, 'failed', 'nothing in a contact note is rerun as the owner\'s message');
    assert.equal(core.transcript('bot-ada').some((entry) => entry.kind === 'owner' && entry.origin === 'owner'), false);
  } finally {
    await core.stop();
  }
});

test('owner work left in a contact note from before is put away on start, and never runs there (SPEC-012 FR-6)', async () => {
  type Internals = {
    record(item: WorkItem): WorkItem; queue: { enqueue(item: WorkItem): void }; pump(): void;
    saveSchedule(schedule: ScheduleRecord): ScheduleRecord; schedules: Map<string, ScheduleRecord>;
    workItems: Map<string, WorkItem>;
  };
  const later = () => new Date(Date.now() + 3_600_000);
  const agentReminder = (core: BotCore, prompt: string) => core.createSchedule({ conversationId: 'bot-ada', kind: 'once', at: later(), prompt,
    createdBy: 'agent' } as Parameters<BotCore['createSchedule']>[0]);
  const { core: first, root } = openTestBot({ botsHome: home.botsHome, id: 'queued' });
  await first.start();
  let leftOver: { reminder: string; message: string; own: string };
  try {
    const done = completed(first, (item) => item.conversationId === 'bot-ada');
    first.admitBotMessage(delivery('ada', 'Ada', 'hello', 'd-q-1'));
    await done;
    // What an older version could leave there: an owner's reminder and a queued owner message.
    const internals = first as unknown as Internals;
    const reminder = agentReminder(first, OWNER_WORDS);
    internals.saveSchedule({ ...reminder, createdBy: 'owner' });
    const message = internals.record(createWorkItem({ kind: 'owner_message', source: 'owner', conversationId: 'bot-ada', prompt: OWNER_WORDS }, new Date()));
    leftOver = { reminder: reminder.id, message: message.id, own: agentReminder(first, 'check back with Ada').id };
  } finally {
    await first.stop();
  }

  const core = BotCore.open({
    root, log: () => {},
    runtime: { runtimeEntry: fakeRuntimeEntry, readyTimeoutMs: 15_000, stopTimeoutMs: 3_000, env: { ...process.env } },
    life: { startupDelayMs: 3_600_000, intervalMs: 3_600_000 },
  });
  const internals = core as unknown as Internals;
  assert.equal(internals.schedules.get(leftOver.reminder)!.state, 'active', 'a read-only host changes nothing');
  await core.start();
  try {
    assert.equal(internals.schedules.get(leftOver.reminder)!.state, 'cancelled', 'the owner\'s reminder is cancelled on start');
    assert.equal(internals.schedules.get(leftOver.own)!.state, 'active', 'the note\'s own reminder stays');
    assert.equal(internals.workItems.get(leftOver.message)!.state, 'cancelled', 'the queued owner message is dropped');

    // The last check before a turn runs still holds for anything that slips past start.
    const message = internals.record(createWorkItem({ kind: 'owner_message', source: 'owner', conversationId: 'bot-ada', prompt: OWNER_WORDS }, new Date()));
    const refused = completed(core, (item) => item.id === message.id);
    internals.queue.enqueue(message);
    internals.pump();
    const ended = await refused;
    assert.equal(ended.state, 'failed');
    assert.match(ended.error ?? '', /cannot write in a contact note/u);
    const made = agentReminder(core, OWNER_WORDS);
    internals.saveSchedule({ ...made, createdBy: 'owner', nextAt: new Date(Date.now() - 1_000).toISOString() });
    const fired = completed(core, (item) => item.kind === 'schedule' && item.source === made.id);
    await core.tick();
    const run = await fired;
    assert.equal(run.state, 'failed');
    assert.notEqual(internals.schedules.get(made.id)!.state, 'active', 'the owner\'s reminder does not stay armed there');
    const sessions = (await fetchFakeState(core)).sessions;
    assert.equal(JSON.stringify(sessions).includes(OWNER_WORDS), false, 'no session saw the owner\'s words');
  } finally {
    await core.stop();
  }
});

test('a provider request in a contact note is answered by choosing, never by typing (SPEC-012 FR-6)', () => {
  const interaction = {
    interactionId: 'i1', kind: 'elicitation', status: 'pending',
    prompt: {
      kind: 'elicitation', title: 'Pick',
      choices: [{ id: 'yes', label: 'Yes' }],
      permissions: [{ id: 'read', label: 'Read' }],
      fields: [
        { id: 'color', label: 'Color', type: 'string', required: true, options: [{ id: 'red', label: 'Red' }] },
        { id: 'tags', label: 'Tags', type: 'strings', required: false, options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
        { id: 'ok', label: 'OK', type: 'boolean', required: false },
        { id: 'note', label: 'Note', type: 'string', required: false },
        { id: 'other', label: 'Other', type: 'string', required: false, options: [{ id: 'x', label: 'X' }], allowOther: true },
        { id: 'count', label: 'Count', type: 'integer', required: false },
      ],
    },
  } as unknown as BotInteraction;
  const accepts = (answer: InteractionAnswer) => assert.doesNotThrow(() => assertChoicesOnly(interaction, answer));
  const refuses = (answer: InteractionAnswer) => assert.throws(() => assertChoicesOnly(interaction, answer), /typed answers stay with the owner/u);
  accepts({ action: 'decline' });
  accepts({ action: 'accept', choice: 'yes', grants: ['read'], values: { color: 'red', tags: ['a', 'b'], ok: true } });
  refuses({ action: 'accept', choice: 'my own words' });
  refuses({ action: 'accept', grants: ['write'] });
  refuses({ action: 'accept', values: { note: OWNER_WORDS } });
  refuses({ action: 'accept', values: { other: OWNER_WORDS } });
  refuses({ action: 'accept', values: { color: OWNER_WORDS } });
  refuses({ action: 'accept', values: { tags: ['a', OWNER_WORDS] } });
  refuses({ action: 'accept', values: { count: 42 } });
  refuses({ action: 'accept', values: { unknown: 'red' } });
});
