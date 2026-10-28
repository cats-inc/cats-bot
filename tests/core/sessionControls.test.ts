import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RuntimeClient } from '../../src/core/runtime/client.ts';
import type { SessionExecutionPolicy } from '../../src/core/types.ts';

/** SPEC-004 with Runtime SPEC-039 R8: negotiate only what the provider target advertises. */

function clientFor(continuity: Record<string, unknown>): RuntimeClient {
  const body = { providers: { claude: { defaultInstance: 'native', defaultBackend: 'cli',
    instances: [{ id: 'native', backend: 'cli', continuity }] } } };
  return new RuntimeClient({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k',
    fetch: (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch });
}

const claude = { interactions: { version: 1, kinds: ['command_approval', 'file_approval', 'tool_approval', 'user_input', 'mcp_form', 'mcp_url'] },
  sessionCapabilities: { version: 1, executionPolicy: true, inventory: true, admissibleCeilings: [{ access: 'full-access', network: true }] } };
const full: SessionExecutionPolicy = { version: 1, mode: 'explicit', access: 'full-access', network: true, approval: 'on-request' };

test('the host asks for tool approval only where the target advertises it', async () => {
  const controls = await clientFor(claude).sessionControls('claude', null);
  assert.deepEqual(controls.interactionHost?.kinds, ['command_approval', 'file_approval', 'tool_approval', 'user_input', 'mcp_form', 'mcp_url']);
  const older = await clientFor({ interactions: { version: 1, kinds: ['user_input'] } }).sessionControls('claude', null);
  assert.deepEqual(older.interactionHost?.kinds, ['user_input']);
});

test('a ceiling outside the advertised ones is refused before a session is created', async () => {
  assert.deepEqual((await clientFor(claude).sessionControls('claude', full)).executionPolicy, full);
  for (const policy of [
    { version: 1, mode: 'explicit', access: 'workspace-write', network: false, approval: 'on-request' },
    { version: 1, mode: 'provider', constraints: { maxAccess: 'full-access', network: false } },
  ] satisfies SessionExecutionPolicy[]) {
    await assert.rejects(clientFor(claude).sessionControls('claude', policy), /cannot enforce this access or network limit/u);
  }
  const codex = { ...claude, sessionCapabilities: { version: 1, executionPolicy: true, inventory: true } };
  const narrow: SessionExecutionPolicy = { version: 1, mode: 'explicit', access: 'workspace-write', network: false, approval: 'on-request' };
  assert.deepEqual((await clientFor(codex).sessionControls('claude', narrow)).executionPolicy, narrow, 'no list means every ceiling');
});
