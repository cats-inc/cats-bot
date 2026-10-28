import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isNewerVersion } from './release.ts';

interface InstallRecord { pid: number; nonce: string; phase: 'draining' | 'handoff'; botId: string; targetVersion: string }
export interface InstallationLease { handoff(): void; release(): void }
export class InstallationRecoveryRequired extends Error {}
export function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

/** All shells using one executable participate, including shells starting during an update. */
export class BotInstallation {
  readonly directory: string;
  private readonly pid: number;
  private readonly version: string;
  private readonly alive: (pid: number) => boolean;
  private readonly nonce = randomUUID();
  private botId = '';
  private registered = false;
  constructor(appData: string, executable: string, version: string, pid = process.pid, alive = processIsAlive) {
    const identity = process.platform === 'win32' ? resolve(executable).toLowerCase() : resolve(executable);
    this.directory = join(appData, 'Cats Bot', 'installations', createHash('sha256').update(identity).digest('hex'));
    this.pid = pid; this.version = version; this.alive = alive;
  }
  private get gate(): string { return join(this.directory, 'install'); }
  private get marker(): string { return join(this.gate, 'owner.json'); }
  private get leaseFile(): string { return join(this.directory, `pid-${this.pid}.json`); }
  private record(): InstallRecord | null {
    try {
      const value = JSON.parse(readFileSync(this.marker, 'utf8')) as InstallRecord;
      return Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.nonce === 'string'
        && ['draining', 'handoff'].includes(value.phase) && typeof value.botId === 'string'
        && typeof value.targetVersion === 'string' ? value : null;
    } catch { return null; }
  }
  pendingBotId(): string | undefined { return this.record()?.botId || undefined; }
  private removeGate(nonce: string): void {
    if (this.record()?.nonce !== nonce) throw new Error('Installation owner changed.');
    const temporary = join(this.gate, `owner-${nonce}.tmp`);
    if (existsSync(temporary)) unlinkSync(temporary);
    unlinkSync(this.marker);
    rmdirSync(this.gate);
  }
  private writeRecord(record: InstallRecord): void {
    const temporary = join(this.gate, `owner-${record.nonce}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify(record), { flag: 'wx' });
      renameSync(temporary, this.marker);
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  acknowledgeFinishedInstaller(): void {
    const record = this.record();
    if (record) {
      if (record.pid !== this.pid && this.alive(record.pid)) throw new Error('Another Bot may still be installing.');
      this.removeGate(record.nonce);
    } else {
      // A crash can leave a gate before its first atomic marker write. Only an
      // explicit user acknowledgement, with no other live shell, may clear it.
      for (const name of readdirSync(this.directory)) {
        const match = /^pid-(\d+)\.json$/u.exec(name);
        if (match && Number(match[1]) !== this.pid && this.alive(Number(match[1]))) throw new Error('Another Bot may still be installing.');
      }
      for (const name of readdirSync(this.gate)) {
        if (name !== 'owner.json' && !/^owner-[a-f0-9-]+\.tmp$/u.test(name)) throw new Error('Unknown installation marker; recovery requires inspection.');
        unlinkSync(join(this.gate, name));
      }
      rmdirSync(this.gate);
    }
  }
  register(botId: string): void {
    if (this.registered) throw new Error('This Bot already registered its installation.');
    mkdirSync(this.directory, { recursive: true });
    this.botId = botId;
    // The OS cannot assign this process ID to another live process. Replace a
    // stale lease left by a crashed process whose PID has since been reused.
    writeFileSync(this.leaseFile, JSON.stringify({ botId, nonce: this.nonce }));
    this.registered = true;
    try {
      if (!existsSync(this.gate)) return;
      const record = this.record();
      if (!record) throw new InstallationRecoveryRequired('An interrupted update left an incomplete installation marker. Finish or close any installer before reopening Cats Bot.');
      if (record.pid !== this.pid && this.alive(record.pid)) throw new Error('Cats Bot is installing an update. Wait for the installer to finish.');
      if (record.phase === 'handoff' && this.version !== record.targetVersion && !isNewerVersion(this.version, record.targetVersion)) {
        throw new InstallationRecoveryRequired('An earlier installer did not confirm completion. Finish or close it before reopening this version of Cats Bot.');
      }
      this.removeGate(record.nonce);
    } catch (error) { this.unregister(); throw error; }
  }
  unregister(): void {
    if (!this.registered) return;
    try {
      const value = JSON.parse(readFileSync(this.leaseFile, 'utf8')) as { nonce: string };
      if (value.nonce === this.nonce) unlinkSync(this.leaseFile);
    } finally { this.registered = false; }
  }
  acquire(targetVersion: string): InstallationLease {
    if (!this.registered || !isNewerVersion(targetVersion, this.version)) throw new Error('No valid installation owner or newer version.');
    mkdirSync(this.gate); // atomic gate; new shells register, see this directory and leave
    const record: InstallRecord = { pid: this.pid, nonce: randomUUID(), phase: 'draining', botId: this.botId, targetVersion };
    try { this.writeRecord(record); }
    catch (error) { rmdirSync(this.gate); throw error; }
    try {
      for (const name of readdirSync(this.directory)) {
        const match = /^pid-(\d+)\.json$/u.exec(name);
        if (!match || Number(match[1]) === this.pid) continue;
        if (this.alive(Number(match[1]))) throw new Error('Quit the other Cats Bot instances before installing this update.');
        unlinkSync(join(this.directory, name));
      }
    } catch (error) { this.removeGate(record.nonce); throw error; }
    return {
      handoff: () => { record.phase = 'handoff'; this.writeRecord(record); },
      release: () => this.removeGate(record.nonce),
    };
  }
}
