import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyProfilePatch, createProfile } from '../../src/core/profile/profile.ts';
import { assertHostedProviderPolicy, assertPolicyBoundary } from '../../src/core/runtime/providerPolicy.ts';
import type { BotProfile, ExecutionAccess, SessionExecutionPolicy } from '../../src/core/types.ts';
import {
  askChoices,
  carryChoice,
  currentChoice,
  defaultChoice,
  desktopControlAllowed,
  permissionPatch,
  permissionSummary,
  reachOf,
  withAsk,
  withDesktopControl,
  withLevel,
  type PermissionChoice,
  type StoredPermissions,
} from '../../src/renderer/settings/permissionChoices.ts';
import { HOSTED_PROVIDER_POLICY } from '../../src/shared/providerTools.ts';

/** ADR-030: two questions, only choices Runtime admits, and every stored combination is one choice. */

const now = new Date('2026-11-16T10:00:00.000Z');
const PROVIDERS = ['claude', 'codex', 'antigravity', 'grok', 'muse', 'kimi'];
const ACCESS: ExecutionAccess[] = ['read-only', 'workspace-write', 'full-access'];

function policies(provider: string): Array<SessionExecutionPolicy | null> {
  if (provider === 'kimi') return [structuredClone(HOSTED_PROVIDER_POLICY)];
  if (provider !== 'claude' && provider !== 'codex') return [null, structuredClone(HOSTED_PROVIDER_POLICY)];
  const out: Array<SessionExecutionPolicy | null> = [null];
  for (const access of ACCESS) {
    for (const network of [false, true]) {
      out.push({ version: 1, mode: 'provider', constraints: { maxAccess: access, network } });
      if (access === 'read-only' && network || access === 'full-access' && !network) continue;
      for (const approval of ['never', 'untrusted', 'on-request'] as const) out.push({ version: 1, mode: 'explicit', access, network, approval });
    }
  }
  return out;
}

/** Every stored combination the core accepts for a provider. */
function storedStates(provider: string): StoredPermissions[] {
  const out: StoredPermissions[] = [];
  for (const providerPolicy of policies(provider)) {
    for (const workspaceAccess of ['read_write', 'read_only'] as const) {
      for (const permissionMode of ['default', 'skip'] as const) {
        try { assertPolicyBoundary(providerPolicy, { workspaceAccess, permissionMode, cwd: '/w' }); } catch { continue; }
        out.push({ provider, providerPolicy, workspaceAccess, permissionMode });
      }
    }
  }
  return out;
}

function profileOf(stored: StoredPermissions): BotProfile {
  const base = createProfile({ id: 'p', name: 'P', provider: stored.provider === 'kimi' ? 'codex' : stored.provider, cwd: '/w', now });
  return { ...base, executionTarget: { provider: stored.provider, model: null }, providerPolicy: stored.providerPolicy,
    permissions: { workspaceAccess: stored.workspaceAccess, permissionMode: stored.permissionMode, cwd: '/w' } };
}
const storedOf = (profile: BotProfile): StoredPermissions => ({ provider: profile.executionTarget.provider, providerPolicy: profile.providerPolicy,
  workspaceAccess: profile.permissions.workspaceAccess, permissionMode: profile.permissions.permissionMode });

/** Every choice a provider offers, with Codex's levels and network drawn every way. */
function choicesFor(provider: string): PermissionChoice[] {
  const out: PermissionChoice[] = [];
  for (const ask of askChoices(provider)) {
    const choice = withAsk(provider, defaultChoice(provider), ask);
    if (provider === 'codex' && (ask === 'fence' || ask === 'cli')) {
      for (const level of ACCESS) {
        if (ask === 'fence' && level === 'full-access') continue;
        const at = withLevel(choice, level);
        out.push(at);
        if (level === 'workspace-write') for (const network of ask === 'fence' ? [null, true, false] : [true, false]) out.push({ ...at, network });
        // Codex's limit that still asks before tools (desktop control), as the earlier page stored it.
        if (ask === 'fence') out.push(withDesktopControl('codex', at), ...(level === 'workspace-write' ? [{ ...withDesktopControl('codex', at), network: true }] : []));
      }
    } else out.push(choice);
  }
  return out;
}

test('every stored combination reads as one offered choice, and saving it untouched sends nothing (ADR-030)', () => {
  for (const provider of PROVIDERS) {
    for (const stored of storedStates(provider)) {
      const choice = currentChoice(stored);
      assert.ok(askChoices(provider).includes(choice.ask), `${provider} ${JSON.stringify(stored)}`);
      assert.equal(permissionPatch(stored, provider, choice), null, `${provider} ${JSON.stringify(stored)}`);
    }
  }
});

