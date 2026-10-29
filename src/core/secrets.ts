import { chmodSync } from 'node:fs';
import { join } from 'node:path';

import { readJsonFile, writeFileAtomic } from './store/atomicFile.ts';

/**
 * SPEC-001 NFR security / Open Question on token storage: secrets such as the
 * Telegram bot token live in `<root>/secrets.json`, never in the profile or
 * the journal. A host that can reach an OS credential facility (the Electron
 * shell through `safeStorage`, DPAPI on Windows) supplies a cipher and the
 * value is stored encrypted; without one the file holds the value as is,
 * with owner-only permissions where the platform supports them, and the CLI
 * says so. A host with a cipher re-stores such plain entries encrypted
 * (`protectAtRest`), and status reports how a value is actually stored
 * (`protectionOf`), not what the host could do. Secrets never appear in logs.
 */

export interface SecretCipher {
  /** A short label stored next to the value, for example `os-safe-storage`. */
  label: string;
  encrypt(plain: string): Buffer;
  decrypt(cipher: Buffer): string;
}

/**
 * SPEC-008 FR-20: a cipher the host serves over the host channel, for a core
 * that runs in a process without the OS facility. Values never leave the
 * account's local channel.
 */
export interface AsyncSecretCipher {
  label: string;
  encrypt(plain: string): Promise<Buffer>;
  decrypt(cipher: Buffer): Promise<string>;
}

export type SecretProtection = 'os' | 'file';

export interface SecretStore {
  get(name: string): string | null;
  set(name: string, value: string): void;
  delete(name: string): void;
  has(name: string): boolean;
  /** What this host can do: `os` when it has a cipher. */
  protection(): SecretProtection;
  /** How the stored value is protected, or null when there is none. */
  protectionOf(name: string): SecretProtection | null;
  /** Re-stores plain entries with this host's cipher; returns how many it upgraded. */
  protectAtRest(): number;
  /** The same three through a cipher that may be asynchronous (SPEC-008 FR-20). */
  getAsync(name: string): Promise<string | null>;
  setAsync(name: string, value: string): Promise<void>;
  protectAtRestAsync(): Promise<number>;
}

interface SecretsFile {
  schemaVersion: 1;
  entries: Record<string, { cipher: string; value: string }>;
}

export const SECRET_TELEGRAM_TOKEN = 'telegramBotToken';

export function secretsPath(root: string): string {
  return join(root, 'secrets.json');
}

export class FileSecretStore implements SecretStore {
  private readonly path: string;
  private readonly cipher: SecretCipher | undefined;
  private readonly asyncCipher: AsyncSecretCipher | undefined;
  private readonly warn: (line: string) => void;

  constructor(root: string, options: { cipher?: SecretCipher; asyncCipher?: AsyncSecretCipher; warn?: (line: string) => void } = {}) {
    this.path = secretsPath(root);
    this.cipher = options.cipher;
    this.asyncCipher = options.cipher ? undefined : options.asyncCipher;
    this.warn = options.warn ?? (() => {});
  }

  protection(): SecretProtection {
    return this.cipher || this.asyncCipher ? 'os' : 'file';
  }

  /** The synchronous paths cannot wait for a host's cipher. */
  private assertSync(): void {
    if (this.asyncCipher) throw new Error('This secret store encrypts through its host; use the asynchronous methods.');
  }

  private codec(): AsyncSecretCipher | undefined {
    const cipher = this.cipher;
    return cipher
      ? { label: cipher.label, encrypt: async (plain) => cipher.encrypt(plain), decrypt: async (data) => cipher.decrypt(data) }
      : this.asyncCipher;
  }

