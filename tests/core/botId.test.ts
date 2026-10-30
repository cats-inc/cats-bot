import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';

import { initializeBot } from '../../src/core/bot.ts';
import { deriveBotId, InvalidBotIdError, isValidBotId, resolveBotRoot } from '../../src/core/store/paths.ts';
import { makeTempHome, type TempHome } from '../support/harness.ts';

let home: TempHome;
before(() => {
  home = makeTempHome('cats-bot-id-');
});
after(() => home.cleanup());

test('a bot id is one plain path segment (SPEC-008 FR-27)', () => {
  for (const id of ['mochi', 'a', '0', 'desk-cat', 'a1-b2-c3', 'x'.repeat(64), 'con-bot', 'com10', 'console']) {
    assert.ok(isValidBotId(id), id);
  }
  for (const id of ['', '.', '..', '../x', 'a/b', 'a\\b', 'Mochi', 'a_b', 'a b', 'a.b', '-a', 'a-', 'a--b', 'x'.repeat(65),
    'con', 'prn', 'aux', 'nul', 'com0', 'com1', 'com9', 'lpt0', 'lpt1', 'lpt9', 'ｍochi']) {
    assert.equal(isValidBotId(id), false, JSON.stringify(id));
  }
});

test('every path from an id is checked first, so nothing reaches the hub\'s part of the root', () => {
  const env = { CATS_BOT_HOME: home.root };
  for (const id of ['..', '../archive/x', 'a/../../bots.json', 'nul']) {
    assert.throws(() => resolveBotRoot(id, env), InvalidBotIdError, id);
  }
  assert.throws(() => resolveBotRoot('..', env), /1 to 64 lowercase letters, digits and single hyphens/u);
  assert.throws(() => initializeBot(home.botsHome, { id: '..', name: 'Escape', provider: 'claude' }), InvalidBotIdError);
  assert.deepEqual(readdirSync(home.root), ['bots'], 'a refused id creates nothing');
  assert.deepEqual(readdirSync(home.botsHome), []);
});

test('a derived id is the name with -catsbot, numbered for a later bot of the same name (D2)', () => {
  assert.equal(deriveBotId('Mochi'), 'mochi-catsbot');
  assert.equal(deriveBotId('Mochi', 2), 'mochi-catsbot-2');
  assert.equal(deriveBotId('Desk Cat!'), 'desk-cat-catsbot');
  assert.equal(deriveBotId('Con'), 'con-catsbot');
  assert.equal(deriveBotId('小貓'), 'catsbot');
  assert.equal(deriveBotId('小貓', 3), 'catsbot-3');
  assert.equal(deriveBotId('b'.repeat(100)), `${'b'.repeat(56)}-catsbot`);
  assert.equal(deriveBotId('b'.repeat(100), 12), `${'b'.repeat(53)}-catsbot-12`);
  assert.equal(deriveBotId(`${'a'.repeat(55)} tail`), `${'a'.repeat(55)}-catsbot`, 'no hyphen is left before the suffix');
  for (const name of ['Mochi', 'Con', 'nul', '小貓', 'a'.repeat(100), '---x---', `${'a'.repeat(63)} tail`]) {
    for (const copy of [1, 2, 999]) assert.ok(isValidBotId(deriveBotId(name, copy)), `${name} ${copy}`);
  }
});

test('the CLI refuses an invalid --id or CATS_BOT_ID with the rule', () => {
  const cli = (args: string[], extra: NodeJS.ProcessEnv = {}) => {
    const env: NodeJS.ProcessEnv = { ...process.env, CATS_BOT_HOME: home.root, ...extra };
    if (!('CATS_BOT_ID' in extra)) delete env.CATS_BOT_ID;
    return spawnSync(process.execPath, [resolve('src/cli/main.ts'), ...args], { env, encoding: 'utf8', windowsHide: true });
  };
  for (const run of [cli(['status', '--id', '..']), cli(['status', '--id', 'Mochi']), cli(['status'], { CATS_BOT_ID: 'a/b' })]) {
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /Invalid bot id .*1 to 64 lowercase letters, digits and single hyphens/u);
  }
  const init = cli(['init', '--name', 'Escape', '--provider', 'claude', '--id', '../escape']);
  assert.equal(init.status, 1, init.stderr);
  assert.equal(existsSync(resolve(home.root, 'escape')), false);
});
