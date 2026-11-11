import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { BotCore, type BotCoreOptions } from '../../src/core/bot.ts';
import { resolveRuntimeEntry } from '../../src/core/runtime/supervisor.ts';
import { makeTempHome, openTestBot, sendAndWait } from '../support/harness.ts';

function optionsFor(botsHome: string, provider = 'codex'): Partial<BotCoreOptions> {
  const projectsDir = join(botsHome, 'claude-projects');
  mkdirSync(projectsDir, { recursive: true });
  return {
    tools: false, log: () => {},
    life: { startupDelayMs: 3_600_000, intervalMs: 3_600_000 },
    runtime: {
      runtimeEntry: resolveRuntimeEntry(), providerCommand: process.execPath,
      providerLaunchArgs: [resolve(`tests/support/fixture-cli/${provider}-fixture.mjs`)], readyTimeoutMs: 60_000,
      ...(provider === 'claude' ? { instanceExtras: { projects_dir: projectsDir } } : {}),
      env: { ...process.env, HOME: botsHome, USERPROFILE: botsHome,
        CODEX_HOME: join(botsHome, 'codex'), APPDATA: join(botsHome, 'roaming'),
        LOCALAPPDATA: join(botsHome, 'local'), XDG_CONFIG_HOME: join(botsHome, '.config'),
        XDG_DATA_HOME: join(botsHome, '.local', 'share') },
    },
  };
}

for (const provider of ['codex', 'claude']) test(`an unused ${provider} replacement survives a second real Runtime restart when a turn arrives`, { timeout: 120_000 }, async () => {
  const home = makeTempHome('cats-bot-unstarted-');
  const options = optionsFor(home.botsHome, provider);
  const { core, root } = openTestBot({ botsHome: home.botsHome, profile: { provider }, core: options });
  let reopened: BotCore | undefined;
  try {
    await core.updateProfile({ heartbeat: { enabled: false } });
    await core.start();
    assert.equal(core.runtimeState(), 'ready');
    const first = await sendAndWait(core, 'home', 'History before the warm session', 60_000);
    assert.equal(first.state, 'completed', first.error);
    // A configuration change warms a new session with the old conversation's
    // handoff. Stop without giving that new worker its first model turn.
    await core.updateProfile({ instructions: 'Keep the conversation going.' });
    await core.tick();
    const warm = (await core.listConversations())[0]!.attachment;
    assert.ok(warm.sessionId);
    assert.equal(warm.providerSessionId, null);
    await core.stop();
    const sessions = JSON.parse(readFileSync(join(root, 'runtime/data/sessions.json'), 'utf8')) as
      Array<{ id: string; messageCount: number; providerSessionId?: string }>;
    assert.equal(sessions.find(session => session.id === warm.sessionId)?.messageCount, 0);

    reopened = BotCore.open({ root, ...options });
    await reopened.start();
    assert.equal(reopened.runtimeState(), 'ready');
    const tick = await reopened.tick();
    assert.equal(tick.outcome, 'rebuilt');
    const replacement = (await reopened.listConversations())[0]!.attachment;
    assert.notEqual(replacement.sessionId, warm.sessionId);
    assert.equal(replacement.replacementPending, true);
    assert.ok(reopened.transcript('home').some(entry => entry.text === 'History before the warm session'));
    assert.equal(reopened.transcript('home').filter(entry => entry.text.includes('a new session starts')).length, 1);
    await reopened.tick();
    assert.equal((await reopened.listConversations())[0]!.attachment.sessionId, replacement.sessionId);

    // The replacement was only warmed by reconcile. A second host shutdown
    // must not permanently lock the conversation before its first real turn.
    await reopened.stop();
    reopened = BotCore.open({ root, ...options });
    await reopened.start();
    assert.equal(reopened.runtimeState(), 'ready');
    for (let tick = 0; tick < 3; tick++) {
      await reopened.tick();
      assert.equal((await reopened.listConversations())[0]!.attachment.sessionId, replacement.sessionId,
        'background ticks must not create another unused replacement');
    }
    assert.equal(reopened.transcript('home').filter(entry => entry.text.includes('a new session starts')).length, 1);

    const next = await sendAndWait(reopened, 'home', 'Continue after restart', 60_000);
    assert.equal(next.state, 'completed', next.error);
    const continued = (await reopened.listConversations())[0]!.attachment;
    assert.notEqual(continued.sessionId, replacement.sessionId);
    assert.ok(continued.providerSessionId);
    assert.equal(continued.replacementPending, undefined);
    assert.equal(reopened.listWorkItems().filter(item => item.run).length, 2,
      'only the two requested prompts ran across all restarts');
  } finally {
    await reopened?.stop();
    await core.stop();
    home.cleanup();
  }
});

test('a failed Codex bootstrap is not an unstarted warm session after restart', { timeout: 120_000 }, async () => {
  const home = makeTempHome('cats-bot-failed-bootstrap-');
  const options = optionsFor(home.botsHome);
  options.runtime = { ...options.runtime, env: { ...options.runtime?.env,
    CATS_BOT_FIXTURE_CODEX_BOOTSTRAP_ERROR: 'Fixture authentication denied' } };
  const { core, root } = openTestBot({ botsHome: home.botsHome, profile: { provider: 'codex' }, core: options });
  let reopened: BotCore | undefined;
  try {
    await core.updateProfile({ heartbeat: { enabled: false } });
    await core.start();
    assert.equal(core.runtimeState(), 'ready');
    const failed = await sendAndWait(core, 'home', 'This attempt must remain recorded', 60_000);
    assert.equal(failed.state, 'failed');
    assert.match(failed.error ?? '', /Fixture authentication denied/u);
    const attachment = (await core.listConversations())[0]!.attachment;
    assert.equal(attachment.providerSessionId, null);
    assert.equal(failed.run?.sessionId, attachment.sessionId);
    await core.stop();

    reopened = BotCore.open({ root, ...options });
    await reopened.start();
    assert.equal(reopened.runtimeState(), 'ready');
    assert.equal((await reopened.tick()).outcome, 'wake_failed');
    const retained = (await reopened.listConversations())[0]!.attachment;
    assert.equal(retained.sessionId, attachment.sessionId);
    assert.equal(retained.replacementPending, undefined);
    assert.ok(reopened.listWorkItems().some(item => item.run?.sessionId === attachment.sessionId));
    assert.equal(reopened.transcript('home').filter(entry => entry.text.includes('a new session starts')).length, 0);
  } finally {
    await reopened?.stop();
    await core.stop();
    home.cleanup();
  }
});