test('a new cat bot reads as its provider\'s default, so the default is not changed (ADR-030)', () => {
  for (const provider of PROVIDERS) {
    const profile = createProfile({ name: 'N', provider, cwd: '/w', now });
    assert.deepEqual(currentChoice(storedOf(profile)), defaultChoice(provider), provider);
  }
});

test('every offered choice saves from every starting point, on the same or another provider, and reads back as itself (ADR-030)', () => {
  for (const from of PROVIDERS) {
    for (const stored of storedStates(from)) {
      for (const to of PROVIDERS) {
        for (const choice of choicesFor(to)) {
          const label = `${JSON.stringify(stored)} -> ${to} ${JSON.stringify(choice)}`;
          const patch = permissionPatch(stored, to, choice);
          const target = from === to ? {} : { executionTarget: { provider: to, model: null } };
          const next = applyProfilePatch(profileOf(stored), { ...target, ...(patch ?? {}) }, now).profile;
          assert.doesNotThrow(() => assertHostedProviderPolicy(to, next.providerPolicy), label);
          // Claude Code and the hosted CLIs admit only the whole computer with the network (Runtime).
          if (next.providerPolicy && to !== 'codex') {
            const access = next.providerPolicy.mode === 'explicit' ? next.providerPolicy.access : next.providerPolicy.constraints.maxAccess;
            const network = next.providerPolicy.mode === 'explicit' ? next.providerPolicy.network : next.providerPolicy.constraints.network;
            assert.deepEqual([access, network], ['full-access', true], label);
          }
          assert.deepEqual(currentChoice(storedOf(next)), choice, label);
        }
      }
    }
  }
});

test('a choice carried to another provider stays a default, or the nearest it offers (ADR-030)', () => {
  for (const from of PROVIDERS) {
    for (const to of PROVIDERS) {
      assert.deepEqual(carryChoice(defaultChoice(from), from, to), defaultChoice(to), `${from} -> ${to}`);
      for (const choice of choicesFor(from)) {
        assert.ok(askChoices(to).includes(carryChoice(choice, from, to).ask), `${from} ${JSON.stringify(choice)} -> ${to}`);
      }
    }
  }
  assert.equal(carryChoice({ ask: 'ask', level: 'full-access', network: true }, 'claude', 'codex').ask, 'ask');
  assert.equal(carryChoice({ ask: 'readonly', level: 'read-only', network: false }, 'claude', 'codex').level, 'read-only');
});

test('a Codex limit that asks before tools reads as itself, keeps desktop control and is not rewritten (ADR-030, SPEC-006 BDC-04)', () => {
  // The earlier page's desktop-control setup for Codex: an explicit sandbox that asks.
  for (const approval of ['on-request', 'untrusted'] as const) {
    const stored: StoredPermissions = { provider: 'codex', workspaceAccess: 'read_write', permissionMode: 'default',
      providerPolicy: { version: 1, mode: 'explicit', access: 'workspace-write', network: false, approval } };
    const choice = currentChoice(stored);
    assert.deepEqual(choice, { ask: 'fence', level: 'workspace-write', network: false, toolsAsk: true });
    assert.equal(desktopControlAllowed('codex', choice), true);
    assert.equal(permissionPatch(stored, 'codex', choice), null, 'untouched, nothing is rewritten');
    assert.match(permissionSummary('Mochi', 'codex', 'Codex', 'work', choice), /before it uses a tool/u);
  }
  // Turning desktop control on inside the limit makes it ask before tools, with the network Bot then sets.
  const plain = currentChoice({ provider: 'codex', workspaceAccess: 'read_write', permissionMode: 'default', providerPolicy: null });
  assert.equal(desktopControlAllowed('codex', plain), false);
  assert.deepEqual(withDesktopControl('codex', plain), { ask: 'fence', level: 'workspace-write', network: false, toolsAsk: true });
});

test('desktop control only with Ask me first; the drawing is fixed wherever the provider fixes it (ADR-030, SPEC-006 BDC-04)', () => {
  for (const provider of PROVIDERS) {
    for (const choice of choicesFor(provider)) {
      assert.equal(desktopControlAllowed(provider, choice), (provider === 'claude' || provider === 'codex') && choice.ask === 'ask'
        || provider === 'codex' && choice.ask === 'fence' && choice.toolsAsk === true);
      const reach = reachOf(provider, provider, choice);
      if (choice.ask === 'legacy') assert.equal(reach, null);
      else if (provider !== 'codex' || choice.ask === 'ask' || choice.ask === 'never') assert.equal(reach?.locked, true, `${provider} ${choice.ask}`);
    }
  }
  assert.equal(reachOf('codex', 'Codex', { ask: 'fence', level: 'workspace-write', network: null })?.wholeComputer, false);
});
