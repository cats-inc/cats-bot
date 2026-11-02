import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { linuxWindowingRelaunchArgs, linuxWindowsAreX11, linuxWindowsUnderWayland } from '../../src/shell/electron/linuxWindowing.ts';
import { displaysBounds, FLOATING_CAT, floatingInputRegions } from '../../src/shell/electron/floatingPlacement.ts';

const root = resolve(import.meta.dirname, '..', '..');

test('only a backend that really is X11 gets an X11 input shape', () => {
  for (const [platform, display, session, requested, expected] of [
    ['linux', ':0', 'wayland', 'x11', true],
    ['linux', ':0', 'x11', '', true],
    ['linux', ':0', '', '', true],
    ['linux', ':0', 'wayland', '', false],
    ['linux', ':0', 'x11', 'wayland', false],
    ['linux', ':0', 'wayland', 'auto', false],
    ['linux', '', 'x11', 'x11', false],
    ['darwin', ':0', 'x11', 'x11', false],
  ] as const) {
    assert.equal(linuxWindowsAreX11({ getSwitchValue: () => requested }, platform, { DISPLAY: display, XDG_SESSION_TYPE: session }), expected);
  }
});

test('only X11 windows on a Wayland desktop need help seeing a click outside a menu', () => {
  const x11 = { getSwitchValue: () => 'x11' };
  assert.equal(linuxWindowsUnderWayland(x11, 'linux', { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' }), true);
  assert.equal(linuxWindowsUnderWayland(x11, 'linux', { DISPLAY: ':0' }), false);
  assert.equal(linuxWindowsUnderWayland({ getSwitchValue: () => 'wayland' }, 'linux', { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' }), false);
  assert.equal(linuxWindowsUnderWayland(x11, 'darwin', { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' }), false);
});

test('every shell menu opens through popupMenu, which covers all displays and shows the menu first', () => {
  const main = readFileSync(join(root, 'src/shell/electron/main.ts'), 'utf8');
  assert.doesNotMatch(main, /\.popup\(/u);
  assert.equal(main.match(/popupMenu\(Menu\.buildFromTemplate\(template\), /gu)?.length, 2);
  const source = readFileSync(join(root, 'src/shell/electron/popupMenu.ts'), 'utf8');
  // Mapped with the menu or just before it, the menu often never paints (ADR-014).
  assert.match(source, /const CATCHER_DELAY_MS = [1-9]\d+;/u);
  assert.match(source, /setTimeout\(\(\) => \{\s+if \(!catcher\.isDestroyed\(\)\) catcher\.showInactive\(\);\s+\}, CATCHER_DELAY_MS\)/u);
  // It takes every click on the desktop, so a menu, its owner or the clock must remove it.
  assert.match(source, /const release = \(\): void => \{\s+clearTimeout\(showing\);\s+clearTimeout\(expiring\);[\s\S]*?if \(!catcher\.isDestroyed\(\)\) catcher\.destroy\(\);/u);
  assert.match(source, /window\.once\('closed', release\);\s+menu\.popup\(\{ window, callback: release \}\);/u);
  assert.match(source, /const CATCHER_MAX_MS = [1-9][\d_]+;/u);
  assert.match(source, /setTimeout\(\(\) => \{\s+release\(\);\s+if \(!window\.isDestroyed\(\)\) menu\.closePopup\(window\);\s+\}, CATCHER_MAX_MS\)/u);
  assert.deepEqual(displaysBounds([{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]), { x: 0, y: 0, width: 1920, height: 1080 });
  assert.deepEqual(displaysBounds([
    { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    { bounds: { x: -1280, y: 200, width: 1280, height: 720 } },
  ]), { x: -1280, y: 0, width: 3200, height: 1080 });
});

test('the Linux avatar never sets a bounding shape or Electron\'s input toggle', () => {
  // ADR-014: a bounding shape leaves black outside it under software compositing and
  // keeps swallowing clicks, and setIgnoreMouseEvents resets the input shape.
  const source = readFileSync(join(root, 'src/shell/electron/floatingBot.ts'), 'utf8');
  assert.doesNotMatch(source, /\.setShape\(/u);
  const reset = /const resetInput = \(\) => \{([\s\S]*?)\n    \};/u.exec(source)?.[1] ?? '';
  assert.match(reset, /if \(process\.platform === 'linux'\) this\.applyInputRegions\(\);\s+else window\.setIgnoreMouseEvents\(true, \{ forward: true \}\);/u);
  assert.match(source, /setInteractive\(interactive: boolean\): void \{\s+if \(process\.platform === 'linux'\) return;/u);
});

test('X11, unavailable XWayland and explicit Wayland do not relaunch; auto is replaced once', () => {
  for (const [platform, display, requested, args, expected] of [
    ['linux', ':0', 'x11', [], null], ['linux', '', 'wayland', [], null],
    ['linux', ':0', 'wayland', ['--ozone-platform=wayland'], null], ['darwin', ':0', 'wayland', [], null],
    ['linux', ':0', 'auto', ['--ozone-platform', 'auto'], ['--ozone-platform=x11']],
  ] as const) {
    assert.deepEqual(linuxWindowingRelaunchArgs({ getSwitchValue: () => requested }, platform,
      { DISPLAY: display, XDG_SESSION_TYPE: 'wayland' }, ['electron', ...args]), expected);
  }
});

test('automatic Wayland selection relaunches with X11 and preserves the app and debugging arguments', () => {
  assert.deepEqual(linuxWindowingRelaunchArgs({ getSwitchValue: () => 'wayland' }, 'linux', { DISPLAY: ':0', XDG_SESSION_TYPE: 'wayland' },
    ['electron', '/checkout', '--remote-debugging-port=9223', '--id', 'mochi']),
  ['/checkout', '--remote-debugging-port=9223', '--id', 'mochi', '--ozone-platform=x11']);
});

test('avatar input regions are bounded and malformed input cannot make its whole transparent window interactive', () => {
  assert.deepEqual(floatingInputRegions([FLOATING_CAT]), [FLOATING_CAT]);
  assert.deepEqual(floatingInputRegions([{ x: -4, y: -2, width: 30, height: 20 }]), [{ x: 0, y: 0, width: 26, height: 18 }]);
  for (const input of [null, [], [{}], [{ x: NaN, y: 0, width: 10, height: 10 }], [{ x: 0, y: 0, width: 0, height: 10 }], Array(9).fill(FLOATING_CAT)]) {
    assert.equal(floatingInputRegions(input), null);
  }
});
