import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { after, before, test } from 'node:test';

import { botPathsFor } from '../../src/core/store/paths.ts';
import {
  askChoices,
  currentChoice,
  defaultChoice,
  permissionPatch,
  withAsk,
  withDesktopControl,
  withLevel,
  type StoredPermissions,
} from '../../src/renderer/settings/permissionChoices.ts';
import type { BotProfile } from '../../src/core/types.ts';
import { makeTempHome, openTestBot, sendAndWait, type TempHome } from '../support/harness.ts';

/**
 * ADR-030 at the core: every choice the Permissions page offers is accepted by `updateProfile` with Runtime
 * ready, reads back as itself, and a session still answers; a profile with the former allowlist starts.
 */

let home: TempHome;
before(() => { home = makeTempHome('cats-bot-permission-pages-'); });
after(() => home.cleanup());

const storedOf = (profile: BotProfile): StoredPermissions => ({ provider: profile.executionTarget.provider, providerPolicy: profile.providerPolicy,
  workspaceAccess: profile.permissions.workspaceAccess, permissionMode: profile.permissions.permissionMode });

test('each Claude Code choice is saved through updateProfile and the next turn still answers (ADR-030)', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'perm-claude', runtimeEnv: { FAKE_PROVIDER_INTERACTIONS: '1' } });
  await core.start();
  try {
    for (const ask of askChoices('claude')) {
      const choice = withAsk('claude', defaultChoice('claude'), ask);
      const before = await core.getProfile();
      const patch = permissionPatch(storedOf(before), 'claude', choice);
      const saved = patch ? await core.updateProfile(patch) : before;
      assert.deepEqual(currentChoice(storedOf(saved)), choice, ask);
      assert.equal((await sendAndWait(core, 'home', `hello ${ask}`)).state, 'completed', ask);
    }
  } finally {
    await core.stop();
  }
});

test('each Codex choice, its limit and desktop control inside it, is accepted by updateProfile (ADR-030)', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'perm-codex', profile: { provider: 'codex' }, runtimeEnv: { FAKE_PROVIDER_INTERACTIONS: '1' } });
  await core.start();
  try {
    const fence = withAsk('codex', defaultChoice('codex'), 'fence');
    const choices = [
      ...askChoices('codex').map((ask) => withAsk('codex', defaultChoice('codex'), ask)),
      withLevel(fence, 'read-only'),
      { ...fence, network: true },
      withDesktopControl('codex', fence),
      withLevel(withAsk('codex', defaultChoice('codex'), 'cli'), 'read-only'),
    ];
    for (const choice of choices) {
      const before = await core.getProfile();
      const patch = permissionPatch(storedOf(before), 'codex', choice);
      const saved = patch ? await core.updateProfile(patch) : before;
      assert.deepEqual(currentChoice(storedOf(saved)), choice, JSON.stringify(choice));
    }
  } finally {
    await core.stop();
  }
});

test('a profile with the former allowlist starts, is upgraded on disk and answers (ADR-030)', async () => {
  const { core, root } = openTestBot({ botsHome: home.botsHome, id: 'perm-allowlist', runtimeEnv: { FAKE_PROVIDER_INTERACTIONS: '1' } });
  const paths = botPathsFor(root);
  const stored = JSON.parse(readFileSync(paths.profile, 'utf8'));
  writeFileSync(paths.profile, JSON.stringify({ ...stored,
    permissions: { ...stored.permissions, permissionMode: 'whitelist', allowedTools: ['Read', 'Grep'] } }));
  await core.start();
  try {
    const profile = await core.getProfile();
    assert.equal(currentChoice(storedOf(profile)).ask, 'ask');
    const written = JSON.parse(readFileSync(paths.profile, 'utf8'));
    assert.equal(written.permissions.permissionMode, 'default');
    assert.equal('allowedTools' in written.permissions, false);
    assert.equal((await sendAndWait(core, 'home', 'hello after the upgrade')).state, 'completed');
  } finally {
    await core.stop();
  }
});
