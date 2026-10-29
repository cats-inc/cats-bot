import type { SessionBinder } from '../conversations/binder.ts';
import type { ConversationStore } from '../conversations/store.ts';
import { isHeartbeatPrompt, parseHeartbeatReply } from '../life/heartbeat.ts';
import { desktopToolInputSummary, desktopToolResultSummary, isDesktopControlToolName } from '../desktopControl/tools.ts';
import { RuntimeHttpError, type RuntimeClient, type RuntimeStreamEvent, type SendMessageRequest } from '../runtime/client.ts';
import type { BotHostEvent, MessageOrigin, WorkItem } from '../types.ts';
import { runWithSessionGate } from './gate.ts';
import { ResponsePresentation } from './responsePresentation.ts';

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

function clipToolText(text: string): string {
  return text.length > TOOL_RESULT_CLIP ? `${text.slice(0, TOOL_RESULT_CLIP)}…` : text;
}

/**
 * SPEC-003 FR-4: what a tool call was given. The runtime reports the input as
 * `toolArgs` (an object for the Claude CLI) and seldom as text, so the
 * transcript keeps it as indented JSON, clipped like results.
 */
export function toolInputText(event: { text?: unknown; toolArgs?: unknown }): string {
  if (typeof event.text === 'string' && event.text) return clipToolText(event.text);
  if (event.toolArgs === undefined || event.toolArgs === null) return '';
  if (typeof event.toolArgs === 'string') return clipToolText(event.toolArgs);
  try {
    return clipToolText(JSON.stringify(event.toolArgs, null, 2) ?? '');
  } catch {
    return '';
  }
}

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
  providerEvent?(item: WorkItem, event: RuntimeStreamEvent): void;
  /**
   * SPEC-006 BDC-04: decided inside the session gate right before the prompt is sent; may
   * return the session's MCP server set, which Runtime keeps until a send changes it.
   */
  prepareSend?(item: WorkItem, sessionId: string): Promise<Pick<SendMessageRequest, 'mcpServers'>>;
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
    const presentation = item.kind === 'heartbeat' || isHeartbeatPrompt(item.prompt)
      ? null : new ResponsePresentation(this.deps.conversations, item, origin, this.deps.now());
    // SPEC-006 BDC-12: desktop tool results (images, UI values, titles) and typed or clipboard
    // text in their inputs never reach the transcript.
    const desktopTools = new Map<string, string>();
    const publishPresentation = () => {
      const entry = presentation?.checkpoint();
      if (entry) this.deps.emit({ type: 'turn.presentation', conversationId, workItemId: item.id, entry });
    };
    const emitDelta = (entry: Parameters<ConversationStore['append']>[1], seq: number) => {
      if (presentation && entry.kind !== 'bot' && entry.kind !== 'progress') {
        presentation.entry({ seq, at: this.deps.now().toISOString(), ...entry });
        publishPresentation();
      }
      this.deps.emit({
        type: 'turn.delta',
        conversationId,
        workItemId: item.id,
        entry: { seq, at: this.deps.now().toISOString(), ...entry },
      });
    };
    const onEvent = (event: RuntimeStreamEvent) => {
      if (event.metadata?.kind === 'interaction_requested' || event.metadata?.kind === 'interaction_updated') {
        this.deps.providerEvent?.(item, event);
        return;
      }
      switch (event.type) {
        case 'init':
        case 'result': {
          // Coarse providers may return text only in their terminal snapshot.
          // A repeated final aggregate must never be appended after streamed deltas.
          if (event.type === 'result' && !textParts.length) {
            const segments = Array.isArray(event.segments) ? event.segments : [];
            const text = segments.filter(segment => segment && typeof segment === 'object' && segment.kind === 'text')
              .map(segment => typeof segment.text === 'string' ? segment.text : '').join('')
              || (typeof event.text === 'string' ? event.text : '');
            if (text) onEvent({ type: 'text', text });
          }
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
              if (presentation) {
                presentation.text(event.text);
                publishPresentation();
              }
              emitDelta({ kind: 'bot', origin, text: event.text, workItemId: item.id }, 0);
            }
          }
          break;
        }
        case 'tool_use': {
          const desktopTool = typeof event.toolName === 'string' && isDesktopControlToolName(event.toolName);
          if (desktopTool && typeof event.toolId === 'string') desktopTools.set(event.toolId, event.toolName as string);
          const entry = this.deps.conversations.append(conversationId, {
            kind: 'tool_use',
            origin,
            text: (desktopTool ? desktopToolInputSummary(event.toolName as string) : null) ?? toolInputText(event),
            workItemId: item.id,
            ...(typeof event.toolName === 'string' ? { toolName: event.toolName } : {}),
            ...(typeof event.toolId === 'string' ? { toolId: event.toolId } : {}),
          });
          emitDelta(entry, entry.seq);
          break;
        }
        case 'tool_result': {
          const name = typeof event.toolName === 'string' ? event.toolName
            : typeof event.toolId === 'string' ? desktopTools.get(event.toolId) : undefined;
          const raw = typeof event.text === 'string' ? event.text : '';
          // An error is the server's own sentence; a result may carry screen content.
          const text = isDesktopControlToolName(name) && event.isError !== true ? desktopToolResultSummary(name) : raw;
          const entry = this.deps.conversations.append(conversationId, {
            kind: 'tool_result',
            origin,
            text: clipToolText(text),
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
            // Only known display statuses belong to durable UI, never arbitrary provider metadata.
            if (presentation && ['finalizing', 'finishing'].includes(String(event.metadata?.kind))) {
              presentation.entry({ seq: 0, at: this.deps.now().toISOString(), kind: 'progress', origin,
                text: clipToolText(event.text), workItemId: item.id });
              publishPresentation();
            }
            emitDelta({ kind: 'progress', origin, text: event.text, workItemId: item.id }, 0);
          }
          break;
        }
        default:
          break;
      }
    };
    const extra = this.deps.prepareSend ? await this.deps.prepareSend(item, sessionId) : {};
    if (controller.signal.aborted) return { kind: 'cancelled' };
    let outcome;
    try {
      outcome = await client.streamMessage(sessionId, { message: item.prompt, ...extra }, onEvent, controller.signal);
    } catch (error) {
      presentation?.seal(controller.signal.aborted ? 'cancelled' : 'failed');
      publishPresentation();
      throw error;
    }
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
        const terminalSeq = (this.deps.conversations.transcript(conversationId).at(-1)?.seq ?? 0) + 1;
        presentation?.seal('completed', terminalSeq);
        publishPresentation();
        this.deps.conversations.append(conversationId, { kind: 'bot', origin, text, workItemId: item.id });
      } else { presentation?.seal('completed'); publishPresentation(); }
      return { kind: 'completed', text, quiet: false };
    }
    presentation?.seal(controller.signal.aborted ? 'cancelled' : outcome.errorText ? 'failed' : 'interrupted');
    publishPresentation();
    if (controller.signal.aborted) return { kind: 'cancelled' };
    if (outcome.errorText) {
      return { kind: 'failed', reason: outcome.errorText };
    }
    this.deps.log(`turn ${item.id}: stream ended without a result`);
    return { kind: 'interrupted' };
  }
}
