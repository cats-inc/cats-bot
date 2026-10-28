import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import type { BotStatus } from '../../src/core/bot.ts';
import type { ConversationRecord } from '../../src/core/types.ts';
import { bubbleText, catReachable, FLOATING_CAT, FLOATING_SIZE, placeFloating } from '../../src/shell/electron/floatingPlacement.ts';
import { buildTrayMenuTemplate, buildTrayTooltip } from '../../src/shell/electron/trayMenu.ts';
import { readShellState, shellStatePath, writeShellState } from '../../src/shell/electron/viewState.ts';

/** The shell's Electron-free pieces (SPEC-001 FR-33): the tray menu data and the note view state. */

let root: string;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'cats-bots-shell-'));
});
after(() => rmSync(root, { recursive: true, force: true }));

function conversation(id: string, role: 'home' | 'note', unreadCount: number, title = id): ConversationRecord {
  return {
    schemaVersion: 1,
    id,
    role,
    title,
    createdAt: '2026-10-27T10:00:00.000Z',
    updatedAt: '2026-10-27T10:00:00.000Z',
    attachment: { state: 'none', sessionId: null, providerSessionId: null, provider: null, model: null, configRevision: null, updatedAt: '2026-10-27T10:00:00.000Z' },
    unreadCount,
    lastOwnerMessageAt: null,
    lastBotMessageAt: null,
    checkpoint: null,
  };
}

const status: BotStatus = {
  id: 'mochi',
  name: 'Mochi',
  root: 'C:/tmp/mochi',
  runtime: { state: 'ready', pid: 1 },
  queue: { queued: 0, running: null },
  pendingInteractions: 0,
  conversations: 2,
  schedules: 0,
  heartbeat: { enabled: true, nextAt: null },
  lastTickAt: null,
  lock: null,
  telegram: { enabled: false, polling: false, ownerChatId: null },
};

test('the tray menu lists home, notes, settings, heartbeat, login and quit with unread counts', () => {
  const clicks: string[] = [];
  const template = buildTrayMenuTemplate({
    botName: 'Mochi',
    status,
    conversations: [conversation('home', 'home', 2, 'Home'), conversation('conv-1', 'note', 1, 'Scratch')],
    heartbeatEnabled: true,
    openAtLogin: false,
    openAtLoginAvailable: true,
    awaitingOwner: 1,
    floatingVisible: true,
  }, {
    onOpenConversation: (id) => clicks.push(`open:${id}`),
    onNewNote: () => clicks.push('new'),
    onOpenSettings: (tab) => clicks.push(`settings:${tab ?? 'bot'}`),
    onCheckForUpdates: () => clicks.push('updates'),
    onToggleHeartbeat: (enabled) => clicks.push(`heartbeat:${enabled}`),
    onToggleOpenAtLogin: (enabled) => clicks.push(`login:${enabled}`),
    onToggleFloating: (visible) => clicks.push(`floating:${visible}`),
    onQuit: () => clicks.push('quit'),
  });
  const labels = template.map((item) => item.label ?? item.type);
  assert.deepEqual(labels, [
    'Mochi: runtime ready, 3 unread, 1 waiting for you',
    'separator',
    'Open home note (2)',
    'Notes',
    'New note',
    'Manage notes…',
    'separator',
    'Pause heartbeat',
    'Show floating cat',
    'Start at login',
    'Settings…',
    'Check for Updates…',
    'separator',
    'Quit',
  ]);
  assert.equal(template[0]?.enabled, false);
  assert.equal(template[3]?.submenu?.[0]?.label, 'Scratch (1)');
  template[2]!.click!();
  template[3]!.submenu![0]!.click!();
  template[4]!.click!();
  template[5]!.click!();
  template[7]!.click!();
  template[8]!.click!();
  template[9]!.click!();
  template[10]!.click!();
  template[11]!.click!();
  template[13]!.click!();
  assert.equal(template[8]?.checked, true);
  assert.deepEqual(clicks, ['open:home', 'open:conv-1', 'new', 'settings:notes', 'heartbeat:false', 'floating:false', 'login:true', 'settings:bot', 'updates', 'quit']);
  assert.equal(buildTrayTooltip({ botName: 'Mochi', status, conversations: [conversation('home', 'home', 0)], heartbeatEnabled: true, openAtLogin: false, openAtLoginAvailable: false, awaitingOwner: 0, floatingVisible: true }), 'Mochi (runtime ready)');
  const paused = buildTrayMenuTemplate({ botName: 'Mochi', status: { ...status, runtime: { state: 'failed', pid: null } }, conversations: [], heartbeatEnabled: false, openAtLogin: true, openAtLoginAvailable: false, awaitingOwner: 0, floatingVisible: false }, {
    onOpenConversation: () => {}, onNewNote: () => {}, onOpenSettings: () => {}, onToggleHeartbeat: () => {}, onToggleOpenAtLogin: () => {}, onToggleFloating: () => {}, onQuit: () => {},
  });
  assert.equal(paused[0]?.label, 'Mochi: runtime failed, retrying');
  assert.ok(paused.some((item) => item.label === 'Resume heartbeat'));
  assert.ok(!paused.some((item) => item.label === 'Start at login'));
});

