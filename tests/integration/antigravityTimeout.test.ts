import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { resolveRuntimeEntry } from '../../src/core/runtime/supervisor.ts';
import { makeTempHome, openTestBot, sendAndWait } from '../support/harness.ts';

test('the packed Runtime lets an agy turn finish after more than 30 seconds of silence', { timeout: 90_000 }, async t => {
  const home = makeTempHome('cats-bot-agy-timeout-');
  const { core } = openTestBot({
    botsHome: home.botsHome, id: 'agy-timeout', profile: { provider: 'antigravity' },
    core: { runtime: {
      runtimeEntry: resolveRuntimeEntry(), providerCommand: process.execPath,
      providerLaunchArgs: [resolve(import.meta.dirname, '../support/fixture-cli/antigravity-fixture.mjs')],
      env: {
        ...process.env, HOME: home.root, USERPROFILE: home.root,
        APPDATA: join(home.root, 'AppData', 'Roaming'), LOCALAPPDATA: join(home.root, 'AppData', 'Local'),
        XDG_CONFIG_HOME: join(home.root, '.config'), XDG_DATA_HOME: join(home.root, '.local', 'share'),
      },
    } },
  });
  t.after(async () => { try { await core.stop(); } finally { home.cleanup(); } });
  await core.start();
  const item = await sendAndWait(core, 'home', 'fixture: delayed agy response', 60_000);
  assert.equal(item.state, 'completed', item.error);
  assert.equal(item.result?.text, 'completed after 31 seconds of silence');
  assert.ok(core.transcript('home').some(entry => entry.kind === 'bot' && entry.workItemId === item.id));
});
