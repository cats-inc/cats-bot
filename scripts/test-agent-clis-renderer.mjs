// Isolated Electron acceptance for Cats Bot Settings' Agent CLIs tab (SPEC-012). Build first, then run:
//   electron scripts/test-agent-clis-renderer.mjs
// It drives the real settings page, preload and Agent CLIs IPC with fake helpers. No window is shown,
// no script runs, no terminal opens, nothing is written outside tmp/, and no failure opens a dialog.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { ProviderSetup } from '../dist/shell/electron/providerSetup.js';
import { registerComputerSetupIpc } from '../dist/shell/electron/computerSetup.js';
import { createPageWindow, pageUrl } from '../dist/shell/electron/settingsWindow.js';

const results = [];
const fail = (error) => {
  console.log(results.join('\n'));
  console.error(error?.stack ?? String(error));
  app.exit(1);
};
dialog.showErrorBox = (title, content) => console.error(title, content);
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
setTimeout(() => fail(new Error('The acceptance run timed out')), 60_000);

// A hidden window is enough for layout and clicks, and keeps this off the owner's desktop.
BrowserWindow.prototype.show = function show() {};
app.on('window-all-closed', () => {});

const root = resolve(import.meta.dirname, '..');
mkdirSync(join(root, 'tmp'), { recursive: true });
const evidence = mkdtempSync(join(root, 'tmp', 'agent-clis-'));
app.setPath('appData', evidence);
app.setPath('userData', evidence);
app.disableHardwareAcceleration();

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const check = (name, ok, detail = '') => {
  results.push(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`);
};

/** A computer that is partly set up: Codex missing, Claude and Grok working, Muse's check broken. */
function world() {
  const calls = [];
  const state = { node: 'ready', npm: 'ready', codex: 'changes_required', claude: 'ready', antigravity: 'changes_required', grok: 'ready', muse: 'throw', shell: 'changes_required' };
  const versions = { node: '22.11.0', claude: '2.0.14', grok: '0.9.0' };
  const run = async (helper, change) => {
    calls.push(`${helper}:${change}`);
    await sleep(40);
    if (change === 'upgrade') {
      if (helper === 'claude') versions.claude = '2.0.20';
      return { status: 'ready', installed: true, detectedVersion: versions[helper], appliedChanges: helper === 'claude' ? ['claude_code_upgraded'] : [] };
    }
    if (change) {
      state[helper] = 'ready';
      versions[helper] = '1.0.0';
      return { status: 'ready', installed: true, appliedChanges: [`${helper} installed`] };
    }
    if (state[helper] === 'throw') throw new Error('The provider check timed out.');
    if (state[helper] === 'ready') return { status: 'ready', installed: true, detectedVersion: versions[helper] ?? '1.0.0', commandPath: `C:\\fake\\${helper}.cmd` };
    return { status: state[helper], installed: false, plannedActions: [`${helper}:install`] };
  };
  return { calls, run };
}

async function open(locale = 'en') {
  const { calls, run } = world();
  const providers = new ProviderSetup(run, {
    windows: true,
    codexInitialization: async (_commandPath, _signal, onCommand) => { onCommand('fake codex app-server'); return { status: 'required' }; },
    describe: (helper, change) => ({ command: `fake ${helper}${change === 'upgrade' ? ' -Upgrade' : change ? ' -Apply' : ' -CheckOnly'}`, file: `${helper}.ps1` }),
    identify: (helper) => ({ file: `${helper}.ps1`, sha256: 'a'.repeat(64), source: 'cats-platform 1234567' }),
  });
  for (const channel of ['ui:language', 'hub:bots']) ipcMain.removeHandler(channel);
  ipcMain.handle('ui:language', () => ({ preference: locale, locale }));
  ipcMain.handle('hub:bots', () => ({
    bots: [
      { id: 'mochi', name: 'Mochi', provider: 'codex', state: 'running', error: null, pid: 1, startAutomatically: true, bossCat: true, bossCatTools: true },
      { id: 'tora', name: 'Tora', provider: 'codex', state: 'stopped', error: null, pid: null, startAutomatically: false, bossCat: false, bossCatTools: null },
      { id: 'hana', name: 'Hana', provider: 'claude', state: 'running', error: null, pid: 2, startAutomatically: true, bossCat: false, bossCatTools: null },
    ],
    unregistered: [], maxBots: 5, active: 3, limits: { hopsPerChain: 3, messagesPerHour: 30 },
  }));
  const window = createPageWindow({
    preloadPath: join(root, 'assets/preload.cjs'),
    rendererDir: join(root, 'dist/renderer'),
    iconPath: join(root, 'assets/icon.png'),
  }, { width: 860, height: 640, title: 'Cats Bot Settings' });
  const terminals = [];
  const cleanup = registerComputerSetupIpc({
    providers,
    fromHub: (event) => event.sender.id === window.webContents.id && event.senderFrame === event.sender.mainFrame,
    stopping: () => false,
    openTerminal: async (provider) => { terminals.push(provider); return { opened: true, command: `${provider} login` }; },
    initializeCodex: async () => ({ opened: true, command: 'codex' }),
  });
  const { webContents } = window;
  webContents.setBackgroundThrottling(false);
  const errors = [];
  webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  await window.loadURL(pageUrl(join(root, 'dist/renderer'), 'settings.html', { scope: 'hub', tab: 'clis' }));
  const js = (code) => Promise.race([
    webContents.executeJavaScript(code),
    new Promise((_done, reject) => setTimeout(() => reject(new Error(`timed out: ${code.slice(0, 120)}`)), 8000)),
  ]);
  const wait = async (code, label = code) => {
    for (let index = 0; index < 150; index += 1) {
      if (await js(code)) return;
      await sleep(40);
    }
    throw new Error(`waited for: ${label}`);
  };
  const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const text = (selector) => js(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ''`);
  const shot = async (name) => {
    await sleep(250);
    // A hidden window paints lazily; ask for a fresh frame so the picture matches the page.
    webContents.invalidate();
    await js('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))');
    writeFileSync(join(evidence, `${name}.png`), (await webContents.capturePage()).toPNG());
  };
  const close = () => {
    cleanup();
    window.destroy();
  };
  await wait("document.querySelectorAll('.clis-pane .setup-row').length === 8 && !document.querySelector('#clis-check').disabled", 'the tab');
  return { window, calls, terminals, errors, js, wait, click, text, shot, close };
}

