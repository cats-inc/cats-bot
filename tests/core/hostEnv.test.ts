import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readProviderOverrides } from '../../src/core/hostEnv.ts';

test('provider overrides come only from CATS_BOT_PROVIDER_* (SPEC-007 FR-4)', () => {
  assert.deepEqual(readProviderOverrides({
    CATS_BOT_PROVIDER_COMMAND: ' node ',
    CATS_BOT_PROVIDER_LAUNCH_ARGS: 'fixture.mjs\n --flag \n',
    CATS_BOT_PROVIDER_PROJECTS_DIR: 'projects',
  }), { providerCommand: 'node', providerLaunchArgs: ['fixture.mjs', '--flag'], instanceExtras: { projects_dir: 'projects' } });
  assert.deepEqual(readProviderOverrides({
    CATS_BOTS_PROVIDER_COMMAND: 'node',
    CATS_BOTS_PROVIDER_LAUNCH_ARGS: 'fixture.mjs',
    CATS_BOTS_PROVIDER_PROJECTS_DIR: 'projects',
  }), {});
});
