import { t } from '../localeStore.ts';
import { HOSTED_PROVIDER_POLICY, HOSTED_TOOL_PROVIDERS } from '../../shared/providerTools.ts';
import type { BotPermissions, ExecutionAccess, SessionExecutionPolicy } from '../../core/types.ts';

/**
 * ADR-030: the Permissions tab asks two things, whether the cat bot asks before it acts and
 * what it can reach, and offers each provider only what Runtime admits for it. Every stored
 * combination reads as exactly one choice, and a choice is written back as the stored values
 * that already mean it, so the defaults stay what they were. Apart from React, for node:test.
 */

export type AskChoice = 'ask' | 'cli' | 'readonly' | 'fence' | 'never' | 'legacy';

export interface PermissionChoice {
  ask: AskChoice;
  /** What it can reach; for Codex's limit and ceiling, the level the owner draws. */
  level: ExecutionAccess;
  /** Null when Bot sets nothing and the CLI's own setting applies (Codex's default). */
  network: boolean | null;
}

/** The profile fields a choice is stored in. */
export interface StoredPermissions {
  provider: string;
  providerPolicy: SessionExecutionPolicy | null;
  workspaceAccess: BotPermissions['workspaceAccess'];
  permissionMode: BotPermissions['permissionMode'];
}

const CLAUDE_CHOICES: readonly AskChoice[] = ['ask', 'cli', 'readonly', 'never'];
const CODEX_CHOICES: readonly AskChoice[] = ['ask', 'fence', 'cli', 'never'];

/** What a provider offers, in the order the owner reads them. */
export function askChoices(provider: string): readonly AskChoice[] {
  if (provider === 'claude') return CLAUDE_CHOICES;
  if (provider === 'codex') return CODEX_CHOICES;
  if (provider === 'kimi') return ['cli'];
  if (HOSTED_TOOL_PROVIDERS.includes(provider)) return ['cli', 'legacy'];
  return ['legacy'];
}

const FULL: Pick<PermissionChoice, 'level' | 'network'> = { level: 'full-access', network: true };

/** What a new cat bot on this provider starts with: the profile's own defaults. */
export function defaultChoice(provider: string): PermissionChoice {
  if (provider === 'claude' || provider === 'kimi') return { ask: 'cli', ...FULL };
  if (provider === 'codex') return { ask: 'fence', level: 'workspace-write', network: null };
  return { ask: 'legacy', ...FULL };
}

/** The one choice a stored combination reads as. */
export function currentChoice(stored: StoredPermissions): PermissionChoice {
  const { provider, providerPolicy: policy } = stored;
  const readOnly = stored.workspaceAccess === 'read_only';
  if (provider === 'claude') {
    // A policy Claude Code cannot hold (only the whole computer with the network) keeps its level,
    // so it differs from every offered choice and the next save replaces it.
    if (policy?.mode === 'explicit') return { ask: policy.approval === 'never' ? 'never' : 'ask', level: policy.access, network: policy.network };
    if (policy?.mode === 'provider') return { ask: 'cli', level: policy.constraints.maxAccess, network: policy.constraints.network };
    if (readOnly) return { ask: 'readonly', level: 'read-only', network: false };
    return { ask: stored.permissionMode === 'skip' ? 'never' : 'cli', ...FULL };
  }
  if (provider === 'codex') {
    if (policy?.mode === 'explicit') {
      if (policy.access === 'full-access') return { ask: policy.approval === 'never' ? 'never' : 'ask', ...FULL };
      return { ask: 'fence', level: policy.access, network: policy.access === 'read-only' ? false : policy.network };
    }
    if (policy?.mode === 'provider') {
      const level = policy.constraints.maxAccess;
      return { ask: 'cli', level, network: level === 'read-only' ? false : level === 'full-access' ? true : policy.constraints.network };
    }
    // Runtime runs a Codex session without a policy in its sandbox, never asking (skip or default alike).
    return readOnly ? { ask: 'fence', level: 'read-only', network: false } : { ask: 'fence', level: 'workspace-write', network: null };
  }
  if (provider === 'kimi') return { ask: 'cli', ...FULL };
  if (HOSTED_TOOL_PROVIDERS.includes(provider) && policy) return { ask: 'cli', ...FULL };
  return { ask: 'legacy', ...FULL };
}

