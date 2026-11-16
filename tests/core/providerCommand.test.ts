import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { canFindProviderCommand, loadInstallKnowledge } from '../../src/core/providers/providerCommand.ts';
import { resolveRuntimeEntry } from '../../src/core/runtime/supervisor.ts';
import { fakeRuntimeEntry, makeTempHome } from '../support/harness.ts';

// ADR-032: a CLI is said to be missing only when the Runtime could not launch it either.

test('the install knowledge comes from the Runtime that runs the cat bot, and a test double has none', async () => {
  assert.equal(await loadInstallKnowledge(fakeRuntimeEntry), null);
  const knowledge = await loadInstallKnowledge(resolveRuntimeEntry());
  assert.ok(knowledge, 'the pinned Runtime carries its install knowledge');
  for (const provider of ['codex', 'claude', 'antigravity', 'grok', 'muse', 'kimi'])
    assert.ok(knowledge(provider)?.check, `${provider} has a check`);
});

test('a CLI where its installer puts it is found although PATH does not lead there', async () => {
  const knowledge = (await loadInstallKnowledge(resolveRuntimeEntry()))!;
  const home = makeTempHome('cats-bot-provider-command-').botsHome;
  const env = { HOME: home, PATH: join(home, 'no-clis') };
  assert.equal(canFindProviderCommand(knowledge, 'claude', 'claude', env, 'darwin'), false);
  assert.equal(canFindProviderCommand(knowledge, 'grok', 'grok', env, 'linux'), false);
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(join(home, '.local', 'bin', 'claude'), '');
  mkdirSync(join(home, '.grok', 'bin'), { recursive: true });
  writeFileSync(join(home, '.grok', 'bin', 'grok'), '');
  assert.equal(canFindProviderCommand(knowledge, 'claude', 'claude', env, 'darwin'), true);
  assert.equal(canFindProviderCommand(knowledge, 'grok', 'grok', env, 'linux'), true);
  assert.equal(canFindProviderCommand(knowledge, 'kimi', 'kimi', env, 'darwin'), false);
});

test('on Windows the npm folders count, an environment name in any case expands, and an unset one is skipped', async () => {
  const knowledge = (await loadInstallKnowledge(resolveRuntimeEntry()))!;
  const home = makeTempHome('cats-bot-provider-command-win-').botsHome;
  const appData = join(home, 'Roaming');
  const env = { USERPROFILE: home, appdata: appData, Path: join(home, 'no-clis') };
  assert.equal(canFindProviderCommand(knowledge, 'codex', 'codex', env, 'win32'), false);
  assert.equal(canFindProviderCommand(knowledge, 'muse', 'muse', env, 'win32'), false, 'no LOCALAPPDATA: its folder is not probed');
  mkdirSync(join(appData, 'npm'), { recursive: true });
  writeFileSync(join(appData, 'npm', 'codex.cmd'), '');
  assert.equal(canFindProviderCommand(knowledge, 'codex', 'codex', env, 'win32'), true);
  mkdirSync(join(home, '.npm-global'), { recursive: true });
  writeFileSync(join(home, '.npm-global', 'kimi.cmd'), '');
  assert.equal(canFindProviderCommand(knowledge, 'kimi', 'kimi', env, 'win32'), true);
});
