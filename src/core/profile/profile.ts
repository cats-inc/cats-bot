import { randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { assertPolicyBoundary, parseProviderPolicy } from '../runtime/providerPolicy.ts';
import { parseModelSelection } from '../providers/selection.ts';

import { readJsonFile, writeJsonAtomic } from '../store/atomicFile.ts';
import type { BotPaths } from '../store/paths.ts';
import type {
  BotEnvironment,
  BotPermissions,
  BotProfile,
  BotProfilePatch,
  DesktopControlPolicy,
  ExecutionTarget,
  HeartbeatPolicy,
  PermissionMode,
  TelegramPolicy,
  WorkspaceAccess,
} from '../types.ts';

/** SPEC-001 FR-1 defaults. */
export const HEARTBEAT_DEFAULTS: HeartbeatPolicy = {
  enabled: true,
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
  instructions?: string;
  provider: string;
  model?: string | null;
  modelSelection?: ExecutionTarget['modelSelection'];
  cwd: string;
  permissionMode?: PermissionMode;
  workspaceAccess?: WorkspaceAccess;
  allowedTools?: string[];
  now?: Date;
}

export function createProfile(input: CreateProfileInput): BotProfile {
  const now = (input.now ?? new Date()).toISOString();
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    id: input.id ?? `bot-${randomUUID().slice(0, 8)}`,
    name: input.name,
    instructions: input.instructions ?? '',
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
      ...(input.allowedTools ? { allowedTools: [...input.allowedTools] } : {}),
      cwd: input.cwd,
    },
    providerPolicy: null,
    heartbeat: { ...HEARTBEAT_DEFAULTS },
    idleSleepMinutes: IDLE_SLEEP_MINUTES_DEFAULT,
    telegram: { ...TELEGRAM_DEFAULTS },
    desktopControl: { ...DESKTOP_CONTROL_DEFAULTS },
    updatedAt: now,
  };
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

const PERMISSION_MODES: readonly PermissionMode[] = ['skip', 'whitelist', 'default'];
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
  const allowedTools = Array.isArray(value.allowedTools)
    ? value.allowedTools.filter((tool): tool is string => typeof tool === 'string')
    : fallback.allowedTools;
  return {
    workspaceAccess,
    permissionMode,
    ...(allowedTools ? { allowedTools } : {}),
    cwd: stringOr(value.cwd, fallback.cwd),
  };
}

function normalizeHeartbeat(value: unknown, fallback: HeartbeatPolicy): HeartbeatPolicy {
  if (!isRecord(value)) return { ...fallback };
  const policy: HeartbeatPolicy = {
    enabled: booleanOr(value.enabled, fallback.enabled),
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

export function normalizeProfile(raw: unknown, fallback: BotProfile): BotProfile {
  if (!isRecord(raw)) return { ...fallback };
  const configRevision = positiveNumberOr(raw.configRevision, fallback.configRevision);
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    id: stringOr(raw.id, fallback.id),
    name: stringOr(raw.name, fallback.name),
    instructions: stringOr(raw.instructions, fallback.instructions),
    environment: normalizeEnvironment(raw.environment),
    executionTarget: normalizeExecutionTarget(raw.executionTarget, fallback.executionTarget),
    configRevision: Math.max(1, Math.floor(configRevision)),
    permissions: normalizePermissions(raw.permissions, fallback.permissions),
    providerPolicy: raw.schemaVersion === 1 || raw.providerPolicy === undefined
      ? null : parseProviderPolicy(raw.providerPolicy),
    heartbeat: normalizeHeartbeat(raw.heartbeat, fallback.heartbeat),
    idleSleepMinutes: positiveNumberOr(raw.idleSleepMinutes, fallback.idleSleepMinutes),
    telegram: normalizeTelegram(raw.telegram, fallback.telegram),
    desktopControl: normalizeDesktopControl(raw.desktopControl),
    updatedAt: stringOr(raw.updatedAt, fallback.updatedAt),
  };
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
      !PERMISSION_MODES.includes(raw.permissions.permissionMode as PermissionMode) ||
      !WORKSPACE_ACCESS.includes(raw.permissions.workspaceAccess as WorkspaceAccess) ||
      (raw.permissions.allowedTools !== undefined &&
        (!Array.isArray(raw.permissions.allowedTools) ||
          raw.permissions.allowedTools.some((t) => typeof t !== 'string')))
    ) {
      throw new Error('Invalid profile permissions; original data was preserved.');
    }
    const profile = normalizeProfile(raw, fallback);
    assertPolicyBoundary(profile.providerPolicy, profile.permissions);
    if (raw.schemaVersion === 1 && migrate) {
      const backup = `${paths.profile}.v1.bak`;
      if (existsSync(backup)) {
        if (!readFileSync(backup).equals(readFileSync(paths.profile))) throw new Error('Profile upgrade backup differs; manual recovery required.');
      } else copyFileSync(paths.profile, backup, constants.COPYFILE_EXCL);
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
    && JSON.stringify(a.allowedTools ?? null) === JSON.stringify(b.allowedTools ?? null)
  );
}

