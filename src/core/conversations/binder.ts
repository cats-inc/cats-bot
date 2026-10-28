import type { ConversationStore } from './store.ts';
import { buildHandoffPack, composeInstructions } from './handoff.ts';
import type { CreateSessionRequest, RuntimeClient, RuntimeMcpServer } from '../runtime/client.ts';
import type { BotProfile, ConversationRecord, SessionAttachment } from '../types.ts';

/**
 * SPEC-001 FR-11 / FR-27: how a conversation gets a usable runtime session.
 * Shared by the turn runner (before a turn) and the reconcile tick (to keep
 * the home conversation warm).
 */

export type BindResult =
  | { ok: true; sessionId: string; how: 'kept' | 'resumed' | 'created' }
  | { ok: false; reason: string; kind: 'resume_failed' | 'create_failed'; noCapacity: boolean };

export interface SessionBinderDependencies {
  client(): RuntimeClient | null;
  profile(): BotProfile;
  conversations: ConversationStore;
  now(): Date;
  /** The session's MCP servers; `sessionId` is null for a session about to be created. */
  mcpServers?(conversationId: string, sessionId: string | null): RuntimeMcpServer[];
  /** A queued or running work item: its prompt reaches the session as a message, not in the handoff pack. */
  isPendingWorkItem?(workItemId: string): boolean;
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

/** What the owner reads when a conversation moves to a session of a newer revision. */
export function staleNotice(attachment: SessionAttachment, profile: BotProfile): string {
  const { provider, model } = profile.executionTarget;
  const retargeted = attachment.provider !== provider || (attachment.model ?? null) !== (model ?? null);
  const change = retargeted
    ? `The bot now runs on ${provider}${model ? ` (${model})` : ''}`
    : 'The bot\'s instructions or permissions changed';
  return `${change}; this conversation continues in a new session with a handoff of what was said so far.`;
}

export function isNoCapacity(message: string): boolean {
  return /\bmax sessions\b[^.]*\breached\b/iu.test(message);
}

export class SessionBinder {
  private readonly deps: SessionBinderDependencies;
  private readonly inFlight = new Map<string, Promise<BindResult>>();

  constructor(deps: SessionBinderDependencies) {
    this.deps = deps;
  }

  /**
   * Keeps a live attachment, resumes a sleeping one, and otherwise creates a
   * session with the persona and the handoff pack. A call made while another
   * bind of the same conversation runs joins it, so the tick and a turn never
   * create two sessions and overwrite each other's attachment.
   */
  bind(conversationId: string): Promise<BindResult> {
    const pending = this.inFlight.get(conversationId);
    if (pending) return pending;
    const run = this.bindNow(conversationId).finally(() => {
      this.inFlight.delete(conversationId);
    });
    this.inFlight.set(conversationId, run);
    return run;
  }

  private async bindNow(conversationId: string): Promise<BindResult> {
    const client = this.deps.client();
    if (!client) return { ok: false, reason: 'runtime unavailable', kind: 'create_failed', noCapacity: false };
    const conversation = this.deps.conversations.require(conversationId);
    const profile = this.deps.profile();
    const { attachment } = conversation;
    const current = attachmentIsCurrent(conversation, profile);
    const live = attachment.state === 'ready' || attachment.state === 'initializing';
    if (attachment.sessionId && live && current) {
      return { ok: true, sessionId: attachment.sessionId, how: 'kept' };
    }
    if (attachment.sessionId && !current && attachment.state !== 'stale' && attachment.state !== 'none') {
      this.deps.log(`conversation ${conversation.id}: attachment is stale after a configuration change`);
      this.deps.conversations.setAttachment(conversation.id, { state: 'stale' });
      this.deps.conversations.append(conversation.id, {
        kind: 'system',
        origin: 'system',
        text: staleNotice(attachment, profile),
      });
    } else if (attachment.sessionId && attachment.state === 'sleeping' && current) {
      try {
        const view = await client.resumeSession(attachment.sessionId, {
          ...await client.sessionControls(profile.executionTarget.provider, profile.providerPolicy),
          ...(this.deps.mcpServers ? { mcpServers: this.deps.mcpServers(conversation.id, attachment.sessionId) } : {}),
        });
        this.deps.conversations.setAttachment(conversation.id, {
          state: view.status === 'ready' ? 'ready' : 'initializing',
          ...(view.providerSessionId ? { providerSessionId: view.providerSessionId } : {}),
        });
        this.deps.log(`conversation ${conversation.id}: resumed session ${attachment.sessionId}`);
        return { ok: true, sessionId: attachment.sessionId, how: 'resumed' };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.deps.log(`conversation ${conversation.id}: resume of ${attachment.sessionId} failed`);
        this.deps.conversations.setAttachment(conversation.id, { state: 'failed', lastError: reason });
        this.deps.conversations.append(conversation.id, {
          kind: 'error',
          origin: 'system',
          text: `Could not resume the previous session: ${reason}`,
        });
        return { ok: false, reason: `resume failed: ${reason}`, kind: 'resume_failed', noCapacity: isNoCapacity(reason) };
      }
    } else if (attachment.state === 'failed' && attachment.sessionId) {
      this.deps.conversations.append(conversation.id, {
        kind: 'system',
        origin: 'system',
        text: 'The previous session could not be continued; a new session starts with a handoff of what was said so far.',
      });
    }
    return this.create(client, this.deps.conversations.require(conversation.id), profile);
  }

  private async create(
    client: RuntimeClient,
    conversation: ConversationRecord,
    profile: BotProfile,
  ): Promise<BindResult> {
    const isPending = this.deps.isPendingWorkItem;
    const pack = buildHandoffPack(
      this.deps.conversations.transcript(conversation.id)
        .filter((entry) => !(isPending && entry.kind === 'owner' && entry.workItemId && isPending(entry.workItemId))),
    );
    const request: CreateSessionRequest = {
      provider: profile.executionTarget.provider,
      ...(profile.executionTarget.model ? { model: profile.executionTarget.model } : {}),
      cwd: profile.permissions.cwd,
      workspaceKind: 'source',
      workspaceAccess: profile.permissions.workspaceAccess,
      ...(!profile.providerPolicy ? { permissionMode: profile.permissions.permissionMode } : {}),
      ...(!profile.providerPolicy && profile.permissions.allowedTools ? { allowedTools: profile.permissions.allowedTools } : {}),
      instructions: composeInstructions(profile.instructions, pack),
      ...(this.deps.mcpServers ? { mcpServers: this.deps.mcpServers(conversation.id, null) } : {}),
    };
    const replaced = conversation.attachment.sessionId;
    try {
      Object.assign(request, await client.sessionControls(profile.executionTarget.provider, profile.providerPolicy));
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
          record.checkpoint = { digest: pack.text, throughSeq: pack.throughSeq, updatedAt: this.deps.now().toISOString() };
        });
      }
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
