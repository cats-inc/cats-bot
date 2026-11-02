import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { resolveRuntimeEntry } from '../../src/core/runtime/supervisor.ts';
import { makeTempHome, openTestBot, sendAndWait, waitForEvent } from '../support/harness.ts';

for (const provider of ['muse', 'grok', 'antigravity']) {
  test(`packed Runtime hosts ${provider} tools and approvals without a desktop`, { timeout: 90_000 }, async () => {
    const home = makeTempHome(`cats-hosted-${provider}-`);
    const log = join(home.root, 'fixture.jsonl');
    const { core } = openTestBot({ botsHome: home.botsHome, profile: { provider }, core: {
      runtime: { runtimeEntry: resolveRuntimeEntry(), providerCommand: process.execPath,
        providerLaunchArgs: [resolve('tests/support/fixture-cli/hosted-fixture.mjs'), provider], readyTimeoutMs: 60_000,
        env: { ...process.env, HOME: home.root, USERPROFILE: home.root,
          XDG_CONFIG_HOME: join(home.root, '.config'), XDG_DATA_HOME: join(home.root, '.local', 'share'),
          APPDATA: join(home.root, 'roaming'), LOCALAPPDATA: join(home.root, 'local'), CATS_HOSTED_FIXTURE_LOG: log } },
    } });
    try {
      await core.updateProfile({ providerPolicy: { version: 1, mode: 'provider', constraints: { maxAccess: 'full-access', network: true } } });
      await core.start(); core.setBossCat(true);
      const first = await sendAndWait(core, 'home', provider === 'antigravity' ? 'fixture:local' : 'fixture:tools', 60_000);
      assert.equal(first.state, 'completed', first.error);
      assert.match(first.result?.text ?? '', provider === 'antigravity' ? /native tools enabled/u : /Cats tool replied:/u);
      assert.equal(core.status().bossCat.tools, provider !== 'antigravity');
      for (const action of ['accept', 'decline'] as const) {
        const pending = waitForEvent(core, event => event.type === 'provider.interactions' && event.pending === 1, 30_000);
        const done = waitForEvent(core, event => event.type === 'turn.completed', 30_000);
        await core.sendOwnerMessage('home', 'fixture:approval'); await pending;
        const card = (await core.providerInteractions('home')).interactions.find(item => item.status === 'pending')!;
        assert.equal(card.kind, 'command_approval');
        await core.respondProviderInteraction('home', card.interactionId, { workItemId: card.workItemId,
          workerGeneration: card.workerGeneration, executionId: card.executionId, expectedRevision: card.revision,
          idempotencyKey: `fixture-${action}`, answer: { action, ...(action === 'accept' ? { choice: 'allow' } : {}) } });
        const result = await done;
        assert.ok(result.type === 'turn.completed');
        assert.equal(result.workItem.result?.text, `native approval ${action === 'accept' ? 'accepted' : 'denied'}`);
      }
      const capabilities = await core.sessionCapabilities('home');
      assert.equal(capabilities.observation?.policy.status, 'verified');
      const audit = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.equal(audit.filter(row => row.event === 'session').length, 1, 'normal turns retain one native session and MCP generation');
      assert.ok(audit.filter(row => row.event === 'session').every(row => !row.grantInEnvironment));
      assert.equal(audit.filter(row => row.event === 'turn').length, 3);
    } finally { await core.stop(); home.cleanup(); }
  });
}
