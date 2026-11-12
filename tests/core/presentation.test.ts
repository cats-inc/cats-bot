import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { BotCore } from '../../src/core/bot.ts';
import { ResponsePresentation } from '../../src/core/queue/responsePresentation.ts';
import type { ConversationStore } from '../../src/core/conversations/store.ts';
import type { WorkItem } from '../../src/core/types.ts';
import { splitConversationPresentation } from '@cats-inc/platform-ui-web/contracts';
import type { TranscriptEntry } from '../../src/core/types.ts';
import { botPathsFor } from '../../src/core/store/paths.ts';
import { savePresentation, readPresentations, deletePresentations, projectPresentationTranscript } from '../../src/core/store/presentation.ts';
import { mergeTranscriptEntries, addEntry } from '../../src/renderer/note/transcript.ts';
import { fakeRuntimeEntry, makeTempHome, openTestBot, sendAndWait, waitForEvent } from '../support/harness.ts';

function snapshot(revision = 1): TranscriptEntry {
  return { seq: 2, at: '2026-10-30T00:00:00.000Z', kind: 'bot', origin: 'owner', text: 'beforeafter',
    workItemId: 'work-1', presentationRevision: revision, presentationSeqs: [2, 3], presentationTerminalSeq: 4,
    presentation: { version: 1, id: 'work-1:execution-1', phase: 'sealed', blocks: [
      { id: 'text-1', index: 0, kind: 'text', status: 'complete', text: 'before', title: null, toolName: null, toolId: null },
      { id: 'tool-1', index: 1, kind: 'tool', status: 'complete', text: 'result', input: 'input', result: 'result', title: null, toolName: 'Read', toolId: 'reused' },
      { id: 'text-2', index: 2, kind: 'text', status: 'complete', text: 'after', title: null, toolName: null, toolId: null },
    ] } };
}

test('tool result closes a text boundary and reuses Desktop grouping without duplicating the tool', () => {
  const saved: TranscriptEntry[] = [];
  const store = { transcript: () => [], savePresentation: (_id: string, entry: TranscriptEntry) => saved.push(entry) } as unknown as ConversationStore;
  const recorder = new ResponsePresentation(store, { id: 'work', conversationId: 'conversation' } as WorkItem, 'owner', new Date());
  const entry = (kind: 'tool_use' | 'tool_result', seq: number): TranscriptEntry => ({ seq, kind, at: '', origin: 'owner', text: kind, toolId: 'same', toolName: 'Read' });
  recorder.entry(entry('tool_use', 1));
  recorder.text('before');
  recorder.entry(entry('tool_result', 2));
  recorder.text('after');
  recorder.seal('completed', 3);
  recorder.checkpoint();
  assert.deepEqual(saved[0]!.presentation!.blocks.map(block => block.text), ['tool_result', 'before', 'after']);
  assert.deepEqual(splitConversationPresentation(saved[0]!.presentation!).map(part => part.blocks.map(block => block.kind)), [['tool', 'text'], ['text']]);
});

test('versioned sidecar preserves legacy bytes, backs up, recovers corrupt generation and preserves future version', () => {
  const home = makeTempHome('cats-presentation-store-');
  try {
    const paths = botPathsFor(home.botsHome);
    savePresentation(paths, 'conversation', snapshot());
    savePresentation(paths, 'conversation', snapshot(2));
    const file = join(paths.root, 'presentations', 'conversation.json');
    assert.equal(readPresentations(paths, 'conversation')[0]!.presentationRevision, 2);
    assert.ok(existsSync(`${file}.bak`));
    writeFileSync(file, '{torn');
    assert.equal(readPresentations(paths, 'conversation')[0]!.presentationRevision, 1);
    savePresentation(paths, 'conversation', snapshot(3));
    assert.equal(readPresentations(paths, 'conversation')[0]!.presentationRevision, 3);
    writeFileSync(file, '{"version":99}');
    assert.throws(() => savePresentation(paths, 'conversation', snapshot(4)), /Unsupported/);
    assert.equal(readFileSync(file, 'utf8'), '{"version":99}');
    deletePresentations(paths, 'conversation');
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(`${file}.bak`), false);
    assert.throws(() => readPresentations(paths, '../other'), /Invalid/);
  } finally { home.cleanup(); }
});

test('crash before or after final JSONL append neither loses partial content nor duplicates final text', () => {
  const response = snapshot();
  const owner: TranscriptEntry = { seq: 1, at: response.at, kind: 'owner', text: 'question', origin: 'owner', workItemId: 'work-1' };
  const tool: TranscriptEntry = { seq: 2, at: response.at, kind: 'tool_use', text: 'input', origin: 'owner', workItemId: 'work-1' };
  const result = { ...tool, seq: 3, kind: 'tool_result' as const, text: 'result' };
  const final = { ...tool, seq: 4, kind: 'bot' as const, text: response.text };
  const before = projectPresentationTranscript([owner, tool, result], [response]);
  const after = projectPresentationTranscript([owner, tool, result, final], [response]);
  assert.deepEqual(before, after);
  assert.deepEqual(after.map(entry => entry.kind), ['owner', 'bot']);
  const unrelated = { ...final, workItemId: 'work-2' };
  assert.ok(projectPresentationTranscript([owner, unrelated], [response]).includes(unrelated));
  const uncovered = { ...tool, seq: 5 };
  assert.ok(projectPresentationTranscript([owner, uncovered], [response]).includes(uncovered));
  assert.deepEqual(projectPresentationTranscript([owner, tool, result, final], []), [owner, tool, result, final]);
});

