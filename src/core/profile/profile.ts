import { randomUUID } from 'node:crypto';

import { readJsonFile, writeJsonAtomic } from '../store/atomicFile.ts';
import type { BotPaths } from '../store/paths.ts';
import type {
  BotPermissions,
  BotProfile,
  BotProfilePatch,
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

export const PROFILE_SCHEMA_VERSION = 1 as const;

export interface CreateProfileInput {
  id?: string;
  name: string;
  instructions?: string;
  provider: string;
  model?: string | null;
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
    executionTarget: { provider: input.provider, model: input.model ?? null },
    configRevision: 1,
    permissions: {
      workspaceAccess: input.workspaceAccess ?? 'read_write',
      permissionMode: input.permissionMode ?? 'default',
      ...(input.allowedTools ? { allowedTools: [...input.allowedTools] } : {}),
      cwd: input.cwd,
    },
    heartbeat: { ...HEARTBEAT_DEFAULTS },
    idleSleepMinutes: IDLE_SLEEP_MINUTES_DEFAULT,
    telegram: { ...TELEGRAM_DEFAULTS },
    updatedAt: now,
  };
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
  return {
    provider: stringOr(value.provider, fallback.provider),
    model: typeof model === 'string' && model.trim() ? model : model === null ? null : fallback.model,
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
export function normalizeProfile(raw: unknown, fallback: BotProfile): BotProfile {
  if (!isRecord(raw)) return { ...fallback };
  const configRevision = positiveNumberOr(raw.configRevision, fallback.configRevision);
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    id: stringOr(raw.id, fallback.id),
    name: stringOr(raw.name, fallback.name),
    instructions: stringOr(raw.instructions, fallback.instructions),
    executionTarget: normalizeExecutionTarget(raw.executionTarget, fallback.executionTarget),
    configRevision: Math.max(1, Math.floor(configRevision)),
    permissions: normalizePermissions(raw.permissions, fallback.permissions),
    heartbeat: normalizeHeartbeat(raw.heartbeat, fallback.heartbeat),
    idleSleepMinutes: positiveNumberOr(raw.idleSleepMinutes, fallback.idleSleepMinutes),
    telegram: normalizeTelegram(raw.telegram, fallback.telegram),
    updatedAt: stringOr(raw.updatedAt, fallback.updatedAt),
  };
}

export type ProfileLoadResult =
  | { ok: true; profile: BotProfile }
  | { ok: false; reason: 'missing' }
  | { ok: false; reason: 'corrupt'; error: string };

export function loadProfile(paths: BotPaths, fallback: BotProfile): ProfileLoadResult {
  const read = readJsonFile<unknown>(paths.profile);
  if (!read.ok) return read;
  return { ok: true, profile: normalizeProfile(read.value, fallback) };
}

export function saveProfile(paths: BotPaths, profile: BotProfile): void {
  writeJsonAtomic(paths.profile, profile);
}

export function sameExecutionTarget(a: ExecutionTarget, b: ExecutionTarget): boolean {
  return a.provider === b.provider && (a.model ?? null) === (b.model ?? null);
}

/**
 * SPEC-001 FR-27: a changed execution target bumps `configRevision`; an
 * identical target is a no-op. Returns the new profile and whether the target changed.
 */
export function applyProfilePatch(
  profile: BotProfile,
  patch: BotProfilePatch,
  now: Date,
): { profile: BotProfile; targetChanged: boolean; providerChanged: boolean } {
  const nextTarget = patch.executionTarget
    ? normalizeExecutionTarget(patch.executionTarget, profile.executionTarget)
    : profile.executionTarget;
  const targetChanged = !sameExecutionTarget(nextTarget, profile.executionTarget);
  const next: BotProfile = {
    ...profile,
    name: patch.name ?? profile.name,
    instructions: patch.instructions ?? profile.instructions,
    executionTarget: nextTarget,
    configRevision: targetChanged ? profile.configRevision + 1 : profile.configRevision,
    permissions: patch.permissions
      ? normalizePermissions({ ...profile.permissions, ...patch.permissions }, profile.permissions)
      : profile.permissions,
    heartbeat: patch.heartbeat
      ? normalizeHeartbeat({ ...profile.heartbeat, ...patch.heartbeat }, profile.heartbeat)
      : profile.heartbeat,
    idleSleepMinutes: patch.idleSleepMinutes ?? profile.idleSleepMinutes,
    telegram: patch.telegram
      ? normalizeTelegram({ ...profile.telegram, ...patch.telegram }, profile.telegram)
      : profile.telegram,
    updatedAt: now.toISOString(),
  };
  return {
    profile: next,
    targetChanged,
    providerChanged: nextTarget.provider !== profile.executionTarget.provider,
  };
}
