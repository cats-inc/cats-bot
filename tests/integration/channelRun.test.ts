import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';

import { initializeBot } from '../../src/core/bot.ts';
import { channelDescriptorFile } from '../../src/core/host-api/channel.ts';
import type { WorkItem } from '../../src/core/types.ts';
import {
  attachOrStartCore, CoreHostedElsewhereError, coreLogFile, killTree, type CoreLaunch, type HostedCore,
} from '../../src/shell/electron/coreHost.ts';
import { processIsAlive } from '../../src/shell/electron/update/installation.ts';
import { fixtureCliCommand, fixtureCliLaunchArgs, makeTempHome, type TempHome } from '../support/harness.ts';

/**
 * PLAN-009 Phase 1: the core runs out of the host's process. The shell's core
 * host starts `cats-bot run` with the real pinned Runtime and the scripted
 * fixture CLI, converses with it through the channel alone, goes away without
 * stopping it, reattaches, and stops it. Everything lives in a temporary
 * directory.
 */

let home: TempHome;
before(() => {
  home = makeTempHome('cats-bot-channel-run-');
});
after(() => home.cleanup());

test('the shell starts its core as a process, leaves it running when it goes, reattaches and stops it', { timeout: 180_000 }, async () => {
  const { root } = initializeBot(home.botsHome, { id: 'runbot', name: 'Run Bot', provider: 'claude' });
  const projectsDir = join(home.root, 'claude-projects');
  mkdirSync(projectsDir, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CATS_BOT_PROVIDER_COMMAND: fixtureCliCommand,
    CATS_BOT_PROVIDER_LAUNCH_ARGS: fixtureCliLaunchArgs.join('\n'),
    CATS_BOT_PROVIDER_PROJECTS_DIR: projectsDir,
    CATS_BOT_FIXTURE_LOG: join(home.root, 'fixture.log'),
    HOME: home.root,
    USERPROFILE: home.root,
    APPDATA: join(home.root, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home.root, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home.root, '.config'),
    XDG_DATA_HOME: join(home.root, '.local', 'share'),
    CATS_BOT_ID: 'not-this-bot',
  };
  const launch: CoreLaunch = {
    execPath: process.execPath, runAsNode: false, entry: resolve('src/cli/main.ts'),
    catsBotHome: home.root, botId: 'runbot', manager: 'test-installation', env,
  };
  const options = { host: { pid: process.pid, executable: process.execPath, installationId: 'test-installation' }, startTimeoutMs: 90_000 };
  let first: HostedCore | null = null;
  let second: HostedCore | null = null;
  try {
    first = await attachOrStartCore(root, launch, options);
    assert.equal(first.started, true);
    assert.equal(first.client.descriptor.manager, 'test-installation');

    const shell = first;
    const completed = new Promise<WorkItem>((resolveTurn) => {
      shell.core.subscribe((event) => {
        if (event.type === 'turn.completed' && event.workItem.kind === 'owner_message') resolveTurn(event.workItem);
      });
    });
    const sent = await shell.core.sendOwnerMessage('home', 'hello from the host');
    const item = await completed;
    assert.equal(item.id, sent.id);
    assert.equal(item.state, 'completed', readFileSync(first.logFile, 'utf8'));

    // The shell goes away without Quit: the core keeps running (FR-15).
    first.client.close();
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    assert.equal(processIsAlive(first.pid), true);

    second = await attachOrStartCore(root, launch, options);
    assert.equal(second.started, false, 'the next shell reattaches instead of starting another core');
    assert.equal(second.pid, first.pid);
    const transcript = await second.core.transcript('home');
    assert.ok(transcript.some((entry) => entry.kind === 'owner' && entry.text === 'hello from the host'));
    assert.ok(transcript.some((entry) => entry.kind === 'bot' && entry.text.length > 0), 'the fixture CLI answered');
    // SPEC-008 FR-11: another installation never takes the core over.
    await assert.rejects(attachOrStartCore(root, { ...launch, manager: 'another-installation' }, options), CoreHostedElsewhereError);

    await second.stop();
    assert.equal(processIsAlive(first.pid), false);
    assert.equal(existsSync(channelDescriptorFile(root)), false, 'the core removed its descriptor');
    const log = readFileSync(coreLogFile(root), 'utf8');
    assert.match(log, /core start bot=runbot/u, 'the core logs to its file');
    assert.equal(log.includes('hello from the host'), false, 'conversation text stays out of the log');
  } finally {
    first?.client.close();
    second?.client.close();
    if (first && processIsAlive(first.pid)) killTree(first.pid);
  }
});