test('future backup and failed atomic replacement preserve existing valid history', () => {
  const home = makeTempHome('cats-presentation-failure-');
  try {
    const paths = botPathsFor(home.botsHome);
    savePresentation(paths, 'conversation', snapshot());
    const file = join(paths.root, 'presentations', 'conversation.json');
    const before = readFileSync(file, 'utf8');
    writeFileSync(`${file}.bak`, '{"version":99}');
    assert.throws(() => savePresentation(paths, 'conversation', snapshot(2)), /Unsupported/);
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal(readFileSync(`${file}.bak`, 'utf8'), '{"version":99}');
    savePresentation(paths, 'failure', snapshot());
    const failed = join(paths.root, 'presentations', 'failure.json');
    const original = readFileSync(failed, 'utf8');
    mkdirSync(`${failed}.bak`);
    assert.throws(() => savePresentation(paths, 'failure', snapshot(2)));
    assert.equal(readFileSync(failed, 'utf8'), original);
    assert.ok(!readdirSync(join(paths.root, 'presentations')).some(name => name.endsWith('.tmp')));
  } finally { home.cleanup(); }
});

test('corrupt primary with an old unbound backup uses original final JSONL exactly once', () => {
  const home = makeTempHome('cats-presentation-recovery-');
  try {
    const paths = botPathsFor(home.botsHome);
    const old = snapshot();
    delete old.presentationTerminalSeq;
    old.presentation!.phase = 'streaming';
    old.text = 'before';
    savePresentation(paths, 'conversation', old);
    savePresentation(paths, 'conversation', snapshot(2));
    writeFileSync(join(paths.root, 'presentations', 'conversation.json'), '{torn');
    const final: TranscriptEntry = { seq: 4, at: old.at, kind: 'bot', origin: 'owner', text: 'beforeafter', workItemId: 'work-1' };
    const restored = projectPresentationTranscript([final], readPresentations(paths, 'conversation'));
    assert.deepEqual(restored, [final]);
    assert.deepEqual(mergeTranscriptEntries([old], restored), [final]);
  } finally { home.cleanup(); }
});

test('late reload cannot replace new live revision, resurrect covered tools, or duplicate terminal text', () => {
  const old = snapshot(1);
  const latest = snapshot(3);
  const tool: TranscriptEntry = { seq: 2, at: old.at, kind: 'tool_use', text: 'input', origin: 'owner', workItemId: 'work-1' };
  const live = addEntry([tool], latest);
  const merged = mergeTranscriptEntries(live, [tool, old]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.presentationRevision, 3);
  assert.equal(addEntry(merged, tool).length, 1);
});

test('real Bot core event adapter persists ordered tools, preserves old API and restores same response on reopen', async () => {
  const home = makeTempHome('cats-presentation-core-');
  const options = { botsHome: home.botsHome, id: 'presentation' };
  const { core, root } = openTestBot(options);
  try {
    await core.start();
    await sendAndWait(core, 'home', 'tool please');
    await sendAndWait(core, 'home', 'tool again');
    const old = core.transcript('home');
    assert.deepEqual(old.map(entry => entry.kind), ['owner', 'tool_use', 'tool_result', 'bot', 'owner', 'tool_use', 'tool_result', 'bot']);
    const view = core.conversationTranscript('home');
    assert.equal(view.filter(entry => entry.presentation).length, 2);
    for (const entry of view.filter(entry => entry.presentation)) {
      assert.deepEqual(entry.presentation!.blocks.map(block => block.kind), ['tool', 'text']);
      assert.equal(entry.presentation!.blocks[0]!.input, 'Read file.txt');
      assert.equal(entry.presentation!.phase, 'sealed');
    }
    assert.notEqual(view[1]!.presentation!.id, view[3]!.presentation!.id);
    await core.stop();
    const reopened = BotCore.open({ root, log: () => {}, runtime: { runtimeEntry: fakeRuntimeEntry },
      life: { startupDelayMs: 3_600_000, intervalMs: 3_600_000 } });
    try {
      await reopened.start();
      assert.deepEqual(reopened.conversationTranscript('home'), view);
    } finally { await reopened.stop(); }
  } finally { await core.stop(); home.cleanup(); }
});

test('interleaved text/tool/text keeps raw and derived events once, and cancellation retains partial history', async () => {
  const home = makeTempHome('cats-presentation-stream-');
  const { core } = openTestBot({ botsHome: home.botsHome });
  try {
    await core.start();
    await sendAndWait(core, 'home', 'layered');
    const response = core.conversationTranscript('home').find(entry => entry.presentation)!;
    assert.deepEqual(response.presentation!.blocks.map(block => [block.kind, block.text]),
      [['text', 'before'], ['tool', 'contents'], ['text', 'after']]);
    const started = waitForEvent(core, event => event.type === 'turn.presentation' && event.entry.text === 'partial');
    const done = waitForEvent(core, event => event.type === 'turn.completed');
    await core.sendOwnerMessage('home', 'partial-slow');
    await started;
    await core.cancelTurn('home');
    await done;
    const cancelled = core.conversationTranscript('home').filter(entry => entry.presentation).at(-1)!;
    assert.equal(cancelled.text, 'partial');
    assert.equal(cancelled.presentation!.phase, 'sealed');
    assert.equal(cancelled.presentation!.blocks[0]!.status, 'error');
    await sendAndWait(core, 'home', 'result-only');
    assert.equal(core.conversationTranscript('home').at(-1)!.text, 'coarse answer');
  } finally { await core.stop(); home.cleanup(); }
});
