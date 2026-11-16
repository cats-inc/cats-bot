import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { canFindProviderCommand, codexCanStart, loadInstallKnowledge, nodeInterpreter } from '../../src/core/providers/providerCommand.ts';
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

test('on Windows the Runtime\'s own lookups count whatever PATHEXT says, and PATH entries are trimmed', async () => {
  const knowledge = (await loadInstallKnowledge(resolveRuntimeEntry()))!;
  const home = makeTempHome('cats-bot-provider-command-ext-').botsHome;
  const appData = join(home, 'Roaming');
  const localAppData = join(home, 'Local');
  const env = { USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: localAppData, PATHEXT: '.EXE', Path: join(home, 'no-clis') };
  // The npm folders are searched with .cmd, .bat and .exe.
  mkdirSync(join(appData, 'npm'), { recursive: true });
  writeFileSync(join(appData, 'npm', 'codex.cmd'), '');
  assert.equal(canFindProviderCommand(knowledge, 'codex', 'codex', env, 'win32'), true);
  // The expected path is taken as it is. Its `\` separators name a folder only on a Windows file system.
  if (process.platform === 'win32') {
    mkdirSync(join(localAppData, 'Programs', 'muse'), { recursive: true });
    writeFileSync(join(localAppData, 'Programs', 'muse', 'muse.cmd'), '');
    assert.equal(canFindProviderCommand(knowledge, 'muse', 'muse', env, 'win32'), true);
  }
  // An empty PATHEXT means the default, and a PATH entry with spaces around it is the folder it names.
  const shims = join(home, 'shims');
  mkdirSync(shims, { recursive: true });
  writeFileSync(join(shims, 'kimi.cmd'), '');
  assert.equal(canFindProviderCommand(knowledge, 'kimi', 'kimi', { ...env, PATHEXT: '', Path: `${join(home, 'no-clis')}; ${shims} ` }, 'win32'), true);
});

test('a script\'s first line says how it starts Node: through PATH, from a named file, or not at all', () => {
  const dir = makeTempHome('cats-bot-node-interpreter-').botsHome;
  const file = (name: string, content: string | Buffer) => {
    writeFileSync(join(dir, name), content);
    return join(dir, name);
  };
  assert.deepEqual(nodeInterpreter(file('npm-codex', '#!/usr/bin/env node\nrequire("./bin")\n')), { onPath: true });
  assert.deepEqual(nodeInterpreter(file('env-s', '#!/usr/bin/env -S node --no-warnings\n')), { onPath: true });
  assert.deepEqual(nodeInterpreter(file('homebrew', '#!/opt/homebrew/opt/node/bin/node\n')), { onPath: false, file: '/opt/homebrew/opt/node/bin/node' });
  assert.equal(nodeInterpreter(file('shell', '#!/bin/sh\nexec codex-native "$@"\n')), null);
  assert.equal(nodeInterpreter(file('nodemon-like', '#!/usr/bin/env nodemon\n')), null);
  assert.equal(nodeInterpreter(file('native', Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00]))), null);
  assert.equal(nodeInterpreter(join(dir, 'absent')), null);
});

test('npm\'s Codex can start only with the Node it runs on; a native Codex needs none', () => {
  const dir = makeTempHome('cats-bot-codex-node-').botsHome;
  const noNode = { PATH: join(dir, 'no-node'), Path: join(dir, 'no-node') };
  const nodeDir = join(dir, 'node-bin');
  mkdirSync(nodeDir, { recursive: true });
  writeFileSync(join(nodeDir, 'node'), '');
  writeFileSync(join(nodeDir, 'node.exe'), '');
  const withNode = { PATH: nodeDir, Path: nodeDir };
  writeFileSync(join(dir, 'codex'), '#!/usr/bin/env node\n');
  assert.equal(codexCanStart(join(dir, 'codex'), noNode, 'darwin'), false);
  assert.equal(codexCanStart(join(dir, 'codex'), withNode, 'darwin'), true);
  // A named interpreter is run without PATH.
  writeFileSync(join(dir, 'brew-codex'), `#!${join(nodeDir, 'node')}\n`);
  assert.equal(codexCanStart(join(dir, 'brew-codex'), noNode, 'darwin'), true);
  writeFileSync(join(dir, 'native-codex'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
  assert.equal(codexCanStart(join(dir, 'native-codex'), noNode, 'linux'), true);
  // Windows: npm's shim needs node.exe beside it or on PATH; a codex.exe needs none.
  const shims = join(dir, 'npm');
  mkdirSync(shims, { recursive: true });
  // npm's cmd-shim, as it writes codex.cmd.
  writeFileSync(join(shims, 'codex.cmd'), '@ECHO off\r\nSETLOCAL\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n"%_prog%" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
  // Another tool's .cmd that wraps a native binary needs no Node.
  writeFileSync(join(dir, 'wrapper.cmd'), '@"%~dp0\\codex-native.exe" %*\r\n');
  assert.equal(codexCanStart(join(dir, 'wrapper.cmd'), noNode, 'win32'), true);
  assert.equal(codexCanStart(join(shims, 'codex.cmd'), noNode, 'win32'), false);
  assert.equal(codexCanStart(join(shims, 'codex.cmd'), withNode, 'win32'), true);
  writeFileSync(join(shims, 'node.exe'), '');
  assert.equal(codexCanStart(join(shims, 'codex.cmd'), noNode, 'win32'), true);
  assert.equal(codexCanStart(join(dir, 'codex.exe'), noNode, 'win32'), true);
});
