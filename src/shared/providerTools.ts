import type { SessionExecutionPolicy } from '../core/types.ts';

export const HOSTED_TOOL_PROVIDERS: readonly string[] = ['antigravity', 'grok', 'muse'];
export function usesHostedProvider(provider: string, policy: SessionExecutionPolicy | null): boolean {
  return policy !== null && HOSTED_TOOL_PROVIDERS.includes(provider);
}
export function providerCanOfferSessionTools(provider: string, policy: SessionExecutionPolicy | null): boolean {
  // Google's ACP credential persistence is not yet verified. Native tools still work.
  return provider !== 'antigravity' && (!HOSTED_TOOL_PROVIDERS.includes(provider) || usesHostedProvider(provider, policy));
}
