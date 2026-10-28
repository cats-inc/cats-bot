import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeClient, RuntimeStreamEvent } from '../runtime/client.ts';
import { writeJsonAtomic } from '../store/atomicFile.ts';
import { INTERACTION_KINDS, type BotInteraction, type BotInteractionResponse, type BotInteractionSnapshot,
  type WorkItem } from '../types.ts';

const live = (i: BotInteraction) => i.status === 'pending' || i.status === 'responding';
const receipt = (i: BotInteraction): BotInteraction => {
  return { botId: i.botId, conversationId: i.conversationId, workItemId: i.workItemId,
    interactionId: i.interactionId, sessionId: i.sessionId, workerGeneration: i.workerGeneration,
    executionId: i.executionId, revision: i.revision, createdAt: i.createdAt, expiresAt: i.expiresAt,
    status: i.status, kind: i.kind, ...(i.reason ? { reason: i.reason } : {}),
    ...(i.decision ? { decision: i.decision } : {}), ...(i.providerConfirmed !== undefined ? { providerConfirmed: i.providerConfirmed } : {}) };
};

function readReceipts(file: string, botId: string): BotInteraction[] | null {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('Interaction receipt store exceeds its limit.');
  const data = JSON.parse(text) as { version?: number; receipts?: BotInteraction[] };
  const keys = ['botId', 'conversationId', 'workItemId', 'interactionId', 'sessionId', 'workerGeneration', 'executionId',
    'revision', 'createdAt', 'expiresAt', 'status', 'kind', 'reason', 'decision', 'providerConfirmed'];
  if (data?.version !== 1 || Object.keys(data).some(k => !['version', 'receipts'].includes(k))
    || !Array.isArray(data.receipts) || data.receipts.length > 256 || data.receipts.some(i => !i || i.botId !== botId
      || Object.keys(i).some(k => !keys.includes(k)) || keys.slice(0, 7).some(k => typeof (i as unknown as Record<string, unknown>)[k] !== 'string')
      || !Number.isSafeInteger(i.revision) || i.revision < 1 || !Number.isFinite(Date.parse(i.createdAt)) || !Number.isFinite(Date.parse(i.expiresAt))
      || !['pending', 'responding', 'resolved', 'expired', 'cancelled', 'interrupted', 'unsupported'].includes(i.status)
      || !INTERACTION_KINDS.includes(i.kind))) {
    throw new Error('Unsupported provider interaction receipt store; original data was preserved.');
  }
  return data.receipts;
}

/** Redacted durable receipts plus in-memory live prompts. No callback or answer is persisted. */
export class BotInteractions {
  private readonly file: string;
  private readonly entries = new Map<string, BotInteraction>();
  private readonly contexts = new Map<string, { item: WorkItem; client: RuntimeClient; executionId?: string; generation?: string; dirty?: boolean }>();
  private readonly refreshes = new Map<string, Promise<BotInteractionSnapshot>>();
  private readonly botId: string;
  private readonly changed: (conversationId: string, pending: number, notify?: boolean) => void;

  constructor(root: string, botId: string, changed: (conversationId: string, pending: number, notify?: boolean) => void) {
    this.file = join(root, 'provider-interactions.json');
    this.botId = botId;
    this.changed = changed;
    // Inspect backup even when primary is valid: a future writer may have replaced
    // its backup before crashing, so an older reader must not destroy that evidence.
    const backup = readReceipts(`${this.file}.bak`, botId);
    if (existsSync(this.file) || backup) {
      let receipts: BotInteraction[] | null;
      try { receipts = readReceipts(this.file, botId) ?? backup; }
      catch (error) {
        if (!(error instanceof SyntaxError) || !backup) throw error;
        receipts = backup;
      }
      for (const i of receipts ?? []) this.entries.set(i.interactionId, live(i)
        ? { ...i, status: 'interrupted', reason: 'bot_core_restarted' } : i);
    }
  }

  track(item: WorkItem, client: RuntimeClient): void {
    if (!item.run) return;
    this.contexts.set(item.conversationId, { item, client });
  }

  notice(item: WorkItem, event: RuntimeStreamEvent): void {
    const context = this.contexts.get(item.conversationId);
    const i = event.metadata?.interaction as BotInteraction | undefined;
    if (context?.item.id !== item.id || !i || i.sessionId !== item.run?.sessionId
      || typeof i.executionId !== 'string' || typeof i.workerGeneration !== 'string') return;
    if (context.executionId && (context.executionId !== i.executionId || context.generation !== i.workerGeneration)) return;
    context.executionId = i.executionId;
    context.generation = i.workerGeneration;
    context.dirty = true;
    void this.snapshot(item.conversationId).catch(() => this.changed(item.conversationId, this.pending(item.conversationId)));
  }

