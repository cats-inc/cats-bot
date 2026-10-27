/**
 * Public surface of the bot core. Hosts (the headless CLI today, the Electron
 * shell later) depend only on what is exported from here.
 */
export type * from './core/types.ts';
export {
  BotCore,
  BotInstanceRunningError,
  BotNotInitializedError,
  initializeBot,
  type BotCoreOptions,
  type BotRuntimeOptions,
  type BotStatus,
  type InitializeBotInput,
} from './core/bot.ts';
export { botPathsFor, resolveBotRoot, resolveBotsHome, type BotPaths } from './core/store/paths.ts';
export { readInstanceLock, writeHandoff } from './core/store/lock.ts';
export { buildHandoffPack, HANDOFF_PACK_LIMIT } from './core/conversations/handoff.ts';
