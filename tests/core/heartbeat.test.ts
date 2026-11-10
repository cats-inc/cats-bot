import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildHeartbeatPrompt,
  HEARTBEAT_MAX_UNANSWERED,
  isHeartbeatPrompt,
  parseHeartbeatReply,
  pickHeartbeatDelayMs,
} from '../../src/core/life/heartbeat.ts';
import { buildWorkReview, REVIEW_TEXT_LIMIT, type ReviewSource } from '../../src/core/life/review.ts';
import { createProfile } from '../../src/core/profile/profile.ts';
import { heartbeatRhythmProblem, resolveHeartbeatRhythm, resolveWakeTime } from '../../src/shared/heartbeatRhythm.ts';
import { HEARTBEAT_DEFAULTS } from '../../src/core/profile/profile.ts';
import { reconcileInterrupted } from '../../src/core/life/recovery.ts';
import type { RuntimeClient } from '../../src/core/runtime/client.ts';
import { createWorkItem } from '../../src/core/queue/workItems.ts';
import type { ConversationRecord, TranscriptEntry, WorkItem } from '../../src/core/types.ts';

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

test('each unanswered message doubles the regular wait; the fifth stops it (SPEC-011 FR-10)', () => {
  const policy = { ...HEARTBEAT_DEFAULTS, regularMinMinutes: 30, regularMaxMinutes: 30 };
  assert.deepEqual([0, 1, 2, 3, 4].map((count) => pickHeartbeatDelayMs('regular', policy, () => 0, count) / 60_000), [30, 60, 120, 240, 480]);
  assert.equal(pickHeartbeatDelayMs('wake', policy, () => 0, 3), 2 * 60_000, 'a wake wait is not backed off');
  assert.equal(HEARTBEAT_MAX_UNANSWERED, 5);
});

test('the rhythm matches Cats Desktop: one wake minute a day, rest across midnight, and its time rules (SPEC-011 FR-3 to FR-5)', () => {
  const times = { bedtime: '23:00', wakeWindowStart: '07:00', wakeWindowEnd: '09:00' };
  const day = new Date(2026, 10, 10, 12, 0);
  const wake = resolveWakeTime(times, 'mochi', day);
  assert.equal(resolveWakeTime(times, 'mochi', new Date(2026, 10, 10, 18, 0)).getTime(), wake.getTime(), 'a restart never re-rolls it');
  assert.ok(wake.getHours() * 60 + wake.getMinutes() >= 7 * 60 && wake.getHours() * 60 + wake.getMinutes() <= 9 * 60);
  assert.equal(resolveHeartbeatRhythm(times, 'mochi', day).phase, 'awake_hours');
  assert.equal(resolveHeartbeatRhythm(times, 'mochi', new Date(2026, 10, 10, 23, 30)).phase, 'rest_hours');
  assert.equal(resolveHeartbeatRhythm(times, 'mochi', new Date(2026, 10, 10, 3, 0)).phase, 'rest_hours');
  const late = { ...times, bedtime: '01:00' };
  assert.equal(resolveHeartbeatRhythm(late, 'mochi', new Date(2026, 10, 10, 0, 30)).phase, 'awake_hours', 'a bedtime after midnight');
  const night = resolveHeartbeatRhythm(times, 'mochi', new Date(2026, 10, 10, 23, 30));
  assert.equal(night.nextWakeAt.getDate(), 11);
  assert.equal(night.restStartedAt.getHours(), 23);
  assert.equal(heartbeatRhythmProblem(times), null);
  assert.match(heartbeatRhythmProblem({ ...times, bedtime: '08:00' }) ?? '', /outside the wake window/u);
  assert.match(heartbeatRhythmProblem({ ...times, wakeWindowEnd: '06:00' }) ?? '', /must not end before it starts/u);
  assert.equal(heartbeatRhythmProblem({ ...times, bedtime: 'late' }), 'Times must be HH:MM');
});

test('assist and companion prompts: assist works from the review, both know how much went unanswered (SPEC-011 FR-13)', () => {
  const base = {
    now: new Date('2026-11-10T10:00:00.000Z'),
    awakeSince: new Date('2026-11-10T08:00:00.000Z'),
    lastOwnerMessageAt: new Date('2026-11-08T10:00:00.000Z'),
    botName: 'Mochi',
  };
  const assist = buildHeartbeatPrompt({ ...base, kind: 'regular', mode: 'assist', unanswered: 2, review: 'REVIEW BLOCK' });
  assert.ok(isHeartbeatPrompt(assist));
  assert.match(assist, /not for small talk/u);
  assert.match(assist, /REVIEW BLOCK/u);
  assert.match(assist, /last wrote to you 2 days ago/u);
  assert.match(assist, /not answered the last 2 unprompted messages/u);
  assert.match(assist, /Do not start the work now/u);
  const companion = buildHeartbeatPrompt({ ...base, kind: 'bedtime', mode: 'companion', unanswered: 0 });
  assert.match(companion, /your bedtime/u);
  assert.doesNotMatch(companion, /unprompted messages you sent/u);
  assert.doesNotMatch(companion, /small talk/u);
});

