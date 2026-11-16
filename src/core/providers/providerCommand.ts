import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { commandIn, findOnPath } from './catalog.ts';

type InstallPlatform = 'windows' | 'macos' | 'linux';

interface InstallKnowledge {
  check?: {
    expectedPaths?: Partial<Record<InstallPlatform, string>>;
    pathHints?: Partial<Record<InstallPlatform, { directoryHint?: string }>>;
  };
}

/** Where a provider's own installer puts its CLI, as the Runtime knows it. */
export type InstallKnowledgeReader = (provider: string) => InstallKnowledge | undefined;

/**
 * ADR-032: the install knowledge the Runtime at `runtimeEntry` resolves commands with. Null when that Runtime
 * carries none (a test double) or it cannot be read, and then nothing is said to be missing.
 */
export async function loadInstallKnowledge(runtimeEntry: string): Promise<InstallKnowledgeReader | null> {
  const file = join(dirname(runtimeEntry), 'core', 'provider-install', 'knowledge.js');
  if (!existsSync(file)) return null;
  try {
    const module = (await import(pathToFileURL(file).href)) as { getProviderInstallKnowledge?: unknown };
    const read = module.getProviderInstallKnowledge;
    return typeof read === 'function' ? (provider) => read(provider) as InstallKnowledge | undefined : null;
  } catch {
    return null;
  }
}

/**
 * Whether the Runtime could launch `command` for `provider`. Looks at least everywhere the Runtime does: PATH, the
 * common npm folders on Windows, and the folder of the installer's expected path and its directory hint. A command
 * this does not find is one the Runtime cannot launch either.
 */
export function canFindProviderCommand(
  knowledge: InstallKnowledgeReader,
  provider: string,
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return findProviderCommand(knowledge, provider, command, env, platform) !== null;
}

/** Where `canFindProviderCommand` finds the command, or null. */
export function findProviderCommand(
  knowledge: InstallKnowledgeReader,
  provider: string,
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const onPath = findOnPath(command, env, platform);
  if (onPath) return onPath;
  const windows = platform === 'win32';
  const read = (name: string) => envValue(env, name, windows);
  // The Runtime looks in the common npm folders with a fixed list of extensions, whatever PATHEXT says.
  const inNpm = windows ? commandIn(command, npmFolders(read), env, platform, WINDOWS_NPM_EXTENSIONS) : null;
  if (inNpm) return inNpm;
  const dirs: string[] = [];
  let check: InstallKnowledge['check'];
  try {
    check = knowledge(provider)?.check;
  } catch {
    check = undefined;
  }
  const target: InstallPlatform = windows ? 'windows' : platform === 'darwin' ? 'macos' : 'linux';
  // The expected path names the stock binary, so its folder holds the command under one of its extensions.
  const expected = check?.expectedPaths?.[target];
  const expectedPath = expected ? expandInstallPath(expected, read) : null;
  if (expectedPath && commandBaseName(expectedPath) === command.toLowerCase() && existsSync(expectedPath)) return expectedPath;
  if (expectedPath) dirs.push(dirname(expectedPath));
  const hint = check?.pathHints?.[target]?.directoryHint;
  const hintPath = hint ? expandInstallPath(hint, read) : null;
  if (hintPath) dirs.push(hintPath);
  return commandIn(command, dirs, env, platform);
}

/**
 * Whether the command at `path` is a script that starts Node through its first line, as npm's `codex` is on macOS
 * and Linux, so it runs only where `node` is on PATH. A native binary, such as Homebrew's `codex`, is not.
 */
export function runsOnNode(path: string): boolean {
  try {
    const fd = openSync(path, 'r');
    try {
      const head = Buffer.alloc(128);
      const read = readSync(fd, head, 0, head.length, 0);
      const line = head.subarray(0, read).toString('utf8').split('\n', 1)[0] ?? '';
      return line.startsWith('#!') && /(?:^|[\s/])node(?:\s|$)/u.test(line.slice(2));
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

const WINDOWS_NPM_EXTENSIONS = ['.cmd', '.bat', '.exe'];

/** The npm folders the Runtime tries on Windows when PATH does not lead to a command. */
function npmFolders(read: (name: string) => string | undefined): string[] {
  const homes = [read('USERPROFILE'), read('HOME')].filter((value): value is string => Boolean(value));
  const appData = read('APPDATA');
  const localAppData = read('LOCALAPPDATA');
  return [
    ...[read('npm_config_prefix'), ...homes.map((home) => join(home, '.npm-global'))].filter((dir): dir is string => Boolean(dir)),
    ...(appData ? [join(appData, 'npm')] : homes.map((home) => join(home, 'AppData', 'Roaming', 'npm'))),
    ...(localAppData ? [join(localAppData, 'npm')] : homes.map((home) => join(home, 'AppData', 'Local', 'npm'))),
  ];
}

/** `muse`, `muse.cmd` and `…\muse\muse.cmd` all name the same command, as the Runtime compares them. */
function commandBaseName(path: string): string {
  return (path.split(/[\\/]/u).pop() ?? path).replace(/\.(?:exe|cmd|bat|com|ps1)$/iu, '').toLowerCase();
}

/** `%NAME%` from the Runtime's environment and a leading `~`, as the Runtime expands them; null when one is unset. */
function expandInstallPath(value: string, read: (name: string) => string | undefined): string | null {
  let expanded = value.replace(/%([^%]+)%/gu, (match, name: string) => read(name) ?? match);
  if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    const home = read('HOME') || read('USERPROFILE');
    if (!home) return null;
    expanded = `${home}${expanded.slice(1)}`;
  }
  return /%[^%]+%/u.test(expanded) ? null : expanded;
}

function envValue(env: NodeJS.ProcessEnv, name: string, windows: boolean): string | undefined {
  if (env[name]) return env[name];
  if (!windows) return undefined;
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}
