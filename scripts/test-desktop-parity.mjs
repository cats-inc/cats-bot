// Build first. Run with Electron; then rerun with --restore <printed evidence directory>.
// Only disposable profiles and simulated installer results are used. No CLI is installed.
// --native-dialog leaves one real update dialog for a scoped native UI acceptance driver.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app, BaseWindow, BrowserWindow, dialog, ipcMain } from 'electron';
import { BotCore, initializeBot } from '../dist/core/bot.js';
import { CLI_PROVIDERS, readLocalModelCatalog } from '../dist/core/providers/catalog.js';
import { NoteWindows } from '../dist/shell/electron/windows.js';
import { FloatingBot } from '../dist/shell/electron/floatingBot.js';
import { SettingsWindow } from '../dist/shell/electron/settingsWindow.js';
import { runFirstRunSetup } from '../dist/shell/electron/setup.js';
import { ProviderSetup } from '../dist/shell/electron/providerSetup.js';
import { loadDesktopHost } from '../dist/shell/electron/win32Desktop.js';
import {
  readShellState,
  writeShellState,
  NOTE_LAYER_LABELS,
} from '../dist/shell/electron/viewState.js';
import { resolveLocale } from '../dist/shared/language.js';
import { BotUpdateController } from '../dist/shell/electron/update/controller.js';
import { TrayUpdateDialog } from '../dist/shell/electron/update/dialog.js';
import { showDesktopUpdateMessageBox } from '../dist/shell/electron/update/presenter.js';
import { buildTrayMenuTemplate } from '../dist/shell/electron/trayMenu.js';

const repo = resolve(import.meta.dirname, '..');
mkdirSync(join(repo, 'tmp'), { recursive: true });
const restoreAt = process.argv.indexOf('--restore');
const restoring = restoreAt >= 0;
const evidence = restoring
  ? resolve(process.argv[restoreAt + 1])
  : mkdtempSync(join(repo, 'tmp', 'desktop-parity-'));
if (!evidence.startsWith(join(repo, 'tmp') + '\\') && !evidence.startsWith(join(repo, 'tmp') + '/'))
  throw new Error('Evidence must be under this checkout tmp/');
app.setPath('appData', evidence);
app.setPath('userData', join(evidence, 'electron'));
app.on('window-all-closed', () => {});
const botRoot = join(evidence, 'bots', 'parity');
const page = {
  preloadPath: join(repo, 'assets/preload.cjs'),
  rendererDir: join(repo, 'dist/renderer'),
  iconPath: join(repo, 'assets/icon.png'),
};
const calls = [],
  installed = new Set(['claude', 'antigravity', 'grok', 'muse']);
const providers = new ProviderSetup(async (helper, apply) => {
  calls.push(`${helper}:${apply}`);
  if (apply) installed.add(helper);
  return {
    status: installed.has(helper) ? 'ready' : 'not_installed',
    installed: installed.has(helper),
    detectedVersion: installed.has(helper) ? 'fixture-1.0' : null,
  };
});
let core,
  windows,
  floating,
  settings,
  desktop,
  quitting = false;
