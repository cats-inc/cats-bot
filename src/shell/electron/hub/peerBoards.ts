import type { RemoteBotCore } from '../../../core/host-api/remote.ts';
import type { BotWorkBoard } from '../../../core/types.ts';
import { diagnosticError } from '../../../shared/diagnosticLog.ts';
import { BOARD_TIMEOUT_MS, readWorkBoard } from './bossCatBroker.ts';

/**
 * SPEC-012 FR-10 / FR-12: every minute, and as soon as the role or a switch
 * changes, the hub hands the Boss Cat's core the other bots' boards. Only
 * running bots whose owner lets the Boss Cat see them are asked; the holder's
 * own board is never sent, and a board that names another bot is dropped.
 * Passes never overlap, and no core can hold one up for longer than the board
 * timeout.
 */

export const PEER_BOARDS_INTERVAL_MS = 60_000;

export interface PeerBoardsDeps {
  holder(): string | null;
  bots(): Array<{ id: string; name: string; state: string }>;
  core(id: string): RemoteBotCore | null;
  sees(id: string): boolean;
  log(line: string, level?: 'info' | 'warn' | 'error'): void;
  intervalMs?: number;
}

function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), BOARD_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

export class PeerBoardsPusher {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private readonly deps: PeerBoardsDeps;

  constructor(deps: PeerBoardsDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.push(), this.deps.intervalMs ?? PEER_BOARDS_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass now; a call made during a pass runs one more pass after it. */
  push(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.pass().finally(() => {
      this.running = null;
      if (this.again) {
        this.again = false;
        void this.push();
      }
    });
    return this.running;
  }

  private async pass(): Promise<void> {
    const holder = this.deps.holder();
    const target = holder ? this.deps.core(holder) : null;
    if (!holder || !target) return;
    const bots = this.deps.bots()
      .filter((bot) => bot.id !== holder && bot.state !== 'archived' && this.deps.sees(bot.id));
    const boards = (await Promise.all(bots.map(async ({ id, name }): Promise<BotWorkBoard | null> => {
      const core = this.deps.core(id);
      if (!core) return null;
      try {
        return await readWorkBoard({ id, name, core });
      } catch (error) {
        this.deps.log(`Boss Cat: ${id} gave no status board: ${diagnosticError(error)}`, 'warn');
        return null;
      }
    }))).filter((board): board is BotWorkBoard => board !== null);
    // The role may have moved while the boards were read.
    if (this.deps.holder() !== holder) return;
    try {
      await withTimeout(Promise.resolve(target.setPeerBoards(boards)));
    } catch (error) {
      this.deps.log(`Boss Cat: the other bots' boards did not reach ${holder}: ${diagnosticError(error)}`, 'warn');
    }
  }
}
