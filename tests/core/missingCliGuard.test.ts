import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { SessionBinder } from '../../src/core/conversations/binder.ts';
import { ConversationStore } from '../../src/core/conversations/store.ts';
import { TurnRunner } from '../../src/core/queue/turnRunner.ts';
import { createWorkItem } from '../../src/core/queue/workItems.ts';
import type { RuntimeClient } from '../../src/core/runtime/client.ts';
import { botPathsFor } from '../../src/core/store/paths.ts';
import type { WorkItemKind } from '../../src/core/types.ts';
import { makeTempHome } from '../support/harness.ts';

// ADR-032: while the CLI cannot be launched, no work item binds a session; only an owner's message says why.
for (const kind of ['owner_message', 'heartbeat', 'schedule', 'event'] as const satisfies readonly WorkItemKind[]) {
  test(`${kind}: work whose CLI cannot be launched fails before it binds a session`, async (t) => {
    const home = makeTempHome('cats-bot-cli-guard-');
    t.after(() => home.cleanup());
    const now = () => new Date('2026-11-16T09:00:00Z');
    const store = new ConversationStore({ paths: botPathsFor(join(home.botsHome, 'guard')), now });
    store.load();
    store.home();
    let binds = 0;
    const binder = { bind: async () => { binds += 1; throw new Error('no bind while the CLI is missing'); } } as unknown as SessionBinder;
    const runner = new TurnRunner({
      client: () => ({}) as unknown as RuntimeClient,
      binder, conversations: store, now, emit: () => {}, persistRun: () => {}, log: () => {},
      missingCli: () => ({ provider: 'codex', label: 'Codex' }),
    });
    const item = createWorkItem({ kind, source: 'fixture', conversationId: 'home', prompt: 'hello' }, now());
    const outcome = await runner.run(item, new AbortController());
    assert.equal(binds, 0);
    assert.equal(item.run, undefined, 'no run is journaled against a session');
    assert.equal(outcome.kind, 'failed');
    const errors = store.transcript('home').filter((entry) => entry.kind === 'error');
    if (kind === 'owner_message') {
      assert.equal(outcome.kind === 'failed' && outcome.reported, true, 'the line it wrote is the failure');
      assert.deepEqual(errors.map((entry) => [entry.text, entry.fix]), [[
        'Codex is not on this computer, so this message got no reply.', { kind: 'install_cli', provider: 'codex', label: 'Codex' },
      ]]);
    } else {
      assert.equal(errors.length, 0, 'background work adds no install line');
      assert.equal(outcome.kind === 'failed' && outcome.reason, 'Codex is not on this computer.');
    }
  });
}
