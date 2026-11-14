import type { SessionBinder } from '../conversations/binder.ts';
import type { ConversationStore } from '../conversations/store.ts';
import { isHeartbeatPrompt, parseHeartbeatReply } from '../life/heartbeat.ts';
import { desktopToolInputSummary, desktopToolResultSummary, isDesktopControlToolName } from '../desktopControl/tools.ts';
import { RuntimeHttpError, type RuntimeClient, type RuntimeStreamEvent, type SendMessageRequest } from '../runtime/client.ts';
import { isProviderSessionUnavailable } from '../runtime/providerSession.ts';
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
  /** `reported`: the turn's stream already wrote this failure into the conversation. */
  | { kind: 'failed'; reason: string; retryAfterMs?: number; reported?: boolean }
  | { kind: 'interrupted' }
  | { kind: 'cancelled' }
  | {
    kind: 'retry_later';
    reason: 'runtime_unavailable' | 'session_busy' | 'no_capacity';
    retryAfterMs: number;
  };

/** What a turn that failed before any output tells about its session (SPEC-001 FR-18). */
interface FailureSignal {
  reason: string;
  /** The last typed code any `error` event carried. */
  code: string | null;
  /** Whether any `error` event said the provider session is unavailable. */
  unavailable: boolean;
}

/** `resend`: rebuild and send the turn again; `rebuild_next`: rebuild for the next turn; `fail`: neither. */
type LossDecision = 'resend' | 'rebuild_next' | 'fail';

/**
 * A turn that ended on an error before the provider produced anything: no
 * text, no tool call, no interaction. Only such a turn may be re-sent in a
 * rebuilt session, since nothing of it can have happened yet.
 */
interface SilentFailure {
  kind: 'failed_before_output';
  reason: string;
  decision: LossDecision;
  /** Whether the conversation already shows the failure (never when the turn is sent again). */
  reported: boolean;
}

export interface TurnRetryDelays {
  ownerBusyMs: number;
  backgroundBusyMs: number;
  runtimeUnavailableMs: number;
  noCapacityMs: number;
  maxBusyAttempts: number;
}