test('note view state normalises what it reads and round-trips what it writes', () => {
  const empty = readShellState(root);
  assert.deepEqual(empty, { schemaVersion: 1, views: {}, openAtLogin: false, floatingBot: { visible: true } });
  writeFileSync(shellStatePath(root), JSON.stringify({ views: { home: { x: 10, y: 20, width: 50, height: 'tall', alwaysOnTop: true, open: true }, bad: null }, openAtLogin: 'yes' }));
  const read = readShellState(root);
  assert.deepEqual(read.views.home, { x: 10, y: 20, width: 340, height: 460, layer: 'top', alwaysOnTop: true, open: true });
  assert.equal(read.views.bad, undefined);
  assert.equal(read.openAtLogin, false);
  assert.deepEqual(read.floatingBot, { visible: true });
  writeShellState(root, {
    schemaVersion: 1,
    views: { 'conv-1': { x: 1, y: 2, width: 300, height: 400, layer: 'normal', alwaysOnTop: false, open: false } },
    openAtLogin: true,
    floatingBot: { visible: false, x: -1500, y: 40 },
  });
  const again = readShellState(root);
  assert.equal(again.views['conv-1']?.width, 300);
  assert.equal(again.openAtLogin, true);
  assert.deepEqual(again.floatingBot, { visible: false, x: -1500, y: 40 });
});

test('the floating bot keeps its place on a live display and says one short line (SPEC-002 FR-7)', () => {
  const primary = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
  const left = { bounds: { x: -1600, y: 0, width: 1600, height: 900 }, workArea: { x: -1600, y: 0, width: 1600, height: 900 } };
  const corner = { x: 1920 - FLOATING_SIZE.width - 16, y: 1040 - FLOATING_SIZE.height - 16 };
  assert.deepEqual(placeFloating({}, [primary], primary), corner);
  assert.deepEqual(placeFloating({ x: -800, y: 300 }, [primary, left], primary), { x: -800, y: 300 });
  assert.deepEqual(placeFloating({ x: -800, y: 300 }, [primary], primary), corner, 'the left display is gone');
  // The window still touches the remaining display, but the cat (from x + 192) is entirely off it.
  assert.equal(catReachable({ x: 1800, y: 300 }, [primary]), false);
  assert.deepEqual(placeFloating({ x: 1800, y: 300 }, [primary], primary), corner);
  // Half the cat on screen is enough to grab it; the transparent rest may hang off the edge.
  const halfOff = { x: 1920 - FLOATING_CAT.x - FLOATING_CAT.width / 2, y: 300 };
  assert.equal(catReachable(halfOff, [primary]), true);
  assert.deepEqual(placeFloating(halfOff, [primary], primary), halfOff);
  assert.equal(catReachable({ x: halfOff.x + 1, y: 300 }, [primary]), false);
  // Over the taskbar (outside the work area but on the display) still counts.
  const onTaskbar = { x: 600, y: 1080 - FLOATING_CAT.y - FLOATING_CAT.height };
  assert.deepEqual(placeFloating(onTaskbar, [primary], primary), onTaskbar);
  // The cat can be reached across two displays only if one of them holds enough of it.
  assert.equal(catReachable({ x: -FLOATING_CAT.x - 20, y: 300 }, [primary, left]), true);
  assert.equal(bubbleText('**Hello** there,\n\n```js\ncode\n```\n`ok`'), 'Hello there, ok');
  const long = bubbleText('word '.repeat(100), 40);
  assert.equal(long.length, 40);
  assert.ok(long.endsWith('…'));
});

test('note layers: a file from before layers keeps its pinned notes on top, and layers round-trip (SPEC-002 FR-8)', () => {
  const dir = join(root, 'layers');
  mkdirSync(dir, { recursive: true });
  writeFileSync(shellStatePath(dir), JSON.stringify({
    schemaVersion: 1,
    views: {
      pinned: { width: 300, height: 300, alwaysOnTop: true, open: true },
      plain: { width: 300, height: 300, alwaysOnTop: false, open: true },
      odd: { width: 300, height: 300, layer: 'ceiling', open: false },
    },
    openAtLogin: false,
  }));
  const read = readShellState(dir);
  assert.equal(read.views.pinned?.layer, 'top');
  assert.equal(read.views.plain?.layer, 'normal');
  assert.equal(read.views.odd?.layer, 'normal', 'an unknown layer falls back to normal');
  read.views.pinned!.layer = 'desktop';
  read.views.plain!.layer = 'wallpaper';
  read.views.odd!.layer = 'top';
  writeShellState(dir, read);
  const raw = JSON.parse(readFileSync(shellStatePath(dir), 'utf8')) as { views: Record<string, { layer: string; alwaysOnTop: boolean }> };
  assert.deepEqual(raw.views.pinned, { ...raw.views.pinned, layer: 'desktop', alwaysOnTop: false });
  assert.deepEqual(raw.views.odd, { ...raw.views.odd, layer: 'top', alwaysOnTop: true }, 'older builds still float it');
  const again = readShellState(dir);
  assert.deepEqual([again.views.pinned?.layer, again.views.plain?.layer, again.views.odd?.layer], ['desktop', 'wallpaper', 'top']);
});
