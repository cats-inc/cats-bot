import type { BotHostEvent, DesktopControlState } from '../types.ts';
import type { HostChannelClient } from './channel.ts';
import { CHANNEL_COMMANDS, type CoreCommand, type CoreCommandTarget } from './commands.ts';

/**
 * PLAN-009 1.3: a core in another process, called like `BotCore` through its
 * host channel. Every command answers asynchronously, including the ones the
 * in-process core answered at once (status, transcripts, work items).
 */

type Remote<F> = F extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never;

export type RemoteBotCore = { [K in Exclude<CoreCommand, 'stopAllDesktopControl'>]: Remote<CoreCommandTarget[K]> } & {
  /** Every conversation's desktop control, as the tray stops it (SPEC-006 BDC-10). */
  stopAllDesktopControl(): Promise<DesktopControlState>;
  subscribe(listener: (event: BotHostEvent) => void): () => void;
};

export function remoteBotCore(client: HostChannelClient): RemoteBotCore {
  const core: Record<string, unknown> = {
    subscribe: (listener: (event: BotHostEvent) => void) => client.onEvent((event) => listener(event)),
  };
  for (const command of CHANNEL_COMMANDS) core[command] = (...args: unknown[]) => client.call(command, ...args);
  return core as RemoteBotCore;
}