export function sameChoice(a: PermissionChoice, b: PermissionChoice): boolean {
  return a.ask === b.ask && a.level === b.level && a.network === b.network;
}

/** A choice made for another provider, carried to the one now chosen: a default stays a default. */
export function carryChoice(choice: PermissionChoice, from: string, to: string): PermissionChoice {
  if (from === to) return choice;
  if (sameChoice(choice, defaultChoice(from))) return defaultChoice(to);
  const offered = askChoices(to);
  if (to === 'claude' || to === 'codex') {
    if (choice.ask === 'ask' || choice.ask === 'never') return { ask: choice.ask, ...FULL };
    if (choice.ask === 'readonly' || (choice.ask === 'fence' && choice.level === 'read-only')) {
      return to === 'claude' ? { ask: 'readonly', level: 'read-only', network: false } : { ask: 'fence', level: 'read-only', network: false };
    }
    if (choice.ask === 'fence') return to === 'codex' ? choice : defaultChoice(to);
    if (choice.ask === 'cli' && HOSTED_TOOL_PROVIDERS.includes(from)) return { ask: 'cli', ...FULL };
    return defaultChoice(to);
  }
  if (offered.includes('cli') && (choice.ask === 'ask' || choice.ask === 'never' || choice.ask === 'cli')) return { ask: 'cli', ...FULL };
  return defaultChoice(to);
}

/** A choice as the stored values that mean it. */
function storedFor(provider: string, choice: PermissionChoice, current: StoredPermissions): Omit<StoredPermissions, 'provider'> {
  const plain = { workspaceAccess: 'read_write' as const, permissionMode: 'default' as const };
  const explicit = (access: ExecutionAccess, network: boolean, approval: 'never' | 'untrusted' | 'on-request'): SessionExecutionPolicy =>
    ({ version: 1, mode: 'explicit', access, network, approval });
  if (provider === 'claude') {
    if (choice.ask === 'ask') return { providerPolicy: explicit('full-access', true, 'on-request'), ...plain };
    if (choice.ask === 'never') return { providerPolicy: explicit('full-access', true, 'never'), ...plain };
    if (choice.ask === 'readonly') return { providerPolicy: null, workspaceAccess: 'read_only', permissionMode: 'default' };
    return { providerPolicy: null, ...plain };
  }
  if (provider === 'codex') {
    if (choice.ask === 'ask') return { providerPolicy: explicit('full-access', true, 'untrusted'), ...plain };
    if (choice.ask === 'never') return { providerPolicy: explicit('full-access', true, 'never'), ...plain };
    if (choice.ask === 'cli') {
      const network = choice.level === 'read-only' ? false : choice.level === 'full-access' ? true : choice.network === true;
      return { providerPolicy: { version: 1, mode: 'provider', constraints: { maxAccess: choice.level, network } }, ...plain };
    }
    if (choice.level === 'read-only') return { providerPolicy: null, workspaceAccess: 'read_only', permissionMode: 'default' };
    if (choice.network === null) return { providerPolicy: null, ...plain };
    return { providerPolicy: explicit('workspace-write', choice.network, 'never'), ...plain };
  }
  if (choice.ask === 'cli') return { providerPolicy: structuredClone(HOSTED_PROVIDER_POLICY), ...plain };
  // Without native tools, the CLI keeps whatever legacy settings it had.
  return { providerPolicy: null, workspaceAccess: current.workspaceAccess, permissionMode: current.permissionMode };
}

export interface PermissionPatch {
  providerPolicy?: SessionExecutionPolicy | null;
  permissions?: Partial<Pick<BotPermissions, 'workspaceAccess' | 'permissionMode'>>;
}

/**
 * Only what differs. An unchanged choice on an unchanged provider sends nothing, so nothing is
 * rewritten and no session is replaced. With a new provider the policy always goes too: left
 * out, the core would keep or drop the old one by its own rules (ADR-025).
 */
