import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDesktopHost } from '../../src/shell/electron/win32Desktop.ts';
import {
  DESKTOP_WINDOW,
  FakeDesktopWindows,
  ICONS_HOST,
  PROGMAN,
  SWP_FRAMECHANGED,
  SWP_NOACTIVATE,
  SWP_SHOWWINDOW,
  WALLPAPER_HOST,
  WS_CHILD,
  WS_POPUP,
  WS_VISIBLE,
} from '../support/fake-desktop-windows.ts';

/**
 * SPEC-002 FR-8 / ADR-002 §1 / ADR-011: the Windows desktop host's rules
 * against a fake window system with the classic 23H2 Explorer layout; no real
 * window is touched.
 */

const NOTE = { left: 100, top: 200, right: 400, bottom: 500 };
const REPAINT = [PROGMAN, 13, 1];

function setup(origin = { x: 0, y: 0 }) {
  const windows = new FakeDesktopWindows(origin);
  const host = createDesktopHost(windows, () => undefined);
  windows.requests = [];
  return { windows, host };
}

test('attach makes a note a child of the layer host at the same screen rectangle, without showing or activating it', () => {
  // A monitor left of the primary one: Explorer's hosts start at the virtual screen's left edge.
  const { windows, host } = setup({ x: -1920, y: 0 });
  const note = windows.addNote(100, NOTE);

  assert.equal(host.attach(note, 'wallpaper'), true);
  assert.equal(windows.get(note).parent, WALLPAPER_HOST);
  assert.equal(windows.style(note) & WS_CHILD, WS_CHILD);
  assert.equal(windows.style(note) & WS_POPUP, 0);
  assert.equal(windows.style(note) & WS_VISIBLE, WS_VISIBLE);
  assert.deepEqual(windows.positions.at(-1), { window: note, x: 2020, y: 200, width: 300, height: 300, flags: SWP_FRAMECHANGED | SWP_NOACTIVATE });
  assert.deepEqual(windows.rect(note), NOTE, 'the same place on screen');
  assert.equal(host.isAttached(note), true);
  assert.equal(host.attachedLayer(note), 'wallpaper');
  assert.equal(host.hostAlive(note), true);
  assert.deepEqual(windows.requests, [], 'joining the wallpaper uncovers nothing');

  assert.equal(host.attach(note, 'desktop'), true);
  assert.equal(windows.get(note).parent, ICONS_HOST);
  assert.equal(host.attachedLayer(note), 'desktop');
  assert.deepEqual(windows.rect(note), NOTE);
});

test('a hidden note stays hidden when it is attached or moved to another layer, and uncovers nothing', () => {
  const { windows, host } = setup();
  const note = windows.addNote(100, NOTE, false);

  host.attach(note, 'wallpaper');
  assert.equal(windows.style(note) & WS_VISIBLE, 0);
  host.attach(note, 'desktop');
  assert.equal(windows.style(note) & WS_VISIBLE, 0);
  assert.ok(windows.positions.every((call) => (call.flags & SWP_SHOWWINDOW) === 0));
  assert.deepEqual(windows.requests, [], 'a hidden note left nothing on the wallpaper host');

  host.attach(note, 'wallpaper');
  host.detach(note);
  assert.equal(windows.style(note) & WS_VISIBLE, 0);
  assert.deepEqual(windows.requests, []);
});

test('attach is refused when the DPI awareness differs or the layer has no host', () => {
  const { windows, host } = setup();
  const note = windows.addNote(100, NOTE);
  windows.get(note).awareness = 1;
  assert.equal(host.attach(note, 'wallpaper'), false);
  assert.equal(windows.get(note).parent, 0);
  assert.equal(host.attachedLayer(note), null);

  windows.get(note).awareness = 2;
  windows.destroy(WALLPAPER_HOST);
  assert.equal(host.attach(note, 'wallpaper'), false);
  assert.equal(windows.get(note).parent, 0);
});

test('a note moved from the wallpaper to the icons host asks Progman once to redraw the wallpaper', () => {
  const { windows, host } = setup();
  const note = windows.addNote(100, NOTE);
  host.attach(note, 'wallpaper');
  host.attach(note, 'wallpaper');
  assert.deepEqual(windows.requests, [], 'attaching again to the same host leaves nothing');
  host.attach(note, 'desktop');
  assert.deepEqual(windows.requests, [REPAINT]);
  host.attach(note, 'wallpaper');
  assert.deepEqual(windows.requests, [REPAINT], 'leaving the icons host needs no wallpaper redraw');
});

test('detach makes a note top-level again with its own style and current visibility; leaving the wallpaper repaints it', () => {
  const { windows, host } = setup();
  const note = windows.addNote(100, NOTE);
  const style = windows.style(note);
  host.attach(note, 'wallpaper');

  host.detach(note);
  assert.equal(windows.get(note).parent, 0);
  assert.equal(windows.style(note), style);
  assert.deepEqual(windows.rect(note), NOTE);
  assert.equal(host.attachedLayer(note), null);
  assert.equal(host.isAttached(note), false);
  assert.deepEqual(windows.requests, [REPAINT]);

  host.attach(note, 'desktop');
  windows.setShown(note, false);
  host.detach(note);
  assert.equal(windows.style(note), style & ~WS_VISIBLE, 'a note hidden while attached stays hidden');
  assert.deepEqual(windows.requests, [REPAINT], 'the icons host needs no wallpaper redraw');

  host.detach(note);
  assert.deepEqual(windows.requests, [REPAINT], 'a top-level note is left alone');
});

