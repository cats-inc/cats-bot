import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { resolveRuntimeEntry } from '../../src/core/runtime/supervisor.ts';
import { makeTempHome, openTestBot, sendAndWait } from '../support/harness.ts';

/**
 * ADR-032 against the real pinned cats-runtime: a cat bot created without its CLI starts, and a message to it
 * says the CLI is missing, once, with the way to install it, in place of the Runtime's resume error. Everything
 * lives in a temporary directory, and the PATH holds no provider CLI.
 */
for (const [provider, label] of [['codex', 'Codex'], ['grok', 'Grok']] as const) {
  test(`a message to a ${label} cat bot whose CLI is not on this computer says so, with the way to install it`, async () => {
    const home = makeTempHome('cats-bot-missing-cli-');
    const projects = join(home.botsHome, 'projects');
    mkdirSync(projects, { recursive: true });
    const { core } = openTestBot({
      botsHome: home.botsHome, id: provider, profile: { provider },
      core: {
        runtime: {
          runtimeEntry: resolveRuntimeEntry(), readyTimeoutMs: 90_000, stopTimeoutMs: 10_000,
          instanceExtras: { projects_dir: projects },
          env: { ...process.env, HOME: home.botsHome, USERPROFILE: home.botsHome, PATH: join(home.botsHome, 'no-clis'),
            APPDATA: join(home.botsHome, 'AppData', 'Roaming'), LOCALAPPDATA: join(home.botsHome, 'AppData', 'Local'),
            XDG_CONFIG_HOME: join(home.botsHome, '.config'), XDG_DATA_HOME: join(home.botsHome, '.local', 'share') },
        },
      },
    });
    await core.start();
    try {
      const turn = await sendAndWait(core, 'home', 'hello', 60_000);
      assert.equal(turn.state, 'failed');
      // The one error the owner sees names the CLI; neither the binder's nor the turn's raw reason is beside it.
      const errors = core.transcript('home').filter((entry) => entry.kind === 'error');
      assert.deepEqual(errors.map((entry) => entry.fix), [{ kind: 'install_cli', provider, label }],
        errors.map((entry) => entry.text).join(' | '));
      assert.equal(errors[0]!.workItemId, turn.id);
      assert.match(turn.error ?? '', /\S/u, 'the work item keeps the raw reason for the log');
    } finally {
      await core.stop();
    }
  });
}

test('a cat bot whose CLI is on this computer keeps its own error when a message fails, with no install line', async () => {
  const home = makeTempHome('cats-bot-present-cli-');
  const projects = join(home.botsHome, 'projects');
  const bin = join(home.botsHome, 'bin');
  mkdirSync(projects, { recursive: true });
  mkdirSync(bin, { recursive: true });
  // A `codex` that is there and fails at once, for a turn that fails for another reason than a missing CLI.
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\necho "codex: failing on purpose" >&2\nexit 1\n');
  chmodSync(join(bin, 'codex'), 0o755);
  writeFileSync(join(bin, 'codex.cmd'), '@echo codex: failing on purpose 1>&2\r\n@exit /b 1\r\n');
  const { core } = openTestBot({
    botsHome: home.botsHome, id: 'present', profile: { provider: 'codex' },
    core: {
      runtime: {
        runtimeEntry: resolveRuntimeEntry(), readyTimeoutMs: 90_000, stopTimeoutMs: 10_000,
        instanceExtras: { projects_dir: projects },
        env: { ...process.env, HOME: home.botsHome, USERPROFILE: home.botsHome, PATH: bin,
          APPDATA: join(home.botsHome, 'AppData', 'Roaming'), LOCALAPPDATA: join(home.botsHome, 'AppData', 'Local'),
          XDG_CONFIG_HOME: join(home.botsHome, '.config'), XDG_DATA_HOME: join(home.botsHome, '.local', 'share') },
      },
    },
  });
  await core.start();
  try {
    const turn = await sendAndWait(core, 'home', 'hello', 60_000);
    assert.equal(turn.state, 'failed');
    const errors = core.transcript('home').filter((entry) => entry.kind === 'error');
    assert.ok(errors.length > 0, 'the failure is written');
    assert.ok(errors.every((entry) => !entry.fix), errors.map((entry) => entry.text).join(' | '));
  } finally {
    await core.stop();
  }
});
