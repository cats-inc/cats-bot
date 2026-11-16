import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CatClicks, QUICK_MENU_CLICK_WAIT_MS } from '../../src/renderer/floatingClicks.ts';

function harness() {
  const calls: string[] = [];
  let timer = null as { run: () => void; ms: number } | null;
  const clicks = new CatClicks({
    activate: () => calls.push('activate'),
    openMenu: (pressedAt) => calls.push(`open@${pressedAt}`),
    closeMenu: () => calls.push('close'),
    setTimer: (run, ms) => {
      timer = { run, ms };
      return timer;
    },
    clearTimer: (handle) => {
      if (handle === timer) timer = null;
    },
  });
  const elapse = () => {
    const due = timer;
    timer = null;
    assert.equal(due?.ms, QUICK_MENU_CLICK_WAIT_MS);
    due!.run();
  };
  return { clicks, calls, elapse, pending: () => timer !== null };
}

test('with the quick menu off or not yet told, every click opens the direct message at once, as before', () => {
  const { clicks, calls, pending } = harness();
  clicks.press(1);
  clicks.click(1);
  clicks.update({ enabled: false, open: false });
  clicks.click(1);
  clicks.click(2);
  assert.deepEqual(calls, ['activate', 'activate', 'activate']);
  assert.equal(pending(), false);
});

test('a single click waits, then opens the menu for the press that asked; a double click opens the direct message', () => {
  const { clicks, calls, elapse, pending } = harness();
  clicks.update({ enabled: true, open: false });
  clicks.press(1000);
  clicks.click(1);
  assert.deepEqual(calls, []);
  elapse();
  assert.deepEqual(calls, ['open@1000']);

  calls.length = 0;
  clicks.update({ enabled: true, open: false });
  clicks.press(2000);
  clicks.click(1);
  clicks.press(2100);
  clicks.click(2);
  assert.deepEqual(calls, ['activate']);
  assert.equal(pending(), false);
});

test('a click while the menu is open closes it at once; a slow second click still counts as a double click', () => {
  const { clicks, calls, elapse } = harness();
  clicks.update({ enabled: true, open: true });
  clicks.click(1);
  assert.deepEqual(calls, ['close']);

  // The second click came after the wait, so the menu opened first; its click count still says double.
  calls.length = 0;
  clicks.update({ enabled: true, open: false });
  clicks.click(1);
  elapse();
  clicks.click(2);
  assert.deepEqual(calls, ['open@0', 'activate']);
});

test('an open the shell declined does not swallow the next click once the shell says the menu is closed', () => {
  const { clicks, calls, elapse } = harness();
  clicks.update({ enabled: true, open: false });
  clicks.click(1);
  elapse();
  // The page counted the menu open when it asked; the shell answers that it is not.
  clicks.update({ enabled: true, open: false });
  calls.length = 0;
  clicks.click(1);
  elapse();
  assert.deepEqual(calls, ['open@0']);
});

test('dragging the cat cancels a waiting click and closes an open menu; turning the menu off cancels too', () => {
  const { clicks, calls, pending } = harness();
  clicks.update({ enabled: true, open: false });
  clicks.click(1);
  clicks.dragStarted();
  assert.equal(pending(), false);
  assert.deepEqual(calls, []);

  clicks.update({ enabled: true, open: true });
  clicks.dragStarted();
  assert.deepEqual(calls, ['close']);

  clicks.update({ enabled: true, open: false });
  clicks.click(1);
  clicks.update({ enabled: false, open: false });
  assert.equal(pending(), false);
});
