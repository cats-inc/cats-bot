import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';

import { initializeBot } from '../../src/core/bot.ts';
import { channelDescriptorFile, HostChannelClient } from '../../src/core/host-api/channel.ts';
import type { TranscriptEntry, WorkItem } from '../../src/core/types.ts';
import { fixtureCliCommand, fixtureCliLaunchArgs, makeTempHome, type TempHome } from '../support/harness.ts';

/**
 * PLAN-009 Phase 1: the core runs out of the host's process. `cats-bot run` starts the
 * real pinned Runtime with the scripted fixture CLI, publishes its channel, and a host
 * converses with it and stops it through the channel alone. Everything lives in a
 * temporary directory.
 */

let home: TempHome;
before(() => {
  home = makeTempHome('cats-bot-channel-run-');
});
after(() => home.cleanup());

async function until(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('cats-bot run serves the host channel: a host converses with the core and stops it', { timeout: 180_000 }, async () => {
  const { root } = initializeBot(home.botsHome, { id: 'runbot', name: 'Run Bot', provider: 'claude' });
  const projectsDir = join(home.root, 'claude-projects');
  mkdirSync(projectsDir, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CATS_BOT_HOME: home.root,
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
  };
  delete env.CATS_BOT_ID;
  const child = spawn(process.execPath, [resolve('src/cli/main.ts'), 'run', '--id', 'runbot', '--manager', 'test-installation', '--json'], {
    env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise<number | null>((resolveExit) => child.on('exit', (code) => resolveExit(code)));
  let client: HostChannelClient | null = null;
  try {
    await until(() => existsSync(channelDescriptorFile(root)), 90_000, `the channel descriptor\n${output}`);
    client = await HostChannelClient.connect(root, {
      host: { pid: process.pid, executable: process.execPath, installationId: 'test-installation' },
    });
    assert.equal(client.descriptor.manager, 'test-installation');
    assert.equal(client.descriptor.pid, child.pid);

    const connected = client;
    const completed = new Promise<WorkItem>((resolveTurn) => {
      connected.onEvent((event) => {
        if (event.type === 'turn.completed' && event.workItem.kind === 'owner_message') resolveTurn(event.workItem);
      });
    });
    const sent = await connected.call('sendOwnerMessage', 'home', 'hello from the host') as WorkItem;
    const item = await completed;
    assert.equal(item.id, sent.id);
    assert.equal(item.state, 'completed', output);
    const transcript = await connected.call('transcript', 'home') as TranscriptEntry[];
    assert.ok(transcript.some((entry) => entry.kind === 'owner' && entry.text === 'hello from the host'));
    assert.ok(transcript.some((entry) => entry.kind === 'bot' && entry.text.length > 0), 'the fixture CLI answered');

    assert.equal(await connected.call('quit'), null);
    assert.equal(await exited, 0, output);
    assert.equal(existsSync(channelDescriptorFile(root)), false, 'the core removed its descriptor');
  } finally {
    client?.close();
    if (child.exitCode === null) child.kill();
  }
});