test('detach forgets a destroyed note; one destroyed on the wallpaper still has the wallpaper redrawn', () => {
  const { windows, host } = setup();
  const note = windows.addNote(100, NOTE);
  host.attach(note, 'wallpaper');
  windows.destroy(note);
  host.detach(note);
  assert.deepEqual(windows.requests, [REPAINT]);
  assert.equal(host.hostAlive(note), false);
});

test('released notes repaint the wallpaper once for all of them, and destroyed ones are forgotten', () => {
  const { windows, host } = setup();
  const [a, b, c] = [windows.addNote(100, NOTE), windows.addNote(101, NOTE), windows.addNote(102, NOTE)];
  host.attach(a, 'wallpaper');
  host.attach(b, 'wallpaper');
  host.attach(c, 'desktop');

  windows.setShown(c, false);
  host.released([{ window: c, shown: true }]);
  assert.deepEqual(windows.requests, [], 'the icons host needs no wallpaper redraw');

  windows.destroy(a);
  windows.destroy(b);
  host.released([{ window: a, shown: true }, { window: b, shown: true }]);
  assert.deepEqual(windows.requests, [REPAINT]);
  assert.equal(host.hostAlive(a), false, 'forgotten');
  host.released([{ window: a, shown: true }, { window: b, shown: true }]);
  assert.deepEqual(windows.requests, [REPAINT], 'nothing left to uncover');

  host.released([{ window: windows.addNote(103, NOTE), shown: true }]);
  assert.deepEqual(windows.requests, [REPAINT], 'a note never attached is ignored');
});

test('released notes that were hidden already uncover nothing, but destroyed ones are still forgotten', () => {
  const { windows, host } = setup();
  const [a, b] = [windows.addNote(100, NOTE), windows.addNote(101, NOTE)];
  host.attach(a, 'wallpaper');
  host.attach(b, 'wallpaper');
  windows.setShown(a, false);
  host.released([{ window: a, shown: true }]);
  assert.deepEqual(windows.requests, [REPAINT], 'hidden by the shell just now');

  windows.destroy(a);
  windows.destroy(b);
  host.released([{ window: a, shown: false }, { window: b, shown: false }]);
  assert.deepEqual(windows.requests, [REPAINT], 'forgetting hidden notes sends nothing more');
  assert.equal(host.hostAlive(a), false);
  assert.equal(host.hostAlive(b), false);
});

test('after Explorer restarts, the notes it took down are forgotten and a window given an old handle starts clean', () => {
  const { windows, host } = setup();
  const note = windows.addNote(100, NOTE);
  host.attach(note, 'wallpaper');
  windows.restartExplorer(1000);
  assert.equal(windows.alive(note), false, 'the child died with its host');

  // Windows reuses the handle for a new note window before anything reports the old one or looks
  // for the new hosts; attach does both.
  const reused = windows.addNote(100, NOTE);
  windows.get(reused).style |= 0x00040000;
  const style = windows.style(reused);
  assert.equal(host.attachedLayer(reused), null);
  assert.equal(host.hostAlive(reused), false);
  assert.equal(host.attach(reused, 'desktop'), true);
  assert.equal(windows.get(reused).parent, ICONS_HOST + 1000);
  assert.deepEqual(windows.requests, [], 'the old wallpaper host is gone and the new one draws its own wallpaper');
  host.detach(reused);
  assert.equal(windows.style(reused), style, "its own top-level style, not the dead note's");
});

test('a lift before anything looks at the hosts leaves a window holding a dead note handle alone', () => {
  const { windows, host } = setup();
  host.attach(windows.addNote(100, NOTE), 'wallpaper');
  windows.restartExplorer(1000);
  const reused = windows.addNote(100, NOTE);
  windows.get(reused).style |= 0x00040000;
  const style = windows.style(reused);
  const placed = windows.positions.length;
  // The owner opens the new note: the shell lifts it with detach, before any refresh.
  host.detach(reused);
  assert.equal(windows.style(reused), style);
  assert.equal(windows.positions.length, placed, 'not moved');
  assert.deepEqual(windows.requests, []);
  assert.equal(host.hostAlive(reused), false, 'forgotten');
});

test('shown means the own WS_VISIBLE of the note, as the shell reports it, whatever the visibility of its host', () => {
  const { windows, host } = setup();
  const note = windows.addNote(100, NOTE);
  host.attach(note, 'wallpaper');
  windows.setShown(WALLPAPER_HOST, false);
  assert.equal(windows.visible(note), false, 'IsWindowVisible would say hidden');
  host.attach(note, 'desktop');
  assert.deepEqual(windows.requests, [REPAINT]);
});

test('bring to front shows and activates a top-level note', () => {
  const { windows, host } = setup();
  const note = windows.addNote(100, NOTE, false);
  assert.equal(host.bringToFront(note), true);
  assert.equal(windows.style(note) & WS_VISIBLE, WS_VISIBLE);
  assert.equal(windows.parentOf(note), DESKTOP_WINDOW);
});
