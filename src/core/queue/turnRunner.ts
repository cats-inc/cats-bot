import { buildHandoffPack, composeInstructions } from '../conversations/handoff.ts';
import type { ConversationStore } from '../conversations/store.ts';
import {
  RuntimeHttpError,
  type CreateSessionRequest,
  type RuntimeClient,
  type RuntimeMcpServer,
  type RuntimeStreamEvent,
} from '../runtime/client.ts';
import type { BotHostEvent, BotProfile, ConversationRecord, MessageOrigin, WorkItem } from '../types.ts';
import { runWithSessionGate } from './gate.ts';

/**
 * SPEC-001 FR-11, FR-17, FR-18, FR-27: run one work item as one runtime turn.
 * Binds the conversation to a session (create, resume or rebuild with the
 * handoff pack), streams the turn, and classifies every runtime answer.
 */

export const BACKGROUND_BUSY_RETRY_MS = 4 * 60_000;
export const OWNER_BUSY_RETRY_MS = 15_000;
export const RUNTIME_UNAVAILABLE_RETRY_MS = 30_000;
export const NO_CAPACITY_RETRY_MS = 5 * 60_000;
const TOOL_RESULT_CLIP = 2_000;

export type TurnOutcome =
  | { kind: 'completed'; text: string }
  | { kind: 'failed'; reason: string; retryAfterMs?: number }
  | { kind: 'interrupted' }
  | { kind: 'cancelled' }
  | {
    kind: 'retry_later';
    reason: 'runtime_unavailable' | 'session_busy' | 'no_capacity';
    retryAfterMs: number;
  };

export interface TurnRetryDelays {
  ownerBusyMs: number;
  backgroundBusyMs: number;
  runtimeUnavailableMs: number;
  noCapacityMs: number;
}

export const DEFAULT_TURN_RETRY_DELAYS: TurnRetryDelays = {
  ownerBusyMs: OWNER_BUSY_RETRY_MS,
  backgroundBusyMs: BACKGROUND_BUSY_RETRY_MS,
  runtimeUnavailableMs: RUNTIME_UNAVAILABLE_RETRY_MS,
  noCapacityMs: NO_CAPACITY_RETRY_MS,
};

export interface TurnRunnerDependencies {
  client(): RuntimeClient | null;
  profile(): BotProfile;
  conversations: ConversationStore;
  now(): Date;
  mcpServers?(): RuntimeMcpServer[];
  emit(event: BotHostEvent): void;
  log(line: string): void;
  delays?: Partial<TurnRetryDelays>;
}

export function originForKind(kind: WorkItem['kind']): MessageOrigin {
  switch (kind) {
    case 'owner_message':
      return 'owner';
    case 'heartbeat':
      return 'heartbeat';
    case 'schedule':
      return 'schedule';
    default:
      return 'event';
  }
}

type BindResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: string; retryAfterMs?: number };

function sameTarget(conversation: ConversationRecord, profile: BotProfile): boolean {
  const { attachment } = conversation;
  return (
    attachment.provider === profile.executionTarget.provider
    && (attachment.model ?? null) === (profile.executionTarget.model ?? null)
  );
}

function isNoCapacity(message: string): boolean {
  return /\bmax sessions\b[^.]*\breached\b/iu.test(message);
}

export class TurnRunner {
  private readonly deps: TurnRunnerDependencies;
  private readonly delays: TurnRetryDelays;

  constructor(deps: TurnRunnerDependencies) {
    this.deps = deps;
    this.delays = { ...DEFAULT_TURN_RETRY_DELAYS, ...deps.delays };
  }