  private save(): void {
    // Keep active prompts in memory; retain only the newest bounded receipts on disk.
    while (this.entries.size > 256) {
      const candidate = [...this.entries].find(([, i]) => !live(i));
      if (!candidate) break;
      this.entries.delete(candidate[0]);
    }
    const value = { version: 1, receipts: [...this.entries.values()].map(receipt) };
    // Backup and primary use the same validated, redacted schema. Failed replacement
    // leaves the previous primary readable; future-schema data is never overwritten.
    writeJsonAtomic(`${this.file}.bak`, value);
    writeJsonAtomic(this.file, value);
  }

  pending(conversationId?: string): number {
    return [...this.entries.values()].filter(i => live(i) && (!conversationId || i.conversationId === conversationId)).length;
  }

  async snapshot(conversationId: string): Promise<BotInteractionSnapshot> {
    const pending = this.refreshes.get(conversationId);
    if (pending) return pending;
    const promise = (async () => {
      let result: BotInteractionSnapshot;
      do {
        const current = this.contexts.get(conversationId);
        if (current) current.dirty = false;
        result = await this.refresh(conversationId);
      } while (this.contexts.get(conversationId)?.dirty);
      return result;
    })().finally(() => {
      this.refreshes.delete(conversationId);
      // A notice may arrive in the microtask gap after the final loop test.
      if (this.contexts.get(conversationId)?.dirty) void this.snapshot(conversationId).catch(() => {});
    });
    this.refreshes.set(conversationId, promise);
    return promise;
  }

  private async refresh(conversationId: string): Promise<BotInteractionSnapshot> {
    const context = this.contexts.get(conversationId);
    let reason: string | undefined;
    if (context?.executionId) {
      try {
        const snapshot = await context.client.interactions(context.item.run!.sessionId);
        if (this.contexts.get(conversationId) !== context) return this.view(conversationId, 'execution_ended');
        if (snapshot.version !== 1 || snapshot.workerGeneration !== context.generation || !Array.isArray(snapshot.interactions)) {
          this.end(context.item.id, 'worker_changed');
          return this.view(conversationId, 'worker_changed');
        }
        let changed = false;
        let notify = false;
        for (const i of snapshot.interactions) {
          if (i.executionId !== context.executionId || i.workerGeneration !== context.generation
            || i.sessionId !== context.item.run!.sessionId) continue;
          const previous = this.entries.get(i.interactionId);
          if (previous && previous.revision >= i.revision) continue;
          if (!previous && i.status === 'pending') notify = true;
          this.entries.set(i.interactionId, { ...i, botId: this.botId, conversationId, workItemId: context.item.id });
          changed = true;
        }
        if (changed) {
          this.save();
          this.changed(conversationId, this.pending(conversationId), notify);
        }
      } catch { reason = 'runtime_unavailable'; }
    }
    return this.view(conversationId, reason);
  }

  private view(conversationId: string, reason?: string): BotInteractionSnapshot {
    return { version: 1, supported: !reason, ...(reason ? { reason } : {}),
      interactions: structuredClone([...this.entries.values()].filter(i => i.conversationId === conversationId)) };
  }

  async respond(conversationId: string, id: string, body: BotInteractionResponse): Promise<void> {
    const context = this.contexts.get(conversationId);
    if (!context || !body || context.item.id !== body.workItemId || context.executionId !== body.executionId
      || context.generation !== body.workerGeneration) throw new Error('Provider request is stale or belongs to another conversation.');
    const current = (await this.snapshot(conversationId)).interactions.find(i => i.interactionId === id);
    if (this.contexts.get(conversationId) !== context || !current || current.workItemId !== body.workItemId) {
      throw new Error('Provider request is no longer active.');
    }
    // Runtime owns strict answer validation, revision checking and duplicate delivery.
    const response = await context.client.respondInteraction(current.sessionId, id, {
      expectedRevision: body.expectedRevision, idempotencyKey: body.idempotencyKey, answer: body.answer,
    });
    if (this.contexts.get(conversationId) === context) {
      this.entries.set(id, { ...response, botId: this.botId, conversationId, workItemId: context.item.id });
      this.save();
      this.changed(conversationId, this.pending(conversationId));
    }
  }

  end(workItemId: string, reason = 'execution_ended'): void {
    for (const [id, context] of this.contexts) if (context.item.id === workItemId) this.contexts.delete(id);
    const conversations = new Set<string>();
    for (const [id, i] of this.entries) if (i.workItemId === workItemId && live(i)) {
      this.entries.set(id, { ...receipt(i), status: 'interrupted', reason });
      conversations.add(i.conversationId);
    }
    if (conversations.size) this.save();
    for (const id of conversations) this.changed(id, this.pending(id));
  }
}
