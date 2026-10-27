import type { ConversationStore } from './store.ts';
import { buildHandoffPack, composeInstructions } from './handoff.ts';
import type { CreateSessionRequest, RuntimeClient, RuntimeMcpServer } from '../runtime/client.ts';
import type { BotProfile, ConversationRecord } from '../types.ts';

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
  mcpServers?(conversationId: string): RuntimeMcpServer[];
  log(line: string): void;
}

export function attachmentMatchesTarget(conversation: ConversationRecord, profile: BotProfile): boolean {
  const { attachment } = conversation;
  return (
    attachment.provider === profile.executionTarget.provider
    && (attachment.model ?? null) === (profile.executionTarget.model ?? null)
  );
}

export function isNoCapacity(message: string): boolean {
  return /\bmax sessions\b[^.]*\breached\b/iu.test(message);
}

export class SessionBinder {
  private readonly deps: SessionBinderDependencies;

  constructor(deps: SessionBinderDependencies) {
    this.deps = deps;
  }

  /**
   * Keeps a live attachment, resumes a sleeping one, and otherwise creates a
   * session with the persona and the handoff pack. `excludeWorkItemId` keeps
   * the prompt of the turn being bound out of the pack.
   */
  async bind(conversationId: string, excludeWorkItemId?: string): Promise<BindResult> {
    const client = this.deps.client();
    if (!client) return { ok: false, reason: 'runtime unavailable', kind: 'create_failed', noCapacity: false };
    const conversation = this.deps.conversations.require(conversationId);
    const profile = this.deps.profile();
    const { attachment } = conversation;
    const targetMatches = attachmentMatchesTarget(conversation, profile);
    const live = attachment.state === 'ready' || attachment.state === 'initializing';
    if (attachment.sessionId && live && targetMatches) {
      return { ok: true, sessionId: attachment.sessionId, how: 'kept' };
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
          ...(this.deps.mcpServers ? { mcpServers: this.deps.mcpServers(conversation.id) } : {}),
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
    return this.create(client, this.deps.conversations.require(conversation.id), profile, excludeWorkItemId);
  }

  private async create(
    client: RuntimeClient,
    conversation: ConversationRecord,
    profile: BotProfile,
    excludeWorkItemId?: string,
  ): Promise<BindResult> {
    const pack = buildHandoffPack(
      this.deps.conversations.transcript(conversation.id)
        .filter((entry) => excludeWorkItemId === undefined || entry.workItemId !== excludeWorkItemId),
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
      ...(this.deps.mcpServers ? { mcpServers: this.deps.mcpServers(conversation.id) } : {}),
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
          record.checkpoint = { digest: pack.text, throughSeq: pack.throughSeq, updatedAt: this.deps.now().toISOString() };
        });
      }
      this.deps.log(`conversation ${conversation.id}: created session ${view.id} (${view.status})`);
      return { ok: true, sessionId: view.id, how: 'created' };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.deps.log(`conversation ${conversation.id}: session create failed`);
      this.deps.conversations.setAttachment(conversation.id, { lastError: reason });
      return { ok: false, reason: `session create failed: ${reason}`, kind: 'create_failed', noCapacity: isNoCapacity(reason) };
    }
  }
}