  async run(item: WorkItem, controller: AbortController): Promise<TurnOutcome> {
    const client = this.deps.client();
    if (!client) {
      return { kind: 'retry_later', reason: 'runtime_unavailable', retryAfterMs: this.delays.runtimeUnavailableMs };
    }
    let resumedAfterNoWorker = false;
    let rebuiltAfterExit = false;
    for (let round = 0; round < 3; round += 1) {
      if (controller.signal.aborted) return { kind: 'cancelled' };
      const conversation = this.deps.conversations.require(item.conversationId);
      const profile = this.deps.profile();
      const bound = await this.bind(client, conversation, profile, item.id);
      if (!bound.ok) {
        if (bound.retryAfterMs !== undefined && item.kind !== 'owner_message') {
          return { kind: 'retry_later', reason: 'no_capacity', retryAfterMs: bound.retryAfterMs };
        }
        return { kind: 'failed', reason: bound.reason };
      }
      item.run = {
        provider: profile.executionTarget.provider,
        model: profile.executionTarget.model,
        sessionId: bound.sessionId,
      };
      try {
        return await runWithSessionGate(bound.sessionId, () =>
          this.stream(client, bound.sessionId, item, controller));
      } catch (error) {
        if (controller.signal.aborted) return { kind: 'cancelled' };
        if (!(error instanceof RuntimeHttpError)) {
          return { kind: 'failed', reason: error instanceof Error ? error.message : String(error) };
        }
        const classified = this.classify(error, item, bound.sessionId, resumedAfterNoWorker, rebuiltAfterExit);
        if (classified === 'resume') {
          resumedAfterNoWorker = true;
          continue;
        }
        if (classified === 'rebuild') {
          rebuiltAfterExit = true;
          continue;
        }
        return classified;
      }
    }
    return { kind: 'failed', reason: 'The session could not be re-established after repeated attempts' };
  }