function conversation(id: string, role: 'home' | 'note', title: string, lastOwnerMessageAt: string | null): ConversationRecord {
  return { id, role, title, lastOwnerMessageAt } as ConversationRecord;
}

function line(seq: number, kind: TranscriptEntry['kind'], text: string, origin: TranscriptEntry['origin'] = kind === 'owner' ? 'owner' : 'bot'): TranscriptEntry {
  return { seq, at: '2026-11-10T09:00:00.000Z', kind, origin, text };
}

test('the work review covers recent conversations only, newest first, and its fingerprint ignores unprompted lines (SPEC-011 FR-13, FR-14)', () => {
  const now = new Date('2026-11-10T10:00:00.000Z');
  const transcripts: Record<string, TranscriptEntry[]> = {
    home: [line(1, 'owner', 'hello'), line(2, 'bot', 'hi'), line(3, 'bot', 'Shall we finish the parser?', 'heartbeat')],
    parser: [line(1, 'owner', 'split the parser'), line(2, 'tool_use', 'Bash'), line(3, 'error', 'the turn ended without a result')],
    old: [line(1, 'owner', 'ancient request')],
  };
  const sources: ReviewSource[] = [
    conversation('home', 'home', 'Direct message', '2026-11-10T08:00:00.000Z'),
    conversation('parser', 'note', 'Parser\nrefactor', '2026-11-10T09:00:00.000Z'),
    conversation('old', 'note', 'Old', '2026-10-01T09:00:00.000Z'),
    conversation('never', 'note', 'Never', null),
  ].map((record) => ({ record, transcript: () => transcripts[record.id] ?? [] }));
  const review = buildWorkReview(sources, [], now)!;
  assert.ok(review.text.indexOf('Note "Parser refactor"') < review.text.indexOf('Your direct message'), 'newest first, titles on one line');
  assert.match(review.text, /Error: the turn ended without a result/u);
  assert.match(review.text, /You \(unprompted\): Shall we finish the parser\?/u);
  assert.doesNotMatch(review.text, /ancient request|Bash/u, 'older than a week and tool lines are left out');

  transcripts.home!.push(line(4, 'bot', 'Another nudge', 'heartbeat'));
  assert.equal(buildWorkReview(sources, [], now)!.fingerprint, review.fingerprint, 'its own unprompted messages are not news');
  transcripts.parser!.push(line(4, 'owner', 'and add tests'));
  assert.notEqual(buildWorkReview(sources, [], now)!.fingerprint, review.fingerprint);

  assert.equal(buildWorkReview(sources.slice(2), [], now), null, 'nothing recent, nothing waiting: nothing to review');
  const waiting = buildWorkReview(sources.slice(2), [{ id: 'w1' } as WorkItem], now)!;
  assert.match(waiting.text, /One question you asked your owner is still waiting/u);

  const long = Array.from({ length: 40 }, (_, index) => line(index + 1, index % 2 ? 'bot' : 'owner', 'x'.repeat(400)));
  const many = Array.from({ length: 30 }, (_, index) => ({
    record: conversation(`n${index}`, 'note', `Note ${index}`, new Date(now.getTime() - (index + 1) * 60_000).toISOString()),
    transcript: () => long,
  }));
  const bounded = buildWorkReview(many, [], now)!;
  assert.ok(bounded.text.length <= REVIEW_TEXT_LIMIT + 200, 'bounded');
  assert.match(bounded.text, /Note "Note 0"[^\n]*\n( {3}(Owner|You): x+…\n){6}/u, 'the newest note keeps its last lines');
  assert.match(bounded.text, /Note "Note 3"[^\n]*\n {3}Owner: x+…\n\d/u, 'a later note keeps its heading and the owner\'s last line');
  assert.match(bounded.text, /\(\d+ more conversations with recent messages left out\.\)/u);
  assert.equal(bounded.fingerprint.split(',').length, 30, 'every recent conversation is seen');
});

test('createProfile starts the heartbeat on auto', () => {
  assert.equal(createProfile({ id: 'b', name: 'Bot', provider: 'claude', cwd: 'C:/w' }).heartbeat.mode, 'auto');
});

function clientWith(messages: Array<{ role: string; text: string; timestamp?: string }> | Error): RuntimeClient {
  return {
    getHistory: async () => {
      if (messages instanceof Error) throw messages;
      return { messages };
    },
  } as unknown as RuntimeClient;
}

function interruptedItem(prompt: string, run: Partial<NonNullable<WorkItem['run']>> = {}): WorkItem {
  return {
    ...createWorkItem({ kind: 'owner_message', source: 'owner', conversationId: 'home', prompt }, new Date('2026-10-28T09:00:00.000Z')),
    admittedAt: '2026-10-28T09:00:00.000Z',
    run: { provider: 'claude', model: null, sessionId: 's1', startedAt: '2026-10-28T09:00:01.000Z', historyBaseline: 0, ...run },
  };
}

