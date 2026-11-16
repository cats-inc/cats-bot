import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { resolveRuntimeEntry } from '../../src/core/runtime/supervisor.ts';
import { HOSTED_PROVIDER_POLICY } from '../../src/shared/providerTools.ts';
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

/** A CLI that is there and fails at once, for a turn that fails for another reason than a missing CLI. */
function failingCli(dir: string, command: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, command), `#!/bin/sh\necho "${command}: failing on purpose" >&2\nexit 1\n`);
  chmodSync(join(dir, command), 0o755);
  writeFileSync(join(dir, `${command}.cmd`), `@echo ${command}: failing on purpose 1>&2\r\n@exit /b 1\r\n`);
}

// The Runtime launches a CLI on PATH, or one where its installer puts it although PATH does not lead there, as for
// a hub started from Finder whose cat bot was not looked up first. Either way the turn keeps its own error.
for (const [where, provider, place] of [
  ['on PATH', 'codex', (home: string) => join(home, 'bin')],
  ['where its installer puts it, off PATH', 'claude', (home: string) => join(home, '.local', 'bin')],
] as const) {
  test(`a cat bot whose CLI is ${where} keeps its own error when a message fails, with no install line`, async () => {
    const home = makeTempHome('cats-bot-present-cli-');
    const projects = join(home.botsHome, 'projects');
    mkdirSync(projects, { recursive: true });
    const bin = place(home.botsHome);
    failingCli(bin, provider);
    const path = where === 'on PATH' ? bin : join(home.botsHome, 'no-clis');
    const { core } = openTestBot({
      botsHome: home.botsHome, id: 'present', profile: { provider },
      core: {
        runtime: {
          runtimeEntry: resolveRuntimeEntry(), readyTimeoutMs: 90_000, stopTimeoutMs: 10_000,
          instanceExtras: { projects_dir: projects },
          env: { ...process.env, HOME: home.botsHome, USERPROFILE: home.botsHome, PATH: path,
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
      // The Runtime launched the stand-in: the core and the Runtime agree that it is there.
      if (process.platform !== 'win32') assert.match(turn.error ?? '', /failing on purpose/u);
    } finally {
      await core.stop();
    }
  });
}

// Hosted Antigravity runs its ACP server, not `agy`; installing `agy` may not provide it, so nothing is claimed.
test('a hosted Antigravity cat bot keeps its own error when a message fails, with no install line', async () => {
  const home = makeTempHome('cats-bot-hosted-antigravity-');
  const projects = join(home.botsHome, 'projects');
  mkdirSync(projects, { recursive: true });
  const { core } = openTestBot({
    botsHome: home.botsHome, id: 'hosted', profile: { provider: 'antigravity' },
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
  await core.updateProfile({ providerPolicy: HOSTED_PROVIDER_POLICY });
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