  /** Decides what a rejected send means (SPEC-001 FR-17 / FR-18). */
  private classify(
    error: RuntimeHttpError,
    item: WorkItem,
    sessionId: string,
    resumedAlready: boolean,
    rebuiltAlready: boolean,
  ): TurnOutcome | 'resume' | 'rebuild' {
    const { conversationId } = item;
    const noWorker = error.status === 404 && /no active worker/iu.test(error.message);
    const closed = error.status === 400 && /closed/iu.test(error.message);
    if ((noWorker || closed) && !resumedAlready) {
      this.deps.log(`turn ${item.id}: session ${sessionId} has no worker; resuming`);
      this.deps.conversations.setAttachment(conversationId, { state: 'sleeping' });
      return 'resume';
    }
    if (error.status === 404 && !rebuiltAlready) {
      this.deps.log(`turn ${item.id}: session ${sessionId} is unknown to the runtime; rebuilding`);
      this.deps.conversations.setAttachment(conversationId, { state: 'closed', lastError: error.message });
      return 'rebuild';
    }
    if (error.status === 410 && !rebuiltAlready) {
      this.deps.log(`turn ${item.id}: worker of session ${sessionId} exited; rebuilding`);
      this.deps.conversations.setAttachment(conversationId, { state: 'closed', lastError: error.message });
      return 'rebuild';
    }
    if (error.status === 409) {
      const retryAfterMs = item.kind === 'owner_message' ? this.delays.ownerBusyMs : this.delays.backgroundBusyMs;
      this.deps.log(`turn ${item.id}: session ${sessionId} busy; retry in ${retryAfterMs}ms`);
      return { kind: 'retry_later', reason: 'session_busy', retryAfterMs };
    }
    if (error.status === 403 || error.status === 429) {
      const body = typeof error.body === 'object' && error.body !== null ? (error.body as Record<string, unknown>) : {};
      const guardrail = typeof body.guardrail === 'object' && body.guardrail !== null
        ? (body.guardrail as Record<string, unknown>)
        : {};
      const cooldownUntil = typeof guardrail.cooldownUntil === 'string' ? Date.parse(guardrail.cooldownUntil) : Number.NaN;
      const retryAfterMs = Number.isFinite(cooldownUntil)
        ? Math.max(0, cooldownUntil - this.deps.now().getTime())
        : undefined;
      this.deps.log(`turn ${item.id}: guardrail ${error.code ?? error.status}`);
      return { kind: 'failed', reason: error.message, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
    }
    return { kind: 'failed', reason: error.message };
  }

  /** SPEC-001 FR-11 / FR-27: use, resume or rebuild the conversation's session. */
  private async bind(
    client: RuntimeClient,
    conversation: ConversationRecord,
    profile: BotProfile,
    workItemId: string,
  ): Promise<BindResult> {
    const { attachment } = conversation;
    const targetMatches = sameTarget(conversation, profile);
    const live = attachment.state === 'ready' || attachment.state === 'initializing';
    if (attachment.sessionId && live && targetMatches) {
      return { ok: true, sessionId: attachment.sessionId };
    }
    if (attachment.sessionId && !targetMatches && attachment.state !== 'stale' && attachment.state !== 'none') {
      this.deps.log(`conversation ${conversation.id}: attachment is stale after a provider/model change`);
      this.deps.conversations.setAttachment(conversation.id, { state: 'stale' });
      this.deps.conversations.append(conversation.id, {
        kind: 'system',
        origin: 'system',
        text: `The bot now runs on ${profile.executionTarget.provider}`
          + `${profile.executionTarget.model ? ` (${profile.executionTarget.model})` : ''}; `
          + 'this conversation continues in a new session with a handoff of what was said so far.',
      });
    } else if (attachment.sessionId && attachment.state === 'sleeping' && targetMatches) {
      try {
        const view = await client.resumeSession(attachment.sessionId, {
          ...(this.deps.mcpServers ? { mcpServers: this.deps.mcpServers() } : {}),
        });
        this.deps.conversations.setAttachment(conversation.id, {
          state: view.status === 'ready' ? 'ready' : 'initializing',
          ...(view.providerSessionId ? { providerSessionId: view.providerSessionId } : {}),
        });
        this.deps.log(`conversation ${conversation.id}: resumed session ${attachment.sessionId}`);
        return { ok: true, sessionId: attachment.sessionId };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.deps.log(`conversation ${conversation.id}: resume of ${attachment.sessionId} failed`);
        this.deps.conversations.setAttachment(conversation.id, { state: 'failed', lastError: reason });
        this.deps.conversations.append(conversation.id, {
          kind: 'error',
          origin: 'system',
          text: `Could not resume the previous session: ${reason}`,
        });
        return { ok: false, reason: `resume failed: ${reason}` };
      }
    } else if (attachment.state === 'failed' && attachment.sessionId) {
      this.deps.conversations.append(conversation.id, {
        kind: 'system',
        origin: 'system',
        text: 'The previous session could not be continued; a new session starts with a handoff of what was said so far.',
      });
    }
    return this.create(client, this.deps.conversations.require(conversation.id), profile, workItemId);
  }

  private async create(
    client: RuntimeClient,
    conversation: ConversationRecord,
    profile: BotProfile,
    workItemId: string,
  ): Promise<BindResult> {
    // The prompt of the turn being bound travels as the message, not in the pack.
    const pack = buildHandoffPack(
      this.deps.conversations.transcript(conversation.id).filter((entry) => entry.workItemId !== workItemId),
    );
    const request: CreateSessionRequest = {
      provider: profile.executionTarget.provider,
      ...(profile.executionTarget.model ? { model: profile.executionTarget.model } : {}),
      cwd: profile.permissions.cwd,
      workspaceKind: 'source',
      workspaceAccess: profile.permissions.workspaceAccess,
      permissionMode: profile.permissions.permissionMode,
      ...(profile.permissions.allowedTools ? { allowedTools: profile.permissions.allowedTools } : {}),
      instructions: composeInstructions(profile.instructions, pack),
      ...(this.deps.mcpServers ? { mcpServers: this.deps.mcpServers() } : {}),
    };
    try {
      const view = await client.createSession(request);
      this.deps.conversations.setAttachment(conversation.id, {
        state: view.status === 'ready' ? 'ready' : 'initializing',
        sessionId: view.id,
        providerSessionId: view.providerSessionId ?? null,
        provider: profile.executionTarget.provider,
        model: profile.executionTarget.model,
        configRevision: profile.configRevision,
      });
      if (pack.text) {
        this.deps.conversations.update(conversation.id, (record) => {
          record.checkpoint = {
            digest: pack.text,
            throughSeq: pack.throughSeq,
            updatedAt: this.deps.now().toISOString(),
          };
        });
      }
      this.deps.log(`conversation ${conversation.id}: created session ${view.id} (${view.status})`);
      return { ok: true, sessionId: view.id };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.deps.log(`conversation ${conversation.id}: session create failed`);
      this.deps.conversations.setAttachment(conversation.id, { lastError: reason });
      return {
        ok: false,
        reason: `session create failed: ${reason}`,
        ...(isNoCapacity(reason) ? { retryAfterMs: this.delays.noCapacityMs } : {}),
      };
    }
  }

  /** SPEC-001 FR-18: stream one turn and attach every event to the transcript. */
  private async stream(
    client: RuntimeClient,
    sessionId: string,
    item: WorkItem,
    controller: AbortController,
  ): Promise<TurnOutcome> {
    const { conversationId } = item;
    const origin = originForKind(item.kind);
    const textParts: string[] = [];
    const emitDelta = (entry: Parameters<ConversationStore['append']>[1], seq: number) => {
      this.deps.emit({
        type: 'turn.delta',
        conversationId,
        workItemId: item.id,
        entry: { seq, at: this.deps.now().toISOString(), ...entry },
      });
    };
    const onEvent = (event: RuntimeStreamEvent) => {
      switch (event.type) {
        case 'init':
        case 'result': {
          if (event.sessionId) {
            this.deps.conversations.setAttachment(conversationId, {
              state: 'ready',
              providerSessionId: event.sessionId,
            });
          } else if (event.type === 'result') {
            this.deps.conversations.setAttachment(conversationId, { state: 'ready' });
          }
          break;
        }
        case 'text': {
          if (typeof event.text === 'string' && event.text) {
            textParts.push(event.text);
            emitDelta({ kind: 'bot', origin, text: event.text, workItemId: item.id }, 0);
          }
          break;
        }
        case 'tool_use': {
          const entry = this.deps.conversations.append(conversationId, {
            kind: 'tool_use',
            origin,
            text: typeof event.text === 'string' ? event.text : '',
            workItemId: item.id,
            ...(typeof event.toolName === 'string' ? { toolName: event.toolName } : {}),
            ...(typeof event.toolId === 'string' ? { toolId: event.toolId } : {}),
          });
          emitDelta(entry, entry.seq);
          break;
        }
        case 'tool_result': {
          const text = typeof event.text === 'string' ? event.text : '';
          const entry = this.deps.conversations.append(conversationId, {
            kind: 'tool_result',
            origin,
            text: text.length > TOOL_RESULT_CLIP ? `${text.slice(0, TOOL_RESULT_CLIP)}…` : text,
            workItemId: item.id,
            ...(typeof event.toolName === 'string' ? { toolName: event.toolName } : {}),
            ...(typeof event.toolId === 'string' ? { toolId: event.toolId } : {}),
            ...(event.isError === true ? { isError: true } : {}),
          });
          emitDelta(entry, entry.seq);
          break;
        }
        case 'error': {
          const entry = this.deps.conversations.append(conversationId, {
            kind: 'error',
            origin,
            text: typeof event.text === 'string' ? event.text : 'runtime error',
            workItemId: item.id,
            isError: true,
          });
          emitDelta(entry, entry.seq);
          break;
        }
        case 'progress': {
          if (typeof event.text === 'string' && event.text) {
            emitDelta({ kind: 'progress', origin, text: event.text, workItemId: item.id }, 0);
          }
          break;
        }
        default:
          break;
      }
    };
    const outcome = await client.streamMessage(sessionId, { message: item.prompt }, onEvent, controller.signal);
    const text = textParts.join('').trim();
    if (outcome.completed) {
      if (text) {
        this.deps.conversations.append(conversationId, { kind: 'bot', origin, text, workItemId: item.id });
      }
      return { kind: 'completed', text };
    }
    if (controller.signal.aborted) return { kind: 'cancelled' };
    if (outcome.errorText) {
      return { kind: 'failed', reason: outcome.errorText };
    }
    this.deps.log(`turn ${item.id}: stream ended without a result`);
    return { kind: 'interrupted' };
  }
}
