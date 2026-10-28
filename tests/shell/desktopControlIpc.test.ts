import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BotCore } from '../../src/core/bot.ts';
import { NOTE_ONLY_COMMANDS, runHostCommand, senderMayInvoke } from '../../src/shell/electron/ipc.ts';

/**
 * SPEC-006 P3: the shell's desktop control commands. Arguments are checked before the core
 * sees them, a note acts only on its own conversation, and Settings reads only the
 * profile-level state; grant answers never travel through the provider interaction commands.
 */

function fakeCore() {
  const calls: unknown[][] = [];
  const state = (conversationId?: string) => ({ available: true, reason: null, enabled: true, conversations: ['home'], pendingRequests: 0,
    ...(conversationId ? { conversation: { conversationId } } : {}) });
  const core = {
    desktopControlState: async (conversationId?: string) => { calls.push(['state', conversationId]); return state(conversationId); },
    setConversationDesktopControl: async (conversationId: string, enabled: boolean) => {
      calls.push(['switch', conversationId, enabled]);
      return state(conversationId);
    },
    respondDesktopGrant: async (conversationId: string, requestId: string, decision: string) => { calls.push(['grant', conversationId, requestId, decision]); },
    stopDesktopControl: async (conversationId?: string) => { calls.push(['stop', conversationId]); },
  } as unknown as BotCore;
  return { core, calls };
}

test('desktop control commands check their arguments and answer with the new state', async () => {
  const { core, calls } = fakeCore();
  assert.deepEqual(await runHostCommand(core, 'desktopControlState', []), { available: true, reason: null, enabled: true, conversations: ['home'], pendingRequests: 0 });
  await runHostCommand(core, 'desktopControlState', ['home']);
  await assert.rejects(runHostCommand(core, 'desktopControlState', [42]), /conversationId/u);

  assert.deepEqual(await runHostCommand(core, 'setConversationDesktopControl', ['home', true]),
    { available: true, reason: null, enabled: true, conversations: ['home'], pendingRequests: 0, conversation: { conversationId: 'home' } });
  await assert.rejects(runHostCommand(core, 'setConversationDesktopControl', ['home', 'yes']), /true or false/u);

  await runHostCommand(core, 'respondDesktopGrant', ['home', 'grant_1', 'deny']);
  for (const decision of ['approve', 'accept', undefined]) {
    await assert.rejects(runHostCommand(core, 'respondDesktopGrant', ['home', 'grant_1', decision]), /allow or deny/u);
  }
  await assert.rejects(runHostCommand(core, 'respondDesktopGrant', ['home', '', 'allow']), /requestId/u);

  await runHostCommand(core, 'stopDesktopControl', ['home']);
  await assert.rejects(runHostCommand(core, 'stopDesktopControl', []), /conversationId/u, 'a note stops its own conversation; the tray stops all');

  assert.deepEqual(calls, [
    ['state', undefined], ['state', 'home'],
    ['switch', 'home', true],
    ['grant', 'home', 'grant_1', 'deny'], ['state', 'home'],
    ['stop', 'home'], ['state', 'home'],
  ]);
});

test('a note controls only its own conversation; Settings reads only the profile-level state', () => {
  const note = { note: 'conv-1', settings: false, floating: false };
  const settings = { note: null, settings: true, floating: false };
  const floating = { note: null, settings: false, floating: true };
  const unknown = { note: null, settings: false, floating: false };

  for (const command of ['setConversationDesktopControl', 'respondDesktopGrant', 'stopDesktopControl']) {
    assert.ok(NOTE_ONLY_COMMANDS.includes(command as never));
    assert.equal(senderMayInvoke(command, ['conv-1', true], note), true, command);
    assert.equal(senderMayInvoke(command, ['home', true], note), false, `${command} for another note`);
    assert.equal(senderMayInvoke(command, ['conv-1', true], settings), false, `${command} from Settings`);
    assert.equal(senderMayInvoke(command, ['conv-1', true], floating), false, `${command} from the floating cat`);
  }
  assert.equal(senderMayInvoke('desktopControlState', ['conv-1'], note), true);
  assert.equal(senderMayInvoke('desktopControlState', ['home'], note), false);
  assert.equal(senderMayInvoke('desktopControlState', [], note), false, 'a note reads its own conversation');
  assert.equal(senderMayInvoke('desktopControlState', [], settings), true);
  assert.equal(senderMayInvoke('desktopControlState', ['conv-1'], settings), false, 'Settings sees no grant requests');
  assert.equal(senderMayInvoke('desktopControlState', [], floating), false);

  // The provider path is unchanged and still note-only.
  assert.equal(senderMayInvoke('respondProviderInteraction', ['conv-1', 'i'], note), true);
  assert.equal(senderMayInvoke('respondProviderInteraction', ['conv-1', 'i'], settings), false);
  assert.equal(senderMayInvoke('updateProfile', [{}], settings), true);
  assert.equal(senderMayInvoke('updateProfile', [{}], unknown), false);
});
