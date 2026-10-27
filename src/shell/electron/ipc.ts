import type { BotCore } from '../../core/bot.ts';
import type { ApprovalDecision, BotProfilePatch } from '../../core/types.ts';

/**
 * SPEC-001 FR-32 / FR-34: the command side of `BotHostApi` as the renderer
 * may call it. Every command is a plain name with JSON arguments; the
 * renderer never receives the runtime's URL or key because the core never
 * exposes them. Window-only commands (hide, pin) are handled by the window
 * layer, not here. The settings page (SPEC-002) adds the provider and model
 * catalogs, renaming and the Telegram token.
 */

export type HostCommand =
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
  | 'setTelegramToken';

export const HOST_COMMANDS: readonly HostCommand[] = [
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
];

function asString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${name} must be a non-empty string`);
  return value;
}

export async function runHostCommand(core: BotCore, command: string, args: unknown[]): Promise<unknown> {
  switch (command as HostCommand) {
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
    default:
      throw new Error(`Unknown host command ${command}`);
  }
}
