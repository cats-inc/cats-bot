import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { BotCore, initializeBot, type BotCoreOptions, type InitializeBotInput } from '../../src/core/bot.ts';
import type { BotHostEvent, WorkItem } from '../../src/core/types.ts';

/**
 * Shared helpers for core tests. Every test gets its own temporary bots home
 * (SPEC-001 state hygiene: never the real `~/.cats`) and must call
 * `cleanup()` in `after`.
 */

export const supportDir = resolve(import.meta.dirname);
export const fakeRuntimeEntry = join(supportDir, 'fake-runtime.mjs');
export const fixtureCliDir = join(supportDir, 'fixture-cli');
/**
 * The fixture is run as `node claude-fixture.mjs …` through the runtime's
 * `launch.args`, never through a shell wrapper: cmd.exe would mangle the
 * quoted `--mcp-config` JSON the runtime passes.
 */
export const fixtureCliCommand = process.execPath;
export const fixtureCliLaunchArgs = [join(fixtureCliDir, 'claude-fixture.mjs')];

export interface TempHome {
  botsHome: string;
  cleanup(): void;
}

export function makeTempHome(prefix = 'cats-bots-test-'): TempHome {
  const botsHome = mkdtempSync(join(tmpdir(), prefix));
  return {
    botsHome,
    cleanup() {
      rmSync(botsHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

export interface TestBotOptions {
  botsHome: string;
  id?: string;
  profile?: Partial<InitializeBotInput>;
  core?: Partial<BotCoreOptions>;
  runtimeEnv?: NodeJS.ProcessEnv;
}

/** A bot on the fake runtime unless `core.runtime.runtimeEntry` says otherwise. */
export function openTestBot(options: TestBotOptions): { core: BotCore; root: string } {
  const id = options.id ?? 'testbot';
  const { root } = initializeBot(options.botsHome, {
    id,
    name: 'Test Bot',
    provider: 'claude',
    ...options.profile,
  });
  const core = BotCore.open({
    root,
    log: () => {},
    runtime: {
      runtimeEntry: fakeRuntimeEntry,
      readyTimeoutMs: 15_000,
      stopTimeoutMs: 3_000,
      env: { ...process.env, ...options.runtimeEnv },
      ...options.core?.runtime,
    },
    handoffPollMs: 100,
    // Tests drive the reconcile tick by hand unless they say otherwise.
    life: { startupDelayMs: 3_600_000, intervalMs: 3_600_000, ...options.core?.life },
    ...options.core,
  });
  return { core, root };
}

export function waitForEvent(
  core: BotCore,
  predicate: (event: BotHostEvent) => boolean,
  timeoutMs = 20_000,
): Promise<BotHostEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('timed out waiting for an event'));
    }, timeoutMs);
    const unsubscribe = core.subscribe((event) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
  });
}

export async function sendAndWait(core: BotCore, conversationId: string, text: string, timeoutMs = 20_000): Promise<WorkItem> {
  let itemId: string | null = null;
  const done = waitForEvent(core, (event) => event.type === 'turn.completed' && event.workItem.id === itemId, timeoutMs);
  const item = await core.sendOwnerMessage(conversationId, text);
  itemId = item.id;
  const event = await done;
  return event.type === 'turn.completed' ? event.workItem : item;
}

export async function fetchFakeState(core: BotCore): Promise<{ sessions: Array<Record<string, unknown>>; calls: Array<Record<string, unknown>> }> {
  const baseUrl = (core as unknown as { supervisor: { baseUrl: string | null } | null }).supervisor?.baseUrl;
  if (!baseUrl) throw new Error('fake runtime is not running');
  const response = await fetch(`${baseUrl}/__test/state`);
  return (await response.json()) as { sessions: Array<Record<string, unknown>>; calls: Array<Record<string, unknown>> };
}
