import type { ConversationStore } from './store.ts';
import { buildHandoffPack, composeInstructions } from './handoff.ts';
import { effectiveReplyLanguage } from '../profile/profile.ts';
import { replyLanguageInstruction } from '../../shared/language.ts';
import { RuntimeHttpError, type CreateSessionRequest, type RuntimeClient, type RuntimeMcpServer } from '../runtime/client.ts';
import { isProviderSessionUnavailable, REBUILT_SESSION_NOTICE } from '../runtime/providerSession.ts';
import type { BotProfile, ConversationRecord, SessionAttachment, TranscriptEntry } from '../types.ts';

/**
 * SPEC-001 FR-11 / FR-27: how a conversation gets a usable runtime session.
 * Shared by the turn runner (before a turn) and the reconcile tick (to keep
 * the home conversation warm).
 */

export type BindResult =
  | { ok: true; sessionId: string; how: 'kept' | 'resumed' | 'created' }
  | { ok: false; reason: string; kind: 'resume_failed' | 'create_failed'; noCapacity: boolean };

interface BindIntent {
  /** A work item will send a prompt immediately after binding. */
  forTurn: boolean;
}

export interface SessionBinderDependencies {
  client(): RuntimeClient | null;
  profile(): BotProfile;
  conversations: ConversationStore;
  now(): Date;
  /** The session's MCP servers; `sessionId` is null for a session about to be created. */
  mcpServers?(conversationId: string, sessionId: string | null): RuntimeMcpServer[];
  /** Remember the exact overlay used to create a session before its first send. */
  sessionCreated?(sessionId: string, servers: RuntimeMcpServer[]): void;
  /** A queued or running work item: its prompt reaches the session as a message, not in the handoff pack. */
  isPendingWorkItem?(workItemId: string): boolean;
  /** Durable journal evidence, recorded before a prompt is sent; absent means unknown. */
  hasAttemptedSessionTurn?(sessionId: string): boolean;
  /** Closes a replaced session once no turn runs in it (FR-27); without it the old worker is left alone. */
  retireSession?(sessionId: string): void;
  log(line: string): void;
}

/** FR-27: a session is reused only when it was created under the profile's current revision. */
export function attachmentIsCurrent(conversation: ConversationRecord, profile: BotProfile): boolean {
  const { attachment } = conversation;
  return (
    attachment.provider === profile.executionTarget.provider
    && (attachment.model ?? null) === (profile.executionTarget.model ?? null)
    && attachment.configRevision === profile.configRevision
  );
}

/**
 * What the owner reads when a conversation moves to a session of a newer
 * revision; `replyLanguageOnly` says the reply language was all that changed.
 */
export function staleNotice(attachment: SessionAttachment, profile: BotProfile, replyLanguageOnly = false): string {
  const { provider, model } = profile.executionTarget;
  const retargeted = attachment.provider !== provider || (attachment.model ?? null) !== (model ?? null);
  const change = retargeted
    ? `The bot now runs on ${provider}${model ? ` (${model})` : ''}`
    : replyLanguageOnly
      ? 'The bot\'s reply language changed'
      : 'The bot\'s instructions or permissions changed';
  return `${change}; this conversation continues in a new session with a handoff of what was said so far.`;
}

export function isNoCapacity(message: string): boolean {
  return /\bmax sessions\b[^.]*\breached\b/iu.test(message);
}

