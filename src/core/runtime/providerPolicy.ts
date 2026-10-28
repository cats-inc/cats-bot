import type { BotPermissions, InteractionHost, SessionExecutionPolicy } from '../types.ts';

export const INTERACTION_HOST: InteractionHost = {
  version: 1,
  kinds: ['command_approval', 'file_approval', 'permission_grant', 'user_input', 'mcp_form', 'mcp_url'],
  timeoutMs: 30 * 60_000,
};

/** Reject unknown policy variants instead of silently falling back to legacy access. */
export function parseProviderPolicy(value: unknown): SessionExecutionPolicy | null {
  if (value === null) return null;
  const fail = (): never => { throw new Error('Invalid provider policy; existing settings were preserved.'); };
  const record = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v)
    ? v as Record<string, unknown> : null;
  const p = record(value);
  const access = (v: unknown) => typeof v === 'string' && ['read-only', 'workspace-write', 'full-access'].includes(v);
  if (!p || p.version !== 1) return fail();
  if (p.mode === 'provider') {
    const c = record(p.constraints);
    if (Object.keys(p).some(k => !['version', 'mode', 'constraints'].includes(k)) || !c
      || Object.keys(c).some(k => !['maxAccess', 'network'].includes(k)) || !access(c.maxAccess)
      || typeof c.network !== 'boolean') return fail();
  } else if (p.mode !== 'explicit' || Object.keys(p).some(k => !['version', 'mode', 'access', 'network', 'approval'].includes(k))
    || !access(p.access) || typeof p.network !== 'boolean' || typeof p.approval !== 'string'
    || !['never', 'untrusted', 'on-request'].includes(p.approval)
    || p.access === 'read-only' && p.network || p.access === 'full-access' && !p.network) return fail();
  return structuredClone(p) as SessionExecutionPolicy;
}

export function assertPolicyBoundary(policy: SessionExecutionPolicy | null, permissions: BotPermissions): void {
  if (!policy) return;
  const access = policy.mode === 'provider' ? policy.constraints.maxAccess : policy.access;
  if (permissions.allowedTools?.length || permissions.permissionMode === 'whitelist'
    || permissions.workspaceAccess === 'read_only' && access !== 'read-only') {
    throw new Error('Provider policy cannot exceed the read-only workspace or replace a tool allowlist.');
  }
}
