import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DesktopControlCapability, DesktopControlState, DesktopGrantRequest } from '../../src/core/types.ts';
import {
  enabledNotesText,
  grantCardText,
  grantedText,
  notePanelVisible,
  noteStatus,
  reasonText,
  settingsRow,
  showStop,
  switchDisabled,
} from '../../src/renderer/desktopControl/desktopControl.ts';

/** SPEC-006 P3: what the note and Settings show of desktop control, apart from React. */

const REQUEST: DesktopGrantRequest = {
  requestId: 'grant_1', query: 'notepad', name: 'Notepad', path: 'C:\\Windows\\notepad.exe', publisher: 'Microsoft Corporation',
  tier: 'full', reason: 'Read the shopping list', createdAt: '2026-10-29T10:00:00.000Z', expiresAt: '2026-10-29T10:10:00.000Z',
};

function state(conversation: Partial<NonNullable<DesktopControlState['conversation']>> = {}, top: Partial<DesktopControlState> = {}) {
  const capability: DesktopControlCapability = { name: 'Cats desktop control', status: 'injected', reason: null };
  return {
    available: true, reason: null, enabled: true, conversations: ['home'], pendingRequests: 0, ...top,
    conversation: { conversationId: 'home', enabled: true, capability, stopped: false, grants: [], pendingRequests: [], ...conversation },
  } satisfies DesktopControlState;
}

const capability = (status: DesktopControlCapability['status'], reason: string | null = null): DesktopControlCapability =>
  ({ name: 'Cats desktop control', status, reason });

test('the note shows desktop control while the profile switch is on, or while something is granted or waits', () => {
  assert.equal(notePanelVisible(null), false);
  assert.equal(notePanelVisible({ ...state(), conversation: undefined }), false, 'Settings state has no conversation');
  assert.equal(notePanelVisible(state({ enabled: false })), true, 'the switch is offered in every note while the feature is on');
  assert.equal(notePanelVisible(state({ enabled: false }, { enabled: false })), false, 'nothing while the feature is off');
  assert.equal(notePanelVisible(state({ pendingRequests: [REQUEST] }, { enabled: false })), true, 'a waiting request is never hidden');
  // BDC-01: the note says why desktop control is unavailable.
  const missing = state({}, { available: false, reason: 'helper_missing' });
  assert.equal(notePanelVisible(missing), true);
  assert.equal(noteStatus(missing, missing.conversation), 'Not available on this computer: the desktop control helper is missing from this installation.');
});

test('the DC-18 status reads as a sentence with its reason', () => {
  const at = (cap: DesktopControlCapability, extra: Partial<NonNullable<DesktopControlState['conversation']>> = {}) => {
    const value = state({ capability: cap, ...extra });
    return noteStatus(value, value.conversation);
  };
  assert.equal(at(capability('off', 'conversation_off'), { enabled: false }), null, 'a note whose switch is off says nothing more');
  assert.equal(at(capability('off', 'off')), 'Off: it is off in Settings.');
  assert.equal(at(capability('not_injected', 'no_turn_yet')), 'Ready from your next message.');
  assert.equal(at(capability('not_injected', 'no_live_session')), 'Ready from your next message.');
  assert.match(at(capability('not_injected', 'policy_preapproves_tools'))!, /^Not in this session: the approval policy runs tools without asking/u);
  assert.match(at(capability('not_injected', 'policy_not_explicit'))!, /Choose access and approval separately/u);
  assert.equal(at(capability('not_injected', 'policy_mismatch')), 'Not in this session: policy mismatch.', 'an unknown code stays readable');
  assert.match(at(capability('injected'))!, /^Ready\. The bot can use it in messages you send from this note or cats-bot say\.$/u);
  assert.match(at(capability('injected'), { stopped: true })!, /^Stopped\./u);
  assert.equal(at(capability('active_turn')), 'The bot can use desktop control in this turn.');
  assert.equal(at(capability('unavailable', 'helper_crashed')),
    'Not available on this computer: the desktop control helper stopped too often; turn desktop control off and on in Settings to retry.');
  assert.equal(reasonText(null), '');
});

test('Stop appears with grants or waiting requests, and the switch can always be turned off', () => {
  const idle = state();
  assert.equal(showStop(idle.conversation), false, 'phase A has no holding state');
  assert.equal(showStop(state({ pendingRequests: [REQUEST] }).conversation), true);
  const granted = state({ grants: [{ name: 'Notepad', path: REQUEST.path, publisher: null, tier: 'full' },
    { name: 'PowerShell', path: 'C:\\pwsh.exe', publisher: 'Microsoft Windows', tier: 'observe_only' }] });
  assert.equal(showStop(granted.conversation), true);
  assert.equal(grantedText(granted.conversation), 'Granted: Notepad, PowerShell (observe only)');
  assert.equal(grantedText(idle.conversation), null);

  assert.equal(switchDisabled(idle, idle.conversation), false);
  const off = state({ enabled: false }, { available: false, reason: 'helper_missing' });
  assert.equal(switchDisabled(off, off.conversation), true, 'not turned on where it cannot work');
  const on = state({ enabled: true }, { available: false, reason: 'helper_missing' });
  assert.equal(switchDisabled(on, on.conversation), false, 'but it can still be turned off');
  const profileOff = state({ enabled: false }, { enabled: false });
  assert.equal(switchDisabled(profileOff, profileOff.conversation), true);
});

test('a grant card names the app, its path, its publisher or unsigned, the observe-only limit and the bot\'s reason', () => {
  assert.deepEqual(grantCardText(REQUEST), {
    title: 'Let the bot see Notepad?',
    path: 'C:\\Windows\\notepad.exe',
    publisher: 'Publisher: Microsoft Corporation',
    observeOnly: null,
    reason: 'The bot\'s reason: Read the shopping list',
  });
  const unsigned = grantCardText({ ...REQUEST, publisher: null, tier: 'observe_only' });
  assert.equal(unsigned.publisher, 'Unsigned app: no publisher could be verified');
  assert.equal(unsigned.observeOnly, 'Observe only: the bot can never type into this app.');
});

test('the Settings switch is hidden off Windows, disabled where the helper cannot run, and can always be turned off', () => {
  assert.deepEqual(settingsRow(null), { hidden: false, disabled: true, note: null }, 'disabled while loading');
  assert.deepEqual(settingsRow({ ...state(), conversation: undefined }), { hidden: false, disabled: false, note: null });
  assert.equal(settingsRow({ ...state(), available: false, reason: 'not_windows', enabled: false }).hidden, true);
  assert.deepEqual(settingsRow({ ...state(), available: false, reason: 'not_windows', enabled: true }),
    { hidden: false, disabled: false, note: 'Not available on this computer: it works only on Windows.' });
  assert.deepEqual(settingsRow({ ...state(), available: false, reason: 'handshake_failed', enabled: false }), {
    hidden: false, disabled: true,
    note: 'Not available on this computer: the desktop control helper did not answer correctly; turn desktop control off and on in Settings to retry.',
  });
  assert.equal(enabledNotesText({ ...state(), conversations: [] }), 'No note has it on yet: turn it on in each note that should use it.');
  assert.equal(enabledNotesText({ ...state(), conversations: ['home'] }), 'On in 1 note.');
  assert.equal(enabledNotesText({ ...state(), conversations: ['home', 'conv-1'] }), 'On in 2 notes.');
});
