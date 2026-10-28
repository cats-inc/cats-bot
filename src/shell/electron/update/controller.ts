import type { BotUpdateState } from '../../../shared/shellUpdate.ts';
import { isNewerVersion, releasePage } from './release.ts';
import type { InstallationLease } from './installation.ts';

export interface BotUpdater {
  check(): Promise<string | null>;
  download(progress: (percent: number) => void): Promise<void>;
  prepareInstall(): Promise<void>;
  install(): Promise<void>;
}
export class InstallHandoffTimeout extends Error {}

export interface UpdateHooks {
  acquireInstall: (version: string) => InstallationLease;
  drain: () => Promise<void>;
  recover: (uncertain: boolean, error: Error) => Promise<void>;
  openRelease: (url: string) => Promise<void>;
  changed?: (state: BotUpdateState) => void;
}

export class BotUpdateController {
  private current: BotUpdateState;
  private readonly updater: BotUpdater | null;
  private readonly hooks: UpdateHooks;
  private active: Promise<void> | null = null;

  constructor(state: BotUpdateState, updater: BotUpdater | null, hooks: UpdateHooks) {
    this.current = state; this.updater = updater; this.hooks = hooks;
  }
  snapshot(): BotUpdateState { return { ...this.current }; }
  private set(patch: Partial<BotUpdateState>): void {
    this.current = { ...this.current, ...patch };
    this.hooks.changed?.(this.snapshot());
  }
  private async operation(work: () => Promise<void>): Promise<BotUpdateState> {
    if (this.active) return this.active.then(() => this.snapshot());
    this.active = Promise.resolve().then(work).catch((error: unknown) => {
      this.set({ phase: 'error', error: (error instanceof Error ? error.message : String(error)).slice(0, 500), percent: null });
    }).finally(() => { this.active = null; });
    await this.active;
    return this.snapshot();
  }
  check(): Promise<BotUpdateState> {
    if (!this.current.canCheck || !this.updater) return Promise.resolve(this.snapshot());
    if (this.current.phase === 'downloaded') return Promise.resolve(this.snapshot());
    return this.operation(async () => {
      this.set({ phase: 'checking', version: null, error: null, percent: null });
      const version = await this.updater!.check();
      this.set({ phase: isNewerVersion(version, this.current.currentVersion) ? 'available' : 'current',
        version: isNewerVersion(version, this.current.currentVersion) ? version : null });
    });
  }
  download(): Promise<BotUpdateState> {
    if (this.active) return this.active.then(() => this.snapshot());
    if (!this.current.canInstall || this.current.phase !== 'available' || !this.updater) return Promise.resolve(this.snapshot());
    return this.operation(async () => {
      this.set({ phase: 'downloading', error: null, percent: 0 });
      await this.updater!.download(percent => {
        if (Number.isFinite(percent)) this.set({ percent: Math.max(0, Math.min(100, percent)) });
      });
      this.set({ phase: 'downloaded', percent: 100 });
    });
  }
  install(): Promise<BotUpdateState> {
    if (this.active) return this.active.then(() => this.snapshot());
    if (!this.current.canInstall || this.current.phase !== 'downloaded' || !this.updater) return Promise.resolve(this.snapshot());
    return this.operation(async () => {
      // Acquire before changing state/draining: another live Bot must remain untouched.
      const lease = this.hooks.acquireInstall(this.current.version!);
      // Other Bot processes can evict the shared native cache. Check while the
      // installation is exclusively held, before interrupting this Bot's work.
      try { await this.updater!.prepareInstall(); }
      catch (error) { lease.release(); throw error; }
      this.set({ phase: 'installing', error: null });
      try {
        await this.hooks.drain();
        lease.handoff();
        await this.updater!.install();
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (!(failure instanceof InstallHandoffTimeout)) lease.release();
        await this.hooks.recover(failure instanceof InstallHandoffTimeout, failure);
        throw failure;
      }
      // Successful/uncertain handoffs retain identity until the new app starts.
    });
  }
  async openRelease(): Promise<void> {
    if (this.current.canCheck && this.current.version) await this.hooks.openRelease(releasePage(this.current.version));
  }
}
