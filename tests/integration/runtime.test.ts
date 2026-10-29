import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import type { RuntimeClient } from '../../src/core/runtime/client.ts';
import { resolveRuntimeEntry } from '../../src/core/runtime/supervisor.ts';
import { fixtureCliCommand, fixtureCliLaunchArgs, makeTempHome, openTestBot, sendAndWait, waitForEvent, type TempHome } from '../support/harness.ts';

/**
 * SPEC-001 A1 against the real pinned cats-runtime package: the bot starts it
 * the way it does in production (`--startup-mode app-managed --port 0`,
 * private `CATS_RUNTIME_DIR`), with the scripted fixture CLI registered as the
 * `claude` command. Everything lives in a temporary directory.
 */

let home: TempHome;
let projectsDir: string;
let fixtureLog: string;
before(() => {
  home = makeTempHome('cats-bot-runtime-');
  projectsDir = join(home.botsHome, 'claude-projects');
  mkdirSync(projectsDir, { recursive: true });
  fixtureLog = join(home.botsHome, 'fixture.log');
});
after(() => home.cleanup());

function fixtureTurns(): Array<{ message: string; resumed: boolean; args: string[] }> {
  try {
    return readFileSync(fixtureLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { message: string; resumed: boolean; args: string[] });
  } catch {
    return [];
  }
}

function writeDiscoveredClaudeSession(cwd: string): string {
  const sessionId = '11111111-2222-4333-8444-555555555555';
  const projectPath = join(projectsDir, 'C--somewhere-else');
  mkdirSync(projectPath, { recursive: true });
  const lines = [
    { type: 'user', cwd, sessionId, timestamp: '2026-10-27T08:00:00.000Z', uuid: 'u1', message: { role: 'user', content: 'hello from another window' } },
    { type: 'assistant', cwd, sessionId, timestamp: '2026-10-27T08:00:01.000Z', uuid: 'u2', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
  ];
  writeFileSync(join(projectPath, `${sessionId}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return sessionId;
}

test('the bot drives the real runtime with the fixture CLI: create, stream, cancel, resume, history', async () => {
  const { core, root } = openTestBot({
    botsHome: home.botsHome,
    id: 'real',
    profile: { instructions: 'You are Mochi, a small desk cat.' },
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
  const discovered = writeDiscoveredClaudeSession(join(root, 'workspace'));
  const statuses: string[] = [];
  core.subscribe((event) => {
    if (event.type === 'runtime.status') statuses.push(event.state);
  });
  await core.start();
  try {
    assert.equal(core.runtimeState(), 'ready', `runtime states: ${statuses.join(',')}`);

    // SPEC-001 FR-5: the private runtime was configured for exactly this provider.
    const providersYaml = readFileSync(join(root, 'runtime', 'config', 'providers.yaml'), 'utf8');
    assert.match(providersYaml, /claude:/u);
    assert.match(providersYaml, /command: /u);
    // SPEC-007 FR-6: Runtime names Cats Bot as its manager.
    const client = (core as unknown as { supervisor: { client: RuntimeClient | null } | null }).supervisor?.client;
    assert.equal((await client!.health()).startup?.managedBy, 'cats-bot');

    // The same advanced catalog/selection contract as Desktop, all the way to CLI arguments.
    const catalog = await core.listModels('claude');
    assert.equal(catalog.source, 'runtime');
    assert.ok(catalog.catalogRevision);
    const entry = catalog.models.find((model) =>
      model.controls?.some((control) => control.key === 'claude.reasoning_effort'),
    )!;
    assert.ok(entry);
    await core.updateProfile({
      executionTarget: {
        provider: 'claude',
        model: entry.id,
        modelSelection: {
          entryMode: 'explicit',
          entryId: entry.id,
          catalogRevision: 'previous-factory-revision',
          controls: { 'claude.reasoning_effort': 'high' },
        },
      },
    });

    const first = await sendAndWait(core, 'home', 'hello', 60_000);
    assert.equal(first.state, 'completed', first.error);
    assert.equal(first.result?.text, 'echo: hello');
    const home1 = (await core.listConversations())[0]!;
    assert.equal(home1.attachment.state, 'ready');
    assert.ok(home1.attachment.providerSessionId, 'the init frame carried the provider session id');
    assert.equal(fixtureTurns().length, 1);
    assert.equal(fixtureTurns()[0]?.resumed, false);
    const launchArgs = fixtureTurns()[0]!.args;
    assert.equal(
      launchArgs[launchArgs.indexOf('--effort') + 1],
      'high',
      'saved catalog effort reaches the real Runtime adapter',
    );

    // The fixture's first turn received the persona through the session instructions.
    const instructed = await sendAndWait(core, 'home', 'instructions?', 60_000);
    assert.equal(instructed.state, 'completed');
    assert.match(instructed.result?.text ?? '', /Mochi/u);

    const tool = await sendAndWait(core, 'home', 'tool time', 60_000);
    assert.equal(tool.state, 'completed');
    const kinds = core.transcript('home').filter((entry) => entry.workItemId === tool.id).map((entry) => entry.kind);
    assert.ok(kinds.includes('tool_use') && kinds.includes('tool_result'), `kinds: ${kinds.join(',')}`);

    // Cancel: the runtime kills the worker, the session closes; the next turn resumes it.
    const running = waitForEvent(core, (event) => event.type === 'work.updated' && event.workItem.state === 'running', 60_000);
    const slow = await core.sendOwnerMessage('home', 'slow:20000');
    await running;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const cancelled = waitForEvent(core, (event) => event.type === 'turn.completed' && event.workItem.id === slow.id, 60_000);
    await core.cancelTurn('home');
    const cancelledItem = await cancelled;
    assert.equal(cancelledItem.type === 'turn.completed' && cancelledItem.workItem.state, 'cancelled');

    const resumed = await sendAndWait(core, 'home', 'resumed?', 60_000);
    assert.equal(resumed.state, 'completed', resumed.error);
    assert.equal(resumed.result?.text, 'resumed=yes', 'the runtime resumed the provider session with --resume');
    const home2 = (await core.listConversations())[0]!;
    assert.equal(home2.attachment.sessionId, home1.attachment.sessionId, 'the runtime session id is kept across resume');
    assert.equal(home2.attachment.providerSessionId, home1.attachment.providerSessionId);

    // SPEC-001 A1: a discovered entry in the private registry changes nothing for the bot.
    const conversations = await core.listConversations();
    assert.equal(conversations.length, 1);
    assert.notEqual(conversations[0]?.attachment.sessionId, discovered);
    const history = await core.sessionHistory('home');
    assert.ok(history.length >= 2, `history: ${JSON.stringify(history)}`);
    assert.ok(history.some((message) => message.role === 'assistant' && /echo: hello/u.test(message.text)));
  } finally {
    await core.stop();
  }
  assert.equal(core.runtimeState(), 'stopped');
});
