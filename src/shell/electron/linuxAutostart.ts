import { readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { writeFileAtomic } from '../../core/store/atomicFile.ts';
import { translate } from '../../shared/language.ts';

/**
 * SPEC-008 FR-23 on Linux: Electron's login items cover Windows and macOS only,
 * so an installed copy writes an XDG autostart entry itself. The session reads
 * that file, so the file decides whether Start at login is on. Only an entry
 * carrying the marker is ever replaced or removed.
 */

export const LINUX_AUTOSTART_MARKER = 'X-Cats-Bot-Managed=true';

const ENTRY_NAME = 'cats-bot.desktop';
/** package.json's linux.executableArgs: the installed launcher starts with the same backend (ADR-012). */
const LAUNCH_ARGUMENTS = ['--ozone-platform=x11'];
const SIGN_IN_COMMENT = 'Start Cats Bot when I sign in';

export function linuxAutostartPath(env: NodeJS.ProcessEnv, home: string): string {
  const base = env.XDG_CONFIG_HOME;
  return join(base && isAbsolute(base) ? base : join(home, '.config'), 'autostart', ENTRY_NAME);
}

/** Desktop Entry quoting: reserved characters need double quotes, and string escapes apply on top. */
function execArgument(argument: string): string {
  const text = argument.replaceAll('%', '%%');
  if (/^[\w\-./=+,:@%]+$/u.test(text)) return text;
  return `"${text.replace(/["`$\\]/gu, '\\$&')}"`.replaceAll('\\', '\\\\');
}

export function linuxAutostartEntry(executable: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(executable)) throw new Error('The executable path cannot be written to a desktop entry.');
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=Cats Bot',
    `Comment=${translate('en', SIGN_IN_COMMENT)}`,
    `Comment[zh_TW]=${translate('zh-TW', SIGN_IN_COMMENT)}`,
    `Exec=${[executable, ...LAUNCH_ARGUMENTS].map(execArgument).join(' ')}`,
    // Removing the package cannot reach a user's home; this makes a left-behind entry do nothing.
    `TryExec=${executable.replaceAll('\\', '\\\\')}`,
    'Icon=cats-bot',
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    LINUX_AUTOSTART_MARKER,
    '',
  ].join('\n');
}

function readEntry(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

const entryLines = (text: string): string[] => text.split(/\r?\n/u).map((line) => line.trim());
const isManaged = (text: string): boolean => entryLines(text).includes(LINUX_AUTOSTART_MARKER);
const isDisabled = (text: string): boolean => {
  const lines = entryLines(text);
  return lines.includes('Hidden=true') || lines.includes('X-GNOME-Autostart-enabled=false');
};

/** Whether the session will start this entry, whoever wrote it. */
export function linuxAutostartEnabled(path: string): boolean {
  try {
    const text = readEntry(path);
    return text !== null && !isDisabled(text);
  } catch {
    return false;
  }
}

export function setLinuxAutostart(path: string, enabled: boolean, executable: string): void {
  const current = readEntry(path);
  if (current !== null && !isManaged(current)) throw new Error(`${path} was not written by Cats Bot.`);
  if (enabled) writeFileAtomic(path, linuxAutostartEntry(executable), { mode: 0o644 });
  else if (current !== null) rmSync(path, { force: true });
}

/** Keeps an enabled entry of ours on this copy's launch command. A disabled one stays the owner's choice. */
export function refreshLinuxAutostart(path: string, executable: string): void {
  const current = readEntry(path);
  if (current === null || !isManaged(current) || isDisabled(current)) return;
  const next = linuxAutostartEntry(executable);
  if (current !== next) writeFileAtomic(path, next, { mode: 0o644 });
}
