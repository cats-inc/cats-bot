import type { BotCore } from '../../core/bot.ts';
import type { ApprovalDecision, BotProfilePatch, BotInteractionResponse, DesktopGrantDecision } from '../../core/types.ts';

/**
 * SPEC-001 FR-32 / FR-34: the command side of `BotHostApi` as the renderer
 * may call it. Every command is a plain name with JSON arguments; the
 * renderer never receives the runtime's URL or key because the core never
 * exposes them. Window-only commands (hide, pin) are handled by the window
 * layer, not here. The settings page (SPEC-002) adds the provider and model
 * catalogs, renaming and the Telegram token. SPEC-006 adds desktop control:
 * its state, the conversation switch, grant answers and stop.
 */

export type HostCommand =
  | 'providerInteractions'
  | 'respondProviderInteraction'
  | 'sessionCapabilities'
  | 'openProviderInteractionUrl'
  | 'getProfile'
  | 'updateProfile'
  | 'listConversations'
  | 'createConversation'
  | 'deleteConversation'
  | 'transcript'
  | 'sendOwnerMessage'
  | 'cancelTurn'
  | 'markSeen'
  | 'listSchedules'
  | 'cancelSchedule'
  | 'listWorkItems'
  | 'resolveApproval'
  | 'status'
  | 'listProviders'
  | 'listModels'
  | 'renameConversation'
  | 'telegramStatus'
  | 'setTelegramToken'
  | 'desktopControlState'
  | 'setConversationDesktopControl'
  | 'respondDesktopGrant'
  | 'stopDesktopControl';

export const HOST_COMMANDS: readonly HostCommand[] = [
  'providerInteractions', 'respondProviderInteraction', 'sessionCapabilities', 'openProviderInteractionUrl',
  'getProfile',
  'updateProfile',
  'listConversations',
  'createConversation',
  'deleteConversation',
  'transcript',
  'sendOwnerMessage',
  'cancelTurn',
  'markSeen',
  'listSchedules',
  'cancelSchedule',
  'listWorkItems',
  'resolveApproval',
  'status',
  'listProviders',
  'listModels',
  'renameConversation',
  'telegramStatus',
  'setTelegramToken',
  'desktopControlState', 'setConversationDesktopControl', 'respondDesktopGrant', 'stopDesktopControl',
];

/**
 * Commands only the note of the named conversation may send. SPEC-006 BDC-07: grants are
 * answered there or in the CLI, never from Settings, the floating cat or a provider request.
 */
export const NOTE_ONLY_COMMANDS: readonly HostCommand[] = [
  'providerInteractions', 'respondProviderInteraction', 'openProviderInteractionUrl',
  'setConversationDesktopControl', 'respondDesktopGrant', 'stopDesktopControl',
];

/** The window a `bot:invoke` came from: a note's conversation, Settings or the floating cat. */
export interface CommandSender {
  note: string | null;
  settings: boolean;
  floating: boolean;
}

/**
 * Whether that window may send the command with these arguments. A note acts only on its own
 * conversation; desktop control state is read by its own note, or at the profile level
 * (no conversation) by Settings, whose switch it shows.
 */
export function senderMayInvoke(command: string, args: unknown[], sender: CommandSender): boolean {
  if (sender.note === null && !sender.settings && !sender.floating) return false;
  if (NOTE_ONLY_COMMANDS.includes(command as HostCommand)) return sender.note !== null && args[0] === sender.note;
  if (command === 'desktopControlState') {
    return sender.note !== null ? args[0] === sender.note : sender.settings && (args[0] === undefined || args[0] === null);
  }
  return true;
}

