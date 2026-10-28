import type { SessionCapabilitiesSnapshot } from '../types.ts';

export type DesktopControlPolicyVerdict = { ok: true } | { ok: false; reason: string };

/**
 * SPEC-006 BDC-04 / SPEC-133 DC-04: inject only when Runtime's report for the session shows
 * that injected MCP tools will ask the owner. `not_observed` passes because Runtime verifies
 * the policy before it releases the first turn and fails a mismatched one. Everything else,
 * including a missing snapshot, fails closed.
 */
export function evaluateDesktopControlPolicy(snapshot: SessionCapabilitiesSnapshot | null | undefined): DesktopControlPolicyVerdict {
  const observation = snapshot?.supported ? snapshot.observation : undefined;
  if (!observation) return { ok: false, reason: 'policy_unknown' };
  if (!observation.interactions?.host?.kinds?.includes('tool_approval')
    || !observation.interactions.supported?.includes('tool_approval')) {
    return { ok: false, reason: 'no_tool_approval_host' };
  }
  const policy = observation.policy;
  const requested = policy?.requested;
  if (policy?.source !== 'explicit' || requested?.mode !== 'explicit') return { ok: false, reason: 'policy_not_explicit' };
  if (requested.approval !== 'on-request' && requested.approval !== 'untrusted') {
    return { ok: false, reason: 'policy_preapproves_tools' };
  }
  if (policy.status !== 'verified' && policy.status !== 'not_observed') return { ok: false, reason: `policy_${policy.status}` };
  return { ok: true };
}