export function permissionPatch(stored: StoredPermissions, provider: string, choice: PermissionChoice): PermissionPatch | null {
  if (provider === stored.provider && sameChoice(choice, currentChoice(stored))) return null;
  const next = storedFor(provider, choice, stored);
  const patch: PermissionPatch = {};
  if (provider !== stored.provider || JSON.stringify(next.providerPolicy) !== JSON.stringify(stored.providerPolicy)) {
    patch.providerPolicy = next.providerPolicy;
  }
  const permissions: PermissionPatch['permissions'] = {};
  if (next.workspaceAccess !== stored.workspaceAccess) permissions.workspaceAccess = next.workspaceAccess;
  if (next.permissionMode !== stored.permissionMode) permissions.permissionMode = next.permissionMode;
  if (Object.keys(permissions).length) patch.permissions = permissions;
  return Object.keys(patch).length ? patch : null;
}

/** SPEC-006 BDC-04: desktop control needs a policy that asks before each action. */
export function desktopControlAllowed(provider: string, choice: PermissionChoice): boolean {
  return (provider === 'claude' || provider === 'codex') && choice.ask === 'ask';
}

/** The choice moved to another level, keeping what the level allows of the network. */
export function withLevel(choice: PermissionChoice, level: ExecutionAccess): PermissionChoice {
  const network = level === 'read-only' ? false : level === 'full-access' ? true
    : choice.network === null ? (choice.ask === 'cli' ? false : null) : choice.network;
  return { ...choice, level, network };
}

/** A choice picked from the list, keeping the level and network where they still apply. */
export function withAsk(provider: string, choice: PermissionChoice, ask: AskChoice): PermissionChoice {
  if (ask === 'readonly') return { ask, level: 'read-only', network: false };
  if (ask === 'fence') {
    if (choice.ask === 'cli' && choice.level !== 'full-access') return { ask, level: choice.level, network: choice.network };
    return defaultChoice('codex');
  }
  if (ask === 'cli' && provider === 'codex') {
    if (choice.ask === 'fence') return { ask, level: choice.level, network: choice.network === true };
    return { ask, ...FULL };
  }
  return { ask, ...FULL };
}

// ---- Words --------------------------------------------------------------------

export function askTitle(provider: string, label: string, ask: AskChoice): string {
  switch (ask) {
    case 'ask': return t('Ask me first');
    case 'cli': return t('Follow {provider}\'s own settings', { provider: label });
    case 'readonly': return t('Read, never change');
    case 'fence': return t('Work inside the limit');
    case 'never': return t('Never ask');
    case 'legacy': return HOSTED_TOOL_PROVIDERS.includes(provider) ? t('Without native tools') : t('Follow {provider}\'s own settings', { provider: label });
  }
}

export function askDetail(provider: string, label: string, ask: AskChoice): string {
  switch (ask) {
    case 'ask':
      return provider === 'codex'
        ? t('Safe read-only commands run; every other command asks you in the conversation first.')
        : t('It asks you in the conversation before it edits a file, runs a command or uses a tool.');
    case 'cli':
      if (provider === 'claude') return t('Uses the mode you chose in Claude Code, such as auto. When it asks, the question appears in the conversation.');
      if (provider === 'codex') return t('Uses your Codex configuration, but never goes past the limit below.');
      if (provider === 'kimi') return t('The first time it runs a command, edits a file or uses the computer, it asks in the conversation. Choose "Allow for this conversation" or "Allow for 30 minutes" there to stop being asked for that kind. Telegram messages, heartbeats and schedules always ask.');
      return t('Turns on {provider}\'s native tools: files, commands and the network. Requests that need your approval appear in the conversation.', { provider: label });
    case 'readonly': return t('It reads files in its filespace. Edits and commands are refused without asking you.');
    case 'fence': return t('It works on its own inside the limit below. Anything outside it fails, without asking you.');
    case 'never': return t('It can use the whole computer and the network, and never asks you.');
    case 'legacy': return HOSTED_TOOL_PROVIDERS.includes(provider) ? t('Keeps the CLI\'s default tool settings.') : '';
  }
}

export interface Reach {
  level: ExecutionAccess;
  network: boolean | null;
  /** Fixed by the choice or the provider; the drawing only shows it. */
  locked: boolean;
  /** Codex's limit cannot be the whole computer: that is Ask me first or Never ask. */
  wholeComputer: boolean;
  note: string;
}

