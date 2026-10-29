import { delimiter, isAbsolute } from 'node:path';

import type {
  ApprovalDecision, BotHostApi, BotProfilePatch, BotInteractionResponse, BotStatus, ConversationRecord,
  DesktopGrantDecision, ModelCatalog, ProviderInfo, TelegramSettingsStatus, TranscriptEntry, WorkItem,
} from '../types.ts';

/**
 * SPEC-001 FR-32 / FR-34 and SPEC-008 FR-13: the commands a host may send to a
 * core, with their argument checks, in one place. The shell's renderer IPC and
 * the host channel both dispatch through `runCoreCommand`, so a command a
 * window may not send is equally unknown to the channel. Every command is a
 * plain name with JSON arguments; the core never exposes the runtime's URL or
 * key through them.
 */

/** Commands a renderer may send through the shell (SPEC-002, SPEC-006). */
export const CORE_COMMANDS = [
  'providerInteractions', 'respondProviderInteraction', 'sessionCapabilities',
  'getProfile', 'updateProfile', 'listConversations', 'createConversation', 'deleteConversation',
  'transcript', 'conversationTranscript', 'sendOwnerMessage', 'cancelTurn', 'markSeen',
  'listSchedules', 'cancelSchedule', 'listWorkItems', 'resolveApproval', 'status',
  'listProviders', 'listModels', 'renameConversation', 'telegramStatus', 'setTelegramToken',
  'desktopControlState', 'setConversationDesktopControl', 'respondDesktopGrant', 'stopDesktopControl',
] as const;

/** Window lifecycle and host-only commands the presenting host sends for itself. */
export const HOST_ONLY_COMMANDS = [
  'openView', 'closeView', 'setViewFocused', 'protectSecretsAtRest', 'stopAllDesktopControl', 'useCommandDirectory', 'quit',
] as const;

export type CoreCommand = (typeof CORE_COMMANDS)[number] | (typeof HOST_ONLY_COMMANDS)[number];
export const CHANNEL_COMMANDS: readonly CoreCommand[] = [...CORE_COMMANDS, ...HOST_ONLY_COMMANDS];

type MaybePromise<T> = T | Promise<T>;

/** What a command runs against: an in-process `BotCore` or a host channel client. */
export interface CoreCommandTarget extends BotHostApi {
  transcript(conversationId: string): MaybePromise<TranscriptEntry[]>;
  conversationTranscript(conversationId: string): MaybePromise<TranscriptEntry[]>;
  listWorkItems(): MaybePromise<WorkItem[]>;
  status(): MaybePromise<BotStatus>;
  listProviders(): MaybePromise<ProviderInfo[]>;
  listModels(provider: string): Promise<ModelCatalog>;
  renameConversation(conversationId: string, title: string): Promise<ConversationRecord>;
  telegramStatus(): MaybePromise<TelegramSettingsStatus>;
  setTelegramToken(token: string | null): Promise<void>;
  protectSecretsAtRest(): Promise<number>;
  /** The directory of a provider CLI the host's setup found or installed, put first on PATH (ADR-006). */
  useCommandDirectory(directory: string): MaybePromise<void>;
}

const MAX_ID = 200;
const MAX_TEXT = 1024 * 1024;

function asString(value: unknown, name: string, max = MAX_ID): string {
  if (typeof value !== 'string' || !value) throw new Error(`${name} must be a non-empty string`);
  if (value.length > max) throw new Error(`${name} is too long`);
  return value;
}

function asOptionalConversation(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : asString(value, 'conversationId');
}

export function isCoreCommand(command: string): command is CoreCommand {
  return (CHANNEL_COMMANDS as readonly string[]).includes(command);
}

