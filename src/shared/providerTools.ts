import type { SessionExecutionPolicy } from '../core/types.ts';

export const HOSTED_TOOL_PROVIDERS: readonly string[] = ['antigravity', 'grok', 'muse', 'kimi'];
/**
 * ADR-025: providers a bot runs only through their hosted target. Kimi's print mode approves every
 * tool without asking, including its computer-use plugin; its hosted `kimi acp` target asks.
 */
export const HOSTED_ONLY_PROVIDERS: readonly string[] = ['kimi'];
/** The one policy a hosted target admits (Runtime ADR-049): full machine and network access, approvals native. */
export const HOSTED_PROVIDER_POLICY: SessionExecutionPolicy = Object.freeze({ version: 1, mode: 'provider',
  constraints: Object.freeze({ maxAccess: 'full-access', network: true }) }) as SessionExecutionPolicy;

export function usesHostedProvider(provider: string, policy: SessionExecutionPolicy | null): boolean {
  return policy !== null && HOSTED_TOOL_PROVIDERS.includes(provider);
}
export function providerCanOfferSessionTools(provider: string, policy: SessionExecutionPolicy | null): boolean {
  // Google's ACP credential persistence is not yet verified. Native tools still work.
  return provider !== 'antigravity' && (!HOSTED_TOOL_PROVIDERS.includes(provider) || usesHostedProvider(provider, policy));
}

/**
 * ADR-025: the policy a profile runs with. A hosted-only provider without a policy gets the hosted
 * policy. Leaving it keeps that policy: the next provider then follows its own native approvals,
 * and a bot never falls back to a legacy mode (which may be `skip`) the owner left behind.
 */
export function requiredProviderPolicy(provider: string, policy: SessionExecutionPolicy | null): SessionExecutionPolicy | null {
  return HOSTED_ONLY_PROVIDERS.includes(provider) ? policy ?? structuredClone(HOSTED_PROVIDER_POLICY) : policy;
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
