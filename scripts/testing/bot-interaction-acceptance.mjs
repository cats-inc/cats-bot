// Build first. Usage: electron scripts/testing/bot-interaction-acceptance.mjs
// Only a disposable profile and fake Runtime are used. On Linux,
// scripts/linux/test-avatar-input.sh adds --native-drag in a private compositor:
// real pointer input and screen pixels, behind which is a native Wayland window.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, openSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { app, ipcMain, Menu, screen } from 'electron';
import { BotCore, initializeBot } from '../../dist/core/bot.js';
import { NoteWindows } from '../../dist/shell/electron/windows.js';
import { FloatingBot } from '../../dist/shell/electron/floatingBot.js';
import { popupMenu } from '../../dist/shell/electron/popupMenu.js';
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
let menuCloses = 0;
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
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const BACKGROUND_PIXEL = '173,216,230';
/** What the compositor shows there. capturePage only ever sees the page, never what surrounds it. */
const screenPixel = (x, y) => {
  const ppm = execFileSync('grim', ['-t', 'ppm', '-g', `${x},${y} 1x1`, '-']);
  return [...ppm.subarray(ppm.length - 3)].join(',');
};
/** A click through the compositor; xdotool's XTEST input reaches the X server without passing through it. */
const compositorClick = async (x, y, button = 'left') => {
  execFileSync('wlrctl', ['pointer', 'move', '-5000', '-5000']);
  await pause(300);
  execFileSync('wlrctl', ['pointer', 'move', String(x), String(y)]);
  await pause(500);
  // XWayland and Chromium need motion inside the surface before a press counts.
  execFileSync('wlrctl', ['pointer', 'move', '1', '1']);
  await pause(200);
  execFileSync('wlrctl', ['pointer', 'move', '-1', '-1']);
  await pause(500);
  execFileSync('wlrctl', ['pointer', 'click', button]);
};
async function startWaylandBackground() {
  const child = spawn(process.execPath, ['--ozone-platform=wayland', `--user-data-dir=${join(evidence, 'background')}`, join(repo, 'scripts/testing/wayland-background-fixture.mjs')],
    { stdio: ['ignore', 'pipe', openSync(join(evidence, 'background.log'), 'a')] });
  const state = { child, ready: false, clicks: 0 };
  let pending = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) {
      if (line.startsWith('fixture-ready')) state.ready = true;
      if (line.startsWith('fixture-click')) state.clicks += 1;
    }
  });
  await wait(() => state.ready, 'native Wayland background');
  return state;
}

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
  ipcMain.handle('floating:menu', () => {
    menus++;
    const menu = Menu.buildFromTemplate([{ label: 'Fixture item' }]);
    menu.once('menu-will-close', () => { menuCloses++; });
    popupMenu(menu, floating.browserWindow);
  });
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
  const native = process.argv.includes('--native-drag');
  if (native) {
    assert.equal(process.platform, 'linux');
    assert.equal(app.commandLine.getSwitchValue('ozone-platform'), 'x11');
    assert.ok(process.env.CATS_BOT_PRIVATE_COMPOSITOR, 'Run --native-drag through scripts/linux/test-avatar-input.sh: it moves the pointer and covers the screen.');
    assert.equal(screen.getPrimaryDisplay().scaleFactor, 1);
    background = await startWaylandBackground();
  }
  await floating.show();
  await wait(() => evaluate(floating.browserWindow, `!!document.getElementById('cat')`), 'avatar loaded');
  if (native) {
    const window = floating.browserWindow;
    const xid = String(window.getNativeWindowHandle().readUInt32LE());
    const bounds = window.getBounds();
    const point = (x, y) => [bounds.x + Math.round(x), bounds.y + Math.round(y)];
    const catCenter = point(240, 174);

    // ADR-014: nothing clips what the window draws, and only the input shape decides who gets a click.
    assert.match(execFileSync('xwininfo', ['-id', xid, '-shape'], { encoding: 'utf8' }), /No window shape defined/u);
    for (const [x, y] of [[20, 20], [150, 60], [20, 200]]) {
      await wait(() => screenPixel(...point(x, y)) === BACKGROUND_PIXEL, `transparent pixel at ${x},${y}`);
    }
    await wait(() => screenPixel(...catCenter) !== BACKGROUND_PIXEL, 'cat on screen');
    execFileSync('grim', [join(evidence, 'avatar-screen.png')]);
    console.log('PASS: the compositor shows the window behind the avatar through its transparent area');

    await compositorClick(...point(20, 20));
    await wait(() => background.clicks === 1, 'transparent click reaches the native Wayland window');
    assert.equal(opened, 0);
    await compositorClick(...catCenter);
    await wait(() => opened === 1, 'real pointer click on the cat');
    assert.equal(background.clicks, 1);
    floating.bubble({ conversationId: 'home', from: 'Fixture', text: 'Bubble input check' });
    await wait(() => evaluate(window, `!document.getElementById('bubble').hidden`), 'bubble shown');
    const bubble = await evaluate(window, `(()=>{const r=document.getElementById('bubble').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await compositorClick(...point(bubble.x, bubble.y));
    await wait(() => opened === 2, 'real pointer click on the bubble');
    assert.equal(background.clicks, 1);
    await wait(() => evaluate(window, `document.getElementById('bubble').hidden`), 'bubble dismissed');
    await pause(300);
    await compositorClick(...point(bubble.x, bubble.y));
    await wait(() => background.clicks === 2, 'click where the bubble was reaches the native Wayland window');
    assert.equal(opened, 2);
    console.log('PASS: real pointer clicks reach the cat and bubble, and pass through everywhere else');

    // A press and release this close together can land as the menu maps and close it
    // at once. A click of human length does not, and that is not what this checks.
    for (let attempt = 0; attempt < 3 && menus === menuCloses; attempt++) {
      const opens = menus;
      await compositorClick(...catCenter, 'right');
      await wait(() => menus === opens + 1, 'real pointer right click on the cat');
      await pause(400);
    }
    assert.equal(menus, menuCloses + 1, 'the menu stays open after a right click');
    const closes = menuCloses;
    // Beside the cat, inside the menu that opens at the pointer and turns away from a screen edge.
    const besideCat = [-70, 70].flatMap(dx => [-15, 15].map(dy => [catCenter[0] + dx, catCenter[1] + dy]));
    await wait(() => besideCat.some(([x, y]) => screenPixel(x, y) !== BACKGROUND_PIXEL), 'menu on screen');
    execFileSync('grim', [join(evidence, 'menu-screen.png')]);
    await pause(500);
    await compositorClick(...point(20, 20));
    await wait(() => menuCloses === closes + 1, 'click outside closes the menu');
    assert.equal(background.clicks, 2, 'the click that closes a menu is its own');
    await pause(300);
    await compositorClick(...point(20, 20));
    await wait(() => background.clicks === 3, 'the next click reaches the native Wayland window');
    console.log('PASS: a click on a native Wayland window closes the menu, and nothing is left in the way');

    execFileSync('xdotool', ['mousemove', '--window', xid, '240', '174', 'mousedown', '1', 'mousemove_relative', '--sync', '--', '-100', '-60', 'mouseup', '1']);
    await wait(() => window.getBounds().x === bounds.x - 100 && window.getBounds().y === bounds.y - 60, 'native avatar drag');
    assert.deepEqual(window.getBounds(), { ...bounds, x: bounds.x - 100, y: bounds.y - 60 });
    execFileSync('xdotool', ['mousemove', '--window', xid, '240', '174', 'click', '1']);
    await wait(() => opened === 3, 'avatar click activation');
    const opens = menus;
    execFileSync('xdotool', ['click', '3']);
    await wait(() => menus === opens + 1, 'avatar context menu');
    await shot(window, 'avatar.png');
    console.log('PASS: native Linux avatar drag, fixed dimensions, activation and context menu');
  }
  console.log(`Evidence: ${evidence}`);
}
async function finish(code) {
  quitting = true;
  background?.child.kill(); floating?.destroy(); notes?.destroyAll();
  await core?.stop();
  app.exit(code);
}
app.whenReady().then(main).then(() => {
  writeFileSync(join(evidence, 'result.json'), JSON.stringify({ passed: true, native: process.argv.includes('--native-drag'), backend: app.commandLine.getSwitchValue('ozone-platform') }));
  return finish(0);
}, error => {
  console.error(error);
  console.error(`Evidence: ${evidence}`);
  if (process.argv.includes('--native-drag')) {
    try { execFileSync('grim', [join(evidence, 'failure-screen.png')]); } catch { /* The error above is what matters. */ }
  }
  writeFileSync(join(evidence, 'result.json'), JSON.stringify({ passed: false, error: String(error) }));
  return finish(1);
});
