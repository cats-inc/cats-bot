import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import {
  CLI_PROVIDERS,
  defaultCommandFor,
  findOnPath,
  listProviders,
  readPackagedModelCatalog,
} from '../../src/core/providers/catalog.ts';
import { renderProvidersConfig } from '../../src/core/runtime/providersConfig.ts';
import { validateSetupInput } from '../../src/shell/electron/setupInput.ts';
import { makeTempHome, openTestBot, type TempHome } from '../support/harness.ts';

/** SPEC-002 FR-1 / FR-3: what the first-run and settings pages offer as provider and model. */

let dir: string;
let home: TempHome;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'cats-bots-providers-'));
  home = makeTempHome('cats-bots-providers-core-');
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
  home.cleanup();
});

test('providers launch with their own command, not their name', () => {
  assert.equal(defaultCommandFor('claude'), 'claude');
  assert.equal(defaultCommandFor('antigravity'), 'agy');
  assert.equal(defaultCommandFor('cursor'), 'cursor-agent');
  assert.equal(defaultCommandFor('kiro'), 'kiro-cli');
  assert.equal(defaultCommandFor('something-new'), 'something-new');
  assert.match(renderProvidersConfig({ provider: 'antigravity' }), /command: "agy"/u);
  assert.match(renderProvidersConfig({ provider: 'antigravity', command: 'C:/tools/agy.cmd' }), /command: "C:\/tools\/agy.cmd"/u);
  assert.equal(new Set(CLI_PROVIDERS.map((provider) => provider.id)).size, CLI_PROVIDERS.length);
});

test('a provider counts as installed when its command is on PATH', () => {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'agy.cmd'), '@echo off\r\n');
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\n');
  const winEnv = { PATH: `${join(dir, 'missing')};${bin}`, PATHEXT: '.EXE;.CMD' };
  assert.equal(findOnPath('agy', winEnv, 'win32')?.toLowerCase(), join(bin, 'agy.cmd').toLowerCase());
  assert.equal(findOnPath('claude', winEnv, 'win32'), null);
  assert.equal(findOnPath('codex', { PATH: bin }, 'linux'), join(bin, 'codex'));
  const listed = listProviders(process.platform === 'win32' ? winEnv : { PATH: bin });
  const codex = listed.find((provider) => provider.id === 'codex');
  const claude = listed.find((provider) => provider.id === 'claude');
  assert.equal(codex?.installed, true);
  assert.equal(claude?.installed, false);
});

test('the catalog shipped with cats-runtime lists models with the default first-class', () => {
  const claude = readPackagedModelCatalog('claude');
  assert.equal(claude.source, 'packaged');
  assert.ok(claude.models.length > 0);
  assert.ok(claude.defaultModel, 'claude has a default model');
  assert.ok(claude.models.some((model) => model.id === claude.defaultModel && model.default));
  assert.ok(claude.models.every((model) => typeof model.label === 'string' && model.label.length > 0));
  assert.deepEqual(readPackagedModelCatalog('no-such-cli'), { provider: 'no-such-cli', defaultModel: null, models: [], source: 'none' });
  const document = { document: { catalogs: [
    { provider: 'x', backend: 'api', models: [{ id: 'api-only', default: true }] },
    { provider: 'x', backend: 'cli', models: [{ id: 'a', label: 'A' }, { id: 'b', default: true }, { label: 'no id' }] },
  ] } };
  assert.deepEqual(readPackagedModelCatalog('x', document), {
    provider: 'x',
    defaultModel: 'b',
    models: [{ id: 'a', label: 'A', default: false }, { id: 'b', label: 'b', default: true }],
    source: 'packaged',
  });
});

test('the running runtime answers for the bot provider; other providers fall back to the shipped catalog', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'catalog' });
  await core.start();
  try {
    const own = await core.listModels('claude');
    assert.equal(own.source, 'runtime');
    assert.equal(own.defaultModel, 'fake-opus');
    assert.deepEqual(own.models.map((model) => model.id), ['fake-opus', 'fake-haiku']);
    const other = await core.listModels('codex');
    assert.equal(other.source, 'packaged');
    assert.ok(other.models.length > 0);
  } finally {
    await core.stop();
  }
  const stopped = await core.listModels('claude');
  assert.equal(stopped.source, 'packaged', 'without a runtime the shipped catalog is used');
});

test('notes can be renamed, never to an empty title', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'rename' });
  await core.start();
  try {
    const note = await core.createConversation();
    const renamed = await core.renameConversation(note.id, '  Groceries  ');
    assert.equal(renamed.title, 'Groceries');
    assert.equal((await core.listConversations()).find((record) => record.id === note.id)?.title, 'Groceries');
    await assert.rejects(core.renameConversation(note.id, '   '), /cannot be empty/u);
    const homeRecord = await core.renameConversation('home', 'Desk');
    assert.equal(homeRecord.role, 'home');
  } finally {
    await core.stop();
  }
});

test('first-run input is checked before a bot is created', () => {
  assert.deepEqual(validateSetupInput({ name: ' Mochi ', provider: 'claude', model: '', instructions: ' purr ' }), {
    name: 'Mochi', provider: 'claude', model: null, instructions: 'purr',
  });
  assert.equal(validateSetupInput({ name: 'Nori', provider: 'codex', model: 'gpt-6-sol' }).model, 'gpt-6-sol');
  assert.throws(() => validateSetupInput({ name: '', provider: 'claude' }), /name/u);
  assert.throws(() => validateSetupInput({ name: 'x', provider: '../evil' }), /agent CLI/u);
  assert.throws(() => validateSetupInput(null), /object/u);
});
