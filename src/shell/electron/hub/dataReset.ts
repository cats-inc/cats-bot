import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

import { readJsonFile, writeJsonAtomic } from '../../../core/store/atomicFile.ts';
import { acquireInstanceLock } from '../../../core/store/lock.ts';
import { botPathsFor } from '../../../core/store/paths.ts';
import { removeTree } from '../../../core/store/removeTree.ts';
import { BOT_DATA_RESET_JOURNAL, isBotDataResetRequest } from '../../../shared/dataReset.ts';

/** Adapted from cats-platform's src/shared/platformDataReset.ts and
 * desktop/host/runtimeDataReset.ts at 07cd727d3e5035297f7e8b6780ea3a9c7314a476 (MIT):
 * durable consent, an ownership allowlist and an offline purge.
 * Bots own separate Runtime roots; a Bot-only reset retains those separately.
 */
export const DATA_RESET_JOURNAL = BOT_DATA_RESET_JOURNAL;
const BOT_CONTAINERS = ['bots', 'archive', 'trash'] as const;
const RESET_DIRECTORIES = [...BOT_CONTAINERS, 'boss-cat', 'logs'] as const;
const RESET_FILES = ['bots.json', 'bots.json.lock', 'hub-state.json', 'window-state.json', 'setup-draft.json'] as const;
interface PendingReset { schemaVersion: 1; id: string; resetRuntime: boolean }
interface BotDirectory { root: string; container: string; name: string }

function stat(target: string) { return lstatSync(target, { throwIfNoEntry: false }); }
function contains(parent: string, target: string): boolean {
  const child = relative(parent, target);
  return !child || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}
function assertParents(target: string): void {
  for (let current = resolve(target);; current = dirname(current)) {
    if (stat(current)?.isSymbolicLink()) throw new Error('Data reset refuses redirected storage.');
    if (dirname(current) === current) break;
  }
}
function assertDirectory(target: string): void {
  assertParents(target);
  const entry = stat(target);
  if (entry && !entry.isDirectory()) throw new Error('Data reset storage must be a directory.');
}

/** Resolve and validate every destructive target before the first removal. */
export function validateBotDataReset(home: string, protectedRoots: string[] = []): BotDirectory[] {
  const root = resolve(home);
  if (!isAbsolute(home) || root === parse(root).root || root === resolve(homedir())
    || protectedRoots.some(protectedRoot => contains(root, resolve(protectedRoot)) || contains(resolve(protectedRoot), root))) {
    throw new Error('Unsafe Cats Bot reset root.');
  }
  assertDirectory(root);
  for (const name of [...RESET_DIRECTORIES, 'retained-runtime']) assertDirectory(join(root, name));
  const bots: BotDirectory[] = [];
  for (const container of BOT_CONTAINERS) {
    const parent = join(root, container);
    if (!stat(parent)) continue;
    for (const name of readdirSync(parent)) {
      const botRoot = join(parent, name);
      const entry = stat(botRoot);
      // removeTree unlinks a redirected child itself, never its destination.
      if (!entry?.isDirectory() || entry.isSymbolicLink()) continue;
      assertDirectory(join(botRoot, 'runtime'));
      const lock = stat(botPathsFor(botRoot).lock);
      if (lock && (!lock.isFile() || lock.isSymbolicLink())) throw new Error('Data reset refuses a redirected bot lock.');
      bots.push({ root: botRoot, container, name });
    }
  }
  return bots;
}

function readPending(home: string): PendingReset | null {
  const file = join(home, DATA_RESET_JOURNAL);
  const entry = stat(file);
  if (!entry) return null;
  assertParents(home);
  if (entry && (!entry.isFile() || entry.isSymbolicLink())) throw new Error('Invalid data reset journal.');
  const result = readJsonFile<PendingReset>(file);
  if (!result.ok) {
    if (result.reason === 'missing') return null;
    throw new Error('Unreadable data reset journal; no data was removed.');
  }
  const value = result.value;
  if (value?.schemaVersion !== 1 || typeof value.resetRuntime !== 'boolean'
    || typeof value.id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value.id)) {
    throw new Error('Invalid data reset journal; no data was removed.');
  }
  return value;
}

function withBotLocks<T>(bots: BotDirectory[], work: () => T): T {
  const release: Array<() => void> = [];
  try {
    for (const bot of bots) {
      const lock = acquireInstanceLock(botPathsFor(bot.root), process.pid, { dataReset: true });
      if (!lock.held) throw new Error('Stop cat bots running in another program before resetting data.');
      release.push(lock.release);
    }
    return work();
  } finally { for (const unlock of release.reverse()) unlock(); }
}

/** Called only after the hub has drained its own cores and Runtime children. */
export function prepareBotDataReset(home: string, request: unknown, protectedRoots: string[] = []): void {
  if (!isBotDataResetRequest(request)) throw new Error('Type RESET to confirm the selected data reset.');
  const bots = validateBotDataReset(home, protectedRoots);
  if (readPending(home)) throw new Error('Finish the pending data reset before requesting another.');
  withBotLocks(bots, () => writeJsonAtomic(join(home, DATA_RESET_JOURNAL), {
    schemaVersion: 1, id: randomUUID(), resetRuntime: request.resetRuntime,
  } satisfies PendingReset));
}

/** Run under the hub lock, before registry recovery, setup or any core starts.
 * Failure retains consent and blocks startup, so stale Bot data cannot revive.
 */
export function completePendingBotDataReset(home: string, options: {
  protectedRoots?: string[];
  beforeErase?: () => void;
  remove?: (target: string) => void;
} = {}): boolean {
  const pending = readPending(home);
  if (!pending) return false;
  const bots = validateBotDataReset(home, options.protectedRoots);
  const retained = join(home, 'retained-runtime', pending.id);
  for (const bot of bots) assertDirectory(join(retained, bot.container, bot.name));
  const targets = new Set<string>(RESET_DIRECTORIES.map(name => join(home, name)));
  for (const name of readdirSync(home)) {
    if (RESET_FILES.some(file => name === file || name.startsWith(`${file}.`))) targets.add(join(home, name));
  }
  if (pending.resetRuntime) targets.add(join(home, 'retained-runtime'));
  const remove = options.remove ?? removeTree;
  return withBotLocks(bots, () => {
    options.beforeErase?.();
    if (!pending.resetRuntime) {
      for (const bot of bots) {
        const runtime = join(bot.root, 'runtime');
        if (!stat(runtime)) continue;
        const destination = join(retained, bot.container, bot.name);
        if (stat(destination)) throw new Error('Retained Runtime destination already exists; no data was overwritten.');
        mkdirSync(dirname(destination), { recursive: true });
        renameSync(runtime, destination);
      }
    }
    for (const target of targets) remove(target);
    // Always last. A crash/retry can safely repeat moves and removals.
    remove(join(home, DATA_RESET_JOURNAL));
    return true;
  });
}
