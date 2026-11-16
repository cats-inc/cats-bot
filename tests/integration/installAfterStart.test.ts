import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { resolveRuntimeEntry } from '../../src/core/runtime/supervisor.ts';
import { fixtureCliDir, makeTempHome, openTestBot, sendAndWait } from '../support/harness.ts';

// A Windows `claude` is an .exe; a script stand-in there is not what the Runtime launches.
const skip = process.platform === 'win32' ? 'POSIX stand-in for the claude binary' : false;

/**
 * ADR-032 with SPEC-001 FR-11 against the real pinned cats-runtime: a cat bot's first message finds no CLI and says
 * so; the owner installs it where its installer puts it; the next message is answered, without restarting.
 */
test('after the missing CLI is installed, the next message is answered', { skip }, async (t) => {
  const home = makeTempHome('cats-bot-install-after-start-');
  t.after(() => home.cleanup());
  const h = home.botsHome;
  const projects = join(h, 'projects');
  mkdirSync(projects, { recursive: true });
  const { core } = openTestBot({
    botsHome: h, id: 'installer', profile: { provider: 'claude' },
    core: {
      runtime: {
        runtimeEntry: resolveRuntimeEntry(), readyTimeoutMs: 90_000, stopTimeoutMs: 10_000,
        instanceExtras: { projects_dir: projects },
        env: { ...process.env, HOME: h, USERPROFILE: h, PATH: [join(h, 'no-clis'), '/usr/bin', '/bin'].join(':'),
          XDG_CONFIG_HOME: join(h, '.config'), XDG_DATA_HOME: join(h, '.local', 'share') },
      },
    },
  });
  await core.start();
  try {
    const first = await sendAndWait(core, 'home', 'hello', 60_000);
    assert.equal(first.state, 'failed');
    assert.deepEqual(core.transcript('home').filter((entry) => entry.kind === 'error').map((entry) => entry.fix?.kind), ['install_cli']);

    // Where Claude's installer puts it: the Runtime looks there although its PATH does not lead there.
    const bin = join(h, '.local', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${join(fixtureCliDir, 'claude-fixture.mjs')}" "$@"\n`);
    chmodSync(join(bin, 'claude'), 0o755);
    const next = await sendAndWait(core, 'home', 'remember 42', 90_000);
    assert.equal(next.state, 'completed', next.error);
    assert.ok(core.transcript('home').some((entry) => entry.kind === 'bot' && entry.workItemId === next.id), 'the cat bot answered');
  } finally {
    await core.stop();
  }
});
