import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import type { BotStatus } from '../../src/core/bot.ts';
import type { ConversationRecord } from '../../src/core/types.ts';
import { bubbleText, catReachable, FLOATING_CAT, FLOATING_SIZE, placeFloating } from '../../src/shell/electron/floatingPlacement.ts';
import { buildHubTrayMenuTemplate, buildHubTrayTooltip, buildTrayMenuTemplate, buildTrayTooltip, type TrayMenuActions, type TrayMenuModel } from '../../src/shell/electron/trayMenu.ts';
import {
  readShellState,
  shellStatePath,
  startupConversations,
  writeShellState,
} from '../../src/shell/electron/viewState.ts';

/** The shell's Electron-free pieces (SPEC-001 FR-33): the tray menu data and the note view state. */

let root: string;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'cats-bot-shell-'));
});
after(() => rmSync(root, { recursive: true, force: true }));

test('restart distinguishes first launch from deliberately hiding every conversation and the avatar', () => {
  const dir = join(root, 'restart');
  mkdirSync(dir);
  const state = readShellState(dir);
  assert.deepEqual(startupConversations(state), ['home'], 'first launch opens direct message');
  state.views.home = {
    width: 340,
    height: 460,
    x: 12,
    y: 34,
    layer: 'normal',
    alwaysOnTop: false,
    open: false,
  };
  state.views.work = {
    width: 350,
    height: 470,
    x: -700,
    y: 80,
    layer: 'desktop',
    alwaysOnTop: false,
    open: false,
  };
  state.floatingBot = { visible: false, x: -400, y: 40 };
  state.language = 'zh-TW';
  writeShellState(dir, state);
  const hidden = readShellState(dir);
  assert.deepEqual(
    startupConversations(hidden),
    [],
    'hiding all windows is not a new installation',
  );
  assert.deepEqual(
    hidden,
    state,
    'visibility, screen coordinates, layer and language survive disk reload',
  );
  hidden.views.work!.open = true;
  writeShellState(dir, hidden);
  assert.deepEqual(
    startupConversations(readShellState(dir)),
    ['work'],
    'direct message remains hidden',
  );
});

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

const DESKTOP_OFF = { enabled: false, pendingRequests: 0, waitingConversationId: null, holding: [] };

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
    desktopControl: DESKTOP_OFF,
  }, {
    onOpenConversation: (id) => clicks.push(`open:${id}`),
    onNewNote: () => clicks.push('new'),
    onOpenSettings: (tab) => clicks.push(`settings:${tab ?? 'bot'}`),
    onCheckForUpdates: () => clicks.push('updates'),
    onToggleHeartbeat: (enabled) => clicks.push(`heartbeat:${enabled}`),
    onToggleOpenAtLogin: (enabled) => clicks.push(`login:${enabled}`),
    onToggleFloating: (visible) => clicks.push(`floating:${visible}`),
    onStopDesktopControl: () => clicks.push('desktop-stop'),
    onQuit: () => clicks.push('quit'),
  });
  const labels = template.map((item) => item.label ?? item.type);
  assert.deepEqual(labels, [
    'Mochi: runtime ready, 3 unread, 1 waiting for you',
    'separator',
    'Open direct message (2)',
    'Conversations',
    'New conversation',
    'Manage conversations…',
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
  assert.equal(buildTrayTooltip({ botName: 'Mochi', status, conversations: [conversation('home', 'home', 0)], heartbeatEnabled: true, openAtLogin: false, openAtLoginAvailable: false, awaitingOwner: 0, floatingVisible: true, desktopControl: DESKTOP_OFF }), 'Mochi (runtime ready)');
  const paused = buildTrayMenuTemplate({ botName: 'Mochi', status: { ...status, runtime: { state: 'failed', pid: null } }, conversations: [], heartbeatEnabled: false, openAtLogin: true, openAtLoginAvailable: false, awaitingOwner: 0, floatingVisible: false, desktopControl: DESKTOP_OFF }, {
    onOpenConversation: () => {}, onNewNote: () => {}, onOpenSettings: () => {}, onToggleHeartbeat: () => {}, onToggleOpenAtLogin: () => {}, onToggleFloating: () => {}, onStopDesktopControl: () => {}, onQuit: () => {},
  });
  assert.equal(paused[0]?.label, 'Mochi: runtime failed, retrying');
  assert.ok(paused.some((item) => item.label === 'Resume heartbeat'));
  assert.ok(!paused.some((item) => item.label === 'Start at login'));
});

