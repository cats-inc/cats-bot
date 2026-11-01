// Build first. Usage: electron scripts/testing/bot-interaction-acceptance.mjs [--native-drag]
// Only a disposable profile and fake Runtime are used. --native-drag sends
// pointer input to this fixture's X11 windows and requires xdotool on Linux.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { BotCore, initializeBot } from '../../dist/core/bot.js';
import { NoteWindows } from '../../dist/shell/electron/windows.js';
import { FloatingBot } from '../../dist/shell/electron/floatingBot.js';
import { relaunchForLinuxWindowing } from '../../dist/shell/electron/linuxWindowing.js';

relaunchForLinuxWindowing(app);
const repo = resolve(import.meta.dirname, '../..');
const evidence = process.env.CATS_BOT_ACCEPTANCE_EVIDENCE || mkdtempSync(join(tmpdir(), 'cats-bot-interactions-'));
if (!resolve(evidence).startsWith(resolve(tmpdir()) + sep)) throw new Error('Acceptance evidence must be in a temporary directory');
app.setPath('userData', evidence);
app.setPath('appData', evidence);
app.on('window-all-closed', () => {});
let core, notes, floating, background;
let opened = 0;
let menus = 0;
let quitting = false;
let suppressCompletion = false;
const wait = async (predicate, label) => {
  const deadline = Date.now() + 10_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const evaluate = async (window, expression) => window.webContents.executeJavaScript(expression);
const shot = async (window, name) => writeFileSync(join(evidence, name), (await window.webContents.capturePage()).toPNG());

async function main() {
  await app.whenReady();
  const { root } = initializeBot(join(evidence, 'bots'), { id: 'fixture', name: 'Interaction fixture', provider: 'claude' });
  core = BotCore.open({ root, tools: false, runtime: { runtimeEntry: join(repo, 'tests/support/fake-runtime.mjs') },
    life: { startupDelayMs: 3_600_000 }, turnRetry: { ownerBusyMs: 5000, maxBusyAttempts: 2 } });
  await core.start();
  const page = { preloadPath: join(repo, 'assets/preload.cjs'), rendererDir: join(repo, 'dist/renderer'), iconPath: join(repo, 'assets/icon.png') };
  notes = new NoteWindows({ ...page, core, botRoot: root, isQuitting: () => quitting, log: () => {} });
  floating = new FloatingBot({ ...page, state: () => notes.shellState.floatingBot, persist: () => notes.persist() });
  ipcMain.handle('ui:language', () => ({ preference: 'en', locale: 'en' }));
  ipcMain.handle('bot:invoke', (_event, command, args = []) => core[command](...args));
  ipcMain.handle('window:state', () => ({ layer: 'normal', layers: ['normal'], botName: 'Interaction fixture' }));
  ipcMain.handle('window:open', () => { opened++; });
  ipcMain.on('floating:interactive', (_event, value) => floating.setInteractive(value));
  ipcMain.on('floating:regions', (_event, regions) => floating.setInputRegions(regions));
  ipcMain.on('floating:moveTo', (_event, x, y) => floating.moveTo(x, y));
  ipcMain.on('floating:dragEnd', () => floating.remember());
  ipcMain.handle('floating:activate', () => { opened++; });
  ipcMain.handle('floating:menu', () => { menus++; });
  core.subscribe(event => {
    if (suppressCompletion && (event.type === 'turn.completed' || event.type === 'conversation.updated'
      || (event.type === 'work.updated' && ['completed', 'failed', 'cancelled'].includes(event.workItem.state)))) return;
    notes.broadcast(event); floating.broadcast(event);
  });
  const note = await notes.open('home');
  await wait(() => evaluate(note, `!!document.getElementById('send')`), 'note loaded');
  const item = await core.sendOwnerMessage('home', 'busy-always');
  await wait(() => core.listWorkItems().find(w => w.id === item.id)?.error === 'session_busy', 'busy wait');
  await wait(() => evaluate(note, `document.getElementById('send').disabled && !document.getElementById('cancel').hidden`), 'waiting controls');
  await evaluate(note, `window.controlChanges=[];window.controlObserver=new MutationObserver(records=>window.controlChanges.push(...records.map(r=>r.attributeName)));for(const id of ['send','cancel'])window.controlObserver.observe(document.getElementById(id),{attributes:true,attributeFilter:['disabled','hidden']})`);
  // Exercise the real 3-second interaction poll while the work is deferred.
  await new Promise(resolve => setTimeout(resolve, 3300));
  assert.deepEqual(await evaluate(note, 'window.controlChanges'), []);
  await shot(note, 'waiting.png');
  await evaluate(note, `document.getElementById('cancel').click()`);
  await wait(() => core.listWorkItems().find(w => w.id === item.id)?.state === 'cancelled', 'cancel deferred work');
  await wait(() => evaluate(note, `!document.getElementById('send').disabled && document.getElementById('cancel').hidden`), 'cancelled controls');
  console.log('PASS: waiting controls remain stable across polling and cancellation clears deferred work');
  suppressCompletion = true;
  const completed = await core.sendOwnerMessage('home', 'slow:150');
  await wait(() => core.listWorkItems().find(w => w.id === completed.id)?.state === 'completed', 'silent completion');
  await wait(() => evaluate(note, `!document.getElementById('send').disabled && document.getElementById('cancel').hidden`), 'poll recovers a missed completion event');
  suppressCompletion = false;
  console.log('PASS: authoritative work polling recovers a missed completion event');
  notes.hide('home');
  await floating.show();
  await wait(() => evaluate(floating.browserWindow, `!!document.getElementById('cat')`), 'avatar loaded');
  if (process.argv.includes('--native-drag')) {
    assert.equal(process.platform, 'linux');
    assert.equal(app.commandLine.getSwitchValue('ozone-platform'), 'x11');
    const pointer = screen.getCursorScreenPoint();
    try {
      const window = floating.browserWindow;
      const xid = String(window.getNativeWindowHandle().readUInt32LE());
      const before = window.getBounds();
      execFileSync('xdotool', ['mousemove', '--window', xid, '240', '174', 'mousedown', '1', 'mousemove_relative', '--sync', '--', '-100', '-60', 'mouseup', '1']);
      await wait(() => window.getBounds().x === before.x - 100 && window.getBounds().y === before.y - 60, 'native avatar drag');
      assert.deepEqual(window.getBounds(), { ...before, x: before.x - 100, y: before.y - 60 });
      execFileSync('xdotool', ['mousemove', '--window', xid, '240', '174', 'click', '1']);
      await wait(() => opened === 1, 'avatar click activation');
      execFileSync('xdotool', ['click', '3']);
      await wait(() => menus === 1, 'avatar context menu');
      await shot(window, 'avatar.png');
      background = new BrowserWindow({ ...window.getBounds(), frame: false, show: false, webPreferences: { sandbox: true } });
      await background.loadURL('data:text/html,<body style="margin:0;background:lightblue;width:100vw;height:100vh" onclick="window.clicks=(window.clicks||0)+1">Fixture background</body>');
      background.show();
      background.setBounds(window.getBounds());
      await shot(background, 'background.png');
      const bounds = window.getBounds();
      execFileSync('xdotool', ['mousemove', String(bounds.x + 20), String(bounds.y + 20), 'click', '1']);
      await wait(() => evaluate(background, 'window.clicks >= 1'), 'transparent area click-through');
      floating.bubble({ conversationId: 'home', from: 'Fixture', text: 'Bubble input check' });
      await wait(() => evaluate(window, `!document.getElementById('bubble').hidden`), 'bubble shown');
      const bubble = await evaluate(window, `(()=>{const r=document.getElementById('bubble').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      execFileSync('xdotool', ['mousemove', String(Math.round(bounds.x + bubble.x)), String(Math.round(bounds.y + bubble.y)), 'click', '1']);
      await wait(() => opened === 2, 'bubble click');
      console.log('PASS: native Linux avatar drag, fixed dimensions, activation, context menu, transparent click-through and bubble click');
    } finally { execFileSync('xdotool', ['mousemove', String(pointer.x), String(pointer.y)]); }
  }
  console.log(`Evidence: ${evidence}`);
}
async function finish(code) {
  quitting = true;
  background?.destroy(); floating?.destroy(); notes?.destroyAll();
  await core?.stop();
  app.exit(code);
}
app.whenReady().then(main).then(() => {
  writeFileSync(join(evidence, 'result.json'), JSON.stringify({ passed: true, native: process.argv.includes('--native-drag'), backend: app.commandLine.getSwitchValue('ozone-platform') }));
  return finish(0);
}, error => {
  console.error(error);
  writeFileSync(join(evidence, 'result.json'), JSON.stringify({ passed: false, error: String(error) }));
  return finish(1);
});
