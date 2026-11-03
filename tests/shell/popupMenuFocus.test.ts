import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import type { BrowserWindow, Menu } from 'electron';

import { popupMenuWithFocus } from '../../src/shell/electron/popupMenuFocus.ts';

class Owner extends EventEmitter {
  destroyed = false;
  focusable = false;
  focused = false;
  calls: string[] = [];
  isDestroyed() { return this.destroyed; }
  isFocusable() { return this.focusable; }
  isFocused() { return this.focused; }
  setFocusable(value: boolean) { this.focusable = value; this.calls.push(`focusable:${value}`); }
  focus() { this.focused = true; this.calls.push('focus'); }
  blur() { this.focused = false; this.calls.push('blur'); }
  close() { this.destroyed = true; this.emit('closed'); }
}

class Popup extends EventEmitter {
  callback?: () => void;
  owner?: BrowserWindow;
  focusedAtPopup = false;
  cancelled = 0;
  failure?: Error;
  popup(options: { window: BrowserWindow; callback?: () => void }) {
    this.owner = options.window;
    this.callback = options.callback;
    this.focusedAtPopup = options.window.isFocused();
    if (this.failure) throw this.failure;
  }
  closePopup() { this.cancelled++; }
  closed() { this.emit('menu-will-close'); this.callback?.(); }
}

function open(menu: Popup, owner: Owner) {
  popupMenuWithFocus(menu as unknown as Menu, owner as unknown as BrowserWindow);
}

function assertReleased(menu: Popup, owner: Owner) {
  assert.equal(owner.focusable, false);
  assert.equal(owner.focused, false);
  assert.equal(owner.listenerCount('hide'), 0);
  assert.equal(owner.listenerCount('closed'), 0);
  assert.equal(menu.listenerCount('menu-will-close'), 0);
}

test('an avatar menu gets an active owner and releases it when the menu closes', () => {
  const owner = new Owner(), menu = new Popup();
  open(menu, owner);
  assert.equal(menu.owner, owner);
  assert.equal(owner.focusable, true);
  assert.equal(menu.focusedAtPopup, true);
  menu.closed();
  assertReleased(menu, owner);
  assert.deepEqual(owner.calls, ['focusable:true', 'focus', 'focusable:false', 'blur']);
});

test('the popup callback restores focusability even without a menu-close event', () => {
  const owner = new Owner(), menu = new Popup();
  open(menu, owner);
  menu.callback?.();
  assertReleased(menu, owner);
  const calls = [...owner.calls];
  menu.closed();
  menu.callback?.();
  assert.deepEqual(owner.calls, calls, 'cleanup runs only once');
});

test('closing a menu does not change focus after a menu action focuses another window', () => {
  const owner = new Owner(), menu = new Popup();
  open(menu, owner);
  owner.focused = false;
  menu.closed();
  assertReleased(menu, owner);
  assert.ok(!owner.calls.includes('blur'));
});

test('an ordinary focusable owner keeps its existing behavior', () => {
  const owner = new Owner(), menu = new Popup();
  owner.focusable = true;
  open(menu, owner);
  menu.closed();
  assert.equal(owner.focusable, true);
  assert.deepEqual(owner.calls, []);
  assert.equal(owner.listenerCount('hide'), 0);
});

test('hiding an avatar cancels its menu and restores it even if no callback arrives', () => {
  const owner = new Owner(), menu = new Popup();
  open(menu, owner);
  owner.emit('hide');
  assert.equal(menu.cancelled, 1);
  assertReleased(menu, owner);
});

test('destroying the owner releases listeners without calling its native methods', () => {
  const owner = new Owner(), menu = new Popup();
  open(menu, owner);
  const calls = [...owner.calls];
  owner.close();
  menu.callback?.();
  assert.deepEqual(owner.calls, calls);
  assert.equal(owner.listenerCount('hide'), 0);
  assert.equal(menu.listenerCount('menu-will-close'), 0);
  assert.equal(menu.cancelled, 0);
});

test('a failed popup restores the avatar and propagates the original failure', () => {
  const owner = new Owner(), menu = new Popup();
  menu.failure = new Error('popup failed');
  assert.throws(() => open(menu, owner), error => error === menu.failure);
  assertReleased(menu, owner);
});

test('a replacement popup cannot lose focus to the previous popup\'s late callback', () => {
  const owner = new Owner(), first = new Popup(), next = new Popup();
  open(first, owner);
  open(next, owner);
  assert.equal(first.cancelled, 1);
  assert.equal(next.focusedAtPopup, true);
  first.closed();
  assert.equal(owner.focusable, true);
  assert.equal(owner.focused, true);
  next.closed();
  assertReleased(next, owner);
});

test('different avatars keep independent menu owners', () => {
  const a = new Owner(), b = new Owner(), first = new Popup(), second = new Popup();
  open(first, a);
  open(second, b);
  first.closed();
  assertReleased(first, a);
  assert.equal(b.focusable, true);
  second.closed();
  assertReleased(second, b);
});

test('a destroyed owner never opens a menu', () => {
  const owner = new Owner(), menu = new Popup();
  owner.close();
  open(menu, owner);
  assert.equal(menu.owner, undefined);
  assert.deepEqual(owner.calls, []);
});
