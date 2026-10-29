import { randomUUID } from 'node:crypto';
import type { ConversationBlock } from '@cats-inc/platform-ui-web/contracts';
import type { ConversationStore } from '../conversations/store.ts';
import type { MessageOrigin, TranscriptEntry, WorkItem } from '../types.ts';

/** Raw Runtime events are the canonical input. Derived content_block snapshots are not appended twice. */
export class ResponsePresentation {
  private readonly store: ConversationStore;
  private readonly conversationId: string;
  private readonly response: TranscriptEntry;
  private readonly openTools = new Map<string, ConversationBlock>();
  private pending: TranscriptEntry | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastSavedAt = 0;
  private saveError: unknown;
  private textBoundary = false;
  constructor(store: ConversationStore, item: WorkItem, origin: MessageOrigin, at: Date) {
    this.store = store;
    this.conversationId = item.conversationId;
    this.response = {
      seq: (store.transcript(item.conversationId).at(-1)?.seq ?? 0) + 1,
      at: at.toISOString(), kind: 'bot', text: '', origin, workItemId: item.id,
      presentation: { version: 1, id: `${item.id}:${randomUUID()}`, phase: 'streaming', blocks: [] },
      presentationRevision: 0, presentationSeqs: [],
    };
  }
  private block(kind: ConversationBlock['kind'], text: string): ConversationBlock {
    const data = this.response.presentation!;
    const block: ConversationBlock = { id: `${data.id}:${data.blocks.length}`, index: data.blocks.length,
      kind, text, status: 'streaming', title: null, toolName: null, toolId: null };
    data.blocks.push(block);
    return block;
  }
  text(value: string): void {
    const last = this.response.presentation!.blocks.at(-1);
    if (last?.kind === 'text' && !this.textBoundary) last.text += value;
    else this.block('text', value);
    this.textBoundary = false;
    this.response.text += value;
  }
  entry(entry: TranscriptEntry): void {
    this.textBoundary = true;
    if (entry.seq > 0) this.response.presentationSeqs!.push(entry.seq);
    const last = this.response.presentation!.blocks.at(-1);
    if (last?.kind === 'text') last.status = 'complete';
    if (entry.kind === 'tool_use') {
      const block = this.block('tool', entry.text);
      block.toolName = entry.toolName ?? null;
      block.toolId = entry.toolId ?? null;
      block.input = entry.text;
      block.result = null;
      if (entry.toolId) this.openTools.set(entry.toolId, block);
    } else if (entry.kind === 'tool_result') {
      const block = (entry.toolId ? this.openTools.get(entry.toolId) : undefined) ?? this.block('tool', entry.text);
      block.toolName ??= entry.toolName ?? null;
      block.toolId ??= entry.toolId ?? null;
      block.result = entry.text;
      block.text = entry.text;
      block.status = entry.isError ? 'error' : 'complete';
      if (entry.toolId) this.openTools.delete(entry.toolId);
    } else if (entry.kind === 'progress' || entry.kind === 'error') {
      const block = this.block('status', entry.text);
      block.status = entry.isError ? 'error' : 'complete';
    }
  }
  seal(state: 'completed' | 'cancelled' | 'failed' | 'interrupted', terminalSeq?: number): void {
    this.response.text = this.response.text.trim();
    this.response.presentation!.phase = 'sealed';
    for (const block of this.response.presentation!.blocks) {
      if (block.status === 'streaming') block.status = state === 'completed' ? 'complete' : 'error';
    }
    if (terminalSeq !== undefined) this.response.presentationTerminalSeq = terminalSeq;
  }
  checkpoint(): TranscriptEntry | null {
    if (!this.response.presentation!.blocks.length) return null;
    this.response.presentationRevision! += 1;
    const snapshot = structuredClone(this.response);
    if (this.saveError) throw this.saveError;
    this.pending = snapshot;
    if (snapshot.presentation!.phase === 'sealed' || Date.now() - this.lastSavedAt >= 100) {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      this.save();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        try { this.save(); } catch (error) { this.saveError = error; }
      }, 100);
    }
    return snapshot;
  }
  private save(): void {
    if (!this.pending) return;
    this.store.savePresentation(this.conversationId, this.pending);
    this.pending = null;
    this.lastSavedAt = Date.now();
  }
}
