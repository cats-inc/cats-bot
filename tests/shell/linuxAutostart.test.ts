import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';

import {
  LINUX_AUTOSTART_MARKER,
  linuxAutostartEnabled,
  linuxAutostartEntry,
  linuxAutostartPath,
  refreshLinuxAutostart,
  setLinuxAutostart,
} from '../../src/shell/electron/linuxAutostart.ts';

const EXECUTABLE = '/opt/Cats Bot/cats-bot';
const root = resolve(import.meta.dirname, '..', '..');

function entryPath(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'cats-bot-autostart-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return linuxAutostartPath({ XDG_CONFIG_HOME: directory }, '/unused');
}

const execLine = (executable: string): string => linuxAutostartEntry(executable).split('\n').find((line) => line.startsWith('Exec='))!;

test('the entry follows XDG_CONFIG_HOME only when it is absolute', () => {
  assert.equal(linuxAutostartPath({ XDG_CONFIG_HOME: '/config' }, '/home/me'), join('/config', 'autostart', 'cats-bot.desktop'));
  const inHome = join('/home/me', '.config', 'autostart', 'cats-bot.desktop');
  assert.equal(linuxAutostartPath({ XDG_CONFIG_HOME: 'relative' }, '/home/me'), inHome);
  assert.equal(linuxAutostartPath({}, '/home/me'), inHome);
});

test('the entry starts the installed launcher\'s backend and is skipped once the package is gone', () => {
  const entry = linuxAutostartEntry(EXECUTABLE);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { build: { linux: { executableArgs: string[] } } };
  assert.equal(execLine(EXECUTABLE), `Exec="${EXECUTABLE}" ${pkg.build.linux.executableArgs.join(' ')}`);
  assert.match(entry, /^\[Desktop Entry\]\nType=Application\n/u);
  assert.match(entry, new RegExp(`^TryExec=${EXECUTABLE}$`, 'mu'));
  assert.match(entry, /^Icon=cats-bot$/mu);
  assert.match(entry, /^Comment\[zh_TW\]=登入時啟動 Cats Bot$/mu);
  assert.ok(entry.includes(`\n${LINUX_AUTOSTART_MARKER}\n`));
  assert.ok(entry.endsWith('\n'));
});

test('Exec quotes reserved characters the way the Desktop Entry specification asks', () => {
  assert.match(execLine('/usr/bin/cats-bot'), /^Exec=\/usr\/bin\/cats-bot /u);
  assert.match(execLine('/opt/100%/cats-bot'), /^Exec=\/opt\/100%%\/cats-bot /u);
  assert.equal(execLine('/opt/a "b"/c').split(' --')[0], String.raw`Exec="/opt/a \\"b\\"/c"`);
  assert.equal(execLine('/opt/a$b `c`/d').split(' --')[0], String.raw`Exec="/opt/a\\$b \\` + '`c' + String.raw`\\` + '`/d"');
  assert.equal(execLine(String.raw`/opt/a b\c`).split(' --')[0], String.raw`Exec="/opt/a b\\\\c"`);
  assert.throws(() => linuxAutostartEntry('/opt/a\nExec=evil'), /cannot be written/u);
});

test('turning it on writes an enabled entry atomically, and off removes it', (t) => {
  const path = entryPath(t);
  assert.equal(linuxAutostartEnabled(path), false);
  setLinuxAutostart(path, false, EXECUTABLE);
  assert.equal(existsSync(path), false);
  setLinuxAutostart(path, true, EXECUTABLE);
  assert.equal(linuxAutostartEnabled(path), true);
  assert.equal(readFileSync(path, 'utf8'), linuxAutostartEntry(EXECUTABLE));
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o022, 0, 'only its owner may change what starts at sign-in');
  assert.deepEqual(readdirSync(dirname(path)), ['cats-bot.desktop']);
  setLinuxAutostart(path, false, EXECUTABLE);
  assert.equal(linuxAutostartEnabled(path), false);
  assert.equal(existsSync(path), false);
});

test('an entry someone else wrote is neither replaced nor removed', (t) => {
  const path = entryPath(t);
  mkdirSync(dirname(path), { recursive: true });
  const foreign = '[Desktop Entry]\nType=Application\nName=Mine\nExec=/usr/local/bin/mine\n';
  writeFileSync(path, foreign);
  assert.throws(() => setLinuxAutostart(path, true, EXECUTABLE), /not written by Cats Bot/u);
  assert.throws(() => setLinuxAutostart(path, false, EXECUTABLE), /not written by Cats Bot/u);
  refreshLinuxAutostart(path, EXECUTABLE);
  assert.equal(readFileSync(path, 'utf8'), foreign);
  // The session still starts it, so the setting reports what will really happen.
  assert.equal(linuxAutostartEnabled(path), true);
});

test('an entry disabled in the desktop settings counts as off and stays that way until turned on', (t) => {
  const path = entryPath(t);
  for (const flag of ['Hidden=true', 'X-GNOME-Autostart-enabled=false']) {
    setLinuxAutostart(path, true, EXECUTABLE);
    const disabled = `${readFileSync(path, 'utf8').replace('X-GNOME-Autostart-enabled=true\n', '')}${flag}\n`;
    writeFileSync(path, disabled);
    assert.equal(linuxAutostartEnabled(path), false);
    refreshLinuxAutostart(path, '/elsewhere/cats-bot');
    assert.equal(readFileSync(path, 'utf8'), disabled);
    setLinuxAutostart(path, true, EXECUTABLE);
    assert.equal(linuxAutostartEnabled(path), true);
  }
});

test('an enabled entry of ours follows this copy, and a removed one is not registered again', (t) => {
  const path = entryPath(t);
  refreshLinuxAutostart(path, EXECUTABLE);
  assert.equal(existsSync(path), false);
  setLinuxAutostart(path, true, '/old/cats-bot');
  refreshLinuxAutostart(path, EXECUTABLE);
  assert.equal(readFileSync(path, 'utf8'), linuxAutostartEntry(EXECUTABLE));
});

test('the shell offers Start at login on Linux only when installed, and the entry decides the setting', () => {
  const main = readFileSync(join(root, 'src/shell/electron/main.ts'), 'utf8');
  assert.match(main, /const linuxAutostart = process\.platform === 'linux' && app\.isPackaged \? linuxAutostartPath\(process\.env, homedir\(\)\) : null;/u);
  assert.match(main, /process\.platform === 'darwin' \|\| linuxAutostart !== null;/u);
  assert.match(main, /if \(linuxAutostart\) setLinuxAutostart\(linuxAutostart, enabled, process\.execPath\);\s+else app\.setLoginItemSettings/u);
  assert.match(main, /const enabled = linuxAutostartEnabled\(linuxAutostart\);\s+if \(enabled !== hubState\.openAtLogin\)/u);
});
