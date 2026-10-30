/**
 * SPEC-008 FR-9 to FR-11: one bot's core as the hub runs it. A core that ends
 * without being asked is marked failed and started again with backoff, a
 * bounded number of times per window; after that the bot stays failed with
 * its error until the owner starts it. Other bots are unaffected. A core that
 * another program hosts is only reported (FR-11).
 */

export type CoreState = 'stopped' | 'starting' | 'running' | 'failed' | 'external';

export interface CoreRunnerOptions<T> {
  /** Starts the core or reattaches to it, and presents it. */
  start(): Promise<T>;
  /** Stops the core through its channel and closes what presented it. */
  stop(handle: T): Promise<void>;
  /** Calls `listener` once if the core ends while running. */
  onLost(handle: T, listener: () => void): void;
  /** Whether a start failed because another program hosts the core. */
  isExternal(error: unknown): boolean;
  changed(): void;
  /** Called once when the runner stops restarting a core that keeps failing. */
  gaveUp?(): void;
  log(line: string): void;
  /** The waits before the first, second and later restarts. */
  delaysMs?: number[];
  /** At most `maxRestarts` restarts within `windowMs`. */
  maxRestarts?: number;
  windowMs?: number;
  now?(): number;
}

const DEFAULT_DELAYS_MS = [1_000, 5_000, 15_000];

export class CoreRunner<T> {
  readonly id: string;
  private readonly options: CoreRunnerOptions<T>;
  private stateValue: CoreState = 'stopped';
  private errorValue: string | null = null;
  private handleValue: T | null = null;
  private wanted = false;
  private restarts: number[] = [];
  private timer: NodeJS.Timeout | null = null;
  private launching: Promise<T | null> | null = null;
  private gaveUp = false;

  constructor(id: string, options: CoreRunnerOptions<T>) {
    this.id = id;
    this.options = options;
  }

  get state(): CoreState {
    return this.stateValue;
  }

  get error(): string | null {
    return this.errorValue;
  }

  get handle(): T | null {
    return this.handleValue;
  }

  /** The owner's start: earlier failures no longer count. */
  start(): Promise<T | null> {
    this.wanted = true;
    this.restarts = [];
    this.gaveUp = false;
    this.clearTimer();
    if (this.handleValue) return Promise.resolve(this.handleValue);
    return this.launch();
  }

  /**
   * A start the owner did not ask for (SPEC-009 `hub_start_bot`): earlier
   * failures still count, and a bot that waits to be restarted, or that the
   * runner gave up on, is left for the owner.
   */
  startAgain(): Promise<T | null> {
    if (this.handleValue) return Promise.resolve(this.handleValue);
    const refusal = this.startAgainRefusal();
    if (refusal) return Promise.reject(new Error(refusal));
    this.wanted = true;
    return this.launch();
  }

  /** Why `startAgain` would be refused now, or null. */
  startAgainRefusal(): string | null {
    if (this.handleValue) return null;
    if (this.gaveUp) return 'It kept failing, so only the owner can start it again.';
    if (this.timer) return 'It failed a moment ago and starts again by itself shortly.';
    return null;
  }

  /** The owner's stop, or Quit: no restart follows. */
  async stop(): Promise<void> {
    this.wanted = false;
    this.gaveUp = false;
    this.clearTimer();
    await this.launching?.catch(() => null);
    const handle = this.handleValue;
    this.handleValue = null;
    if (handle) await this.options.stop(handle);
    this.set('stopped', null);
  }

  private set(state: CoreState, error: string | null): void {
    this.stateValue = state;
    this.errorValue = error;
    this.options.changed();
  }

  private launch(): Promise<T | null> {
    if (this.launching) return this.launching;
    this.set('starting', null);
    const task = (async () => {
      try {
        const handle = await this.options.start();
        if (!this.wanted) {
          await this.options.stop(handle);
          this.set('stopped', null);
          return null;
        }
        this.handleValue = handle;
        this.options.onLost(handle, () => this.lost(handle));
        this.set('running', null);
        return handle;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.options.isExternal(error)) {
          this.set('external', message);
          return null;
        }
        this.options.log(`bot ${this.id} did not start: ${message}`);
        this.set('failed', message);
        this.scheduleRestart();
        return null;
      }
    })();
    this.launching = task;
    void task.finally(() => {
      if (this.launching === task) this.launching = null;
    });
    return task;
  }

  private lost(handle: T): void {
    if (handle !== this.handleValue) return;
    this.handleValue = null;
    if (!this.wanted) {
      this.set('stopped', null);
      return;
    }
    this.options.log(`bot ${this.id}: the core stopped unexpectedly`);
    this.set('failed', 'The Bot core stopped unexpectedly.');
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    const now = this.options.now?.() ?? Date.now();
    const windowMs = this.options.windowMs ?? 10 * 60_000;
    this.restarts = this.restarts.filter((at) => now - at < windowMs);
    if (this.restarts.length >= (this.options.maxRestarts ?? 3)) {
      this.options.log(`bot ${this.id} failed ${this.restarts.length + 1} times and is not started again until the owner starts it`);
      this.gaveUp = true;
      this.options.changed();
      this.options.gaveUp?.();
      return;
    }
    const delays = this.options.delaysMs ?? DEFAULT_DELAYS_MS;
    const delay = delays[Math.min(this.restarts.length, delays.length - 1)]!;
    this.restarts.push(now);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.wanted) void this.launch();
    }, delay);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Whether the runner gave up restarting until the owner starts it; true once, from the moment it does. */
  get exhausted(): boolean {
    return this.gaveUp && this.stateValue === 'failed';
  }
}
