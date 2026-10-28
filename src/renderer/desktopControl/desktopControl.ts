import type { DesktopControlState, DesktopGrantRequest } from '../../core/types.ts';

/**
 * SPEC-006 P3: what the note and the settings page show of desktop control, apart from React,
 * so it is tested with node:test. The core decides; this only words its state and reasons.
 */

const REASONS: Record<string, string> = {
  not_windows: 'it works only on Windows',
  no_helper: 'this build has no desktop control helper',
  helper_missing: 'the desktop control helper is missing from this installation',
  handshake_failed: 'the desktop control helper did not answer correctly; turn desktop control off and on in Settings to retry',
  helper_crashed: 'the desktop control helper stopped too often; turn desktop control off and on in Settings to retry',
  helper_failed: 'the desktop control helper could not start',
  server_failed: 'the desktop control server could not start',
  closed: 'the bot is shutting down',
  unavailable: 'the desktop control helper is not available',
  off: 'it is off in Settings',
  conversation_off: 'it is off for this note',
  no_live_session: 'it starts with your next message',
  no_turn_yet: 'it starts with your next message',
  session_changed: 'it starts with your next message',
  policy_unknown: 'the session has not reported its approval policy yet',
  policy_not_explicit: 'choose "Choose access and approval separately" under Provider access and tools in Settings',
  policy_preapproves_tools: 'the approval policy runs tools without asking; choose one that asks',
  no_tool_approval_host: 'this agent CLI cannot ask you before each tool call',
};

/** A reason code in the owner's words; an unknown code is shown with spaces. */
export function reasonText(reason: string | null): string {
  if (!reason) return '';
  return REASONS[reason] ?? reason.replaceAll('_', ' ');
}

type Conversation = NonNullable<DesktopControlState['conversation']>;

/** The note shows desktop control while the profile switch is on, and always while something waits or is granted. */
export function notePanelVisible(state: DesktopControlState | null): state is DesktopControlState & { conversation: Conversation } {
  const conversation = state?.conversation;
  if (!state || !conversation) return false;
  return state.enabled || conversation.grants.length > 0 || conversation.pendingRequests.length > 0;
}

/** Phase A has no holding state: Stop is offered whenever the conversation has grants or waiting requests. */
export function showStop(conversation: Conversation): boolean {
  return conversation.grants.length > 0 || conversation.pendingRequests.length > 0 || conversation.capability.status === 'holding';
}

/** The conversation switch can always be turned off; it is turned on only where desktop control can work. */
export function switchDisabled(state: DesktopControlState, conversation: Conversation): boolean {
  return !conversation.enabled && (!state.available || !state.enabled);
}

/** One line under the switch: SPEC-133 DC-18 status with its reason, or null when there is nothing to say. */
export function noteStatus(state: DesktopControlState, conversation: Conversation): string | null {
  if (!state.available) return `Not available on this computer: ${reasonText(state.reason)}.`;
  if (!conversation.enabled) return null;
  const { status, reason } = conversation.capability;
  switch (status) {
    case 'unavailable':
      return `Not available on this computer: ${reasonText(reason)}.`;
    case 'off':
      return `Off: ${reasonText(reason)}.`;
    case 'not_injected':
      if (reason === 'no_turn_yet' || reason === 'no_live_session' || reason === 'session_changed') {
        return 'Ready from your next message.';
      }
      return `Not in this session: ${reasonText(reason)}.`;
    case 'injected':
      return conversation.stopped && conversation.grants.length === 0
        ? 'Stopped. The bot has to ask again before it can see an app.'
        : 'Ready. The bot can use it in messages you send from this note or cats-bot say.';
    case 'active_turn':
      return 'The bot can use desktop control in this turn.';
    case 'holding':
      return 'The bot is operating your desktop.';
    default:
      return null;
  }
}

/** The granted apps in one line. */
export function grantedText(conversation: Conversation): string | null {
  if (conversation.grants.length === 0) return null;
  return `Granted: ${conversation.grants.map((app) => app.tier === 'observe_only' ? `${app.name} (observe only)` : app.name).join(', ')}`;
}

export interface GrantCardText {
  title: string;
  path: string;
  publisher: string;
  observeOnly: string | null;
  reason: string;
}

/** A grant request card (SPEC-133 DC-08): the app, its path, its publisher or "unsigned", and the bot's reason. */
export function grantCardText(request: DesktopGrantRequest): GrantCardText {
  return {
    title: `Let the bot see ${request.name}?`,
    path: request.path,
    publisher: request.publisher ? `Publisher: ${request.publisher}` : 'Unsigned app: no publisher could be verified',
    observeOnly: request.tier === 'observe_only' ? 'Observe only: the bot can never type into this app.' : null,
    reason: `The bot's reason: ${request.reason}`,
  };
}

export interface SettingsRow {
  /** Off Windows, where there is nothing to set, the row is hidden unless the switch is somehow on. */
  hidden: boolean;
  disabled: boolean;
  /** Why it cannot be used here, or null. */
  note: string | null;
}

/** The profile switch in Settings > Bot (SPEC-006 BDC-02). */
export function settingsRow(state: DesktopControlState | null): SettingsRow {
  if (!state) return { hidden: false, disabled: true, note: null };
  if (state.available) return { hidden: false, disabled: false, note: null };
  return {
    hidden: state.reason === 'not_windows' && !state.enabled,
    // A switch that is on can always be turned off.
    disabled: !state.enabled,
    note: `Not available on this computer: ${reasonText(state.reason)}.`,
  };
}

/** How many notes have their own switch on, for the settings page. */
export function enabledNotesText(state: DesktopControlState): string {
  const count = state.conversations.length;
  if (count === 0) return 'No note has it on yet: turn it on in each note that should use it.';
  return `On in ${count} ${count === 1 ? 'note' : 'notes'}.`;
}
