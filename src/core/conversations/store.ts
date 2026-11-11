import { randomUUID } from 'node:crypto';

import { isValidBotId } from '../store/paths.ts';
import { checkedResponse, projectPresentationTranscript } from '../store/presentation.ts';
import { responseCovers } from '../store/stateSchema.ts';
import type { BotStateStore, EntriesPage } from '../store/stateStore.ts';
import type {
  AttachmentState,
  ConversationRecord,
  ConversationRole,
  SessionAttachment,
  TranscriptEntry,
  TranscriptPage,
} from '../types.ts';

/**
 * SPEC-001 FR-9, FR-10, FR-12 and SPEC-014: conversation records, their transcripts and
 * their reply presentations in the bot's state database. Every mutation goes through
 * `update`, so the stored record is always the rendering of the one in memory.
 */

/** SPEC-014 FR-10: entries in a page of the note when the reader names no number. */
export const TRANSCRIPT_PAGE_DEFAULT = 100;
/** SPEC-014 FR-10: the most entries a page holds. */
export const TRANSCRIPT_PAGE_MAX = 500;
/** SPEC-014 FR-10: a page above this size is read again with fewer entries. */
export const TRANSCRIPT_PAGE_BUDGET_BYTES = 1024 * 1024;

export const ATTACHMENT_STATES: readonly AttachmentState[] = [
  'none',
  'initializing',
  'ready',
  'sleeping',
  'closed',
  'stale',
  'failed',
];

export function emptyAttachment(now: string): SessionAttachment {
  return {
    state: 'none',
    sessionId: null,
    providerSessionId: null,
    provider: null,
    model: null,
    configRevision: null,
    updatedAt: now,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function normalizeAttachment(raw: unknown, now: string): SessionAttachment {
  if (!isRecord(raw)) return emptyAttachment(now);
  const state = ATTACHMENT_STATES.includes(raw.state as AttachmentState)
    ? (raw.state as AttachmentState)
    : 'none';
  return {
    state,
    sessionId: stringOrNull(raw.sessionId),
    providerSessionId: stringOrNull(raw.providerSessionId),
    provider: stringOrNull(raw.provider),
    model: stringOrNull(raw.model),
    configRevision: typeof raw.configRevision === 'number' ? raw.configRevision : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
    ...(typeof raw.lastError === 'string' ? { lastError: raw.lastError } : {}),
    ...(raw.unavailableReason === 'provider_session_unavailable' || raw.unavailableReason === 'runtime_session_missing'
      || raw.unavailableReason === 'repeated_provider_failure'
      ? { unavailableReason: raw.unavailableReason } : {}),
    ...(raw.replacementPending === true ? { replacementPending: true } : {}),
  };
}

export function normalizeConversation(raw: unknown, now: string): ConversationRecord | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) return null;
  const role: ConversationRole = raw.role === 'home' ? 'home' : 'note';
  const checkpoint = isRecord(raw.checkpoint)
    && typeof raw.checkpoint.digest === 'string'
    && typeof raw.checkpoint.throughSeq === 'number'
    ? {
      digest: raw.checkpoint.digest,
      throughSeq: raw.checkpoint.throughSeq,
      updatedAt: typeof raw.checkpoint.updatedAt === 'string' ? raw.checkpoint.updatedAt : now,
    }
    : null;
  return {
    schemaVersion: 1,
    id: raw.id,
    role,
    title:
      typeof raw.title === 'string'
        ? raw.title
        : role === 'home'
          ? 'Direct message'
          : 'Conversation',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : now,
    attachment: normalizeAttachment(raw.attachment, now),
    unreadCount:
      typeof raw.unreadCount === 'number' && raw.unreadCount >= 0 ? Math.floor(raw.unreadCount) : 0,
    lastOwnerMessageAt: stringOrNull(raw.lastOwnerMessageAt),
    lastBotMessageAt: stringOrNull(raw.lastBotMessageAt),
    checkpoint,
    contactOf: role === 'note' && typeof raw.contactOf === 'string' && isValidBotId(raw.contactOf) ? raw.contactOf : null,
    contactName: role === 'note' && typeof raw.contactName === 'string' && raw.contactName.trim()
      ? raw.contactName.trim().slice(0, 80)
      : null,
  };
}

