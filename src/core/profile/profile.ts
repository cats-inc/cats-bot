import { randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { assertPolicyBoundary, parseProviderPolicy } from '../runtime/providerPolicy.ts';
import { HOSTED_ONLY_PROVIDERS, requiredProviderPolicy } from '../../shared/providerTools.ts';
import { parseModelSelection } from '../providers/selection.ts';

import { DEFAULT_BOT_AVATAR, isBotAvatar, resolveBotAvatar, type BotAvatar } from '../../shared/avatars.ts';
import { checkedBotName, checkedBotPersona, normalizeBotName, normalizeBotPersona } from '../../shared/botText.ts';
import { clockOr, HEARTBEAT_RHYTHM_DEFAULTS, heartbeatRhythmProblem, parseClockMinutes } from '../../shared/heartbeatRhythm.ts';
import {
  BOT_REPLY_LANGUAGE_DEFAULT,
  isBotReplyLanguage,
  isHubLanguageReport,
  resolveBotReplyLanguage,
  sameHubLanguageReport,
  type HubLanguageReport,
  type ReplyLanguageCode,
} from '../../shared/language.ts';
import { readJsonFile, writeJsonAtomic } from '../store/atomicFile.ts';
import type { BotPaths } from '../store/paths.ts';
import type {
  BotEnvironment,
  BotPermissions,
  BotProfile,
  BotProfilePatch,
  DesktopControlPolicy,
  ExecutionTarget,
  HeartbeatMode,
  HeartbeatPolicy,
  PermissionMode,
  SessionExecutionPolicy,
  TelegramPolicy,
  WorkspaceAccess,
} from '../types.ts';

/** SPEC-001 FR-1 and SPEC-011 FR-1 defaults; the rhythm is Cats Desktop's. */
export const HEARTBEAT_DEFAULTS: HeartbeatPolicy = {
  enabled: true,
  mode: 'auto',
  ...HEARTBEAT_RHYTHM_DEFAULTS,
  wakeMinMinutes: 2,
  wakeMaxMinutes: 10,
  regularMinMinutes: 30,
  regularMaxMinutes: 120,
};

export const IDLE_SLEEP_MINUTES_DEFAULT = 15;

export const TELEGRAM_DEFAULTS: TelegramPolicy = { enabled: false, ownerChatId: null };

/** SPEC-006 BDC-02: desktop control is off until the owner turns it on. */
export const DESKTOP_CONTROL_DEFAULTS: DesktopControlPolicy = { enabled: false };

export const PROFILE_SCHEMA_VERSION = 2 as const;

export interface CreateProfileInput {
  id?: string;
  name: string;
  avatar?: BotAvatar;
  instructions?: string;
  provider: string;
  model?: string | null;
  modelSelection?: ExecutionTarget['modelSelection'];
  cwd: string;
  permissionMode?: PermissionMode;
  workspaceAccess?: WorkspaceAccess;
  now?: Date;
}

export function createProfile(input: CreateProfileInput): BotProfile {
  const now = (input.now ?? new Date()).toISOString();
  if (input.permissionMode !== undefined && !PERMISSION_MODES.includes(input.permissionMode)) {
    throw new Error('permissionMode must be default or skip');
  }
  const profile: BotProfile = {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    id: input.id ?? `bot-${randomUUID().slice(0, 8)}`,
    name: checkedBotName(input.name),
    avatar: input.avatar ?? DEFAULT_BOT_AVATAR,
    instructions: checkedBotPersona(input.instructions ?? ''),
    environment: { kind: 'native' },
    executionTarget: {
      provider: input.provider,
      model: input.model ?? null,
      ...(input.modelSelection
        ? { modelSelection: parseModelSelection(input.modelSelection) }
        : {}),
    },
    configRevision: 1,
    permissions: {
      workspaceAccess: input.workspaceAccess ?? 'read_write',
      permissionMode: input.permissionMode ?? 'default',
      cwd: input.cwd,
    },
    providerPolicy: requiredProviderPolicy(input.provider, null),
    ...(HOSTED_ONLY_PROVIDERS.includes(input.provider) ? { providerPolicyAuto: true as const } : {}),
    heartbeat: { ...HEARTBEAT_DEFAULTS },
    idleSleepMinutes: IDLE_SLEEP_MINUTES_DEFAULT,
    telegram: { ...TELEGRAM_DEFAULTS },
    desktopControl: { ...DESKTOP_CONTROL_DEFAULTS },
    replyLanguage: BOT_REPLY_LANGUAGE_DEFAULT,
    hubLanguage: null,
    showProgressDetails: false,
    showVerboseMessages: false,
    updatedAt: now,
  };
  // ADR-025: a hosted-only provider brings full machine access, which a read-only filespace cannot
  // hold. Refuse here rather than write a profile that would never load again.
  if (profile.providerPolicy && HOSTED_ONLY_PROVIDERS.includes(profile.executionTarget.provider)) {
    try { assertPolicyBoundary(profile.providerPolicy, profile.permissions); }
    catch { throw new Error('Kimi runs only with full machine access, so it cannot use a read-only filespace.'); }
  }
  return profile;
}

/**
 * SPEC-006 P0 decision: a missing or invalid value is off, never the fallback, so a
 * profile rewritten by an older Bot (which drops the field) turns the feature off.
 */
function normalizeDesktopControl(value: unknown): DesktopControlPolicy {
  return { enabled: isRecord(value) && value.enabled === true };
}

function normalizeTelegram(value: unknown, fallback: TelegramPolicy): TelegramPolicy {
  if (!isRecord(value)) return { ...fallback };
  const ownerChatId = value.ownerChatId;
  return {
    enabled: booleanOr(value.enabled, fallback.enabled),
    ownerChatId: typeof ownerChatId === 'number' && Number.isSafeInteger(ownerChatId)
      ? ownerChatId
      : ownerChatId === null ? null : fallback.ownerChatId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function positiveNumberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

const PERMISSION_MODES: readonly PermissionMode[] = ['skip', 'default'];
/** Read once more, only to upgrade a profile written before ADR-030. */
const READABLE_PERMISSION_MODES: readonly string[] = [...PERMISSION_MODES, 'whitelist'];
const WORKSPACE_ACCESS: readonly WorkspaceAccess[] = ['read_write', 'read_only'];

function normalizeExecutionTarget(value: unknown, fallback: ExecutionTarget): ExecutionTarget {
  if (!isRecord(value)) return { ...fallback };
  const model = value.model;
  const chrome = typeof value.claudeInChrome === 'boolean' ? value.claudeInChrome : fallback.claudeInChrome === true;
  const modelSelection = parseModelSelection(
    Object.hasOwn(value, 'modelSelection')
      ? value.modelSelection
      : (value.provider === undefined || value.provider === fallback.provider) &&
          (value.model === undefined || value.model === fallback.model)
        ? fallback.modelSelection
        : undefined,
  );
  return {
    provider: stringOr(value.provider, fallback.provider),
    model:
      typeof model === 'string' && model.trim() ? model : model === null ? null : fallback.model,
    ...(modelSelection ? { modelSelection } : {}),
    // Absent means off, so profiles written before this option keep their launch.
    ...(chrome ? { claudeInChrome: true } : {}),
  };
}

function normalizePermissions(value: unknown, fallback: BotPermissions): BotPermissions {
  if (!isRecord(value)) return { ...fallback };
  const permissionMode = PERMISSION_MODES.includes(value.permissionMode as PermissionMode)
    ? (value.permissionMode as PermissionMode)
    : fallback.permissionMode;
  const workspaceAccess = WORKSPACE_ACCESS.includes(value.workspaceAccess as WorkspaceAccess)
    ? (value.workspaceAccess as WorkspaceAccess)
    : fallback.workspaceAccess;
  return {
    workspaceAccess,
    permissionMode,
    cwd: stringOr(value.cwd, fallback.cwd),
  };
}

const HEARTBEAT_MODES: readonly HeartbeatMode[] = ['auto', 'assist', 'companion'];

export function isHeartbeatMode(value: unknown): value is HeartbeatMode {
  return HEARTBEAT_MODES.includes(value as HeartbeatMode);
}

/** SPEC-011 FR-2: a profile written before SPEC-011 reads as `auto` on Desktop's rhythm. */
function normalizeHeartbeat(value: unknown, fallback: HeartbeatPolicy): HeartbeatPolicy {
  if (!isRecord(value)) return { ...fallback };
  const policy: HeartbeatPolicy = {
    enabled: booleanOr(value.enabled, fallback.enabled),
    mode: isHeartbeatMode(value.mode) ? value.mode : fallback.mode,
    bedtime: clockOr(value.bedtime, fallback.bedtime),
    wakeWindowStart: clockOr(value.wakeWindowStart, fallback.wakeWindowStart),
    wakeWindowEnd: clockOr(value.wakeWindowEnd, fallback.wakeWindowEnd),
    wakeMinMinutes: positiveNumberOr(value.wakeMinMinutes, fallback.wakeMinMinutes),
    wakeMaxMinutes: positiveNumberOr(value.wakeMaxMinutes, fallback.wakeMaxMinutes),
    regularMinMinutes: positiveNumberOr(value.regularMinMinutes, fallback.regularMinMinutes),
    regularMaxMinutes: positiveNumberOr(value.regularMaxMinutes, fallback.regularMaxMinutes),
  };
  if (policy.wakeMaxMinutes < policy.wakeMinMinutes) policy.wakeMaxMinutes = policy.wakeMinMinutes;
  if (policy.regularMaxMinutes < policy.regularMinMinutes) {
    policy.regularMaxMinutes = policy.regularMinMinutes;
  }
  return policy;
}

/**
 * SPEC-001 FR-4: every missing or invalid field takes its default; the file on
 * disk is never rewritten by a read.
 */
/**
 * SPEC-008 FR-24: a profile without an environment runs natively. Any other
 * kind is refused rather than run natively instead (ADR-010).
 */
export function normalizeEnvironment(value: unknown): BotEnvironment {
  if (value === undefined || (isRecord(value) && value.kind === 'native')) return { kind: 'native' };
  const kind = isRecord(value) && typeof value.kind === 'string' ? value.kind : typeof value;
  throw new Error(`Unsupported execution environment ${JSON.stringify(kind)}; this version runs bots natively only.`);
}

/**
 * ADR-030: the tool allowlist is gone. A profile that still has one moves, once, to the choice
 * that asks first: an explicit policy with full access that asks for each action (Claude Code,
 * Codex). A read-only filespace stays read-only, and the other CLIs keep their own default. A
 * list left beside another mode never reached a session, so it is only dropped. Sessions made
 * with the list are replaced, with a handoff.
 */
export function withoutAllowlist(raw: Record<string, unknown>): { raw: Record<string, unknown>; changed: boolean } {
  const permissions = isRecord(raw.permissions) ? raw.permissions : null;
  if (!permissions) return { raw, changed: false };
  const allowlist = permissions.permissionMode === 'whitelist';
  if (!allowlist && !Object.hasOwn(permissions, 'allowedTools')) return { raw, changed: false };
  const { allowedTools: _dropped, ...rest } = permissions;
  const next: Record<string, unknown> = { ...raw, permissions: allowlist ? { ...rest, permissionMode: 'default' } : rest };
  if (!allowlist) return { raw: next, changed: true };
  const provider = isRecord(raw.executionTarget) ? raw.executionTarget.provider : undefined;
  if (permissions.workspaceAccess !== 'read_only' && (provider === 'claude' || provider === 'codex')) {
    next.schemaVersion = PROFILE_SCHEMA_VERSION;
    next.providerPolicy = {
      version: 1, mode: 'explicit', access: 'full-access', network: true, approval: provider === 'claude' ? 'on-request' : 'untrusted',
    } satisfies SessionExecutionPolicy;
  }
  next.configRevision = Math.max(1, Math.floor(positiveNumberOr(raw.configRevision, 1))) + 1;
  return { raw: next, changed: true };
}

export function normalizeProfile(stored: unknown, fallback: BotProfile): BotProfile {
  if (!isRecord(stored)) return { ...fallback };
  const raw = withoutAllowlist(stored).raw;
  const configRevision = positiveNumberOr(raw.configRevision, fallback.configRevision);
  const executionTarget = normalizeExecutionTarget(raw.executionTarget, fallback.executionTarget);
  const storedPolicy = raw.schemaVersion === 1 || raw.providerPolicy === undefined ? null : parseProviderPolicy(raw.providerPolicy);
  const providerPolicy = requiredProviderPolicy(executionTarget.provider, storedPolicy);
  // Only a hosted-only provider carries the marker; on any other provider a policy is the owner's.
  const providerPolicyAuto = providerPolicy !== null && HOSTED_ONLY_PROVIDERS.includes(executionTarget.provider)
    && (storedPolicy === null || raw.providerPolicyAuto === true);
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    id: stringOr(raw.id, fallback.id),
    name: stringOr(raw.name, fallback.name),
    // SPEC-008 FR-29: every bot made before the choice is the default Cat, and an older writer drops the field.
    avatar: resolveBotAvatar(raw.avatar),
    instructions: stringOr(raw.instructions, fallback.instructions),
    environment: normalizeEnvironment(raw.environment),
    executionTarget,
    configRevision: Math.max(1, Math.floor(configRevision)),
    permissions: normalizePermissions(raw.permissions, fallback.permissions),
    providerPolicy,
    ...(providerPolicyAuto ? { providerPolicyAuto: true as const } : {}),
    heartbeat: normalizeHeartbeat(raw.heartbeat, fallback.heartbeat),
    idleSleepMinutes: positiveNumberOr(raw.idleSleepMinutes, fallback.idleSleepMinutes),
    telegram: normalizeTelegram(raw.telegram, fallback.telegram),
    desktopControl: normalizeDesktopControl(raw.desktopControl),
    // SPEC-008 FR-28: an older writer drops both, which reads as following the hub
    // until the hub reports again.
    replyLanguage: isBotReplyLanguage(raw.replyLanguage) ? raw.replyLanguage : BOT_REPLY_LANGUAGE_DEFAULT,
    hubLanguage: isHubLanguageReport(raw.hubLanguage)
      ? { reply: raw.hubLanguage.reply, display: raw.hubLanguage.display }
      : null,
    // SPEC-003 FR-12: only an explicit true turns it on; an older writer drops it, which reads as off.
    showProgressDetails: raw.showProgressDetails === true,
    showVerboseMessages: raw.showVerboseMessages === true,
    updatedAt: stringOr(raw.updatedAt, fallback.updatedAt),
  };
}

/** SPEC-008 FR-28: the language this bot's sessions are told to reply in, or none. */
export function effectiveReplyLanguage(profile: Pick<BotProfile, 'replyLanguage' | 'hubLanguage'>): ReplyLanguageCode | null {
  return resolveBotReplyLanguage(profile.replyLanguage, profile.hubLanguage);
}

export type ProfileLoadResult =
  | { ok: true; profile: BotProfile }
  | { ok: false; reason: 'missing' }
  | { ok: false; reason: 'corrupt'; error: string };

export function loadProfile(
  paths: BotPaths,
  fallback: BotProfile,
  migrate = false,
): ProfileLoadResult {
  const read = readJsonFile<unknown>(paths.profile);
  if (!read.ok) return read;
  try {
    const raw = read.value;
    if (
      !isRecord(raw) ||
      ![1, 2].includes(raw.schemaVersion as number) ||
      (raw.schemaVersion === 2 && !Object.hasOwn(raw, 'providerPolicy'))
    ) {
      throw new Error('Unsupported profile schema; restore a compatible backup or use a newer Bot.');
    }
    // Never use defaults to broaden a malformed access boundary during upgrade.
    if (
      !isRecord(raw.permissions) ||
      typeof raw.permissions.cwd !== 'string' ||
      !READABLE_PERMISSION_MODES.includes(raw.permissions.permissionMode as string) ||
      !WORKSPACE_ACCESS.includes(raw.permissions.workspaceAccess as WorkspaceAccess) ||
      (raw.permissions.allowedTools !== undefined &&
        (!Array.isArray(raw.permissions.allowedTools) ||
          raw.permissions.allowedTools.some((t) => typeof t !== 'string')))
    ) {
      throw new Error('Invalid profile permissions; original data was preserved.');
    }
    const profile = normalizeProfile(raw, fallback);
    assertPolicyBoundary(profile.providerPolicy, profile.permissions);
    const allowlistGone = withoutAllowlist(raw).changed;
    if (migrate && (raw.schemaVersion === 1 || allowlistGone)) {
      if (raw.schemaVersion === 1) {
        const backup = `${paths.profile}.v1.bak`;
        if (existsSync(backup)) {
          if (!readFileSync(backup).equals(readFileSync(paths.profile))) throw new Error('Profile upgrade backup differs; manual recovery required.');
        } else copyFileSync(paths.profile, backup, constants.COPYFILE_EXCL);
      } else {
        // ADR-030: an older Bot run in between may write a list again; each one keeps its own copy.
        const backup = `${paths.profile}.allowlist.bak`;
        if (!existsSync(backup)) copyFileSync(paths.profile, backup, constants.COPYFILE_EXCL);
        else if (!readFileSync(backup).equals(readFileSync(paths.profile))) {
          copyFileSync(paths.profile, `${paths.profile}.allowlist.${Date.now()}.bak`, constants.COPYFILE_EXCL);
        }
      }
      writeJsonAtomic(paths.profile, profile);
    }
    return { ok: true, profile };
  } catch (error) {
    return { ok: false, reason: 'corrupt', error: error instanceof Error ? error.message : 'Profile upgrade failed' };
  }
}

export function saveProfile(paths: BotPaths, profile: BotProfile): void {
  writeJsonAtomic(paths.profile, profile);
}

/** The same policy whatever order its keys were sent in. */
function samePolicy(a: SessionExecutionPolicy | null, b: SessionExecutionPolicy | null): boolean {
  const values = (p: SessionExecutionPolicy | null) => p === null ? null : p.mode === 'provider'
    ? [p.mode, p.version, p.constraints.maxAccess, p.constraints.network]
    : [p.mode, p.version, p.access, p.network, p.approval];
  return JSON.stringify(values(a)) === JSON.stringify(values(b));
}

export function sameExecutionTarget(a: ExecutionTarget, b: ExecutionTarget): boolean {
  return (
    a.provider === b.provider &&
    (a.model ?? null) === (b.model ?? null) &&
    JSON.stringify(parseModelSelection(a.modelSelection)) ===
      JSON.stringify(parseModelSelection(b.modelSelection)) &&
    (a.claudeInChrome === true) === (b.claudeInChrome === true)
  );
}

function samePermissions(a: BotPermissions, b: BotPermissions): boolean {
  return (
    a.workspaceAccess === b.workspaceAccess
    && a.permissionMode === b.permissionMode
    && a.cwd === b.cwd
  );
}

export interface ProfileChange {
  profile: BotProfile;
  targetChanged: boolean;
  providerChanged: boolean;
  sessionChanged: boolean;
  /** SPEC-008 FR-28: the language sessions are told to reply in was the only session setting that changed. */
  replyLanguageOnly: boolean;
}

function sameText(value: unknown, stored: string, normalize: (text: string) => string): boolean {
  return typeof value === 'string' && normalize(value) === normalize(stored);
}

/**
 * SPEC-011 FR-2: an owner's change is refused rather than silently replaced,
 * with Cats Desktop's rules for the rhythm (its SPEC-124 FR-3).
 */
function checkedHeartbeatPatch(current: HeartbeatPolicy, patch: Partial<HeartbeatPolicy>): HeartbeatPolicy {
  if (patch.mode !== undefined && !isHeartbeatMode(patch.mode)) {
    throw new Error('heartbeat mode must be auto, assist or companion');
  }
  for (const key of ['bedtime', 'wakeWindowStart', 'wakeWindowEnd'] as const) {
    if (patch[key] !== undefined && parseClockMinutes(patch[key]) === null) throw new Error(`${key} must be HH:MM`);
  }
  const next = normalizeHeartbeat({ ...current, ...patch }, current);
  // Only a change to the times is checked, so pausing never fails over a hand-edited file.
  const timesChanged = next.bedtime !== current.bedtime
    || next.wakeWindowStart !== current.wakeWindowStart
    || next.wakeWindowEnd !== current.wakeWindowEnd;
  const problem = timesChanged ? heartbeatRhythmProblem(next) : null;
  if (problem) throw new Error(problem);
  return next;
}

/**
 * SPEC-001 FR-27: a change to anything a session is created with (execution
 * target, instructions, permissions, cwd, the reply language it is told)
 * bumps `configRevision`, so sessions of the old revision are replaced; an
 * identical value is a no-op. Returns the new profile and what changed.
 */
export function applyProfilePatch(
  profile: BotProfile,
  patch: BotProfilePatch,
  now: Date,
): ProfileChange {
  const nextTarget = patch.executionTarget
    ? normalizeExecutionTarget(patch.executionTarget, profile.executionTarget)
    : profile.executionTarget;
  const targetChanged = !sameExecutionTarget(nextTarget, profile.executionTarget);
  // SPEC-010 FR-19: new or changed text follows the rule. Stored text that predates it keeps working,
  // also when a page sends it back trimmed: that is no change.
  const nextName = patch.name == null || sameText(patch.name, profile.name, normalizeBotName)
    ? profile.name
    : checkedBotName(patch.name);
  const nextInstructions = patch.instructions == null || sameText(patch.instructions, profile.instructions, normalizeBotPersona)
    ? profile.instructions
    : checkedBotPersona(patch.instructions);
  if (patch.permissions) {
    const asked = patch.permissions as Record<string, unknown>;
    if (Object.hasOwn(asked, 'allowedTools')) throw new Error('Tool allowlists are no longer supported; choose how the cat bot asks instead');
    if (asked.permissionMode !== undefined && !PERMISSION_MODES.includes(asked.permissionMode as PermissionMode)) {
      throw new Error('permissionMode must be default or skip');
    }
    if (asked.workspaceAccess !== undefined && !WORKSPACE_ACCESS.includes(asked.workspaceAccess as WorkspaceAccess)) {
      throw new Error('workspaceAccess must be read_write or read_only');
    }
  }
  const nextPermissions = patch.permissions
    ? normalizePermissions({ ...profile.permissions, ...patch.permissions }, profile.permissions)
    : profile.permissions;
  // ADR-025: a policy the patch sets is the owner's. Leaving Kimi drops only the policy Kimi brought,
  // so a bot returns to its own earlier mode; one the owner chose (say Grok's native tools) stays.
  const explicitPolicy = patch.providerPolicy !== undefined;
  let basePolicy = explicitPolicy ? parseProviderPolicy(patch.providerPolicy) : profile.providerPolicy;
  // Saving the very policy Cats filled in while staying on Kimi (Settings offers it nothing else) is
  // not a new choice; a policy sent together with a new provider is.
  let baseAuto = profile.providerPolicyAuto === true && (!explicitPolicy
    || nextTarget.provider === profile.executionTarget.provider && samePolicy(basePolicy, profile.providerPolicy));
  if (baseAuto && HOSTED_ONLY_PROVIDERS.includes(profile.executionTarget.provider) && !HOSTED_ONLY_PROVIDERS.includes(nextTarget.provider)) {
    basePolicy = null; baseAuto = false;
  }
  const nextProviderPolicy = requiredProviderPolicy(nextTarget.provider, basePolicy);
  const nextProviderPolicyAuto = nextProviderPolicy !== null && HOSTED_ONLY_PROVIDERS.includes(nextTarget.provider)
    && (baseAuto || basePolicy === null);
  assertPolicyBoundary(nextProviderPolicy, nextPermissions);
  if (patch.replyLanguage !== undefined && !isBotReplyLanguage(patch.replyLanguage)) {
    throw new Error('replyLanguage must be hub, display, unspecified or a supported language code');
  }
  if (patch.avatar !== undefined && !isBotAvatar(patch.avatar)) throw new Error('avatar must be one of the Cat looks');
  for (const key of ['showProgressDetails', 'showVerboseMessages'] as const) {
    if (patch[key] !== undefined && typeof patch[key] !== 'boolean') throw new Error(`${key} must be true or false`);
  }
  const nextHeartbeat = patch.heartbeat ? checkedHeartbeatPatch(profile.heartbeat, patch.heartbeat) : profile.heartbeat;
  const nextReplyLanguage = patch.replyLanguage ?? profile.replyLanguage;
  const replyLanguageChanged = effectiveReplyLanguage({ replyLanguage: nextReplyLanguage, hubLanguage: profile.hubLanguage })
    !== effectiveReplyLanguage(profile);
  const otherSessionChange = targetChanged
    || nextInstructions !== profile.instructions
    || !samePermissions(nextPermissions, profile.permissions)
    || JSON.stringify(nextProviderPolicy) !== JSON.stringify(profile.providerPolicy);
  const sessionChanged = otherSessionChange || replyLanguageChanged;
  const { providerPolicyAuto: _previousAuto, ...unmarked } = profile;
  const next: BotProfile = {
    ...unmarked,
    ...(nextProviderPolicyAuto ? { providerPolicyAuto: true as const } : {}),
    name: nextName,
    // Not a session setting: no session is told how its Cat looks, so no revision bump (SPEC-008 FR-29).
    avatar: patch.avatar ?? profile.avatar,
    instructions: nextInstructions,
    executionTarget: nextTarget,
    configRevision: sessionChanged ? profile.configRevision + 1 : profile.configRevision,
    permissions: nextPermissions,
    providerPolicy: nextProviderPolicy,
    heartbeat: nextHeartbeat,
    idleSleepMinutes: patch.idleSleepMinutes ?? profile.idleSleepMinutes,
    telegram: patch.telegram
      ? normalizeTelegram({ ...profile.telegram, ...patch.telegram }, profile.telegram)
      : profile.telegram,
    // Not a session setting: the descriptor follows per send, so no revision bump (SPEC-006).
    desktopControl: patch.desktopControl
      ? normalizeDesktopControl({ ...profile.desktopControl, ...patch.desktopControl })
      : profile.desktopControl,
    replyLanguage: nextReplyLanguage,
    // Not a session setting: only how the notes draw a reply (SPEC-003 FR-12).
    showProgressDetails: patch.showProgressDetails ?? profile.showProgressDetails,
    // Not a session setting either: only which lines the notes show (SPEC-003 FR-14).
    showVerboseMessages: patch.showVerboseMessages ?? profile.showVerboseMessages,
    updatedAt: now.toISOString(),
  };
  return {
    profile: next,
    targetChanged,
    // The runtime's launch arguments change with the provider and with Claude in Chrome.
    providerChanged: nextTarget.provider !== profile.executionTarget.provider
      || (nextTarget.claudeInChrome === true) !== (profile.executionTarget.claudeInChrome === true),
    sessionChanged,
    replyLanguageOnly: replyLanguageChanged && !otherSessionChange,
  };
}

/**
 * SPEC-008 FR-28: the hub's report of its reply language and display language.
 * It bumps the revision only when the language this bot's sessions are told
 * changes; a bot with its own language just records the report. Returns null
 * when the report is what the profile already holds.
 */
export function applyHubLanguage(profile: BotProfile, report: HubLanguageReport, now: Date): ProfileChange | null {
  if (profile.hubLanguage && sameHubLanguageReport(profile.hubLanguage, report)) return null;
  const hubLanguage = { reply: report.reply, display: report.display };
  const replyLanguageChanged = effectiveReplyLanguage({ replyLanguage: profile.replyLanguage, hubLanguage })
    !== effectiveReplyLanguage(profile);
  return {
    profile: {
      ...profile,
      hubLanguage,
      configRevision: replyLanguageChanged ? profile.configRevision + 1 : profile.configRevision,
      updatedAt: now.toISOString(),
    },
    targetChanged: false,
    providerChanged: false,
    sessionChanged: replyLanguageChanged,
    replyLanguageOnly: replyLanguageChanged,
  };
}