/**
 * SPEC-001 FR-27: a change to anything a session is created with (execution
 * target, instructions, permissions, cwd) bumps `configRevision`, so sessions
 * of the old revision are replaced; an identical value is a no-op. Returns the
 * new profile and what changed.
 */
export function applyProfilePatch(
  profile: BotProfile,
  patch: BotProfilePatch,
  now: Date,
): { profile: BotProfile; targetChanged: boolean; providerChanged: boolean; sessionChanged: boolean } {
  const nextTarget = patch.executionTarget
    ? normalizeExecutionTarget(patch.executionTarget, profile.executionTarget)
    : profile.executionTarget;
  const targetChanged = !sameExecutionTarget(nextTarget, profile.executionTarget);
  const nextInstructions = patch.instructions ?? profile.instructions;
  const nextPermissions = patch.permissions
    ? normalizePermissions({ ...profile.permissions, ...patch.permissions }, profile.permissions)
    : profile.permissions;
  const nextProviderPolicy = patch.providerPolicy === undefined ? profile.providerPolicy : parseProviderPolicy(patch.providerPolicy);
  assertPolicyBoundary(nextProviderPolicy, nextPermissions);
  const sessionChanged = targetChanged
    || nextInstructions !== profile.instructions
    || !samePermissions(nextPermissions, profile.permissions)
    || JSON.stringify(nextProviderPolicy) !== JSON.stringify(profile.providerPolicy);
  const next: BotProfile = {
    ...profile,
    name: patch.name ?? profile.name,
    instructions: nextInstructions,
    executionTarget: nextTarget,
    configRevision: sessionChanged ? profile.configRevision + 1 : profile.configRevision,
    permissions: nextPermissions,
    providerPolicy: nextProviderPolicy,
    heartbeat: patch.heartbeat
      ? normalizeHeartbeat({ ...profile.heartbeat, ...patch.heartbeat }, profile.heartbeat)
      : profile.heartbeat,
    idleSleepMinutes: patch.idleSleepMinutes ?? profile.idleSleepMinutes,
    telegram: patch.telegram
      ? normalizeTelegram({ ...profile.telegram, ...patch.telegram }, profile.telegram)
      : profile.telegram,
    // Not a session setting: the descriptor follows per send, so no revision bump (SPEC-006).
    desktopControl: patch.desktopControl
      ? normalizeDesktopControl({ ...profile.desktopControl, ...patch.desktopControl })
      : profile.desktopControl,
    updatedAt: now.toISOString(),
  };
  return {
    profile: next,
    targetChanged,
    // The runtime's launch arguments change with the provider and with Claude in Chrome.
    providerChanged: nextTarget.provider !== profile.executionTarget.provider
      || (nextTarget.claudeInChrome === true) !== (profile.executionTarget.claudeInChrome === true),
    sessionChanged,
  };
}