function sessionLabel(conversation: ConversationRecord, profile: BotProfile): string {
  return Array.from(`Cats Bot · ${profile.name} · ${conversation.title}`
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')).slice(0, 160).join('');
}

/**
 * SPEC-012 FR-8: what a contact note's new session is handed, by allow-list:
 * the other bot's messages, and this bot's replies to those messages and to
 * the owner's decisions. Anything the owner wrote there before the note became
 * a contact note is left out, and so is whatever could echo it: replies to the
 * owner's messages or reminders, reminder receipts and recovery notices.
 */
function inContactHandoff(entry: TranscriptEntry): boolean {
  if (entry.kind === 'owner') return entry.origin === 'bot';
  if (entry.kind === 'bot') return entry.origin === 'event';
  return false;
}

export class SessionBinder {
  private readonly deps: SessionBinderDependencies;
  private readonly inFlight = new Map<string, { intent: BindIntent; result: Promise<BindResult> }>();

  constructor(deps: SessionBinderDependencies) {
    this.deps = deps;
  }

  /**
   * Keeps a live attachment, inspects/resumes a saved compatible one, and otherwise creates a
   * session with the persona and the handoff pack. A call made while another
   * bind of the same conversation runs joins it, so the tick and a turn never
   * create two sessions and overwrite each other's attachment.
   */
  bind(conversationId: string, options: { forTurn?: boolean } = {}): Promise<BindResult> {
    const pending = this.inFlight.get(conversationId);
    if (pending) {
      pending.intent.forTurn ||= options.forTurn === true;
      return pending.result;
    }
    const intent: BindIntent = { forTurn: options.forTurn === true };
    const run = this.bindNow(conversationId, intent).finally(() => {
      this.inFlight.delete(conversationId);
    });
    this.inFlight.set(conversationId, { intent, result: run });
    return run;
  }

  private async bindNow(conversationId: string, intent: BindIntent): Promise<BindResult> {
    const client = this.deps.client();
    if (!client) return { ok: false, reason: 'runtime unavailable', kind: 'create_failed', noCapacity: false };
    const conversation = this.deps.conversations.require(conversationId);
    const profile = this.deps.profile();
    const { attachment } = conversation;
    const current = attachmentIsCurrent(conversation, profile);
    if (current && attachment.sessionId && attachment.unavailableReason) {
      return this.replaceUnavailable(client, conversation, profile, attachment.unavailableReason);
    }
    const live = attachment.state === 'ready' || attachment.state === 'initializing';
    if (attachment.sessionId && live && current) {
      return { ok: true, sessionId: attachment.sessionId, how: 'kept' };
    }
    if (
      attachment.sessionId &&
      !current &&
      attachment.state !== 'stale' &&
      attachment.state !== 'none'
    ) {
      this.deps.log(`conversation ${conversation.id}: attachment is stale after a configuration change`);
      this.deps.conversations.setAttachment(conversation.id, { state: 'stale' });
      this.deps.conversations.append(conversation.id, {
        kind: 'system',
        origin: 'system',
        text: staleNotice(attachment, profile),
      });
    } else if (attachment.sessionId && current && ['sleeping', 'closed', 'failed'].includes(attachment.state)) {
      return this.resumeSaved(client, conversation, profile, intent);
    }
    return this.create(client, this.deps.conversations.require(conversation.id), profile);
  }

  private async resumeSaved(client: RuntimeClient, conversation: ConversationRecord, profile: BotProfile, intent: BindIntent): Promise<BindResult> {
    const { attachment } = conversation;
    const id = attachment.sessionId!;
    const unchanged = () => this.deps.conversations.get(conversation.id)?.attachment.sessionId === id
      && this.deps.profile().configRevision === profile.configRevision;
    try {
      const observed = await client.getSession(id);
      if (!unchanged()) throw new Error('Conversation binding changed during resume.');
      if (observed.id !== id || observed.providerName && observed.providerName !== attachment.provider
        || observed.providerSessionId && attachment.providerSessionId
          && observed.providerSessionId !== attachment.providerSessionId) {
        throw new Error('Saved Runtime session identity no longer matches this conversation.');
      }
      if (observed.providerSessionUnavailable) {
        return this.replaceUnavailable(client, conversation, profile, 'provider_session_unavailable');
      }
      if (observed.status === 'closing') throw new Error('Previous session worker is still closing.');
      if (['ready', 'initializing', 'busy'].includes(observed.status)) {
        this.deps.conversations.setAttachment(conversation.id, {
          state: observed.status === 'initializing' ? 'initializing' : 'ready',
        });
        return { ok: true, sessionId: id, how: 'kept' };
      }
      // A warm CLI worker can stop before its first turn creates a native
      // session. messageCount counts completed messages, so also require the
      // absence of durable attempted-turn evidence. Auth/policy/bootstrap
      // failures must retain their mapping even before native ID adoption.
      if (observed.status === 'closed' && observed.origin === 'runtime'
        && observed.providerBackend === 'cli' && observed.messageCount === 0
        && !observed.providerSessionId && !attachment.providerSessionId
        && !observed.sourcePath && !observed.providerSourcePath
        && !observed.inspection?.currentRun && !observed.inspection?.lastRun
        && this.deps.hasAttemptedSessionTurn?.(id) === false) {
        // An unused replacement may itself have been stopped by shutdown or
        // sleep. Only a pending turn can replace it again; reconcile must not
        // create a fresh idle worker on every tick. The complete evidence above
        // excludes failed sends/bootstrap and unknown or lost session records.
        return this.replaceUnavailable(client, conversation, profile, 'provider_session_unavailable', intent.forTurn);
      }
      const controls = await client.sessionControls(profile.executionTarget.provider, profile.providerPolicy);
      const servers = this.deps.mcpServers?.(conversation.id, id);
      const view = await client.resumeSession(id, { ...controls, sessionLabel: sessionLabel(conversation, profile),
        ...(servers ? { mcpServers: servers } : {}) });
      if (!unchanged()) throw new Error('Conversation binding changed during resume.');
      if (view.id !== id || view.providerSessionId && attachment.providerSessionId
        && view.providerSessionId !== attachment.providerSessionId) throw new Error('Resume changed native session identity.');
      this.deps.conversations.setAttachment(conversation.id, {
        state: view.status === 'ready' ? 'ready' : 'initializing',
        ...(view.providerSessionId ? { providerSessionId: view.providerSessionId } : {}),
      });
      if (servers) this.deps.sessionCreated?.(id, servers);
      this.deps.log(`conversation ${conversation.id}: resumed session ${id}`);
      return { ok: true, sessionId: id, how: 'resumed' };
    } catch (error) {
      if (!unchanged()) return { ok: false, reason: 'Conversation binding changed during resume.', kind: 'resume_failed', noCapacity: false };
      if (error instanceof RuntimeHttpError && isProviderSessionUnavailable(error.message, error.code)) {
        return this.replaceUnavailable(client, conversation, profile, 'provider_session_unavailable');
      }
      if (error instanceof RuntimeHttpError && error.status === 404 && error.message === 'Session not found') {
        return this.replaceUnavailable(client, conversation, profile, 'runtime_session_missing');
      }
      const reason = error instanceof Error ? error.message : String(error);
      this.deps.log(`conversation ${conversation.id}: resume of ${id} failed`);
      this.deps.conversations.setAttachment(conversation.id, { state: 'failed', lastError: reason });
      if (attachment.lastError !== reason) this.deps.conversations.append(conversation.id, {
        kind: 'error', origin: 'system', text: `Could not resume the previous session: ${reason}`,
      });
      return { ok: false, reason: `resume failed: ${reason}`, kind: 'resume_failed', noCapacity: isNoCapacity(reason) };
    }
  }

  private replaceUnavailable(client: RuntimeClient, conversation: ConversationRecord, profile: BotProfile,
    reason: NonNullable<SessionAttachment['unavailableReason']>, unstartedTurn = false): Promise<BindResult> {
    if (conversation.attachment.replacementPending && !unstartedTurn) {
      return Promise.resolve({ ok: false, kind: 'resume_failed', noCapacity: false,
        reason: 'Automatic session replacement stopped because the previous replacement has not completed a turn.' });
    }
    this.deps.conversations.setAttachment(conversation.id, {
      state: 'failed', unavailableReason: reason, replacementPending: true,
    });
    return this.create(client, this.deps.conversations.require(conversation.id), profile, true);
  }

  private async create(
    client: RuntimeClient,
    conversation: ConversationRecord,
    profile: BotProfile,
    replacementPending = false,
  ): Promise<BindResult> {
    const isPending = this.deps.isPendingWorkItem;
    const pack = buildHandoffPack(
      this.deps.conversations.transcript(conversation.id)
        .filter((entry) => !(isPending && entry.kind === 'owner' && entry.workItemId && isPending(entry.workItemId)))
        .filter((entry) => !conversation.contactOf || inContactHandoff(entry)),
    );
    const request: CreateSessionRequest = {
      provider: profile.executionTarget.provider,
      sessionLabel: sessionLabel(conversation, profile),
      ...(profile.executionTarget.model ? { model: profile.executionTarget.model } : {}),
      cwd: profile.permissions.cwd,
      workspaceKind: 'source',
      workspaceAccess: profile.permissions.workspaceAccess,
      ...(!profile.providerPolicy ? { permissionMode: profile.permissions.permissionMode } : {}),
      ...(!profile.providerPolicy && profile.permissions.allowedTools ? { allowedTools: profile.permissions.allowedTools } : {}),
      instructions: composeInstructions(
        profile.instructions,
        pack,
        replyLanguageInstruction(effectiveReplyLanguage(profile)),
      ),
      ...(this.deps.mcpServers ? { mcpServers: this.deps.mcpServers(conversation.id, null) } : {}),
    };
    const replaced = conversation.attachment.sessionId;
    try {
      if (profile.executionTarget.modelSelection)
        request.modelSelection = await client.currentModelSelection(
          profile.executionTarget.provider,
          profile.executionTarget.modelSelection,
        );
      Object.assign(request, await client.sessionControls(profile.executionTarget.provider, profile.providerPolicy));
      const view = await client.createSession(request);
      this.deps.conversations.setAttachment(conversation.id, {
        state: view.status === 'ready' ? 'ready' : 'initializing',
        sessionId: view.id,
        providerSessionId: view.providerSessionId ?? null,
        provider: profile.executionTarget.provider,
        model: profile.executionTarget.model,
        configRevision: profile.configRevision,
        unavailableReason: undefined,
        replacementPending: replacementPending || undefined,
      });
      this.deps.sessionCreated?.(view.id, request.mcpServers ?? []);
      if (pack.text) {
        this.deps.conversations.update(conversation.id, (record) => {
          record.checkpoint = { digest: pack.text, throughSeq: pack.throughSeq, updatedAt: this.deps.now().toISOString() };
        });
      }
      if (replacementPending) this.deps.conversations.append(conversation.id, {
        kind: 'system', origin: 'system', text: REBUILT_SESSION_NOTICE,
      });
      this.deps.log(`conversation ${conversation.id}: created session ${view.id} (${view.status})`);
      // FR-27: nothing else would ever close the replaced session's worker.
      if (replaced && replaced !== view.id) this.deps.retireSession?.(replaced);
      return { ok: true, sessionId: view.id, how: 'created' };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.deps.log(`conversation ${conversation.id}: session create failed`);
      this.deps.conversations.setAttachment(conversation.id, { lastError: reason });
      return { ok: false, reason: `session create failed: ${reason}`, kind: 'create_failed', noCapacity: isNoCapacity(reason) };
    }
  }
}
