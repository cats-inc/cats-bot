import { delimiter, isAbsolute } from 'node:path';

import { isTerminalWorkState } from '../queue/workItems.ts';
import type {
  ApprovalDecision, BotDelivery, BotDeliveryState, BotHostApi, BotProfilePatch, BotInteractionResponse, BotStatus,
  ConversationRecord, DesktopGrantDecision, ModelCatalog, ProviderInfo, TelegramSettingsStatus, TranscriptEntry, WorkItem,
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
  'openView', 'closeView', 'setViewFocused', 'protectSecretsAtRest', 'stopAllDesktopControl', 'useCommandDirectory',
  'admitBotMessage', 'botDeliveries', 'setCoordinator', 'quit',
] as const;

export type CoreCommand = (typeof CORE_COMMANDS)[number] | (typeof HOST_ONLY_COMMANDS)[number];
export const CHANNEL_COMMANDS: readonly CoreCommand[] = [...CORE_COMMANDS, ...HOST_ONLY_COMMANDS];

type MaybePromise<T> = T | Promise<T>;

/** What a command runs against: an in-process `BotCore` or a host channel client. */
export interface CoreCommandTarget extends BotHostApi {
  transcript(conversationId: string): MaybePromise<TranscriptEntry[]>;
  conversationTranscript(conversationId: string): MaybePromise<TranscriptEntry[]>;
  /** Every work item, or one conversation's. */
  listWorkItems(conversationId?: string): MaybePromise<WorkItem[]>;
  status(): MaybePromise<BotStatus>;
  listProviders(): MaybePromise<ProviderInfo[]>;
  listModels(provider: string): Promise<ModelCatalog>;
  renameConversation(conversationId: string, title: string): Promise<ConversationRecord>;
  telegramStatus(): MaybePromise<TelegramSettingsStatus>;
  setTelegramToken(token: string | null): Promise<void>;
  protectSecretsAtRest(): Promise<number>;
  /** The directory of a provider CLI the host's setup found or installed, put first on PATH (ADR-006). */
  useCommandDirectory(directory: string): MaybePromise<void>;
  /** SPEC-009 FR-7 and FR-12: a delivery from another bot, admitted once per delivery id. */
  admitBotMessage(delivery: BotDelivery): MaybePromise<WorkItem>;
  /** SPEC-009 FR-12: how the named deliveries stand, read from the journal. */
  botDeliveries(deliveryIds: string[]): MaybePromise<BotDeliveryState[]>;
  /** SPEC-009 FR-3: whether the hub reports this bot as the coordinator holder. */
  setCoordinator(holder: boolean): MaybePromise<void>;
}

const MAX_DELIVERY_TEXT = 64 * 1024;

function asDelivery(value: unknown): BotDelivery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('delivery must be an object');
  const raw = value as Record<string, unknown>;
  const hop = raw.hop;
  if (typeof hop !== 'number' || !Number.isSafeInteger(hop) || hop < 1 || hop > 100) throw new Error('hop must be a positive integer');
  if (raw.kind !== 'message' && raw.kind !== 'reply') throw new Error('kind must be message or reply');
  return {
    deliveryId: asString(raw.deliveryId, 'deliveryId'),
    chainId: asString(raw.chainId, 'chainId'),
    hop,
    kind: raw.kind,
    from: asString(raw.from, 'from'),
    fromName: asString(raw.fromName, 'fromName'),
    ...(raw.conversationId === undefined || raw.conversationId === null ? {} : { conversationId: asString(raw.conversationId, 'conversationId') }),
    text: asString(raw.text, 'text', MAX_DELIVERY_TEXT),
  };
}

const MAX_ID = 200;
const MAX_TEXT = 1024 * 1024;

/**
 * What a host reads of a history that only grows: the newest part within a
 * byte budget, so a snapshot stays far below the channel's frame limit
 * however long the bot has run. Hosts show recent history.
 */
const TRANSCRIPT_BUDGET_BYTES = 4 * 1024 * 1024;
const FINISHED_WORK_BUDGET_BYTES = 2 * 1024 * 1024;

function newestWithin<T>(items: T[], budget: number): T[] {
  let used = 0;
  let from = items.length;
  while (from > 0) {
    const size = Buffer.byteLength(JSON.stringify(items[from - 1]));
    // The newest item stays even when it alone is over the budget.
    if (used + size > budget && from < items.length) break;
    used += size;
    from -= 1;
  }
  return items.slice(from);
}

/** A transcript's newest entries within the budget. */
export function recentEntries(entries: TranscriptEntry[], budget = TRANSCRIPT_BUDGET_BYTES): TranscriptEntry[] {
  return newestWithin(entries, budget);
}

/** Every unfinished work item and the newest finished ones within the budget, in order. */
export function recentWorkItems(items: WorkItem[], budget = FINISHED_WORK_BUDGET_BYTES): WorkItem[] {
  const kept = new Set(newestWithin(items.filter((item) => isTerminalWorkState(item.state)), budget));
  return items.filter((item) => !isTerminalWorkState(item.state) || kept.has(item));
}

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
    case 'transcript': return recentEntries(await target.transcript(asString(args[0], 'conversationId')));
    case 'conversationTranscript': return recentEntries(await target.conversationTranscript(asString(args[0], 'conversationId')));
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
    case 'listWorkItems': return recentWorkItems(await target.listWorkItems(asOptionalConversation(args[0])));
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
    case 'admitBotMessage': return target.admitBotMessage(asDelivery(args[0]));
    case 'botDeliveries': {
      const ids = args[0];
      if (!Array.isArray(ids) || ids.length > 1000) throw new Error('deliveryIds must be a list');
      return target.botDeliveries(ids.map((id) => asString(id, 'deliveryId')));
    }
    case 'setCoordinator':
      if (typeof args[0] !== 'boolean') throw new Error('holder must be true or false');
      await target.setCoordinator(args[0]);
      return null;
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

