import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { initializeBot, readBotProfile, type InitializeBotInput } from '../../../core/profile/initialize.ts';
import { readJsonFile } from '../../../core/store/atomicFile.ts';
import { acquireInstanceLock } from '../../../core/store/lock.ts';
import { botPathsFor, deriveBotId, hubPathsFor, isValidBotId } from '../../../core/store/paths.ts';
import { addBot, reconcileRegistry, writeRegistry, type BotRegistry, type RegistryBot } from './registry.ts';

/**
 * SPEC-008 FR-3, FR-5 and FR-6: what Settings → Bots does to the registry and
 * the bot directories. Removing a bot takes two steps, each confirmed by the
 * owner: archive (the directory moves to `archive/`) and, only for an
 * archived bot, delete (the directory moves to `trash/` and is removed).
 * Every rename happens under the bot's instance lock, and the rename is the
 * commit point: a registry write that fails after it is repaired by the next
 * reconcile, and a delete that stops partway is finished at the next start.
 */

/** A refusal the owner reads, such as the bot cap. */
export class BotManagementError extends Error {}

export interface BotCores {
  /** Stops the bot's core through its channel and closes its windows (FR-10). */
  stop(id: string): Promise<void>;
  /** Whether a core another host started runs this bot (FR-11). */
  hostedElsewhere(id: string): boolean;
}

export type NewBot = Omit<InitializeBotInput, 'id'> & { id?: string };

export class BotManager {
  private current: BotRegistry;
  private readonly home: string;
  private readonly cores: BotCores;
  private readonly now: () => Date;
  private busy: Promise<unknown> = Promise.resolve();

  constructor(home: string, registry: BotRegistry, cores: BotCores, now: () => Date = () => new Date()) {
    this.home = home;
    this.current = registry;
    this.cores = cores;
    this.now = now;
  }

  get registry(): BotRegistry {
    return this.current;
  }

  /** Bots that count toward the cap: registered and not archived. */
  activeCount(): number {
    return this.current.bots.filter((bot) => bot.archivedAt === null).length;
  }

  entry(id: string): RegistryBot | undefined {
    return this.current.bots.find((bot) => bot.id === id);
  }

  /** One change at a time, in the order asked. */
  private serial<T>(work: () => Promise<T> | T): Promise<T> {
    const next = this.busy.then(work, work);
    this.busy = next.catch(() => undefined);
    return next;
  }

  private save(registry: BotRegistry): void {
    this.current = registry;
    writeRegistry(this.home, registry);
  }

  private assertCap(): void {
    if (this.activeCount() >= this.current.maxBots) {
      throw new BotManagementError(`Cats Bot runs at most ${this.current.maxBots} bots. Archive one first.`);
    }
  }

  /** A free id: the given one, or one derived from the name with a number added when taken. */
  private freeId(input: NewBot): string {
    const paths = hubPathsFor(this.home);
    const taken = (id: string) => this.entry(id) !== undefined || existsSync(join(paths.bots, id)) || existsSync(join(paths.archive, id));
    if (input.id !== undefined) {
      if (!isValidBotId(input.id)) throw new BotManagementError(`"${input.id}" is not a valid bot id.`);
      if (taken(input.id)) throw new BotManagementError(`A bot with the id ${input.id} already exists.`);
      return input.id;
    }
    const base = deriveBotId(input.name);
    if (!taken(base)) return base;
    for (let n = 2; n < 1000; n += 1) {
      const id = `${base.slice(0, 60)}-${n}`;
      if (!taken(id)) return id;
    }
    throw new BotManagementError('No free bot id is left for that name.');
  }

  /** FR-5 and FR-6: a new bot, registered and not yet started. */
  create(input: NewBot): Promise<string> {
    return this.serial(() => {
      const id = this.freeId(input);
      this.assertCap();
      const { id: _requested, ...profile } = input;
      initializeBot(hubPathsFor(this.home).bots, { ...profile, id });
      this.save(addBot(this.current, id, this.now()));
      return id;
    });
  }

  /** FR-3: a directory the reconcile found without an entry, taken in at the owner's request. */
  register(id: string): Promise<void> {
    return this.serial(() => {
      if (this.entry(id)) return;
      const dir = join(hubPathsFor(this.home).bots, id);
      if (!isValidBotId(id) || !existsSync(dir) || !readBotProfile(dir)) throw new BotManagementError(`There is no bot ${id} to add.`);
      this.assertCap();
      this.save(addBot(this.current, id, this.now()));
    });
  }

  setStartAutomatically(id: string, value: boolean): Promise<void> {
    return this.serial(() => {
      if (!this.entry(id)) throw new BotManagementError(`There is no bot ${id}.`);
      this.save({ ...this.current, bots: this.current.bots.map((bot) => (bot.id === id ? { ...bot, startAutomatically: value } : bot)) });
    });
  }

