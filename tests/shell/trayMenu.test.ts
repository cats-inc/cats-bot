import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import type { BotStatus } from '../../src/core/bot.ts';
import type { ConversationRecord } from '../../src/core/types.ts';
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
  conversations: 2,
  schedules: 0,
  heartbeat: { enabled: true, nextAt: null },
  lastTickAt: null,
  lock: null,
  telegram: { enabled: false, polling: false, ownerChatId: null },
};

test('the tray menu lists home, notes, heartbeat, login and quit with unread counts', () => {
  const clicks: string[] = [];
  const template = buildTrayMenuTemplate({
    botName: 'Mochi',
    status,
    conversations: [conversation('home', 'home', 2, 'Home'), conversation('conv-1', 'note', 1, 'Scratch')],
    heartbeatEnabled: true,
    openAtLogin: false,
    openAtLoginAvailable: true,
    awaitingOwner: 1,
  }, {
    onOpenConversation: (id) => clicks.push(`open:${id}`),
    onNewNote: () => clicks.push('new'),
    onToggleHeartbeat: (enabled) => clicks.push(`heartbeat:${enabled}`),
    onToggleOpenAtLogin: (enabled) => clicks.push(`login:${enabled}`),
    onQuit: () => clicks.push('quit'),
  });
  const labels = template.map((item) => item.label ?? item.type);
  assert.deepEqual(labels, [
    'Mochi: runtime ready, 3 unread, 1 waiting for you',
    'separator',
    'Open home note (2)',
    'Notes',
    'New note',
    'separator',
    'Pause heartbeat',
    'Start at login',
    'separator',
    'Quit',
  ]);
  assert.equal(template[0]?.enabled, false);
  assert.equal(template[3]?.submenu?.[0]?.label, 'Scratch (1)');
  template[2]!.click!();
  template[3]!.submenu![0]!.click!();
  template[4]!.click!();
  template[6]!.click!();
  template[7]!.click!();
  template[9]!.click!();
  assert.deepEqual(clicks, ['open:home', 'open:conv-1', 'new', 'heartbeat:false', 'login:true', 'quit']);
  assert.equal(buildTrayTooltip({ botName: 'Mochi', status, conversations: [conversation('home', 'home', 0)], heartbeatEnabled: true, openAtLogin: false, openAtLoginAvailable: false, awaitingOwner: 0 }), 'Mochi (runtime ready)');
  const paused = buildTrayMenuTemplate({ botName: 'Mochi', status: { ...status, runtime: { state: 'failed', pid: null } }, conversations: [], heartbeatEnabled: false, openAtLogin: true, openAtLoginAvailable: false, awaitingOwner: 0 }, {
    onOpenConversation: () => {}, onNewNote: () => {}, onToggleHeartbeat: () => {}, onToggleOpenAtLogin: () => {}, onQuit: () => {},
  });
  assert.equal(paused[0]?.label, 'Mochi: runtime failed, retrying');
  assert.ok(paused.some((item) => item.label === 'Resume heartbeat'));
  assert.ok(!paused.some((item) => item.label === 'Start at login'));
});

test('note view state normalises what it reads and round-trips what it writes', () => {
  const empty = readShellState(root);
  assert.deepEqual(empty, { schemaVersion: 1, views: {}, openAtLogin: false });
  writeFileSync(shellStatePath(root), JSON.stringify({ views: { home: { x: 10, y: 20, width: 50, height: 'tall', alwaysOnTop: true, open: true }, bad: null }, openAtLogin: 'yes' }));
  const read = readShellState(root);
  assert.deepEqual(read.views.home, { x: 10, y: 20, width: 340, height: 460, alwaysOnTop: true, open: true });
  assert.equal(read.views.bad, undefined);
  assert.equal(read.openAtLogin, false);
  writeShellState(root, { schemaVersion: 1, views: { 'conv-1': { x: 1, y: 2, width: 300, height: 400, alwaysOnTop: false, open: false } }, openAtLogin: true });
  const again = readShellState(root);
  assert.equal(again.views['conv-1']?.width, 300);
  assert.equal(again.openAtLogin, true);
});
