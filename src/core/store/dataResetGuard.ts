import { lstatSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { BOT_DATA_RESET_JOURNAL } from '../../shared/dataReset.ts';

/** A reset's durable fence also applies to headless core and init entry points.
 * Keep this independent of Electron. A failed purge must not revive old bots.
 */
export function assertBotDataResetNotPending(botRoot: string): void {
  const container = dirname(resolve(botRoot));
  if (!['bots', 'archive', 'trash'].includes(basename(container))) return;
  if (lstatSync(join(dirname(container), BOT_DATA_RESET_JOURNAL), { throwIfNoEntry: false })) {
    throw new Error('Cats Bot data reset is pending. Reopen Cats Bot to finish it before starting or changing bots.');
  }
}