const pause = () => new Promise((resolve) => setTimeout(resolve, 30));
const wait = async (condition, message = 'condition') => {
  const deadline = Date.now() + 12_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timeout: ${message}`);
    await pause();
  }
};
async function renderer(window) {
  const contents = window.webContents;
  if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
  const evaluate = async (expression) => {
    const result = await contents.debugger.sendCommand('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  return {
    evaluate,
    wait: (expression) => wait(() => evaluate(expression), expression),
    click: (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`),
    select: (selector, value) =>
      evaluate(
        `{ const e=document.querySelector(${JSON.stringify(selector)}); e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event('change',{bubbles:true})); }`,
      ),
    input: (selector, value) =>
      evaluate(
        `{ const e=document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)}); e.dispatchEvent(new Event('input',{bubbles:true})); }`,
      ),
    screenshot: async (name) => {
      const shot = await contents.debugger.sendCommand('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(evidence, name), Buffer.from(shot.data, 'base64'));
    },
  };
}
function openCore() {
  core = BotCore.open({ root: botRoot, log: () => {}, life: { startupDelayMs: 3_600_000 } });
}
function makeWindows() {
  desktop ??= loadDesktopHost(console.log);
  windows = new NoteWindows({
    ...page,
    core,
    botRoot,
    isQuitting: () => quitting,
    desktop,
    log: console.log,
  });
  floating = new FloatingBot({
    ...page,
    state: () => windows.shellState.floatingBot,
    persist: () => windows.persist(),
  });
}
function registerShell() {
  settings = new SettingsWindow(page);
  const language = () => ({
    preference: windows.shellState.language ?? 'system',
    locale: resolveLocale(windows.shellState.language ?? 'system', 'en-US'),
  });
  ipcMain.handle('ui:language', language);
  ipcMain.handle('ui:setLanguage', (_event, value) => {
    windows.shellState.language = value;
    windows.flush();
    for (const w of BrowserWindow.getAllWindows())
      w.webContents.send('ui:languageChanged', language());
    return language();
  });
  ipcMain.handle('bot:invoke', (_event, command, args = []) => core[command](...args));
  ipcMain.handle('setup:check', (_event, provider) => providers.check(provider));
  ipcMain.handle('setup:install', (_event, provider, step) => providers.install(provider, step));
  ipcMain.handle('window:state', (event) => {
    const id = windows.windowFor(event.sender.id)?.conversationId;
    return { layer: windows.layerOf(id), alwaysOnTop: windows.layerOf(id) === 'top' };
  });
  ipcMain.handle('window:hide', (event) =>
    windows.hide(windows.windowFor(event.sender.id).conversationId),
  );
  ipcMain.handle('window:open', (_event, id) => {
    void windows.open(id);
  });
  ipcMain.handle('shell:state', () => ({
    botId: 'parity',
    version: '0.2.2',
    openAtLogin: false,
    openAtLoginAvailable: false,
    floatingVisible: floating.visible,
  }));
  ipcMain.handle('shell:noteLayers', () => ({
    available: windows.availableLayers(),
    labels: NOTE_LAYER_LABELS,
    layers: windows.layers(),
  }));
  ipcMain.handle('shell:updateState', () => ({
    phase: 'unavailable',
    currentVersion: '0.2.2',
    version: null,
    distribution: 'development',
    canCheck: false,
    canInstall: false,
    reason: null,
    error: null,
    percent: null,
  }));
  ipcMain.on('floating:interactive', (_event, value) => floating.setInteractive(value));
}
async function main() {
  await app.whenReady();
  if (!restoring) {
    const done = runFirstRunSetup({
      ...page,
      botRoot,
      systemLocale: 'en-US',
      providers,
      create: async (input) => {
        initializeBot(join(evidence, 'bots'), { id: 'parity', ...input });
        openCore();
      },
    });
    await wait(() => BrowserWindow.getAllWindows().length === 1, 'setup window');
    const ui = await renderer(BrowserWindow.getAllWindows()[0]);
    await ui.wait(
      "document.querySelector('#setup-provider')?.value === 'codex' && !document.querySelector('.provider-installation')?.getAttribute('aria-busy').includes('true')",
    );
    assert.deepEqual(
      await ui.evaluate(
        "Array.from(document.querySelector('#setup-provider').options).map(o=>o.value)",
      ),
      CLI_PROVIDERS.map((p) => p.id),
    );
    assert.equal(await ui.evaluate("document.querySelector('#setup-submit').disabled"), true);
    assert.deepEqual(calls, ['node:false']);
    await ui.select('#display-language', 'zh-TW');
    await ui.wait(
      "document.documentElement.lang === 'zh-TW' && document.querySelector('h1')?.textContent === '認識你的機器人'",
    );
    await ui.screenshot('onboarding-zh-TW.png');
    for (let index = 0; index < 3; index++) {
      await ui.click('.setup-step button:not(:disabled)');
      await ui.wait(
        "document.querySelector('.provider-installation').getAttribute('aria-busy') === 'false'",
      );
    }
    assert.deepEqual(
      calls.filter((call) => call.endsWith(':true')),
      ['node:true', 'npm:true', 'codex:true'],
    );
    await ui.wait("!document.querySelector('#setup-submit').disabled");
    const beforeNative = calls.length;
    await ui.select('#setup-provider', 'claude');
    await ui.wait(
      "document.querySelector('#setup-provider').value === 'claude' && !document.querySelector('#setup-submit').disabled && document.querySelector('#setup-model').value === 'opus'",
    );
    assert.deepEqual(calls.slice(beforeNative), ['claude:false']);
    await ui.screenshot('onboarding-claude.png');
    await ui.click('#setup-submit');
    await done;
    makeWindows();
    registerShell();
    const dm = await windows.open('home');
    const dmUi = await renderer(dm);
    await dmUi.wait("document.body.innerText.includes('私訊')");
    await settings.open('app');
    let uiSettings = await renderer(settings.browserWindow);
    await uiSettings.wait("document.querySelector('#display-language')?.value === 'zh-TW'");
    assert.deepEqual(
      await uiSettings.evaluate(
        "Array.from(document.querySelector('#display-language').options).map(o=>o.value)",
      ),
      ['system', 'en', 'zh-TW'],
    );
    await uiSettings.select('#display-language', 'en');
    await dmUi.wait(
      "document.documentElement.lang === 'en' && document.body.innerText.includes('Direct message')",
    );
    await uiSettings.click('[data-tab=bot]');
    await uiSettings.wait(
      "document.querySelector('#bot-provider')?.value === 'claude' && !document.querySelector('#bot-provider').disabled",
    );
    await uiSettings.select('#bot-provider', 'codex');
    await uiSettings.wait(
      "document.getElementById('bot-codex.reasoning_effort') && !document.querySelector('#bot-save').disabled",
    );
    const expected = readLocalModelCatalog('codex', join(botRoot, 'runtime'));
    assert.deepEqual(
      await uiSettings.evaluate(
        "Array.from(document.querySelector('#bot-model').options).map(o=>o.value)",
      ),
      expected.models.map((model) => model.id),
    );
    await uiSettings.select('[id="bot-codex.reasoning_effort"]', 'max');
    await uiSettings.click('#bot-save');
    await wait(
      async () =>
        (await core.getProfile()).executionTarget.modelSelection?.controls?.[
          'codex.reasoning_effort'
        ] === 'max',
      'saved effort',
    );
    await uiSettings.evaluate(
      "document.querySelector('#bot-model').scrollIntoView({block:'center'})",
    );
    await uiSettings.screenshot('settings-catalog.png');
    // An unrelated save must preserve both unsupported providers and old unset-model profiles.
    for (const provider of ['codex', 'copilot']) {
      settings.destroy();
      await core.updateProfile({
        executionTarget: { provider, model: null, modelSelection: null },
      });
      await settings.open('bot');
      uiSettings = await renderer(settings.browserWindow);
      await uiSettings.wait(
        "document.querySelector('#bot-name') && document.querySelector('#bot-provider').options.length >= 5 && !document.querySelector('#bot-save').disabled",
      );
      if (provider === 'codex')
        await uiSettings.wait(
          "document.querySelectorAll('.setup-step').length === 3 && document.querySelector('.provider-installation').getAttribute('aria-busy') === 'false'",
        );
      await uiSettings.input('#bot-name', `Parity ${provider}`);
      await uiSettings.wait("!document.querySelector('#bot-save').disabled");
      await uiSettings.click('#bot-save');
      try {
        await wait(async () => (await core.getProfile()).name === `Parity ${provider}`, 'rename');
      } catch (error) {
        writeFileSync(join(evidence, `rename-${provider}-failure.json`), JSON.stringify({
          profile: await core.getProfile(),
          renderer: await uiSettings.evaluate('document.body.innerText'),
        }, null, 2));
        throw error;
      }
      assert.deepEqual((await core.getProfile()).executionTarget, { provider, model: null });
    }
    settings.destroy();
    await floating.show();
    floating.moveTo(480, 180);
    const avatar = await renderer(floating.browserWindow);
    assert.equal(
      await avatar.evaluate("document.querySelectorAll('[title]').length"),
      0,
      'avatar has no hover tooltips',
    );
    const shown = [];
    for (const [index, layer] of windows.availableLayers().entries()) {
      const record = await core.createConversation(`Parity ${layer}`),
        win = await windows.open(record.id);
      win.setBounds({ x: 70 + index * 75, y: 90 + index * 60, width: 350, height: 420 });
      await pause();
      windows.setLayer(record.id, layer);
      shown.push(record.id);
    }
    // A slow startup can already have captured this restore list when the
    // owner closes the direct message. The later restore must respect that close.
    const pendingRestore = windows.previouslyOpen();
    await dmUi.click('#hide');
    await wait(() => !windows.shellState.views.home.open, 'direct message hidden');
    for (const id of pendingRestore) await windows.open(id, { restore: true });
    assert.equal(dm.isVisible(), false, 'startup restore must not reopen a closed direct message');
    await windows.open('home');
    assert.equal(dm.isVisible(), true, 'an explicit owner open still shows the direct message');
    await dmUi.click('#hide');
    await wait(() => !windows.shellState.views.home.open, 'direct message hidden again');
    await pause();
    windows.flush();
    for (const [index, id] of shown.entries()) {
      const saved = windows.shellState.views[id];
      assert.equal(saved.x, 70 + index * 75);
      assert.equal(saved.y, 90 + index * 60);
      assert.ok(Math.abs(saved.width - 350) <= 1);
      assert.ok(Math.abs(saved.height - 420) <= 1);
    }
    writeFileSync(join(evidence, 'mixed.json'), JSON.stringify(readShellState(botRoot), null, 2));
    for (const id of shown) windows.hide(id);
    floating.hide();
    floating.remember();
    windows.flush();
    assert.deepEqual(windows.previouslyOpen(), []);
    writeFileSync(
      join(evidence, 'phase1.json'),
      JSON.stringify(
        {
          passed: true,
          processId: process.pid,
          calls,
          layers: windows.availableLayers(),
          realInstallerLaunched: false,
        },
        null,
        2,
      ),
    );
  } else {
    openCore();
    makeWindows();
    registerShell();
    assert.deepEqual(windows.previouslyOpen(), []);
    assert.equal(windows.shellState.floatingBot.visible, false);
    assert.equal(
      BrowserWindow.getAllWindows().length,
      0,
      'all hidden remains all hidden in a fresh process',
    );
    quitting = true;
    windows.destroyAll();
    quitting = false;
    const mixed = JSON.parse(readFileSync(join(evidence, 'mixed.json'), 'utf8'));
    writeShellState(botRoot, mixed);
    makeWindows();
    for (const id of windows.previouslyOpen()) {
      const window = await windows.open(id, { restore: true }),
        expected = mixed.views[id];
      assert.equal(window.isVisible(), true);
      assert.equal(windows.layerOf(id), expected.layer);
      if (['desktop', 'wallpaper'].includes(expected.layer) && process.platform === 'win32') {
        const handle = Number(window.getNativeWindowHandle().readBigUInt64LE(0));
        assert.equal(desktop.isAttached(handle), true, `${expected.layer} is attached to Explorer`);
        assert.equal(desktop.attachedLayer(handle), expected.layer);
      }
      const bounds = window.getBounds();
      for (const key of ['x', 'y', 'width', 'height'])
        assert.ok(
          Math.abs(bounds[key] - expected[key]) <= 1,
          `${id} ${key}: ${bounds[key]} vs ${expected[key]}`,
        );
    }
    assert.ok(!windows.listOpen().includes('home'));
    await floating.show();
    assert.deepEqual(floating.browserWindow.getPosition(), [
      mixed.floatingBot.x,
      mixed.floatingBot.y,
    ]);
    writeFileSync(
      join(evidence, 'phase2.json'),
      JSON.stringify(
        {
          passed: true,
          processId: process.pid,
          restored: windows.listOpen(),
          layers: windows.layers(),
          avatar: floating.browserWindow.getPosition(),
        },
        null,
        2,
      ),
    );
  }
  if (process.argv.includes('--native-dialog')) {
    const controller = new BotUpdateController(
      {
        phase: 'current',
        currentVersion: '0.2.2',
        version: null,
        distribution: 'standard-preview',
        canCheck: false,
        canInstall: false,
        reason: null,
        error: null,
        percent: null,
      },
      null,
      {},
    );
    const flow = new TrayUpdateDialog({
      controller,
      locale: () => 'zh-TW',
      stopping: () => false,
      show: (dialogSpec) =>
        showDesktopUpdateMessageBox({
          platform: process.platform,
          dialogSpec,
          createOwner: (options) => new BaseWindow(options),
          focusApp: () => app.focus(),
          showMessageBox: (options, owner) =>
            owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options),
        }),
    });
    let opened;
    const menu = buildTrayMenuTemplate(
      {
        botName: 'Parity',
        locale: 'zh-TW',
        status: core.status(),
        conversations: await core.listConversations(),
        heartbeatEnabled: false,
        openAtLogin: false,
        openAtLoginAvailable: false,
        awaitingOwner: 0,
        floatingVisible: false,
        desktopControl: {
          enabled: false,
          pendingRequests: 0,
          waitingConversationId: null,
          holding: [],
        },
      },
      {
        onCheckForUpdates: () => {
          opened = flow.open();
        },
      },
    );
    const count = BrowserWindow.getAllWindows().length;
    menu.find((item) => item.label === '檢查更新…').click();
    writeFileSync(
      join(evidence, 'dialog-pending.json'),
      JSON.stringify({ pid: process.pid, title: '檢查更新', evidence }),
    );
    console.log(`Native dialog waiting: ${evidence}`);
    await opened;
    assert.equal(BrowserWindow.getAllWindows().length, count, 'tray update never opens Settings');
    writeFileSync(
      join(evidence, 'native-dialog.json'),
      JSON.stringify({ passed: true, settingsOpened: false }),
    );
  }
  console.log(`Desktop parity ${restoring ? 'restore' : 'initial'} acceptance passed: ${evidence}`);
}
void main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    quitting = true;
    windows?.destroyAll();
    floating?.destroy();
    settings?.destroy();
    await core?.stop();
    app.exit(process.exitCode ?? 0);
  });
