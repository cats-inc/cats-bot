import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { findOnPath } from '../../core/providers/catalog.ts';

/**
 * SPEC-010 FR-15: sign-in needs a real terminal, so this opens one with a fixed
 * command per provider. No text from a page or a model reaches it: the command
 * comes from this table and the page only names a provider from it.
 */

const SIGN_IN: Readonly<Record<string, string>> = {
  codex: 'codex login',
  claude: 'claude',
  antigravity: 'agy',
  grok: 'grok login',
  muse: 'muse login',
};

export function signInCommand(provider: unknown): string | null {
  return typeof provider === 'string' && Object.hasOwn(SIGN_IN, provider) ? SIGN_IN[provider]! : null;
}

export interface TerminalInvocation {
  command: string;
  args: string[];
  /** A script to write first, whose path replaces `{script}` in `args`. */
  script?: string;
}

/** Terminals on Linux, in the order tried, with how each takes one program to run. */
const LINUX_TERMINALS: ReadonlyArray<[string, string[]]> = [
  ['x-terminal-emulator', ['-e', '{script}']],
  ['gnome-terminal', ['--', '{script}']],
  ['konsole', ['-e', '{script}']],
  ['xfce4-terminal', ['-x', '{script}']],
  ['kitty', ['{script}']],
  ['alacritty', ['-e', '{script}']],
  ['xterm', ['-e', '{script}']],
];

const EARLY_EXIT_MS = 400;

function quoted(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * A script for macOS and Linux: a GUI launch has no login-shell PATH, so it carries
 * the app's, which holds every folder a helper reported. It leaves a shell open so
 * the owner can read the result.
 */
export function signInScript(command: string, path: string): string {
  return `#!/bin/sh\nrm -f -- "$0"\nexport PATH=${quoted(path)}\n${command}\nexec "\${SHELL:-/bin/sh}"\n`;
}

/** How to open a terminal on this OS, or null when none is known to be installed. */
export function terminalInvocation(
  platform: NodeJS.Platform,
  command: string,
  env: NodeJS.ProcessEnv,
  isInstalled: (program: string) => boolean = (program) => findOnPath(program, env, platform) !== null,
): TerminalInvocation | null {
  const path = env.PATH ?? env.Path ?? '';
  if (platform === 'win32') {
    // `start` opens a window of its own. Its first quoted argument is the window's title, and
    // it looks in the current folder first, so it gets the full path where there is one.
    // Command Prompt runs npm's .cmd shims, so this needs no PowerShell policy.
    const shell = env.ComSpec || 'cmd.exe';
    return { command: shell, args: ['/c', 'start', 'Cats Bot', shell, '/k', command] };
  }
  if (platform === 'darwin') {
    return { command: 'open', args: ['-a', 'Terminal', '{script}'], script: signInScript(command, path) };
  }
  if (platform === 'linux') {
    const found = LINUX_TERMINALS.find(([program]) => isInstalled(program));
    return found ? { command: found[0], args: [...found[1]], script: signInScript(command, path) } : null;
  }
  return null;
}

function writeScript(script: string, platform: NodeJS.Platform): string {
  const dir = mkdtempSync(join(tmpdir(), 'cats-bot-sign-in-'));
  // Terminal.app runs a file it is given only under this extension.
  const file = join(dir, platform === 'darwin' ? 'sign-in.command' : 'sign-in.sh');
  writeFileSync(file, script, { mode: 0o700 });
  chmodSync(file, 0o700);
  return file;
}

/** Opens the terminal. False when none could be opened, so the page offers the command to copy. */
export function openSignInTerminal(
  provider: unknown,
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; launch?: typeof spawn } = {},
): Promise<{ opened: boolean; command: string | null }> {
  const command = signInCommand(provider);
  if (!command) return Promise.resolve({ opened: false, command: null });
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const launch = options.launch ?? spawn;
  const invocation = terminalInvocation(platform, command, env);
  if (!invocation) return Promise.resolve({ opened: false, command });
  return new Promise((resolve) => {
    try {
      const script = invocation.script ? writeScript(invocation.script, platform) : '';
      const args = invocation.args.map((arg) => (arg === '{script}' ? script : arg));
      const child = launch(invocation.command, args, { detached: true, stdio: 'ignore', env, cwd: homedir(), windowsHide: false });
      child.once('error', () => resolve({ opened: false, command }));
      // A launcher with no display to open on starts, then exits with an error right away.
      child.once('exit', (code) => resolve({ opened: code === 0, command }));
      child.once('spawn', () => {
        child.unref();
        setTimeout(() => resolve({ opened: true, command }), EARLY_EXIT_MS);
      });
    } catch {
      resolve({ opened: false, command });
    }
  });
}
