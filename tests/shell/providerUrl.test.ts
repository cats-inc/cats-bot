import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BotCore } from '../../src/core/bot.ts';
import { runHostCommand } from '../../src/shell/electron/ipc.ts';

test('external authorization URL requires a live supported request and safe URL', async () => {
  const opened: string[] = [];
  const interaction = { interactionId: 'request', kind: 'mcp_url', status: 'pending',
    expiresAt: new Date(Date.now() + 60_000).toISOString(), prompt: { url: 'https://example.com/authorize' } };
  let supported = true;
  const core = { providerInteractions: async () => ({ supported, interactions: [interaction] }) } as unknown as BotCore;
  const open = async (url: string) => { opened.push(url); };
  await runHostCommand(core, 'openProviderInteractionUrl', ['home', 'request'], open);
  assert.equal(opened.length, 1);
  supported = false;
  await assert.rejects(runHostCommand(core, 'openProviderInteractionUrl', ['home', 'request'], open));
  supported = true;
  for (const url of ['file:///C:/secret', 'https://user:password@example.com']) {
    interaction.prompt.url = url;
    await assert.rejects(runHostCommand(core, 'openProviderInteractionUrl', ['home', 'request'], open));
  }
  interaction.prompt.url = 'https://example.com/authorize';
  interaction.status = 'resolved';
  await assert.rejects(runHostCommand(core, 'openProviderInteractionUrl', ['home', 'request'], open));
  interaction.status = 'pending'; interaction.expiresAt = new Date(0).toISOString();
  await assert.rejects(runHostCommand(core, 'openProviderInteractionUrl', ['home', 'request'], open));
  assert.equal(opened.length, 1);
});