test('the tray shows desktop control while it is on, opens the note that waits and stops every conversation (SPEC-006 BDC-10)', () => {
  const clicks: string[] = [];
  const actions = {
    onOpenConversation: (id: string) => clicks.push(`open:${id}`), onNewNote: () => {}, onOpenSettings: () => {}, onToggleHeartbeat: () => {},
    onToggleOpenAtLogin: () => {}, onToggleFloating: () => {}, onStopDesktopControl: () => clicks.push('desktop-stop'), onQuit: () => {},
  };
  const base = {
    botName: 'Mochi', status, conversations: [conversation('home', 'home', 0, 'Home'), conversation('conv-1', 'note', 0, 'Scratch')],
    heartbeatEnabled: true, openAtLogin: false, openAtLoginAvailable: false, awaitingOwner: 0, floatingVisible: true,
  };
  const off = buildTrayMenuTemplate({ ...base, desktopControl: DESKTOP_OFF }, actions);
  assert.ok(!off.some((item) => item.label?.includes('esktop control')), 'nothing while the profile switch is off');

  const on = { ...base, desktopControl: { enabled: true, pendingRequests: 0, waitingConversationId: null, holding: [] } };
  const idle = buildTrayMenuTemplate(on, actions);
  assert.ok(!idle.some((item) => item.label?.startsWith('Desktop control requests')));
  const stop = idle.find((item) => item.label === 'Stop desktop control');
  assert.ok(stop, 'Stop is offered whenever desktop control is on');
  stop.click!();
  assert.equal(buildTrayTooltip(on), 'Mochi (runtime ready) - desktop control on');

  const waiting = { ...base, desktopControl: { enabled: true, pendingRequests: 2, waitingConversationId: 'conv-1', holding: [] } };
  const template = buildTrayMenuTemplate(waiting, actions);
  const labels = template.map((item) => item.label ?? item.type);
  assert.deepEqual(labels.slice(0, 4), [
    'Mochi: runtime ready',
    'separator',
    'Open direct message',
    'Desktop control requests (2)',
  ]);
  assert.ok(labels.indexOf('Stop desktop control') > labels.indexOf('Pause heartbeat'));
  template[3]!.click!();
  assert.equal(buildTrayTooltip(waiting), 'Mochi (runtime ready) - desktop control request waiting');
  const unknown = buildTrayMenuTemplate({ ...base, desktopControl: { enabled: true, pendingRequests: 1, waitingConversationId: null,
    holding: [] } }, actions);
  unknown.find((item) => item.label === 'Desktop control requests (1)')!.click!();
  assert.deepEqual(clicks, ['desktop-stop', 'open:conv-1', 'open:home'], 'the tray opens the note; it never answers a grant');
});

test('while the bot holds control the tray names the app and offers Stop first (SPEC-006 BDC-10, SPEC-133 DC-11)', () => {
  const clicks: string[] = [];
  const actions = {
    onOpenConversation: (id: string) => clicks.push(`open:${id}`), onNewNote: () => {}, onOpenSettings: () => {}, onToggleHeartbeat: () => {},
    onToggleOpenAtLogin: () => {}, onToggleFloating: () => {}, onStopDesktopControl: () => clicks.push('desktop-stop'), onQuit: () => {},
  };
  const base = {
    botName: 'Mochi', status, conversations: [conversation('home', 'home', 0, 'Home')],
    heartbeatEnabled: true, openAtLogin: false, openAtLoginAvailable: false, awaitingOwner: 0, floatingVisible: true,
  };
  const holding = { ...base, desktopControl: { enabled: true, pendingRequests: 1, waitingConversationId: 'home',
    holding: [{ conversationId: 'home', app: '記事本' }, { conversationId: 'conv-1', app: '記事本' }] } };
  const template = buildTrayMenuTemplate(holding, actions);
  const labels = template.map((item) => item.label ?? item.type);
  assert.deepEqual(labels.slice(0, 3), ['Stop desktop control (記事本)', 'separator', 'Mochi: runtime ready'],
    'Stop is the nearest item, and each app is named once');
  assert.equal(labels.filter((label) => label?.startsWith('Stop desktop control')).length, 1, 'one Stop item');
  assert.ok(labels.includes('Desktop control requests (1)'), 'a waiting request still opens its note');
  template[0]!.click!();
  assert.deepEqual(clicks, ['desktop-stop']);
  assert.equal(buildTrayTooltip(holding), 'Mochi (runtime ready) - the bot is operating 記事本');

  const released = { ...base, desktopControl: { enabled: true, pendingRequests: 0, waitingConversationId: null, holding: [] } };
  assert.equal(buildTrayMenuTemplate(released, actions)[0]!.label, 'Mochi: runtime ready', 'the release takes the item away');
  assert.equal(buildTrayTooltip(released), 'Mochi (runtime ready) - desktop control on');
});