export async function runCoreCommand(target: CoreCommandTarget, command: string, args: unknown[]): Promise<unknown> {
  if (!isCoreCommand(command)) throw new Error(`Unknown host command ${command}`);
  switch (command) {
    case 'providerInteractions': return target.providerInteractions(asString(args[0], 'conversationId'));
    case 'respondProviderInteraction':
      await target.respondProviderInteraction(asString(args[0], 'conversationId'), asString(args[1], 'interactionId'), args[2] as BotInteractionResponse);
      return null;
    case 'sessionCapabilities': return target.sessionCapabilities(asString(args[0], 'conversationId'), args[1] === true);
    case 'getProfile': return target.getProfile();
    case 'updateProfile': {
      const patch = args[0] ?? {};
      if (typeof patch !== 'object' || Array.isArray(patch)) throw new Error('patch must be an object');
      return target.updateProfile(patch as BotProfilePatch);
    }
    case 'listConversations': return target.listConversations();
    case 'createConversation': return target.createConversation(typeof args[0] === 'string' ? asString(args[0], 'title') : undefined);
    case 'deleteConversation':
      await target.deleteConversation(asString(args[0], 'conversationId'));
      return null;
    case 'transcript': return target.transcript(asString(args[0], 'conversationId'));
    case 'conversationTranscript': return target.conversationTranscript(asString(args[0], 'conversationId'));
    case 'sendOwnerMessage': return target.sendOwnerMessage(asString(args[0], 'conversationId'), asString(args[1], 'text', MAX_TEXT));
    case 'cancelTurn':
      await target.cancelTurn(asString(args[0], 'conversationId'));
      return null;
    case 'markSeen':
      await target.markSeen(asString(args[0], 'conversationId'));
      return null;
    case 'listSchedules': return target.listSchedules();
    case 'cancelSchedule':
      await target.cancelSchedule(asString(args[0], 'scheduleId'));
      return null;
    case 'listWorkItems': return target.listWorkItems();
    case 'resolveApproval': {
      const decision = args[1];
      if (decision !== 'approve' && decision !== 'deny') throw new Error('decision must be approve or deny');
      await target.resolveApproval(asString(args[0], 'workItemId'), decision as ApprovalDecision);
      return null;
    }
    case 'status': return target.status();
    case 'listProviders': return target.listProviders();
    case 'listModels': return target.listModels(asString(args[0], 'provider'));
    case 'renameConversation': return target.renameConversation(asString(args[0], 'conversationId'), asString(args[1], 'title'));
    case 'telegramStatus': return target.telegramStatus();
    case 'setTelegramToken':
      // The token goes into the secret store and is never echoed back.
      await target.setTelegramToken(typeof args[0] === 'string' && args[0].trim() ? asString(args[0], 'token', 4096) : null);
      return target.telegramStatus();
    case 'desktopControlState': return target.desktopControlState(asOptionalConversation(args[0]));
    case 'setConversationDesktopControl':
      if (typeof args[1] !== 'boolean') throw new Error('enabled must be true or false');
      return target.setConversationDesktopControl(asString(args[0], 'conversationId'), args[1]);
    case 'respondDesktopGrant': {
      const decision = args[2];
      if (decision !== 'allow' && decision !== 'deny') throw new Error('decision must be allow or deny');
      await target.respondDesktopGrant(asString(args[0], 'conversationId'), asString(args[1], 'requestId'), decision as DesktopGrantDecision);
      return target.desktopControlState(asString(args[0], 'conversationId'));
    }
    case 'stopDesktopControl':
      // A note stops its own conversation; the tray stops every conversation (SPEC-006 BDC-10).
      await target.stopDesktopControl(asString(args[0], 'conversationId'));
      return target.desktopControlState(asString(args[0], 'conversationId'));
    case 'stopAllDesktopControl':
      await target.stopDesktopControl();
      return target.desktopControlState();
    case 'openView':
      await target.openView(asString(args[0], 'conversationId'));
      return null;
    case 'closeView':
      await target.closeView(asString(args[0], 'conversationId'));
      return null;
    case 'setViewFocused':
      if (typeof args[1] !== 'boolean') throw new Error('focused must be true or false');
      await target.setViewFocused(asString(args[0], 'conversationId'), args[1]);
      return null;
    case 'protectSecretsAtRest': return target.protectSecretsAtRest();
    case 'useCommandDirectory': {
      const directory = asString(args[0], 'directory', 4096);
      if (!isAbsolute(directory) || directory.includes('\0') || directory.includes(delimiter)) throw new Error('directory must be one absolute path');
      await target.useCommandDirectory(directory);
      return null;
    }
    case 'quit':
      await target.quit();
      return null;
  }
}