app.whenReady().then(async () => {
  const w = await open();

  /* ---- Opening it runs nothing ---- */
  check('opening the tab runs no helper', w.calls.length === 0, w.calls.join(','));
  check('the lead says nothing is checked until you ask', /Nothing is checked until you ask/u.test(await w.text('#clis-lead')));
  const unchecked = await w.js("[...document.querySelectorAll('.setup-row')].filter((row) => /Not checked yet/.test(row.textContent)).length");
  check('every row reads not checked yet', unchecked === 8, String(unchecked));
  check('the hint counts the read-only checks', /up to 9 read-only checks/u.test(await w.text('.setup-foot-hint')), await w.text('.setup-foot-hint'));
  check('a CLI says which cat bots use it', /Used by Mochi, Tora/u.test(await w.text('.setup-row[data-row=codex]')));
  check('an unused CLI says so', /No cat bot uses it yet/u.test(await w.text('.setup-row[data-row=grok]')));
  check('the Agent CLIs tab is selected', await w.js("document.querySelector('.tab[data-tab=clis]')?.getAttribute('aria-selected') === 'true'"));
  await w.shot('1-not-checked');

  /* ---- The check ---- */
  await w.click('#clis-check');
  await w.wait("/Results from your check/.test(document.querySelector('#clis-lead').textContent)", 'results');
  check('the check read Node.js first and changed nothing', w.calls[0] === 'node:false' && w.calls.every((call) => call.endsWith(':false')), w.calls.join(' '));
  check('a broken check says so and opens its details', /Cannot check/u.test(await w.text('.setup-row[data-row=muse]')) && /timed out/u.test(await w.text('.setup-row[data-row=muse]')));
  check('a failed check keeps the log open', await w.js("document.querySelector('.setup-log').classList.contains('is-open')"));
  check('a missing CLI offers its tick box, unticked', await w.js("document.querySelector('#setup-tick-codex')?.checked === false"));
  check('a working CLI offers an update tick, unticked', await w.js("document.querySelector('#setup-update-claude')?.checked === false"));
  check('the npm folder and PowerShell scripts offer no update', await w.js("!document.querySelector('#setup-update-npm') && !document.querySelector('#setup-update-shell')"));
  check('Codex hangs from Node.js', await w.js("document.querySelector('.setup-row[data-row=codex]').classList.contains('is-dep-last') && document.querySelector('.setup-rows.is-unlocked')"));
  check('the cat bots\' missing CLI is counted', /1 item\(s\) your cat bots need/u.test(await w.text('#clis-lead')), await w.text('#clis-lead'));
  check('working CLIs get a sign-in row', await w.js("!!document.querySelector('[data-row=sign-in-claude]') && !!document.querySelector('[data-row=sign-in-grok]') && !document.querySelector('[data-row=sign-in-codex]')"));
  check('Claude says it is signed in', /Signed in/u.test(await w.text('[data-row=sign-in-claude]')));
  check('the update shortcut appears from two working rows', /Tick all 3 updates/u.test(await w.text('#clis-tick-updates')));
  await w.shot('2-checked');

  /* ---- Ticking ---- */
  await w.click('#setup-tick-codex');
  await w.click('#setup-update-claude');
  await w.wait("document.querySelector('.setup-row[data-row=claude] .setup-tags')", 'update tags');
  await w.click('#setup-more-claude');
  await w.wait("document.querySelector('.setup-row[data-row=claude] .setup-details')", 'update details');
  const details = await w.text('.setup-row[data-row=claude] .setup-details');
  check('an update says what it will do', /newest release/u.test(details), details.slice(0, 80));
  check('an update shows the command it really runs', /fake claude -Upgrade/u.test(details));
  check('an update names its script and hash', /claude\.ps1, SHA-256 aaaaaaaa/u.test(details));
  check('two ticks are counted', /Apply 2 ticked/u.test(await w.text('#clis-apply')));
  await w.shot('3-ticked');

  /* ---- Applying ---- */
  w.calls.length = 0;
  await w.click('#clis-apply');
  await w.wait("document.querySelector('#clis-recheck') && !document.querySelector('#clis-recheck').disabled", 'applied');
  check('only the ticked rows ran, top down', w.calls.filter((call) => !call.endsWith(':false')).join(' ') === 'codex:true claude:upgrade', w.calls.join(' '));
  check('an update says what it found', /Updated 2\.0\.14 → 2\.0\.20/u.test(await w.text('.setup-row[data-row=claude]')));
  check('the installed CLI is ready', await w.js("document.querySelector('.setup-row[data-row=codex]').classList.contains('is-ready')"));
  check('the newly working CLI gets a sign-in row', await w.js("!!document.querySelector('[data-row=sign-in-codex]')"));
  check('Codex first-time setup follows on Windows', await w.js("!!document.querySelector('[data-row=codex-initialization]')"));
  check('nothing unticked ran', !w.calls.some((call) => call.startsWith('antigravity:true') || call.startsWith('shell:true')));
  await w.click('#setup-open-terminal-codex');
  await w.wait("/Terminal opened/.test(document.querySelector('[data-row=sign-in-codex]').textContent)", 'terminal');
  check('sign-in opens its fixed command', w.terminals.join(',') === 'codex');
  check('the log records the terminal', /Terminal/u.test(await w.text('.setup-log-scroll')));
  const overflow = await w.js('document.documentElement.scrollWidth - document.documentElement.clientWidth');
  check('nothing scrolls sideways at 860×640', overflow <= 0, String(overflow));
  await w.shot('4-applied');
  check('no page error, English', w.errors.length === 0, w.errors.join(' | ').slice(0, 200));
  w.close();

  /* ---- Traditional Chinese ---- */
  const zh = await open('zh-TW');
  check('the tab is named in Traditional Chinese', (await zh.text('.tab[data-tab=clis]')).trim() === 'Agent CLI');
  await zh.click('#clis-check');
  await zh.wait("/檢查的結果/.test(document.querySelector('#clis-lead').textContent)", 'zh results');
  check('the groups read in Traditional Chinese', /透過 Node\.js 安裝/u.test(await zh.text('.clis-pane')));
  check('a failed check keeps the log open in Traditional Chinese too', await zh.js("document.querySelector('.setup-log').classList.contains('is-open')"), await zh.text('.setup-row[data-row=muse]'));
  const zhOverflow = await zh.js('document.documentElement.scrollWidth - document.documentElement.clientWidth');
  check('nothing scrolls sideways in Traditional Chinese', zhOverflow <= 0, String(zhOverflow));
  // The log opens with a 0.2 s transition, which a hidden window runs slowly.
  await sleep(800);
  await zh.shot('5-checked-zh');
  check('no page error, Traditional Chinese', zh.errors.length === 0, zh.errors.join(' | ').slice(0, 200));
  zh.close();

  /* ---- A cat bot's own tab: only its CLI's chain, in the same rows (FR-13) ---- */
  {
    const calls = [];
    const opened = [];
    const versions = { node: '22.11.0' };
    const state = { node: 'ready', npm: 'ready', codex: 'changes_required', shell: 'ready' };
    const providers = new ProviderSetup(async (helper, change) => {
      calls.push(`${helper}:${change}`);
      await sleep(40);
      if (change === 'upgrade') {
        versions.node = '22.12.0';
        return { status: 'ready', installed: true, detectedVersion: versions.node, appliedChanges: ['winget_upgrade_OpenJS.NodeJS.LTS'] };
      }
      if (change) {
        state[helper] = 'ready';
        return { status: 'ready', installed: true, appliedChanges: [`${helper} installed`] };
      }
      return state[helper] === 'ready'
        ? { status: 'ready', installed: true, detectedVersion: versions[helper] ?? '1.0.0' }
        : { status: state[helper], installed: false, plannedActions: [`${helper}:install`] };
    }, {
      windows: true,
      codexInitialization: async () => ({ status: 'ready' }),
      describe: (helper, change) => ({ command: `fake ${helper}${change === 'upgrade' ? ' -Upgrade' : change ? ' -Apply' : ' -CheckOnly'}`, file: `${helper}.ps1` }),
      identify: (helper) => ({ file: `${helper}.ps1`, sha256: 'b'.repeat(64), source: 'cats-platform 1234567' }),
    });
    const { createProfile } = await import('../dist/core/profile/profile.js');
    const { CLI_PROVIDERS, readPackagedModelCatalog } = await import('../dist/core/providers/catalog.js');
    const profile = createProfile({ id: 'mochi', name: 'Mochi', provider: 'codex', cwd: evidence });
    const status = {
      id: 'mochi', name: 'Mochi', avatar: profile.avatar, root: evidence, runtime: { state: 'ready', pid: 1 },
      queue: { queued: 0, running: null }, pendingInteractions: 0, awaitingOwner: 0, bossCat: { holder: false, tools: false },
      conversations: 1, schedules: 0,
      heartbeat: { enabled: false, nextAt: null, mode: 'quiet', phase: 'awake_hours', unanswered: 0, waitingForOwner: false },
      lastTickAt: null, lock: null, telegram: { enabled: false, polling: false, ownerChatId: null },
    };
    const answers = {
      getProfile: () => profile,
      status: () => status,
      listProviders: () => CLI_PROVIDERS.map((item) => ({ ...item, installed: true })),
      listModels: (provider) => readPackagedModelCatalog(provider),
      listConversations: () => [],
      desktopControlState: () => ({ available: false, reason: 'Not in this check.', enabled: false, conversations: [], pendingRequests: 0, holding: [] }),
    };
    const channels = ['ui:language', 'bot:invoke', 'setup:environment', 'setup:check', 'setup:install', 'shell:openAgentClis'];
    for (const channel of channels) ipcMain.removeHandler(channel);
    ipcMain.handle('ui:language', () => ({ preference: 'en', locale: 'en' }));
    ipcMain.handle('bot:invoke', (_event, command, args) => answers[command]?.(...(args ?? [])) ?? null);
    ipcMain.handle('setup:environment', () => ({ platform: 'win32', startAtLoginOffered: false }));
    const logTo = (event) => (entry) => { if (!event.sender.isDestroyed()) event.sender.send('setup:log', entry); };
    ipcMain.handle('setup:check', (event, provider) => providers.check(provider, undefined, logTo(event)));
    ipcMain.handle('setup:install', (event, provider, step, change) => providers.install(provider, step, logTo(event), change));
    ipcMain.handle('shell:openAgentClis', () => { opened.push('clis'); return null; });
    const window = createPageWindow({
      preloadPath: join(root, 'assets/preload.cjs'),
      rendererDir: join(root, 'dist/renderer'),
      iconPath: join(root, 'assets/icon.png'),
    }, { width: 860, height: 640, title: 'Mochi Settings' });
    const { webContents } = window;
    webContents.setBackgroundThrottling(false);
    const errors = [];
    webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
    await window.loadURL(pageUrl(join(root, 'dist/renderer'), 'settings.html', { tab: 'bot' }));
    const js = (code) => webContents.executeJavaScript(code);
    const wait = async (code, label) => {
      for (let index = 0; index < 150; index += 1) {
        if (await js(code)) return;
        await sleep(40);
      }
      throw new Error(`waited for: ${label}`);
    };
    const shot = async (name) => {
      await sleep(800);
      webContents.invalidate();
      await js('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))');
      writeFileSync(join(evidence, `${name}.png`), (await webContents.capturePage()).toPNG());
    };
    await wait("document.querySelectorAll('.provider-checklist .setup-row').length === 4", 'the checklist');
    check('a cat bot\'s tab runs no helper when it opens', calls.length === 0, calls.join(','));
    check('it lists its own chain, not checked yet', await js("[...document.querySelectorAll('.provider-checklist .setup-row')].every((row) => /Not checked yet/.test(row.textContent))"));
    await js("document.querySelector('.provider-checklist').scrollIntoView()");
    await shot('6-bot-tab-not-checked');
    await js("document.querySelector('#provider-check').click()");
    await wait("document.querySelector('#setup-tick-provider')", 'its plan');
    check('its missing CLI offers a tick box', await js("document.querySelector('#setup-tick-provider').checked === false"));
    check('Node.js offers an update', await js("!!document.querySelector('#setup-update-node')"));
    await js("document.querySelector('#setup-update-node').click()");
    await js("document.querySelector('#setup-tick-provider').click()");
    await wait("/Apply 2 ticked/.test(document.querySelector('#provider-apply')?.textContent ?? '')", 'two ticks');
    check('updating Node.js asks for administrator permission', /administrator permission/u.test(await js("document.querySelector('.provider-checklist-foot').textContent")));
    await js("document.querySelector('.provider-checklist').scrollIntoView()");
    await shot('7-bot-tab-ticked');
    calls.length = 0;
    await js("document.querySelector('#provider-apply').click()");
    await wait("document.querySelector('#provider-check') && !document.querySelector('#provider-check').disabled && document.querySelector('.setup-row[data-row=provider]')?.classList.contains('is-ready')", 'applied');
    const changes = calls.filter((call) => !call.endsWith(':false'));
    check('the bot\'s ticks ran top down', changes.join(' ') === 'node:upgrade codex:true', calls.join(' '));
    check('its update says what it found', /Updated 22\.11\.0 → 22\.12\.0/u.test(await js("document.querySelector('.setup-row[data-row=node]').textContent")));
    await js("document.querySelector('#provider-all-clis').click()");
    await sleep(100);
    check('it links to every agent CLI in Cats Bot Settings', opened.join(',') === 'clis');
    await js("document.querySelector('.provider-checklist').scrollIntoView()");
    await shot('8-bot-tab-applied');
    check('no page error, a cat bot\'s tab', errors.length === 0, errors.join(' | ').slice(0, 200));
    window.destroy();
  }

  console.log(results.join('\n'));
  const failed = results.filter((line) => line.startsWith('FAIL')).length;
  console.log(`passed ${results.length - failed} of ${results.length}; screenshots in ${evidence}`);
  assert.equal(failed, 0);
  app.exit(0);
}).catch(fail);