test('note view state normalises what it reads and round-trips what it writes', () => {
  const empty = readShellState(root);
  assert.deepEqual(empty, {
    schemaVersion: 1,
    language: 'system',
    views: {},
    openAtLogin: false,
    floatingBot: { visible: true },
  });
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

test('the hub tray: one bot keeps today\'s menu, more bots get a submenu each and share the hub items (SPEC-008 FR-16)', () => {
  const clicks: string[] = [];
  const actionsFor = (bot: string): TrayMenuActions => ({
    onOpenConversation: (id) => clicks.push(`${bot}:open:${id}`),
    onNewNote: () => clicks.push(`${bot}:new`),
    onOpenSettings: () => clicks.push(`${bot}:settings`),
    onCheckForUpdates: () => clicks.push(`${bot}:updates`),
    onToggleHeartbeat: () => clicks.push(`${bot}:heartbeat`),
    onToggleOpenAtLogin: () => clicks.push(`${bot}:login`),
    onToggleFloating: () => clicks.push(`${bot}:floating`),
    onStopDesktopControl: () => clicks.push(`${bot}:desktop-stop`),
    onQuit: () => clicks.push(`${bot}:quit`),
  });
  const model = (name: string, unread: number, waiting: number): TrayMenuModel => ({
    botName: name,
    status: { ...status, name },
    conversations: [conversation('home', 'home', unread, 'Home')],
    heartbeatEnabled: true,
    openAtLogin: true,
    openAtLoginAvailable: true,
    awaitingOwner: waiting,
    floatingVisible: false,
    desktopControl: DESKTOP_OFF,
  });
  const hub = {
    onOpenBots: () => clicks.push('hub:bots'),
    onCheckForUpdates: () => clicks.push('hub:updates'),
    onToggleOpenAtLogin: (enabled: boolean) => clicks.push(`hub:login:${enabled}`),
    onQuit: () => clicks.push('hub:quit'),
  };
  const one = { bots: [{ model: model('Mochi', 0, 0), actions: actionsFor('mochi') }], openAtLogin: true, openAtLoginAvailable: true };
  assert.deepEqual(
    buildHubTrayMenuTemplate(one, hub).map((item) => item.label ?? item.type),
    buildTrayMenuTemplate(one.bots[0]!.model, one.bots[0]!.actions).map((item) => item.label ?? item.type),
    'one bot: today\'s menu',
  );
  assert.equal(buildHubTrayTooltip(one), buildTrayTooltip(one.bots[0]!.model));

  const two = {
    bots: [{ model: model('Mochi', 2, 1), actions: actionsFor('mochi') }, { model: model('Nori', 0, 0), actions: actionsFor('nori') }],
    openAtLogin: true,
    openAtLoginAvailable: true,
  };
  const template = buildHubTrayMenuTemplate(two, hub);
  assert.deepEqual(template.map((item) => item.label ?? item.type),
    ['Mochi (3)', 'Nori', 'separator', 'Bots…', 'Start at login', 'Check for Updates…', 'separator', 'Quit']);
  const mochi = template[0]!.submenu!;
  assert.equal(mochi.some((item) => item.label === 'Quit' || item.label === 'Start at login' || item.label === 'Check for Updates…'), false,
    'a bot\'s submenu has no hub items');
  mochi.find((item) => item.label?.startsWith('Open direct message'))!.click!();
  template[1]!.submenu!.find((item) => item.label === 'Settings…')!.click!();
  template.find((item) => item.label === 'Bots…')!.click!();
  template.find((item) => item.label === 'Start at login')!.click!();
  template.find((item) => item.label === 'Quit')!.click!();
  assert.deepEqual(clicks, ['mochi:open:home', 'nori:settings', 'hub:bots', 'hub:login:false', 'hub:quit']);
  assert.equal(buildHubTrayTooltip(two), 'Cats Bot (2 bots) - 2 unread - 1 waiting for you');

  const none = buildHubTrayMenuTemplate({ bots: [], openAtLogin: false, openAtLoginAvailable: false, locale: 'zh-TW' }, hub);
  assert.deepEqual(none.map((item) => item.label ?? item.type), ['沒有正在執行的機器人', 'separator', '機器人…', '檢查更新…', 'separator', '結束']);
});