function asString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${name} must be a non-empty string`);
  return value;
}

export async function runHostCommand(core: BotCore, command: string, args: unknown[], openExternal?: (url: string) => Promise<void>): Promise<unknown> {
  switch (command as HostCommand) {
    case 'providerInteractions': return core.providerInteractions(asString(args[0], 'conversationId'));
    case 'respondProviderInteraction':
      await core.respondProviderInteraction(asString(args[0], 'conversationId'), asString(args[1], 'interactionId'), args[2] as BotInteractionResponse);
      return null;
    case 'sessionCapabilities': return core.sessionCapabilities(asString(args[0], 'conversationId'), args[1] === true);
    case 'openProviderInteractionUrl': {
      const snapshot = await core.providerInteractions(asString(args[0], 'conversationId'));
      if (!snapshot.supported) throw new Error('The provider request cannot currently be verified.');
      const interaction = snapshot.interactions.find(i => i.interactionId === asString(args[1], 'interactionId'));
      if (!interaction?.prompt?.url || interaction.kind !== 'mcp_url' || interaction.status !== 'pending'
        || Date.parse(interaction.expiresAt) <= Date.now() || !openExternal) throw new Error('No active URL request.');
      const url = new URL(interaction.prompt.url);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported request URL.');
      await openExternal(url.href);
      return null;
    }
    case 'getProfile':
      return core.getProfile();
    case 'updateProfile':
      return core.updateProfile((args[0] ?? {}) as BotProfilePatch);
    case 'listConversations':
      return core.listConversations();
    case 'createConversation':
      return core.createConversation(typeof args[0] === 'string' ? args[0] : undefined);
    case 'deleteConversation':
      await core.deleteConversation(asString(args[0], 'conversationId'));
      return null;
    case 'transcript':
      return core.transcript(asString(args[0], 'conversationId'));
    case 'sendOwnerMessage':
      return core.sendOwnerMessage(asString(args[0], 'conversationId'), asString(args[1], 'text'));
    case 'cancelTurn':
      await core.cancelTurn(asString(args[0], 'conversationId'));
      return null;
    case 'markSeen':
      await core.markSeen(asString(args[0], 'conversationId'));
      return null;
    case 'listSchedules':
      return core.listSchedules();
    case 'cancelSchedule':
      await core.cancelSchedule(asString(args[0], 'scheduleId'));
      return null;
    case 'listWorkItems':
      return core.listWorkItems();
    case 'resolveApproval': {
      const decision = args[1];
      if (decision !== 'approve' && decision !== 'deny') throw new Error('decision must be approve or deny');
      await core.resolveApproval(asString(args[0], 'workItemId'), decision as ApprovalDecision);
      return null;
    }
    case 'status':
      return core.status();
    case 'listProviders':
      return core.listProviders();
    case 'listModels':
      return core.listModels(asString(args[0], 'provider'));
    case 'renameConversation':
      return core.renameConversation(asString(args[0], 'conversationId'), asString(args[1], 'title'));
    case 'telegramStatus':
      return core.telegramStatus();
    case 'setTelegramToken':
      // The token goes into the secret store and is never echoed back to a renderer.
      await core.setTelegramToken(typeof args[0] === 'string' && args[0].trim() ? args[0] : null);
      return core.telegramStatus();
    case 'desktopControlState':
      return core.desktopControlState(args[0] === undefined || args[0] === null ? undefined : asString(args[0], 'conversationId'));
    case 'setConversationDesktopControl':
      if (typeof args[1] !== 'boolean') throw new Error('enabled must be true or false');
      return core.setConversationDesktopControl(asString(args[0], 'conversationId'), args[1]);
    case 'respondDesktopGrant': {
      const decision = args[2];
      if (decision !== 'allow' && decision !== 'deny') throw new Error('decision must be allow or deny');
      await core.respondDesktopGrant(asString(args[0], 'conversationId'), asString(args[1], 'requestId'), decision as DesktopGrantDecision);
      return core.desktopControlState(asString(args[0], 'conversationId'));
    }
    case 'stopDesktopControl':
      await core.stopDesktopControl(asString(args[0], 'conversationId'));
      return core.desktopControlState(asString(args[0], 'conversationId'));
    default:
      throw new Error(`Unknown host command ${command}`);
  }
}
