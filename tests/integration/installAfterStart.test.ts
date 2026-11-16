import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

import { BotCore, initializeBot } from '../../src/core/bot.ts';
import { saveProfile } from '../../src/core/profile/profile.ts';
import { resolveRuntimeEntry } from '../../src/core/runtime/supervisor.ts';
import { botPathsFor } from '../../src/core/store/paths.ts';
import { awakeNow, fixtureCliDir, makeTempHome, sendAndWait } from '../support/harness.ts';

/**
 * ADR-032 against the real pinned cats-runtime: a cat bot's first message finds no CLI; the owner installs it, as
 * "Open Provider and model" leads to; the next message is answered, without restarting the cat bot. The core is
 * opened as the shell opens it, with no runtime env of its own, so this file's process environment is the one the
 * Runtime starts with: a temporary home and a PATH that holds no provider CLI and no Node. `node --test` runs each
 * file in its own process.
 */

// A Windows CLI is an .exe; a script stand-in there is not what the Runtime launches.
const skip = process.platform === 'win32' ? 'POSIX stand-ins for the provider binaries' : false;

/** A temporary home of the test's own, which the Runtime it starts next inherits. */
function useHome(t: TestContext): string {
  const home = makeTempHome('cats-bot-install-after-start-');
  t.after(() => home.cleanup());
  const h = home.botsHome;
  Object.assign(process.env, {
    HOME: h, USERPROFILE: h, PATH: [join(h, 'no-clis'), '/usr/bin', '/bin'].join(':'),
    XDG_CONFIG_HOME: join(h, '.config'), XDG_DATA_HOME: join(h, '.local', 'share'),
  });
  return h;
}

/** A core opened as the shell opens it, for a cat bot that is awake now whatever the clock says. */
async function openCore(h: string, id: string, provider: string): Promise<BotCore> {
  const projects = join(h, 'projects');
  mkdirSync(projects, { recursive: true });
  const { profile, root } = initializeBot(h, { id, name: 'Mochi', provider });
  saveProfile(botPathsFor(root), { ...profile, heartbeat: { ...profile.heartbeat, ...awakeNow(new Date(), { sinceWake: 5 * 60, untilBed: 12 * 60 }) } });
  const core = BotCore.open({
    root, log: () => {},
    runtime: { runtimeEntry: resolveRuntimeEntry(), readyTimeoutMs: 90_000, stopTimeoutMs: 10_000, instanceExtras: { projects_dir: projects } },
    handoffPollMs: 100,
    life: { startupDelayMs: 3_600_000, intervalMs: 3_600_000 },
  });
  await core.start();
  return core;
}

/** Installs a `claude` that is the repo's scripted Claude Code stand-in. */
function installClaude(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'claude');
  writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${join(fixtureCliDir, 'claude-fixture.mjs')}" "$@"\n`);
  chmodSync(file, 0o755);
}

/** The first message gets the install line, and no session was made or ran a turn. */
async function firstMessageFindsNoCli(core: BotCore, label: string): Promise<void> {
  // The cat wakes before anyone writes; with no CLI it makes no session.
  assert.equal((await core.tick()).outcome, 'wake_failed');
  const first = await sendAndWait(core, 'home', 'hello', 60_000);
  assert.equal(first.state, 'failed');
  const errors = core.transcript('home').filter((entry) => entry.kind === 'error');
  assert.deepEqual(errors.map((entry) => [entry.fix?.kind, entry.fix?.label]), [['install_cli', label]]);
  assert.equal(core.listWorkItems().some((item) => item.run?.sessionId), false, 'no session ran a turn');
  assert.equal((await core.listConversations())[0]!.attachment.sessionId ?? null, null, 'no session was made');
}

for (const [where, place, report] of [
  // Where Claude's installer puts it: the Runtime looks there although its PATH does not lead there.
  ['where its installer puts it', (h: string) => join(h, '.local', 'bin'), false],
  // Elsewhere, such as an npm prefix: the shell reports the folder, and the Runtime starts again with it on PATH.
  ['in a folder the shell reports', (h: string) => join(h, 'prefix', 'bin'), true],
] as const) {
  test(`after the missing CLI is installed ${where}, the next message is answered`, { skip }, async (t) => {
    const h = useHome(t);
    const folder = place(h);
    const core = await openCore(h, report ? 'reported' : 'installer', 'claude');
    try {
      await firstMessageFindsNoCli(core, 'Claude');
      installClaude(folder);
      if (report) core.useCommandDirectory(folder);
      const next = await sendAndWait(core, 'home', 'remember 42', 90_000);
      assert.equal(next.state, 'completed', next.error);
      const reply = core.transcript('home').filter((entry) => entry.kind === 'bot' && entry.workItemId === next.id);
      assert.ok(reply.length > 0, 'the cat bot answered');
      assert.equal(core.transcript('home').some((entry) => /resume/iu.test(entry.text)), false,
        core.transcript('home').map((entry) => `${entry.kind}: ${entry.text}`).join(' | '));
    } finally {
      await core.stop();
    }
  });
}

test('an npm Codex with no Node says Node.js is missing, and runs once the Node folder is reported', { skip }, async (t) => {
  const h = useHome(t);
  // npm's `codex` is a script that starts Node; it sits where the Runtime's install knowledge looks for it.
  const npmBin = join(h, '.npm-global', 'bin');
  mkdirSync(npmBin, { recursive: true });
  writeFileSync(join(npmBin, 'codex'), '#!/usr/bin/env node\nprocess.stderr.write("STUB-CODEX-RAN\\n");\nprocess.exit(1);\n');
  chmodSync(join(npmBin, 'codex'), 0o755);
  const core = await openCore(h, 'codex', 'codex');
  try {
    await firstMessageFindsNoCli(core, 'Node.js');
    const nodeBin = join(h, 'node', 'bin');
    mkdirSync(nodeBin, { recursive: true });
    symlinkSync(process.execPath, join(nodeBin, 'node'));
    core.useCommandDirectory(nodeBin);
    const next = await sendAndWait(core, 'home', 'hello again', 90_000);
    assert.equal(next.state, 'failed');
    assert.match(next.error ?? '', /STUB-CODEX-RAN/u, 'the Runtime launched codex with Node');
  } finally {
    await core.stop();
  }
});

test('a check that finds a CLI the running Runtime already launches restarts nothing', { skip }, async (t) => {
  const h = useHome(t);
  const folder = join(h, '.local', 'bin');
  installClaude(folder);
  const core = await openCore(h, 'found', 'claude');
  try {
    const first = await sendAndWait(core, 'home', 'hello', 90_000);
    assert.equal(first.state, 'completed', first.error);
    const pid = core.status().runtime.pid;
    assert.ok(pid);
    core.useCommandDirectory(folder);
    const next = await sendAndWait(core, 'home', 'hello again', 90_000);
    assert.equal(next.state, 'completed', next.error);
    assert.equal(core.status().runtime.pid, pid, 'the same Runtime answered');
  } finally {
    await core.stop();
  }
});