/** What the reach drawing shows, or null when there is nothing Bot sets. */
export function reachOf(provider: string, label: string, choice: PermissionChoice): Reach | null {
  if (choice.ask === 'legacy') return null;
  if (provider === 'claude') {
    if (choice.ask === 'readonly') return { level: 'read-only', network: false, locked: true, wholeComputer: false, note: '' };
    return { ...FULL, locked: true, wholeComputer: true, note: t('Claude Code has no sandbox, so this is always the whole computer and the network.') };
  }
  if (provider === 'codex') {
    if (choice.ask === 'ask') return { ...FULL, locked: true, wholeComputer: true, note: t('Approval requests reach you only with the whole computer and the network.') };
    if (choice.ask === 'never') return { ...FULL, locked: true, wholeComputer: true, note: '' };
    if (choice.ask === 'fence') return { level: choice.level, network: choice.network, locked: false, wholeComputer: false, note: t('Codex\'s sandbox stops anything outside this.') };
    return { level: choice.level, network: choice.network, locked: false, wholeComputer: true, note: t('This is the limit: Codex\'s own settings never go past it.') };
  }
  return { ...FULL, locked: true, wholeComputer: true, note: t('{provider} sets its own reach.', { provider: label }) };
}

/** The sentence at the top of the tab: what the cat bot can do, in plain words. */
export function permissionSummary(name: string, provider: string, label: string, folder: string, choice: PermissionChoice): string {
  const values = { name, folder, provider: label };
  switch (choice.ask) {
    case 'ask':
      return provider === 'codex'
        ? t('{name} can use the whole computer and the network. Safe read-only commands run; it asks you in the conversation before any other command.', values)
        : t('{name} can use the whole computer and the network. It asks you in the conversation before it edits a file, runs a command or uses a tool.', values);
    case 'readonly': return t('{name} can only read files in the {folder} folder. Edits and commands are refused without asking you.', values);
    case 'never': return t('{name} can use the whole computer and the network, and never asks you.', values);
    case 'fence':
      if (choice.level === 'read-only') return t('{name} reads files in the {folder} folder on its own. Anything else fails, without asking you.', values);
      if (choice.network === true) return t('{name} reads and edits files in the {folder} folder and uses the network on its own. Anything else fails, without asking you.', values);
      if (choice.network === false) return t('{name} reads and edits files in the {folder} folder on its own, without the network. Anything else fails, without asking you.', values);
      return t('{name} reads and edits files in the {folder} folder on its own. Anything outside it fails, without asking you.', values);
    case 'cli':
      if (provider === 'codex') {
        if (choice.level === 'read-only') return t('{name} follows your Codex settings, but can at most read files in the {folder} folder.', values);
        if (choice.level === 'full-access') return t('{name} follows your Codex settings, up to the whole computer and the network.', values);
        return choice.network
          ? t('{name} follows your Codex settings, but can at most edit files in the {folder} folder and use the network.', values)
          : t('{name} follows your Codex settings, but can at most edit files in the {folder} folder, without the network.', values);
      }
      if (provider === 'claude') return t('{name} follows your Claude Code settings and can use the whole computer and the network. When Claude Code asks, the question appears in the conversation.', values);
      if (provider === 'kimi') return t('{name} follows Kimi Code\'s own settings and can use the whole computer and the network. It asks in the conversation the first time it runs a command, edits a file or uses the computer.', values);
      return t('{name} uses {provider}\'s native tools and can use the whole computer and the network. Requests that need your approval appear in the conversation.', values);
    case 'legacy':
      return HOSTED_TOOL_PROVIDERS.includes(provider)
        ? t('{name} keeps the CLI\'s default tool settings, without {provider}\'s native tools.', values)
        : t('{name} follows {provider}\'s own settings.', values);
  }
}

/** The folder's own name, for the sentence; the full path is in the field below it. */
export function folderName(cwd: string): string {
  const parts = cwd.split(/[\\/]+/u).filter(Boolean);
  return parts.at(-1) ?? cwd;
}