function toolEntry(item: WorkItem, kind: 'tool_use' | 'tool_result', at: string, toolId = 't1'): TranscriptEntry {
  return { seq: 0, at, kind, origin: 'owner', text: '', workItemId: item.id, toolName: 'Bash', toolId };
}

test('interrupted turns are settled by runtime evidence, never rerun (FR-28)', async () => {
  const item = interruptedItem('write the plan');
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

test('recovery only counts messages of this run and earns completion (FR-28)', async () => {
  const yesterday = [
    { role: 'user', text: 'back up the photos', timestamp: '2026-10-27T09:00:00.000Z' },
    { role: 'assistant', text: 'Starting the backup now.', timestamp: '2026-10-27T09:00:05.000Z' },
    { role: 'assistant', text: 'Backup finished.', timestamp: '2026-10-27T09:03:00.000Z' },
  ];
  // Today's prompt never reached the session: yesterday's identical prompt is before the baseline.
  const today = interruptedItem('back up the photos', { historyBaseline: 3 });
  const notThisRun = await reconcileInterrupted(today, clientWith(yesterday));
  assert.equal(notThisRun.verdict, 'awaiting_owner');

  // It did reach it: only what follows today's prompt counts, every reply of the turn is kept.
  const ran = await reconcileInterrupted(today, clientWith([
    ...yesterday,
    { role: 'user', text: 'back up the photos', timestamp: '2026-10-28T09:00:02.000Z' },
    { role: 'assistant', text: 'Starting the backup now.', timestamp: '2026-10-28T09:00:05.000Z' },
    { role: 'assistant', text: 'Backup finished.', timestamp: '2026-10-28T09:04:00.000Z' },
    { role: 'user', text: 'thanks', timestamp: '2026-10-28T09:05:00.000Z' },
    { role: 'assistant', text: 'You are welcome.', timestamp: '2026-10-28T09:05:02.000Z' },
  ]));
  assert.deepEqual(ran, { verdict: 'completed', text: 'Starting the backup now.\n\nBackup finished.' });

  // A tool call the core saw without its result: the reply so far may be partial.
  const midTool = [
    ...yesterday,
    { role: 'user', text: 'back up the photos', timestamp: '2026-10-28T09:00:02.000Z' },
    { role: 'assistant', text: 'Starting the backup now.', timestamp: '2026-10-28T09:00:05.000Z' },
  ];
  const open = await reconcileInterrupted(today, clientWith(midTool), [toolEntry(today, 'tool_use', '2026-10-28T09:00:06.000Z')]);
  assert.equal(open.verdict, 'awaiting_owner');
  assert.match(open.verdict === 'awaiting_owner' ? open.evidence : '', /no result.*Starting the backup now/u);

  // The tool finished but no reply came after its result.
  const tools = [toolEntry(today, 'tool_use', '2026-10-28T09:00:06.000Z'), toolEntry(today, 'tool_result', '2026-10-28T09:03:00.000Z')];
  const beforeResult = await reconcileInterrupted(today, clientWith(midTool), tools);
  assert.equal(beforeResult.verdict, 'awaiting_owner');
  const afterResult = await reconcileInterrupted(today, clientWith([
    ...midTool,
    { role: 'assistant', text: 'Backup finished.', timestamp: '2026-10-28T09:03:10.000Z' },
  ]), tools);
  assert.equal(afterResult.verdict, 'completed');
  const untimed = await reconcileInterrupted(today, clientWith([
    ...midTool.map(({ role, text }) => ({ role, text })),
    { role: 'assistant', text: 'Backup finished.' },
  ]), tools);
  assert.equal(untimed.verdict, 'awaiting_owner', 'without timestamps a reply cannot be placed after the tool result');

  // A run journaled before baselines existed: only a timestamp ties the prompt to it.
  const legacy = interruptedItem('back up the photos', { historyBaseline: undefined });
  const untied = await reconcileInterrupted(legacy, clientWith(yesterday.map(({ role, text }) => ({ role, text }))));
  assert.equal(untied.verdict, 'awaiting_owner');
  const oldTimes = await reconcileInterrupted(legacy, clientWith(yesterday));
  assert.equal(oldTimes.verdict, 'awaiting_owner', "yesterday's prompt is older than this run");
  const tied = await reconcileInterrupted(legacy, clientWith([
    ...yesterday,
    { role: 'user', text: 'back up the photos', timestamp: '2026-10-28T09:00:02.000Z' },
    { role: 'assistant', text: 'Backup finished.', timestamp: '2026-10-28T09:04:00.000Z' },
  ]));
  assert.deepEqual(tied, { verdict: 'completed', text: 'Backup finished.' });
});
