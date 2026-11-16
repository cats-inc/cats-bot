import { existsSync } from 'node:fs';
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
  if (findOnPath(command, env, platform)) return true;
  const windows = platform === 'win32';
  const read = (name: string) => envValue(env, name, windows);
  const homes = [read('HOME'), read('USERPROFILE')].filter((value): value is string => Boolean(value));
  const dirs: string[] = [];
  if (windows) {
    const appData = read('APPDATA');
    const localAppData = read('LOCALAPPDATA');
    dirs.push(
      ...[read('npm_config_prefix'), ...homes.map((home) => join(home, '.npm-global'))].filter((dir): dir is string => Boolean(dir)),
      ...(appData ? [join(appData, 'npm')] : homes.map((home) => join(home, 'AppData', 'Roaming', 'npm'))),
      ...(localAppData ? [join(localAppData, 'npm')] : homes.map((home) => join(home, 'AppData', 'Local', 'npm'))),
    );
  }
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
  if (expectedPath) dirs.push(dirname(expectedPath));
  const hint = check?.pathHints?.[target]?.directoryHint;
  const hintPath = hint ? expandInstallPath(hint, read) : null;
  if (hintPath) dirs.push(hintPath);
  return commandIn(command, dirs, env, platform) !== null;
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
