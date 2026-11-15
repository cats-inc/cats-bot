import type { SessionExecutionPolicy } from '../core/types.ts';

export const HOSTED_TOOL_PROVIDERS: readonly string[] = ['antigravity', 'grok', 'muse'];
export function usesHostedProvider(provider: string, policy: SessionExecutionPolicy | null): boolean {
  return policy !== null && HOSTED_TOOL_PROVIDERS.includes(provider);
}
export function providerCanOfferSessionTools(provider: string, policy: SessionExecutionPolicy | null): boolean {
  // Google's ACP credential persistence is not yet verified. Native tools still work.
  return provider !== 'antigravity' && (!HOSTED_TOOL_PROVIDERS.includes(provider) || usesHostedProvider(provider, policy));
}

/**
 * SPEC-009 FR-11: the holder's `cats-hub` tools. `pending` until its provider fetches them at the holder's
 * next send (FR-3), `connected` after; `needsAccess` for a hosted provider whose access is not set yet, and
 * `unsupported` for one that cannot take them at all. Only a core the hub runs hears that it holds the role:
 * `notRunning` waits for the bot to start, and a core another program runs (`external`) never gets them.
 */
export type BossCatToolsState = 'connected' | 'pending' | 'notRunning' | 'external' | 'needsAccess' | 'unsupported';
export type BossCatHosting = 'hub' | 'external' | 'none';
export function bossCatToolsState(provider: string, policy: SessionExecutionPolicy | null, hosting: BossCatHosting,
  discovered: boolean): BossCatToolsState {
  if (provider === 'antigravity') return 'unsupported';
  if (!providerCanOfferSessionTools(provider, policy)) return 'needsAccess';
  if (hosting === 'external') return 'external';
  if (hosting === 'none') return 'notRunning';
  return discovered ? 'connected' : 'pending';
}