  /** The order of the bots that are not archived, as given; archived ones keep theirs after them. */
  reorder(ids: string[]): Promise<void> {
    return this.serial(() => {
      const active = this.current.bots.filter((bot) => bot.archivedAt === null).map((bot) => bot.id);
      if (ids.length !== active.length || ids.some((id) => !active.includes(id)) || new Set(ids).size !== ids.length) {
        throw new BotManagementError('The new order must name every bot once.');
      }
      const position = new Map(ids.map((id, index) => [id, index]));
      this.save({
        ...this.current,
        bots: this.current.bots.map((bot) => ({ ...bot, order: position.get(bot.id) ?? ids.length + bot.order })),
      });
    });
  }

  /** FR-5 archive: stop, lock, rename into `archive/`, record. */
  archive(id: string): Promise<void> {
    return this.serial(async () => {
      const bot = this.entry(id);
      if (!bot || bot.archivedAt !== null) throw new BotManagementError(`Bot ${id} is not active.`);
      if (this.cores.hostedElsewhere(id)) {
        throw new BotManagementError(`Bot ${id} is running in another program. Stop it there first.`);
      }
      await this.cores.stop(id);
      const paths = hubPathsFor(this.home);
      this.move(id, join(paths.bots, id), join(paths.archive, id));
      const holder = this.current.coordinator.holder === id ? null : this.current.coordinator.holder;
      this.save({
        ...this.current,
        coordinator: { holder },
        bots: this.current.bots.map((entry) => (entry.id === id ? { ...entry, archivedAt: this.now().toISOString() } : entry)),
      });
    });
  }

  /** FR-5 restore: subject to the cap; the bot comes back stopped. */
  restore(id: string): Promise<void> {
    return this.serial(() => {
      const bot = this.entry(id);
      if (!bot || bot.archivedAt === null) throw new BotManagementError(`Bot ${id} is not archived.`);
      this.assertCap();
      const paths = hubPathsFor(this.home);
      this.move(id, join(paths.archive, id), join(paths.bots, id));
      this.save({ ...this.current, bots: this.current.bots.map((entry) => (entry.id === id ? { ...entry, archivedAt: null } : entry)) });
    });
  }

  /**
   * FR-5 delete, only for an archived bot: into `trash/`, out of the registry,
   * then removed with its encrypted secrets. Cannot be undone. The provider
   * CLIs' own folders are not touched.
   */
  delete(id: string): Promise<void> {
    return this.serial(() => {
      const bot = this.entry(id);
      const paths = hubPathsFor(this.home);
      if (!bot || bot.archivedAt === null || !existsSync(join(paths.archive, id))) {
        throw new BotManagementError(`Only an archived bot can be deleted; archive ${id} first.`);
      }
      const trashed = join(paths.trash, `${id}.${this.now().getTime()}`);
      this.move(id, join(paths.archive, id), trashed);
      this.save({ ...this.current, bots: this.current.bots.filter((entry) => entry.id !== id) });
      removeTree(trashed);
    });
  }

  /**
   * FR-3 at start: deletions the owner confirmed that stopped partway are
   * finished, and any entry they left is removed. Then the registry follows
   * the directories.
   */
  recover(): { unregistered: string[]; missing: string[]; skipped: string[] } {
    const paths = hubPathsFor(this.home);
    let registry = this.current;
    if (existsSync(paths.trash)) {
      for (const name of readdirSync(paths.trash)) {
        const id = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.\d+$/u.exec(name)?.[1];
        // A bot created again under the same id keeps its entry.
        if (id && !existsSync(join(paths.bots, id)) && !existsSync(join(paths.archive, id))) {
          registry = { ...registry, bots: registry.bots.filter((bot) => bot.id !== id) };
        }
        removeTree(join(paths.trash, name));
      }
    }
    if (registry.coordinator.holder && !registry.bots.some((bot) => bot.id === registry.coordinator.holder)) {
      registry = { ...registry, coordinator: { holder: null } };
    }
    const reconciled = reconcileRegistry(this.home, registry, this.now());
    if (JSON.stringify(reconciled.registry) !== JSON.stringify(this.current)) this.save(reconciled.registry);
    return { unregistered: reconciled.unregistered, missing: reconciled.missing, skipped: reconciled.skipped };
  }

  /** Renames a stopped bot's directory under its instance lock, which moves with it and is released after. */
  private move(id: string, from: string, to: string): void {
    const lock = acquireInstanceLock(botPathsFor(from));
    if (!lock.held) {
      throw new BotManagementError(`Bot ${id} is in use by another program (pid ${lock.owner.pid}); it was left as it is.`);
    }
    try {
      mkdirSync(dirname(to), { recursive: true });
      renameSync(from, to);
    } catch (error) {
      lock.release();
      throw new BotManagementError(`Bot ${id} could not be moved and was left as it is: ${error instanceof Error ? error.message : String(error)}`);
    }
    const moved = botPathsFor(to).lock;
    const held = readJsonFile<{ pid?: unknown }>(moved);
    if (held.ok && held.value.pid === process.pid) rmSync(moved, { force: true });
  }
}

/** Removes a directory tree without following junctions or symbolic links into their targets. */
function removeTree(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
