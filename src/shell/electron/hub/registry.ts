import { existsSync, readdirSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { readJsonFile, writeJsonAtomic } from '../../../core/store/atomicFile.ts';
import { acquireLockFile } from '../../../core/store/lock.ts';
import { hubPathsFor, isValidBotId } from '../../../core/store/paths.ts';
import { MAX_CHAIN_HOPS } from '../../../core/tools/hubTools.ts';

/**
 * SPEC-008 FR-2 and FR-3: the bot registry, `<CATS_BOT_HOME>/bots.json`.
 * Only the hub writes it, under a lock file, through temp file plus rename.
 * Missing fields get defaults; a corrupt file is reported and never
 * overwritten (SPEC-001 FR-4 rules).
 */

export const REGISTRY_SCHEMA_VERSION = 1;

/** SPEC-008 FR-6: the bot cap, a hub setting not offered in the UI. */
export const DEFAULT_MAX_BOTS = 3;

export interface RegistryBot {
  id: string;
  order: number;
  startAutomatically: boolean;
  createdAt: string;
  archivedAt: string | null;
}

export interface BotRegistry {
  schemaVersion: 1;
  bots: RegistryBot[];
  /** ADR-010: only native in this version. */
  environmentProfile: { kind: 'native' };
  /** SPEC-009 FR-1: the bot holding the coordinator role, when it was assigned and how. */
  coordinator: CoordinatorRole;
  maxBots: number;
  /** SPEC-009 FR-8: the owner's limits on coordinator messages. */
  limits: CoordinatorLimits;
}

export type CoordinatorAssignment = 'first-run' | 'owner' | 'confirmed-proposal';

export interface CoordinatorRole {
  holder: string | null;
  assignedAt: string | null;
  how: CoordinatorAssignment | null;
}

export interface CoordinatorLimits {
  hopsPerChain: number;
  messagesPerHour: number;
}

export const DEFAULT_LIMITS: CoordinatorLimits = { hopsPerChain: 4, messagesPerHour: 10 };

/**
 * The values the owner can choose. A chain needs two hops for one message and
 * its reply, and no delivery carries a hop above the core's bound.
 */
export const LIMIT_RANGES: Readonly<Record<keyof CoordinatorLimits, readonly [number, number]>> = {
  hopsPerChain: [2, MAX_CHAIN_HOPS],
  messagesPerHour: [1, 1000],
};

/** SPEC-009 FR-1 and FR-2: who holds the role now, recorded with when and how. */
export function withHolder(registry: BotRegistry, holder: string | null, how: CoordinatorAssignment, now: Date = new Date()): BotRegistry {
  return { ...registry, coordinator: holder ? { holder, assignedAt: now.toISOString(), how } : { holder: null, assignedAt: null, how: null } };
}

export type RegistryRead =
  | { state: 'missing' }
  | { state: 'ok'; registry: BotRegistry }
  | { state: 'corrupt'; error: string };

export class RegistryCorruptError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function emptyRegistry(): BotRegistry {
  return {
    schemaVersion: 1, bots: [], environmentProfile: { kind: 'native' },
    coordinator: { holder: null, assignedAt: null, how: null }, maxBots: DEFAULT_MAX_BOTS, limits: { ...DEFAULT_LIMITS },
  };
}

/** Field by field: defaults for what is missing, a refusal for what cannot be read safely. */
export function normalizeRegistry(raw: unknown): BotRegistry {
  if (!isRecord(raw) || raw.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
    throw new RegistryCorruptError('Unsupported bot registry schema; restore a compatible backup or use a newer Cats Bot.');
  }
  const profile = raw.environmentProfile;
  if (profile !== undefined && (!isRecord(profile) || profile.kind !== 'native')) {
    // ADR-010: a non-native profile is never run natively instead.
    throw new RegistryCorruptError('The bot registry names an execution environment this version cannot run; only native is supported.');
  }
  if (raw.bots !== undefined && !Array.isArray(raw.bots)) throw new RegistryCorruptError('The bot registry has no readable bot list.');
  const bots: RegistryBot[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of ((raw.bots as unknown[] | undefined) ?? []).entries()) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !isValidBotId(entry.id) || seen.has(entry.id)) {
      throw new RegistryCorruptError(`The bot registry has an unreadable entry at position ${index + 1}.`);
    }
    seen.add(entry.id);
    bots.push({
      id: entry.id,
      order: Number.isFinite(entry.order) ? Number(entry.order) : index,
      startAutomatically: typeof entry.startAutomatically === 'boolean' ? entry.startAutomatically : true,
      createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date(0).toISOString(),
      archivedAt: typeof entry.archivedAt === 'string' ? entry.archivedAt : null,
    });
  }
  const coordinator = isRecord(raw.coordinator) ? raw.coordinator : {};
  const holder = typeof coordinator.holder === 'string' && seen.has(coordinator.holder) ? coordinator.holder : null;
  const how = holder && ['first-run', 'owner', 'confirmed-proposal'].includes(coordinator.how as string)
    ? coordinator.how as CoordinatorAssignment : null;
  const maxBots = Number.isSafeInteger(raw.maxBots) && (raw.maxBots as number) > 0 ? (raw.maxBots as number) : DEFAULT_MAX_BOTS;
  const limits = isRecord(raw.limits) ? raw.limits : {};
  const limit = (value: unknown, fallback: number, [min, max]: readonly [number, number]) =>
    (Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max ? value as number : fallback);
  return {
    schemaVersion: 1,
    bots: sortBots(bots),
    environmentProfile: { kind: 'native' },
    coordinator: {
      holder,
      assignedAt: holder && typeof coordinator.assignedAt === 'string' ? coordinator.assignedAt : null,
      how,
    },
    maxBots,
    limits: {
      hopsPerChain: limit(limits.hopsPerChain, DEFAULT_LIMITS.hopsPerChain, LIMIT_RANGES.hopsPerChain),
      messagesPerHour: limit(limits.messagesPerHour, DEFAULT_LIMITS.messagesPerHour, LIMIT_RANGES.messagesPerHour),
    },
  };
}

