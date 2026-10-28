import { readJsonFile, writeJsonAtomic } from '../store/atomicFile.ts';

/**
 * SPEC-006 BDC-03 (P0 decision): the conversations whose desktop control switch is on live in
 * `desktop-control.json` in the Bot's data root, `{ "version": 1, "conversations": [] }`,
 * written atomically. Conversation records keep schema 1. A missing file means every switch
 * is off. A corrupt file also reads as all off and is replaced by the owner's next change; a
 * file from a newer Bot (another version) reads as all off and is never overwritten.
 */

export const DESKTOP_CONTROL_SWITCHES_VERSION = 1;
const MAX_CONVERSATIONS = 1_000;

interface SwitchFile {
  version: typeof DESKTOP_CONTROL_SWITCHES_VERSION;
  conversations: string[];
}

export class DesktopControlSwitches {
  private readonly file: string;
  private readonly warn: (line: string) => void;
  private enabled = new Set<string>();
  /** Set when the file belongs to a newer Bot: it reads as all off and is left untouched. */
  private foreign = false;

  constructor(file: string, warn: (line: string) => void = () => {}) {
    this.file = file;
    this.warn = warn;
    this.load();
  }

  load(): void {
    this.enabled = new Set();
    this.foreign = false;
    const read = readJsonFile<unknown>(this.file);
    if (!read.ok) {
      if (read.reason === 'corrupt') this.warn('desktop control switches are unreadable; every conversation reads as off');
      return;
    }
    const value = read.value as Partial<SwitchFile> | null;
    if (!value || typeof value !== 'object' || value.version !== DESKTOP_CONTROL_SWITCHES_VERSION) {
      this.foreign = true;
      this.warn('desktop control switches have an unknown version; every conversation reads as off');
      return;
    }
    if (!Array.isArray(value.conversations)) {
      this.warn('desktop control switches are invalid; every conversation reads as off');
      return;
    }
    for (const id of value.conversations) {
      if (typeof id === 'string' && id && id.length <= 200) this.enabled.add(id);
    }
  }

  isEnabled(conversationId: string): boolean {
    return this.enabled.has(conversationId);
  }

  list(): string[] {
    return [...this.enabled];
  }

  /** Returns whether the switch changed. */
  set(conversationId: string, enabled: boolean): boolean {
    if (this.enabled.has(conversationId) === enabled) return false;
    if (this.foreign) throw new Error('desktop-control.json was written by a newer Bot; it is left unchanged.');
    const next = new Set(this.enabled);
    if (enabled) {
      if (next.size >= MAX_CONVERSATIONS) throw new Error('Too many conversations have desktop control on.');
      next.add(conversationId);
    } else {
      next.delete(conversationId);
    }
    const file: SwitchFile = { version: DESKTOP_CONTROL_SWITCHES_VERSION, conversations: [...next] };
    writeJsonAtomic(this.file, file);
    this.enabled = next;
    return true;
  }
}
