import type { SessionBinder } from '../conversations/binder.ts';
import type { ConversationStore } from '../conversations/store.ts';
import { isHeartbeatPrompt, parseHeartbeatReply } from '../life/heartbeat.ts';
import { RuntimeHttpError, type RuntimeClient, type RuntimeStreamEvent } from '../runtime/client.ts';
import type { BotHostEvent, MessageOrigin, WorkItem } from '../types.ts';
import { runWithSessionGate } from './gate.ts';

/**
 * SPEC-001 FR-11, FR-17, FR-18, FR-25, FR-27: run one work item as one
 * runtime turn. Binds the conversation to a session through the binder,
 * streams the turn, and classifies every runtime answer.
 */

export const BACKGROUND_BUSY_RETRY_MS = 4 * 60_000;
export const OWNER_BUSY_RETRY_MS = 15_000;
export const RUNTIME_UNAVAILABLE_RETRY_MS = 30_000;
export const NO_CAPACITY_RETRY_MS = 5 * 60_000;
const TOOL_RESULT_CLIP = 2_000;

export type TurnOutcome =
  | { kind: 'completed'; text: string; quiet: boolean }
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
  binder: SessionBinder;
  conversations: ConversationStore;
  now(): Date;
  emit(event: BotHostEvent): void;
  /** FR-28: journals the item with its run before the prompt leaves, so a crash mid-turn keeps the evidence. */
  persistRun(item: WorkItem): void;
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
      const bound = await this.deps.binder.bind(item.conversationId);
      if (!bound.ok) {
        if (bound.noCapacity && item.kind !== 'owner_message') {
          return { kind: 'retry_later', reason: 'no_capacity', retryAfterMs: this.delays.noCapacityMs };
        }
        return { kind: 'failed', reason: bound.reason };
      }
      const attachment = this.deps.conversations.require(item.conversationId).attachment;
      item.run = {
        provider: attachment.provider ?? '',
        model: attachment.model,
        sessionId: bound.sessionId,
        startedAt: this.deps.now().toISOString(),
        historyBaseline: bound.how === 'created' ? 0 : await this.historyLength(client, bound.sessionId),
      };
      this.deps.persistRun(item);
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

  /** The session's history length before this turn's prompt; null when the runtime cannot say. */
  private async historyLength(client: RuntimeClient, sessionId: string): Promise<number | null> {
    try {
      const history = await client.getHistory(sessionId);
      return Array.isArray(history.messages) ? history.messages.length : null;
    } catch {
      return null;
    }
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
          // The conversation may already have moved to a newer session (FR-27); only this one is touched.
          if (this.deps.conversations.get(conversationId)?.attachment.sessionId !== sessionId) break;
          if (event.sessionId) {
            this.deps.conversations.setAttachment(conversationId, { state: 'ready', providerSessionId: event.sessionId });
          } else if (event.type === 'result') {
            this.deps.conversations.setAttachment(conversationId, { state: 'ready' });
          }
          break;
        }
        case 'text': {
          if (typeof event.text === 'string' && event.text) {
            textParts.push(event.text);
            if (item.kind !== 'heartbeat') {
              emitDelta({ kind: 'bot', origin, text: event.text, workItemId: item.id }, 0);
            }
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
      // SPEC-001 FR-25: a quiet heartbeat leaves no message behind.
      if (item.kind === 'heartbeat' || isHeartbeatPrompt(item.prompt)) {
        const parsed = parseHeartbeatReply(text);
        if (parsed.quiet) return { kind: 'completed', text: '', quiet: true };
        this.deps.conversations.append(conversationId, { kind: 'bot', origin: 'heartbeat', text: parsed.body, workItemId: item.id });
        emitDelta({ kind: 'bot', origin: 'heartbeat', text: parsed.body, workItemId: item.id }, 0);
        return { kind: 'completed', text: parsed.body, quiet: false };
      }
      if (text) {
        this.deps.conversations.append(conversationId, { kind: 'bot', origin, text, workItemId: item.id });
      }
      return { kind: 'completed', text, quiet: false };
    }
    if (controller.signal.aborted) return { kind: 'cancelled' };
    if (outcome.errorText) {
      return { kind: 'failed', reason: outcome.errorText };
    }
    this.deps.log(`turn ${item.id}: stream ended without a result`);
    return { kind: 'interrupted' };
  }
}
