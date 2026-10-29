import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { resolveRuntimeEntry } from '../../src/core/runtime/supervisor.ts';
import { fixtureCliCommand, fixtureCliLaunchArgs, makeTempHome, openTestBot, sendAndWait, type TempHome } from '../support/harness.ts';

/**
 * SPEC-001 A4 on the real pinned cats-runtime: a secret told in one note
 * cannot be recalled from another, and after a global provider/model change
 * the next turn runs under the new target in a new session (never a resume
 * of the old attachment).
 */

let home: TempHome;
let projectsDir: string;
let fixtureLog: string;
before(() => {
  home = makeTempHome('cats-bot-multinote-');
  projectsDir = join(home.botsHome, 'claude-projects');
  mkdirSync(projectsDir, { recursive: true });
  fixtureLog = join(home.botsHome, 'fixture.log');
});
after(() => home.cleanup());

function fixtureTurns(): Array<{ message: string; resumed: boolean; args: string[]; sessionId: string }> {
  try {
    return readFileSync(fixtureLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

test('notes do not share context, and a retarget replaces sessions instead of resuming them', async () => {
  const { core } = openTestBot({
    botsHome: home.botsHome,
    id: 'notes',
    core: {
      turnRetry: { ownerBusyMs: 300, backgroundBusyMs: 300, runtimeUnavailableMs: 300 },
      runtime: {
        runtimeEntry: resolveRuntimeEntry(),
        providerCommand: fixtureCliCommand,
        providerLaunchArgs: fixtureCliLaunchArgs,
        instanceExtras: { projects_dir: projectsDir },
        readyTimeoutMs: 90_000,
        stopTimeoutMs: 10_000,
        env: {
          ...process.env,
          HOME: home.botsHome,
          USERPROFILE: home.botsHome,
          APPDATA: join(home.botsHome, 'AppData', 'Roaming'),
          LOCALAPPDATA: join(home.botsHome, 'AppData', 'Local'),
          XDG_CONFIG_HOME: join(home.botsHome, '.config'),
          XDG_DATA_HOME: join(home.botsHome, '.local', 'share'),
          CATS_BOT_FIXTURE_LOG: fixtureLog,
        },
      },
    },
  });
  await core.start();
  try {
    const noteA = await core.createConversation('Note A');
    const noteB = await core.createConversation('Note B');
    const told = await sendAndWait(core, noteA.id, 'remember:pumpkin', 60_000);
    assert.equal(told.result?.text, 'remembered pumpkin');
    const other = await sendAndWait(core, noteB.id, 'recall?', 60_000);
    assert.equal(other.result?.text, 'recall=nothing', 'the other note cannot see the secret');
    const same = await sendAndWait(core, noteA.id, 'recall?', 60_000);
    assert.equal(same.result?.text, 'recall=pumpkin', 'the note that was told still knows');
    const sessions = (await core.listConversations()).map((record) => record.attachment.sessionId);
    assert.equal(new Set(sessions.filter(Boolean)).size, 2, 'two notes, two sessions');

    const beforeRetarget = (await core.listConversations()).find((record) => record.id === noteA.id)!.attachment;
    await core.updateProfile({ executionTarget: { provider: 'claude', model: 'sonnet-fixture' } });
    const stale = (await core.listConversations()).find((record) => record.id === noteA.id)!.attachment;
    assert.equal(stale.state, 'stale');
    const retargeted = await sendAndWait(core, noteA.id, 'model?', 60_000);
    assert.equal(retargeted.result?.text, 'model=sonnet-fixture', 'the next turn ran under the new model');
    assert.equal(retargeted.configRevision, 2);
    const afterRetarget = (await core.listConversations()).find((record) => record.id === noteA.id)!.attachment;
    assert.notEqual(afterRetarget.sessionId, beforeRetarget.sessionId, 'a new runtime session');
    assert.equal(afterRetarget.model, 'sonnet-fixture');
    const last = fixtureTurns().at(-1)!;
    assert.equal(last.resumed, false, 'the old provider session was not resumed');
    assert.ok(last.args.includes('--model') && last.args.includes('sonnet-fixture'));
    const forgotten = await sendAndWait(core, noteA.id, 'recall?', 60_000);
    assert.equal(forgotten.result?.text, 'recall=nothing', 'the new session has only the handoff pack, not the old process memory');
    assert.ok(core.transcript(noteA.id).some((entry) => entry.kind === 'system' && /now runs on claude \(sonnet-fixture\)/u.test(entry.text)));
  } finally {
    await core.stop();
  }
});
