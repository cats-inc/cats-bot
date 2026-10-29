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
export {
  assertValidBotId, BOT_ID_RULE, botPathsFor, InvalidBotIdError, isValidBotId, resolveBotRoot, resolveBotsHome, resolveCatsBotHome, type BotPaths,
} from './core/store/paths.ts';
export { readInstanceLock, writeHandoff } from './core/store/lock.ts';
export { buildHandoffPack, HANDOFF_PACK_LIMIT } from './core/conversations/handoff.ts';
export {
  CHANNEL_PROTOCOL, channelDescriptorFile, HostChannelClient, HostChannelServer, readChannelDescriptor,
  type ChannelDescriptor, type ChannelHostIdentity, type ChannelHostServices,
} from './core/host-api/channel.ts';
export { CHANNEL_COMMANDS, CORE_COMMANDS, runCoreCommand, type CoreCommandTarget } from './core/host-api/commands.ts';