function sortBots(bots: RegistryBot[]): RegistryBot[] {
  return [...bots].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

export function readRegistry(home: string): RegistryRead {
  const read = readJsonFile<unknown>(hubPathsFor(home).registry);
  if (!read.ok) return read.reason === 'missing' ? { state: 'missing' } : { state: 'corrupt', error: read.error };
  try {
    return { state: 'ok', registry: normalizeRegistry(read.value) };
  } catch (error) {
    return { state: 'corrupt', error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Writes the registry under its lock file. A registry that became corrupt on
 * disk is never overwritten.
 */
export function writeRegistry(home: string, registry: BotRegistry): void {
  const paths = hubPathsFor(home);
  const lock = acquireLockFile(paths.registryLock, { pid: process.pid, host: hostname(), startedAt: new Date().toISOString() });
  if (!lock.held) throw new Error(`The bot registry is being written by another process (pid ${lock.owner.pid}).`);
  try {
    const current = readRegistry(home);
    if (current.state === 'corrupt') throw new RegistryCorruptError(`The bot registry is unreadable and was kept: ${current.error}`);
    writeJsonAtomic(paths.registry, { ...registry, bots: sortBots(registry.bots) });
  } finally {
    lock.release();
  }
}

/** The valid bot ids with a profile under a directory, and the names skipped as invalid (FR-27). */
export function listBotDirectories(dir: string): { ids: string[]; skipped: string[] } {
  if (!existsSync(dir)) return { ids: [], skipped: [] };
  const ids: string[] = [];
  const skipped: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!isValidBotId(entry.name)) skipped.push(entry.name);
    else if (existsSync(join(dir, entry.name, 'profile.json'))) ids.push(entry.name);
  }
  return { ids: ids.sort(), skipped: skipped.sort() };
}

export interface Reconciled {
  registry: BotRegistry;
  /** Whether `registry` differs from what was read and should be written. */
  changed: boolean;
  /** Directories under `bots/` without an entry, for the owner to add. */
  unregistered: string[];
  /** Directories under `archive/` without an entry. */
  unregisteredArchived: string[];
  /** Entries without a directory: shown as failed, never removed automatically. */
  missing: string[];
  /** Directory names that are not valid bot ids. */
  skipped: string[];
}

/**
 * FR-3: the directory's location decides whether a bot is archived. Entries
 * and directories that do not match are reported, and nothing is deleted.
 */
export function reconcileRegistry(home: string, registry: BotRegistry, now: Date = new Date()): Reconciled {
  const paths = hubPathsFor(home);
  const active = listBotDirectories(paths.bots);
  const archived = listBotDirectories(paths.archive);
  let changed = false;
  const bots = registry.bots.map((bot) => {
    if (active.ids.includes(bot.id) && bot.archivedAt !== null) {
      changed = true;
      return { ...bot, archivedAt: null };
    }
    if (!active.ids.includes(bot.id) && archived.ids.includes(bot.id) && bot.archivedAt === null) {
      changed = true;
      return { ...bot, archivedAt: now.toISOString() };
    }
    return bot;
  });
  const known = new Set(bots.map((bot) => bot.id));
  return {
    registry: { ...registry, bots },
    changed,
    unregistered: active.ids.filter((id) => !known.has(id)),
    unregisteredArchived: archived.ids.filter((id) => !known.has(id) && !active.ids.includes(id)),
    missing: bots.filter((bot) => !active.ids.includes(bot.id) && !archived.ids.includes(bot.id)).map((bot) => bot.id),
    skipped: [...active.skipped, ...archived.skipped],
  };
}

/** The bots that may run: registered, not archived and with a directory, in their order. */
export function activeBots(registry: BotRegistry, home: string): RegistryBot[] {
  const present = new Set(listBotDirectories(hubPathsFor(home).bots).ids);
  return registry.bots.filter((bot) => bot.archivedAt === null && present.has(bot.id));
}

/**
 * D11: the bots a first hub takes in from directories made before it: a bot
 * named at launch first, then the others by id, up to the cap.
 */
export function adoptionOrder(existing: string[], requested: string | undefined, cap: number): string[] {
  const named = requested && existing.includes(requested) ? [requested] : [];
  return [...named, ...[...existing].sort().filter((id) => id !== requested)].slice(0, cap);
}

export function addBot(registry: BotRegistry, id: string, now: Date = new Date()): BotRegistry {
  if (registry.bots.some((bot) => bot.id === id)) return registry;
  const order = registry.bots.reduce((max, bot) => Math.max(max, bot.order + 1), 0);
  return { ...registry, bots: [...registry.bots, { id, order, startAutomatically: true, createdAt: now.toISOString(), archivedAt: null }] };
}
