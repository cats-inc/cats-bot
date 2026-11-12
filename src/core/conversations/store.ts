import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { readJsonFile, writeJsonAtomic } from '../store/atomicFile.ts';
import { conversationFile, isValidBotId, transcriptFile, type BotPaths } from '../store/paths.ts';
import { appendTranscript, readTranscript } from '../store/transcript.ts';
import { deletePresentations, readPresentations, savePresentation, projectPresentationTranscript } from '../store/presentation.ts';
import type {
  AttachmentState,
  ConversationRecord,
  ConversationRole,
  SessionAttachment,
  TranscriptEntry,
} from '../types.ts';

/**
 * SPEC-001 FR-9, FR-10, FR-12: conversation records under
 * `conversations/<id>.json`, transcripts under `transcripts/<id>.jsonl`.
 * Every mutation goes through `update` so the file on disk is always the
 * atomic rendering of the in-memory record.
 */

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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ConversationStoreOptions {
  paths: BotPaths;
  now: () => Date;
  /** Receives problems that are not fatal, such as a corrupt record left in place (FR-4). */
  warn?: (message: string) => void;
}

export class ConversationStore {
  private readonly paths: BotPaths;
  private readonly now: () => Date;
  private readonly warn: (message: string) => void;
  private readonly records = new Map<string, ConversationRecord>();
  private readonly nextSeq = new Map<string, number>();
  /** SPEC-012 FR-5: contact notes upgraded in memory whose files still hold the old record. */
  private readonly unwrittenUpgrades = new Set<string>();

  constructor(options: ConversationStoreOptions) {
    this.paths = options.paths;
    this.now = options.now;
    this.warn = options.warn ?? (() => {});
  }

  load(): void {
    this.records.clear();
    this.nextSeq.clear();
    this.unwrittenUpgrades.clear();
    mkdirSync(this.paths.conversations, { recursive: true });
    const now = this.now().toISOString();
    for (const name of readdirSync(this.paths.conversations).sort()) {
      if (!name.endsWith('.json')) continue;
      const file = conversationFile(this.paths, name.slice(0, -'.json'.length));
      const read = readJsonFile<unknown>(file);
      if (!read.ok) {
        this.warn(`conversation ${name}: ${read.reason === 'missing' ? 'missing' : read.error}; left untouched`);
        continue;
      }
      const record = normalizeConversation(read.value, now);
      if (!record) {
        this.warn(`conversation ${name}: not a conversation record; left untouched`);
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
   * (`persistUpgrades`), after a copy of the old file; read-only hosts never do.
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

  /**
   * Writes the contact note upgrades `load` applied in memory. A note whose
   * old file cannot be copied aside stays upgraded in memory only, and is
   * upgraded again on the next start; its next change is written either way.
   */
  persistUpgrades(): void {
    for (const id of [...this.unwrittenUpgrades]) {
      const record = this.records.get(id);
      if (!record) {
        this.unwrittenUpgrades.delete(id);
        continue;
      }
      if (!this.backUpBeforeUpgrade(id)) continue;
      try {
        this.write(record);
      } catch (error) {
        this.warn(`conversation ${id}: contact note upgrade was not written (${errorText(error)}); applied in memory`);
      }
    }
  }

  /** The old file, copied aside once before an upgraded record replaces it. */
  private backUpBeforeUpgrade(id: string): boolean {
    try {
      const file = conversationFile(this.paths, id);
      const backups = join(this.paths.conversations, '.backup');
      mkdirSync(backups, { recursive: true });
      const backup = join(backups, `${id}.before-contact-note.json`);
      if (!existsSync(backup) && existsSync(file)) copyFileSync(file, backup);
      return true;
    } catch (error) {
      this.warn(`conversation ${id}: the file before the contact note upgrade could not be copied aside (${errorText(error)})`);
      return false;
    }
  }

  private write(record: ConversationRecord): void {
    // A change to a note upgraded only in memory still tries the copy first; the record is
    // written either way, since the upgrade only adds what an older version ignores.
    if (this.unwrittenUpgrades.has(record.id)) this.backUpBeforeUpgrade(record.id);
    writeJsonAtomic(conversationFile(this.paths, record.id), record);
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

  /** SPEC-001 FR-14: the record and transcript go together; the caller closed the session first. */
  remove(id: string): void {
    const record = this.require(id);
    if (record.role === 'home') throw new Error('The direct message cannot be deleted');
    this.records.delete(id);
    this.nextSeq.delete(id);
    this.unwrittenUpgrades.delete(id);
    rmSync(conversationFile(this.paths, id), { force: true });
    rmSync(transcriptFile(this.paths, id), { force: true });
    deletePresentations(this.paths, id);
  }

  transcript(id: string): TranscriptEntry[] {
    this.require(id);
    return readTranscript(this.paths, id);
  }

  presentationTranscript(id: string, runningWorkId?: string): TranscriptEntry[] {
    return projectPresentationTranscript(this.transcript(id), readPresentations(this.paths, id), runningWorkId);
  }

  savePresentation(id: string, entry: TranscriptEntry): void {
    this.require(id);
    savePresentation(this.paths, id, entry);
  }

  append(id: string, entry: Omit<TranscriptEntry, 'seq' | 'at'>): TranscriptEntry {
    this.require(id);
    let seq = this.nextSeq.get(id);
    if (seq === undefined) {
      seq = (readTranscript(this.paths, id).at(-1)?.seq ?? 0) + 1;
    }
    const at = this.now().toISOString();
    const full: TranscriptEntry = { seq, at, ...entry };
    appendTranscript(this.paths, id, full);
    this.nextSeq.set(id, seq + 1);
    this.update(id, (record) => {
      // SPEC-009 FR-7: another bot's message does not count as the owner writing.
      if (entry.kind === 'owner' && entry.origin !== 'bot') record.lastOwnerMessageAt = at;
      if (entry.kind === 'bot') record.lastBotMessageAt = at;
    });
    return full;
  }
}