  private read(): SecretsFile {
    const read = readJsonFile<Partial<SecretsFile>>(this.path);
    if (!read.ok || typeof read.value !== 'object' || read.value === null) {
      if (read.ok === false && read.reason === 'corrupt') this.warn(`secrets file unreadable: ${read.error}`);
      return { schemaVersion: 1, entries: {} };
    }
    const entries: SecretsFile['entries'] = {};
    for (const [name, entry] of Object.entries(read.value.entries ?? {})) {
      if (entry && typeof entry === 'object' && typeof entry.value === 'string' && typeof entry.cipher === 'string') {
        entries[name] = { cipher: entry.cipher, value: entry.value };
      }
    }
    return { schemaVersion: 1, entries };
  }

  private write(file: SecretsFile): void {
    writeFileAtomic(this.path, `${JSON.stringify(file, null, 2)}\n`);
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // Windows has no POSIX mode bits; the profile directory ACL applies.
    }
  }

  has(name: string): boolean {
    return name in this.read().entries;
  }

  protectionOf(name: string): SecretProtection | null {
    const entry = this.read().entries[name];
    if (!entry) return null;
    return entry.cipher === 'none' ? 'file' : 'os';
  }

  protectAtRest(): number {
    this.assertSync();
    if (!this.cipher) return 0;
    const file = this.read();
    let upgraded = 0;
    for (const [name, entry] of Object.entries(file.entries)) {
      if (entry.cipher !== 'none') continue;
      const plain = Buffer.from(entry.value, 'base64').toString('utf8');
      file.entries[name] = { cipher: this.cipher.label, value: this.cipher.encrypt(plain).toString('base64') };
      upgraded += 1;
    }
    if (upgraded > 0) this.write(file);
    return upgraded;
  }

  get(name: string): string | null {
    this.assertSync();
    const entry = this.read().entries[name];
    if (!entry) return null;
    if (entry.cipher === 'none') return Buffer.from(entry.value, 'base64').toString('utf8');
    if (!this.cipher || this.cipher.label !== entry.cipher) {
      this.warn(`secret ${name} was protected with ${entry.cipher}, which this host cannot open`);
      return null;
    }
    try {
      return this.cipher.decrypt(Buffer.from(entry.value, 'base64'));
    } catch (error) {
      this.warn(`secret ${name} could not be decrypted: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  set(name: string, value: string): void {
    this.assertSync();
    const file = this.read();
    file.entries[name] = this.cipher
      ? { cipher: this.cipher.label, value: this.cipher.encrypt(value).toString('base64') }
      : { cipher: 'none', value: Buffer.from(value, 'utf8').toString('base64') };
    this.write(file);
  }

  async protectAtRestAsync(): Promise<number> {
    const codec = this.codec();
    if (!codec) return 0;
    const file = this.read();
    let upgraded = 0;
    for (const [name, entry] of Object.entries(file.entries)) {
      if (entry.cipher !== 'none') continue;
      const plain = Buffer.from(entry.value, 'base64').toString('utf8');
      file.entries[name] = { cipher: codec.label, value: (await codec.encrypt(plain)).toString('base64') };
      upgraded += 1;
    }
    if (upgraded > 0) this.write(file);
    return upgraded;
  }

  async getAsync(name: string): Promise<string | null> {
    const entry = this.read().entries[name];
    if (!entry) return null;
    if (entry.cipher === 'none') return Buffer.from(entry.value, 'base64').toString('utf8');
    const codec = this.codec();
    if (!codec || codec.label !== entry.cipher) {
      this.warn(`secret ${name} was protected with ${entry.cipher}, which this host cannot open`);
      return null;
    }
    try {
      return await codec.decrypt(Buffer.from(entry.value, 'base64'));
    } catch (error) {
      this.warn(`secret ${name} could not be decrypted: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async setAsync(name: string, value: string): Promise<void> {
    const codec = this.codec();
    const stored = codec
      ? { cipher: codec.label, value: (await codec.encrypt(value)).toString('base64') }
      : { cipher: 'none', value: Buffer.from(value, 'utf8').toString('base64') };
    const file = this.read();
    file.entries[name] = stored;
    this.write(file);
  }

  delete(name: string): void {
    const file = this.read();
    if (!(name in file.entries)) return;
    delete file.entries[name];
    this.write(file);
  }
}
