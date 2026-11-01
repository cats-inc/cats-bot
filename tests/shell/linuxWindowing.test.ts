import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linuxWindowingRelaunchArgs } from '../../src/shell/electron/linuxWindowing.ts';
import { FLOATING_CAT, floatingInputRegions } from '../../src/shell/electron/floatingPlacement.ts';

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