/** PLAN-009 D29's sender conversations, `bot-<sender id>`, named "Messages from <name>". */
const SENDER_CONVERSATION = /^bot-(.+)$/u;
const SENDER_TITLE = /^Messages from (.+)$/u;

/**
 * SPEC-014 FR-10: the newest part of a page within `budget` bytes, and the `seq` it was cut
 * at, or null when all of it fits. A cut keeps every entry of a `seq` and never falls inside
 * a shown presentation's span, so that the page before it projects as the whole transcript
 * would. When even the newest part that can be cut off is larger, it is the page, so that a
 * page holds an entry whatever its size.
 */
export function newestWithinBudget(
  projected: readonly TranscriptEntry[],
  budget: number,
): { entries: TranscriptEntry[]; cut: number | null } {
  const sizes = projected.map((entry) => Buffer.byteLength(JSON.stringify(entry)) + 1);
  if (sizes.reduce((sum, size) => sum + size, 1) <= budget) return { entries: [...projected], cut: null };
  const spans = projected
    .filter((entry) => entry.presentation)
    .map((entry) => [entry.seq, responseCovers(entry) ?? entry.seq] as const);
  let used = 1;
  let best: number | null = null;
  for (let index = projected.length - 1; index > 0; index -= 1) {
    used += sizes[index]!;
    const seq = projected[index]!.seq;
    if (projected[index - 1]!.seq === seq) continue;
    if (spans.some(([from, to]) => from < seq && seq <= to)) continue;
    if (used > budget) {
      best ??= index;
      break;
    }
    best = index;
  }
  return best === null
    ? { entries: [...projected], cut: null }
    : { entries: projected.slice(best), cut: projected[best]!.seq };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ConversationStoreOptions {
  /** The bot's open store; it throws when none is open. */
  store: () => BotStateStore;
  now: () => Date;
  /** Receives problems that are not fatal, such as a record that cannot be read (FR-4). */
  warn?: (message: string) => void;
}

export class ConversationStore {
  private readonly store: () => BotStateStore;
  private readonly now: () => Date;
  private readonly warn: (message: string) => void;
  private readonly records = new Map<string, ConversationRecord>();
  /** SPEC-012 FR-5: contact notes upgraded in memory whose stored records are still the old ones. */
  private readonly unwrittenUpgrades = new Set<string>();

  constructor(options: ConversationStoreOptions) {
    this.store = options.store;
    this.now = options.now;
    this.warn = options.warn ?? (() => {});
  }

  load(): void {
    this.records.clear();
    this.unwrittenUpgrades.clear();
    const now = this.now().toISOString();
    for (const raw of this.store().conversations()) {
      const record = normalizeConversation(raw, now);
      if (!record) {
        const id = typeof (raw as { id?: unknown } | null)?.id === 'string' ? (raw as { id: string }).id : '?';
        this.warn(`conversation ${id}: not a conversation record; left untouched`);
        continue;
      }
      this.records.set(record.id, this.upgradeContactNote(record));
    }
  }

  /**
   * SPEC-012 FR-5 / FR-8: a sender conversation from before contact notes is
   * one from the moment it is read, in every host. Its session may have seen
   * words the owner wrote there, so it is marked stale and the next one starts
   * from a handoff without them. Only a running core writes the upgrade
   * (`persistUpgrades`); read-only hosts never do. The migration's copy of the
   * version-1 files keeps the record as it was.
   */
  private upgradeContactNote(record: ConversationRecord): ConversationRecord {
    if (record.role !== 'note' || record.contactOf) return record;
    const sender = SENDER_CONVERSATION.exec(record.id)?.[1];
    if (!sender || !isValidBotId(sender)) return record;
    this.unwrittenUpgrades.add(record.id);
    return {
      ...record,
      contactOf: sender,
      contactName: SENDER_TITLE.exec(record.title)?.[1]?.trim().slice(0, 80) || sender,
      ...(record.attachment.sessionId ? { attachment: { ...record.attachment, state: 'stale' as const } } : {}),
    };
  }

  /** Writes the contact note upgrades `load` applied in memory. */
  persistUpgrades(): void {
    for (const id of [...this.unwrittenUpgrades]) {
      const record = this.records.get(id);
      if (!record) {
        this.unwrittenUpgrades.delete(id);
        continue;
      }
      try {
        this.write(record);
      } catch (error) {
        this.warn(`conversation ${id}: contact note upgrade was not written (${errorText(error)}); applied in memory`);
      }
    }
  }

  private write(record: ConversationRecord): void {
    this.store().saveConversation(record);
    this.unwrittenUpgrades.delete(record.id);
  }

  list(): ConversationRecord[] {
    return [...this.records.values()].sort((a, b) => {
      if (a.role !== b.role) return a.role === 'home' ? -1 : 1;
      return a.createdAt.localeCompare(b.createdAt);
    });
  }

  get(id: string): ConversationRecord | undefined {
    return this.records.get(id);
  }

  require(id: string): ConversationRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown conversation ${id}`);
    return record;
  }

  /** SPEC-001 FR-10: exactly one home conversation, created on first use. */
  home(): ConversationRecord {
    const existing = this.list().find((record) => record.role === 'home');
    if (existing) return existing;
    return this.create('Direct message', 'home', 'home');
  }

  create(
    title: string,
    role: ConversationRole = 'note',
    id?: string,
    contact?: { botId: string; name: string },
  ): ConversationRecord {
    const now = this.now().toISOString();
    const record: ConversationRecord = {
      schemaVersion: 1,
      id: id ?? `conv-${randomUUID().slice(0, 8)}`,
      role,
      title,
      createdAt: now,
      updatedAt: now,
      attachment: emptyAttachment(now),
      unreadCount: 0,
      lastOwnerMessageAt: null,
      lastBotMessageAt: null,
      checkpoint: null,
      contactOf: role === 'note' && contact ? contact.botId : null,
      contactName: role === 'note' && contact ? contact.name.slice(0, 80) : null,
    };
    this.records.set(record.id, record);
    this.write(record);
    return record;
  }

  update(id: string, mutate: (record: ConversationRecord) => void): ConversationRecord {
    const current = this.require(id);
    const next: ConversationRecord = structuredClone(current);
    mutate(next);
    next.updatedAt = this.now().toISOString();
    this.records.set(id, next);
    this.write(next);
    return next;
  }

  setAttachment(id: string, patch: Partial<SessionAttachment>): ConversationRecord {
    return this.update(id, (record) => {
      record.attachment = { ...record.attachment, ...patch, updatedAt: this.now().toISOString() };
      if (!('lastError' in patch)) delete record.attachment.lastError;
    });
  }

  /**
   * SPEC-001 FR-14 and SPEC-014 FR-5: the record, its transcript, its presentations and its
   * work items go together, in one transaction; the caller closed the session first.
   */
  remove(id: string): void {
    const record = this.require(id);
    if (record.role === 'home') throw new Error('The direct message cannot be deleted');
    this.store().deleteConversation(id);
    this.records.delete(id);
    this.unwrittenUpgrades.delete(id);
  }

  transcript(id: string): TranscriptEntry[] {
    this.require(id);
    return this.store().entries(id);
  }

  /** SPEC-014 FR-10: the newest entries, or the ones before a `seq`, in `seq` order. */
  transcriptPage(id: string, page: EntriesPage): TranscriptEntry[] {
    this.require(id);
    return this.store().entriesPage(id, page);
  }

  /** The highest `seq` of the conversation, or 0. */
  lastSeq(id: string): number {
    this.require(id);
    return this.store().lastSeq(id);
  }

  presentationTranscript(id: string, runningWorkId?: string): TranscriptEntry[] {
    return projectPresentationTranscript(this.transcript(id), this.presentations(id), runningWorkId);
  }

  /**
   * SPEC-014 FR-10: a page of the transcript as the note shows it, with the `beforeSeq` of
   * the page before it, within `budgetBytes`. A page never parts a reply presentation from
   * the entries it covers: it reaches back to the start of any presentation that covers its
   * first entry, so each page projects as the whole transcript would. It reads its own
   * entries and presentations, and the rest of the conversation only through indexes.
   */
  presentationPage(
    id: string,
    page: EntriesPage,
    runningWorkId?: string,
    budgetBytes = Number.POSITIVE_INFINITY,
  ): TranscriptPage {
    this.require(id);
    const store = this.store();
    const window = store.entriesWindow(id, page);
    if (window.firstSeq === null) return { entries: [], olderBeforeSeq: null };
    let entries = window.entries;
    let floor = window.firstSeq;
    for (let reach = store.presentationReach(id, floor); reach !== null; reach = store.presentationReach(id, floor)) {
      entries = [...store.entriesBetween(id, reach, floor), ...entries];
      floor = reach;
    }
    const own = this.checkedResponses(id, store.responsesBetween(id, floor, page.beforeSeq));
    // A presentation that never bound its final entry is left out when a bot entry of its
    // work item comes after it, as the whole transcript's projection leaves it out. One
    // after this page is asked of the store, by index.
    const upper = page.beforeSeq;
    const finishedLater = new Map<string, boolean>();
    const shown = upper === undefined ? own : own.filter((response) => {
      const workItemId = response.workItemId!;
      if (entries.some((entry) => entry.kind === 'bot' && entry.workItemId === workItemId && entry.seq >= response.seq)) {
        return true;
      }
      if (!finishedLater.has(workItemId)) finishedLater.set(workItemId, store.hasBotEntryOf(id, workItemId, upper));
      return !finishedLater.get(workItemId);
    });
    const { entries: kept, cut } = newestWithinBudget(
      projectPresentationTranscript(entries, shown, runningWorkId),
      budgetBytes,
    );
    return { entries: kept, olderBeforeSeq: cut ?? (store.hasEntryBefore(id, floor) ? floor : null) };
  }

  /** The reply presentations as the shared contract reads them; one it cannot is reported. */
  private presentations(id: string): TranscriptEntry[] {
    return this.checkedResponses(id, this.store().responses(id));
  }

  private checkedResponses(id: string, raws: readonly unknown[]): TranscriptEntry[] {
    const checked: TranscriptEntry[] = [];
    for (const raw of raws) {
      const response = checkedResponse(raw);
      if (response) checked.push(response);
      else this.warn(`conversation ${id}: a reply presentation cannot be read and was left out`);
    }
    return checked;
  }

  savePresentation(id: string, entry: TranscriptEntry): void {
    this.require(id);
    if (!checkedResponse(entry)) throw new Error('Invalid conversation presentation record');
    this.store().saveResponse(id, entry);
  }

  /** The entry and the record's own change are one transaction. */
  append(id: string, entry: Omit<TranscriptEntry, 'seq' | 'at'>): TranscriptEntry {
    this.require(id);
    const at = this.now().toISOString();
    return this.store().transaction(() => {
      const full = this.store().appendEntry(id, { at, ...entry });
      this.update(id, (record) => {
        // SPEC-009 FR-7: another bot's message does not count as the owner writing.
        if (entry.kind === 'owner' && entry.origin !== 'bot') record.lastOwnerMessageAt = at;
        if (entry.kind === 'bot') record.lastBotMessageAt = at;
      });
      return full;
    });
  }
}