export const DEFAULT_TURN_RETRY_DELAYS: TurnRetryDelays = {
  ownerBusyMs: OWNER_BUSY_RETRY_MS,
  backgroundBusyMs: BACKGROUND_BUSY_RETRY_MS,
  runtimeUnavailableMs: RUNTIME_UNAVAILABLE_RETRY_MS,
  noCapacityMs: NO_CAPACITY_RETRY_MS,
  maxBusyAttempts: 8,
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
  accepted?(item: WorkItem): void;
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
  /** Per conversation: the last turn that failed before any output, in which session and with which prompt. */
  private readonly lastSilentFailure = new Map<string, { sessionId: string; reason: string; prompt: string }>();
  /** Per conversation: a rebuild was asked for; the value is the session being replaced. */
  private readonly rebuildRequested = new Map<string, string>();
  /** Per conversation: the session a rebuild produced, until a turn completes in that conversation. */
  private readonly rebuiltSession = new Map<string, string>();

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
      const bound = await this.deps.binder.bind(item.conversationId, { forTurn: true });
      if (!bound.ok) {
        if (bound.noCapacity && item.kind !== 'owner_message') {
          return { kind: 'retry_later', reason: 'no_capacity', retryAfterMs: this.delays.noCapacityMs };
        }
        return { kind: 'failed', reason: bound.reason };
      }
      // Whoever bound it (this turn or the reconcile tick), a session other than the one
      // a rebuild replaced is the rebuilt one.
      const replaced = this.rebuildRequested.get(item.conversationId);
      if (replaced !== undefined && replaced !== bound.sessionId) {
        this.rebuildRequested.delete(item.conversationId);
        this.rebuiltSession.set(item.conversationId, bound.sessionId);
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
      let result: TurnOutcome | SilentFailure;
      const rebuiltAlready = rebuiltAfterExit;
      const decide = (failure: FailureSignal) => this.decideLoss(item, bound.sessionId, failure, rebuiltAlready);
      try {
        result = await runWithSessionGate(bound.sessionId, () =>
          this.stream(client, bound.sessionId, item, controller, decide));
      } catch (error) {
        this.lastSilentFailure.delete(item.conversationId);
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
      if (result.kind !== 'failed_before_output') {
        this.lastSilentFailure.delete(item.conversationId);
        if (result.kind === 'completed'
          && this.deps.conversations.get(item.conversationId)?.attachment.sessionId === bound.sessionId) {
          this.rebuiltSession.delete(item.conversationId);
          this.deps.conversations.setAttachment(item.conversationId, {
            replacementPending: undefined, unavailableReason: undefined,
          });
        }
        return result;
      }
      if (result.decision === 'fail') {
        this.lastSilentFailure.set(item.conversationId, { sessionId: bound.sessionId, reason: result.reason, prompt: item.prompt });
        return { kind: 'failed', reason: result.reason, reported: result.reported };
      }
      this.requestRebuild(item, bound.sessionId, result.reason,
        result.decision === 'rebuild_next' ? 'repeated_provider_failure' : 'provider_session_unavailable');
      if (result.decision === 'rebuild_next') return { kind: 'failed', reason: result.reason, reported: result.reported };
      rebuiltAfterExit = true;
    }
    return { kind: 'failed', reason: 'The session could not be re-established after repeated attempts' };
  }

  /** Called when a conversation is deleted, so nothing about it outlives it. */
  forget(conversationId: string): void {
    this.lastSilentFailure.delete(conversationId);
    this.rebuildRequested.delete(conversationId);
    this.rebuiltSession.delete(conversationId);
  }

  /**
   * SPEC-001 FR-18: what a turn that failed before any output means for its
   * session. Runtime's typed code or a known provider text says the provider
   * session is gone: rebuild and send the turn again. Otherwise the same
   * failure for two different prompts in a row in the same session says the
   * failure is the session's rather than the turn's: rebuild for the next
   * turn, without sending this one again. A session a rebuild produced is
   * never rebuilt again before a turn of the conversation completes, so a
   * failure no rebuild can fix costs one rebuild, not one per turn.
   */
  private decideLoss(item: WorkItem, sessionId: string, failure: FailureSignal, rebuiltAlready: boolean): LossDecision {
    const { conversationId } = item;
    const attachment = this.deps.conversations.get(conversationId)?.attachment;
    if (attachment?.sessionId !== sessionId || attachment.replacementPending
      || rebuiltAlready || this.rebuiltSession.get(conversationId) === sessionId) return 'fail';
    if (failure.unavailable) return 'resend';
    // Runtime classified this failure as something else.
    if (failure.code !== null) return 'fail';
    const previous = this.lastSilentFailure.get(conversationId);
    return previous !== undefined
      && previous.sessionId === sessionId
      && previous.reason === failure.reason
      && previous.prompt !== item.prompt
      ? 'rebuild_next'
      : 'fail';
  }

  /** `failed` makes the next bind tell the owner, hand the transcript on and retire the old session. */
  private requestRebuild(item: WorkItem, sessionId: string, reason: string,
    unavailableReason: 'provider_session_unavailable' | 'repeated_provider_failure' = 'provider_session_unavailable'): void {
    if (this.deps.conversations.get(item.conversationId)?.attachment.sessionId !== sessionId) return;
    this.deps.log(`turn ${item.id}: the provider session behind ${sessionId} cannot be continued; rebuilding from the transcript`);
    this.lastSilentFailure.delete(item.conversationId);
    this.rebuildRequested.set(item.conversationId, sessionId);
    this.deps.conversations.setAttachment(item.conversationId, { state: 'failed', unavailableReason, lastError: reason });
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
    const attachment = this.deps.conversations.get(conversationId)?.attachment;
    if (attachment?.sessionId !== sessionId) return { kind: 'failed', reason: error.message };
    if (isProviderSessionUnavailable(error.message, error.code)) {
      if (!rebuiltAlready && !attachment.replacementPending && this.rebuiltSession.get(conversationId) !== sessionId) {
        this.requestRebuild(item, sessionId, error.message);
        return 'rebuild';
      }
      if (error.code === 'provider_session_unavailable') this.requestRebuild(item, sessionId, error.message);
      return { kind: 'failed', reason: error.message };
    }
    const noWorker = error.status === 404 && /no active worker/iu.test(error.message);
    const closed = error.status === 400 && /closed/iu.test(error.message);
    const exited = error.status === 410 && error.message === 'Worker process has exited';
    const missing = error.status === 404 && error.message === 'Session not found';
    if ((noWorker || closed || exited || missing) && !resumedAlready) {
      this.deps.log(`turn ${item.id}: session ${sessionId} has no worker; resuming`);
      this.deps.conversations.setAttachment(conversationId, { state: 'sleeping' });
      return 'resume';
    }
    if (error.status === 409) {
      // 409 also covers provider-selection and routing conflicts; retrying
      // those as busy can never make progress and hides the actual failure.
      const busy = error.code === 'session_busy' || [
        'Session is busy processing another message',
        'Worker is busy processing another message',
      ].includes(error.message);
      if (!busy) {
        this.deps.log(`turn ${item.id}: runtime rejected HTTP 409${error.code ? ` (${error.code.replace(/[^a-zA-Z0-9_-]/gu, '').slice(0, 80)})` : ''}`);
        return { kind: 'failed', reason: `Runtime rejected the message (HTTP 409${error.code ? `, ${error.code}` : ''}): ${error.message}` };
      }
      const limit = item.kind === 'owner_message' ? this.delays.maxBusyAttempts : 2;
      if (item.attempts >= limit) {
        this.deps.log(`turn ${item.id}: HTTP 409 session_busy; automatic retries stopped after ${item.attempts} attempts`);
        return { kind: 'failed', reason: 'The session is still busy. Automatic retries stopped. Your message is kept here; try again later.' };
      }
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
    decide: (failure: FailureSignal) => LossDecision,
  ): Promise<TurnOutcome | SilentFailure> {
    const { conversationId } = item;
    const origin = originForKind(item.kind);
    const textParts: string[] = [];
    const heartbeat = item.kind === 'heartbeat' || isHeartbeatPrompt(item.prompt);
    // Whether the provider did anything this turn; a turn that did is never re-sent.
    let produced = false;
    // Errors before any output wait: a turn sent again in a rebuilt session leaves them out.
    const pendingErrors: string[] = [];
    // Whether this attempt wrote an error into the conversation, so the failure is not written twice.
    let wroteError = false;
    let unavailable = false;
    let errorCode: string | null = null;
    const presentation = heartbeat
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
    const appendError = (text: string) => {
      wroteError = true;
      const entry = this.deps.conversations.append(conversationId, { kind: 'error', origin, text, workItemId: item.id, isError: true });
      emitDelta(entry, entry.seq);
    };
    const markProduced = () => {
      if (produced) return;
      produced = true;
      for (const text of pendingErrors.splice(0)) appendError(text);
    };
    const onEvent = (event: RuntimeStreamEvent) => {
      if (event.metadata?.kind === 'interaction_requested' || event.metadata?.kind === 'interaction_updated') {
        markProduced();
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
            markProduced();
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
          markProduced();
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
          markProduced();
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
          const text = typeof event.text === 'string' ? event.text : 'runtime error';
          const code = typeof event.code === 'string' ? event.code : null;
          if (code !== null) errorCode = code;
          if (isProviderSessionUnavailable(text, code)) unavailable = true;
          // FR-25: a heartbeat the owner never asked for leaves no message behind, failed or not;
          // the journal keeps the failed work item's error.
          if (heartbeat) {
            this.deps.log(`turn ${item.id}: heartbeat error${code ? ` (${code.replace(/[^a-zA-Z0-9_-]/gu, '').slice(0, 80)})` : ''}`);
            break;
          }
          if (produced) appendError(text);
          else pendingErrors.push(text);
          break;
        }
        case 'content_block': {
          const block = typeof event.block === 'object' && event.block !== null ? (event.block as Record<string, unknown>) : {};
          if (block.kind === 'text' || block.kind === 'tool') markProduced();
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
      outcome = await client.streamMessage(sessionId, { message: item.prompt, ...extra }, onEvent, controller.signal, () => this.deps.accepted?.(item));
    } catch (error) {
      for (const pending of pendingErrors.splice(0)) appendError(pending);
      presentation?.seal(controller.signal.aborted ? 'cancelled' : 'failed', this.deps.now());
      publishPresentation();
      throw error;
    }
    errorCode ??= outcome.errorCode ?? null;
    unavailable ||= isProviderSessionUnavailable(outcome.errorText, outcome.errorCode);
    const failedSilently = !outcome.completed && !controller.signal.aborted && outcome.errorText !== null && !produced;
    const decision = failedSilently ? decide({ reason: outcome.errorText!, code: errorCode, unavailable }) : null;
    if (decision === 'resend') {
      this.deps.log(`turn ${item.id}: ${pendingErrors.length} error(s) before any output are not kept; the turn is sent again`);
      pendingErrors.length = 0;
    } else {
      for (const pending of pendingErrors.splice(0)) appendError(pending);
    }
    const text = textParts.join('').trim();
    if (!outcome.completed && !controller.signal.aborted && unavailable) {
      const attachment = this.deps.conversations.get(conversationId)?.attachment;
      // Known provider text on a fenced replacement may be retried in that same
      // live worker after repair. Runtime's typed terminal evidence may not.
      if (attachment?.sessionId === sessionId
        && (!attachment.replacementPending || errorCode === 'provider_session_unavailable')) this.deps.conversations.setAttachment(conversationId, {
        state: 'failed', unavailableReason: 'provider_session_unavailable',
        lastError: outcome.errorText ?? 'Native session unavailable',
      });
      // The shared tail seals/publishes failures. Partial work is never re-sent;
      // the next bind may replace it once, subject to the persisted fence.
    }
    if (outcome.completed) {
      // SPEC-001 FR-25: a quiet heartbeat leaves no message behind.
      if (heartbeat) {
        const parsed = parseHeartbeatReply(text);
        if (parsed.quiet) return { kind: 'completed', text: '', quiet: true };
        this.deps.conversations.append(conversationId, { kind: 'bot', origin: 'heartbeat', text: parsed.body, workItemId: item.id });
        emitDelta({ kind: 'bot', origin: 'heartbeat', text: parsed.body, workItemId: item.id }, 0);
        return { kind: 'completed', text: parsed.body, quiet: false };
      }
      if (text) {
        const terminalSeq = (this.deps.conversations.transcript(conversationId).at(-1)?.seq ?? 0) + 1;
        presentation?.seal('completed', this.deps.now(), terminalSeq);
        publishPresentation();
        this.deps.conversations.append(conversationId, { kind: 'bot', origin, text, workItemId: item.id });
      } else { presentation?.seal('completed', this.deps.now()); publishPresentation(); }
      return { kind: 'completed', text, quiet: false };
    }
    presentation?.seal(controller.signal.aborted ? 'cancelled' : outcome.errorText ? 'failed' : 'interrupted', this.deps.now());
    publishPresentation();
    if (controller.signal.aborted) return { kind: 'cancelled' };
    if (outcome.errorText) {
      return decision === null
        ? { kind: 'failed', reason: outcome.errorText, reported: wroteError }
        : { kind: 'failed_before_output', reason: outcome.errorText, decision, reported: wroteError };
    }
    this.deps.log(`turn ${item.id}: stream ended without a result`);
    return { kind: 'interrupted' };
  }
}
