// Isolated Electron acceptance for the setup wizard (SPEC-010). Build first, then run:
//   electron scripts/test-setup-wizard-renderer.mjs
// It drives the real page, preload and first-run IPC with fake helpers. No window is shown, no
// script runs, no terminal opens and nothing is written outside tmp/, and no failure opens a dialog.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { ProviderSetup } from '../dist/shell/electron/providerSetup.js';
import { runFirstRunSetup } from '../dist/shell/electron/setup.js';

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
// Each scenario closes its window, and the next one still has to run.
app.on('window-all-closed', () => {});

const root = resolve(import.meta.dirname, '..');
mkdirSync(join(root, 'tmp'), { recursive: true });
const evidence = mkdtempSync(join(root, 'tmp', 'setup-wizard-'));
app.setPath('appData', evidence);
app.setPath('userData', evidence);
app.disableHardwareAcceleration();

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const check = (name, ok, detail = '') => {
  results.push(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` :: ${detail}` : ''}`);
};

function helpers(world) {
  const calls = [];
  const run = async (helper, apply, signal) => {
    calls.push(`${helper}:${apply}`);
    await new Promise((done, reject) => {
      const timer = setTimeout(done, world.delay ?? 60);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason);
      }, { once: true });
    });
    if (world.hang?.[helper] && !apply) {
      await new Promise((_done, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }
    if (apply) {
      const scripted = world.applies?.[helper]?.shift();
      if (scripted) return scripted;
      world.state[helper] = 'ready';
      return { status: 'ready', installed: true, appliedChanges: [`${helper} changed`] };
    }
    const status = world.state[helper];
    if (status === 'ready') return { status: 'ready', installed: true, detectedVersion: '1.2.3' };
    if (status === 'auth_required') return { status, installed: true, detectedVersion: '2.0.0', manualSteps: ['Run claude to sign in.'] };
    // Windows' npm helper previews a restart when its unapplied plan changes PATH.
    return { status, installed: false, restartRequired: helper === 'npm' && status === 'changes_required', plannedActions: world.planned?.[helper] ?? [`${helper}:plan`] };
  };
  return { calls, run };
}

async function open(world, extra = {}) {
  const { calls, run } = helpers(world);
  const providers = new ProviderSetup(run, {
    codexInitialization: async (_commandPath, _signal, onCommand) => { onCommand('fake codex app-server'); return { status: world.codexInitialization ?? 'ready' }; },
    describe: (helper, apply) => ({ command: `fake ${helper}${apply ? ' -Apply' : ''}`, file: `${helper}.ps1` }),
    identify: (helper) => ({ file: `${helper}.ps1`, sha256: 'a'.repeat(64), source: 'cats-platform 1234567' }),
  });
  const before = new Set(BrowserWindow.getAllWindows());
  const created = [];
  const done = runFirstRunSetup({
    language: { read: () => 'en', write() {} },
    systemLocale: 'en',
    providers,
    preloadPath: join(root, 'assets/preload.cjs'),
    rendererDir: join(root, 'dist/renderer'),
    iconPath: join(root, 'assets/icon.png'),
    startAtLoginOffered: true,
    botFolder: (name) => join('bots', `${name.toLowerCase()}-catsbot`),
    takeDraft: () => null,
    restart: () => true,
    create: async (input) => { created.push(input); },
    initializeCodex: async () => { calls.push('open-codex-terminal'); return { opened: true, command: 'codex' }; },
    ...extra,
  });
  const window = BrowserWindow.getAllWindows().find((item) => !before.has(item));
  const { webContents } = window;
  webContents.setBackgroundThrottling(false);
  const errors = [];
  webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  if (webContents.isLoading()) await new Promise((ready) => webContents.once('did-finish-load', ready));
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
  const type = (selector, value) => js(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    const proto = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(node, ${JSON.stringify(value)});
    node.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const shot = async (name) => {
    await sleep(250);
    await js('new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))');
    writeFileSync(join(evidence, `${name}.png`), (await webContents.capturePage()).toPNG());
  };
  const logOpen = () => js("document.querySelector('.setup-log').classList.contains('is-open')");
  const page = () => js("[...document.querySelectorAll('.setup-pane')].findIndex((pane) => !pane.hidden) + 1");
  const rows = () => js("[...document.querySelectorAll('.setup-pane:not([hidden]) .setup-rows > .setup-row')].filter((row) => row.dataset.row).map((row) => row.dataset.row + ':' + row.className.replace('setup-row', '').trim())");
  // ADR-032: a row's action asks in a box under the row, and the box's own button runs it.
  const runRow = async (id) => {
    await click(`#setup-act-${id}`);
    await wait(`document.querySelector('.setup-row[data-row=${id}] .setup-confirm .run')`, `${id} box`);
    await click(`.setup-row[data-row=${id}] .setup-confirm .run`);
  };
  await wait("document.querySelector('#setup-name') && document.querySelectorAll('input[name=setup-provider]').length === 6", 'page 1');
  // Creating closes the window, so the click is queued and the script waits on `done` instead.
  const submit = async () => {
    await js("setTimeout(() => document.querySelector('#setup-submit').click()); true");
    await done;
  };
  return { window, calls, created, done, errors, js, wait, click, type, shot, logOpen, page, rows, runRow, submit };
}

// Electron waits for its ESM entrypoint before ready; top-level await would
// deadlock this fixture before its first scenario. Register the work instead.
app.whenReady().then(async () => {

/* ---- Codex on a clean machine, on the three pages of a cat bot's settings (ADR-032) ---- */
{
  const world = {
    state: { node: 'changes_required', npm: 'changes_required', codex: 'changes_required', shell: 'changes_required' },
    planned: { shell: ["Set CurrentUser ExecutionPolicy to RemoteSigned (currently 'Restricted')"] },
    applies: { node: [{ status: 'changes_required', interruptions: [{ kind: 'elevation_required' }], warnings: ['Administrator elevation was cancelled or failed.'] }] },
  };
  const w = await open(world);
  w.window.setSize(800, 600);
  await sleep(200);

  // Page 1 starts nothing and fits the minimum window.
  check('opening runs no helper', w.calls.length === 0, w.calls.join(','));
  check('the rail names the settings pages', (await w.js("[...document.querySelectorAll('.setup-step-title')].map((n) => n.textContent).join('>')")) === 'Name and look>Provider and model>Permissions');
  check('the name has focus', await w.js("document.activeElement?.id === 'setup-name'"));
  const fit = await w.js("(() => { const p = document.querySelector('.setup-pane:not([hidden])'); return [p.scrollHeight, p.clientHeight]; })()");
  check('page 1 fits the minimum window', fit[0] <= fit[1], fit.join(' '));
  const order = await w.js("[...document.querySelectorAll('.setup-pane:not([hidden]) .field > span, .setup-pane:not([hidden]) .field > label, .setup-pane:not([hidden]) legend')].map((n) => n.firstChild.textContent.trim())");
  check('page 1 has name, look and personality', order.join('>') === 'Name>Appearance>Personality', order.join('>'));
  check('the log says nothing has run', (await w.js("document.querySelector('.setup-log-last').textContent")) === 'Nothing has run yet.');
  await w.shot('1-page-one-minimum');

  // Presets.
  await w.click('#setup-persona-2');
  const third = await w.js("document.querySelector('#setup-instructions').value");
  check('a preset replaces the box', third.startsWith('You are a playful cat'), third);
  check('its button shows pressed', await w.js("document.querySelector('#setup-persona-2').getAttribute('aria-pressed') === 'true'"));
  await w.click('#setup-persona-0');
  const first = await w.js("document.querySelector('#setup-instructions').value");
  const hint = await w.js("document.querySelector('#setup-instructions').placeholder");
  check('the first preset is the placeholder', first === hint && first.length > 0);
  await w.type('#setup-instructions', '');
  check('clearing unpresses', await w.js("[...document.querySelectorAll('.setup-chip')].every((c) => c.getAttribute('aria-pressed') === 'false')"));
  // FR-5: Ctrl+Z, sent to this page alone, brings back what a preset replaced.
  await w.js("document.querySelector('#setup-instructions').focus(); document.execCommand('insertText', false, 'my own words')");
  await w.click('#setup-persona-1');
  await w.wait("document.querySelector('#setup-instructions').value.startsWith('You are a calm')", 'preset replaced the words');
  w.window.webContents.focus();
  // Ctrl+Z reaches the page's editing directly. On macOS, Cmd+Z goes through the app menu, which this
  // fixture has none of, so the page's own undo stands in for it.
  if (process.platform === 'darwin') {
    await w.js("document.querySelector('#setup-instructions').focus(); document.execCommand('undo')");
  } else {
    w.window.webContents.sendInputEvent({ type: 'rawKeyDown', keyCode: 'Z', modifiers: ['control'] });
    w.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] });
  }
  await sleep(200);
  const undone = await w.js("document.querySelector('#setup-instructions').value");
  check('undo restores what a preset replaced', undone === 'my own words', undone.slice(0, 60));
  await w.type('#setup-instructions', '');

  // The rule, on the page.
  await w.type('#setup-name', 'Mo‮chi');
  await w.wait("document.querySelector('#setup-name-error')", 'name error');
  check('a hidden character in the name holds Next', await w.js("document.querySelector('#setup-to-provider').disabled"));
  await w.type('#setup-name', 'Mochi');
  await w.type('#setup-instructions', `Be kind.${String.fromCodePoint(0xE0068, 0xE0069)}`);
  await w.wait("document.querySelector('#setup-persona-error')", 'persona error');
  check('hidden text in the persona holds Next', await w.js("document.querySelector('#setup-to-provider').disabled"));
  await w.type('#setup-instructions', 'x'.repeat(4001));
  await w.wait("/4,000/.test(document.querySelector('#setup-persona-error')?.textContent ?? '')", 'length error');
  await w.type('#setup-instructions', '');
  await w.wait("!document.querySelector('#setup-to-provider').disabled", 'Next enabled');
  await w.click('#setup-to-provider');

  // Page 2: Provider and model, as a cat bot's settings has it.
  await w.wait("document.querySelector('#setup-next')", 'page 2');
  check('no provider is preselected', await w.js("!document.querySelector('input[name=setup-provider]:checked')"));
  check('Next waits for a provider', await w.js("document.querySelector('#setup-next').disabled"));
  await w.click('input[name=setup-provider][value=codex]');
  await w.wait("document.querySelector('#provider-check')", 'provider rows');
  check('choosing a provider runs nothing', w.calls.length === 0);
  check('before the check every row is unchecked', await w.js("[...document.querySelectorAll('.setup-pane:not([hidden]) .setup-rows .setup-row-state')].every((n) => n.textContent === 'Not checked yet')"));
  check('Next does not wait for a check (ADR-032)', await w.js("!document.querySelector('#setup-next').disabled"));
  check('the page has no tick boxes', await w.js("!document.querySelector('.setup-pane:not([hidden]) .setup-rows input[type=checkbox]')"));
  check('the page has no sheet or link to Cats Bot Settings', await w.js("!document.querySelector('#provider-all-clis') && !document.querySelector('.setup-log-sheet')"));
  await w.click('#provider-check');
  await w.wait("document.querySelector('.setup-log').classList.contains('is-open')", 'log opens');
  check('the log opens for a read-only check', true);
  await w.wait("document.querySelector('#setup-act-node')", 'first round');
  const round1 = await w.rows();
  check('round 1: Node.js can be set up, what needs it waits', round1.filter((row) => !row.startsWith('shell')).join(' ') === 'node:is-needs npm:is-waiting provider:is-waiting', round1.join(' '));
  check('the check ran only what it could', w.calls.filter((call) => call !== 'shell:false').join(' ') === 'node:false', w.calls.join(' '));
  await w.wait("!document.querySelector('.setup-log').classList.contains('is-open')", 'log closes after success');
  check('the log closes after a good check', true);
  check('Next still does not wait for what is missing', await w.js("!document.querySelector('#setup-next').disabled"));
  await w.shot('2-round-one');

  // A declined prompt.
  await w.runRow('node');
  await w.wait("document.querySelector('#setup-retry-node')", 'failure');
  const declined = await w.js("document.querySelector('.setup-row[data-row=node]').textContent");
  check('a declined prompt says nothing changed', /chose No/u.test(declined) && world.state.node !== 'ready', declined.slice(0, 80));
  check('a failure opens the log', await w.logOpen());
  await w.shot('3-declined');

  // Try again needs no new box, and the second round reads the rest.
  await w.click('#setup-retry-node');
  await w.wait("document.querySelector('#setup-act-npm')", 'second round');
  const round2 = await w.rows();
  check('round 2: everything else is read at once', round2.filter((row) => !row.startsWith('shell')).join(' ') === 'node:is-ready npm:is-needs provider:is-needs', round2.join(' '));
  await w.click('#provider-setup-all');
  await w.wait("document.querySelector('.provider-ops > .setup-confirm .run')", 'set up all box');
  const listed = await w.js("document.querySelector('.provider-ops > .setup-confirm').textContent");
  check('set up all names only what is required', /npm/u.test(listed) && /Codex/u.test(listed) && !/PowerShell/u.test(listed), listed.slice(0, 120));
  await w.click('.provider-ops > .setup-confirm .run');
  await w.wait("document.querySelector('.setup-row[data-row=provider]')?.classList.contains('is-ready') && !document.querySelector('.provider-ops').getAttribute('aria-busy').includes('true')", 'applied');
  check('only what was confirmed changed anything', w.calls.filter((call) => call.endsWith(':true')).join(' ') === 'node:true node:true npm:true codex:true', w.calls.filter((call) => call.endsWith(':true')).join(' '));
  check('the optional step did not run', world.state.shell !== 'ready');
  check('the wizard offers no Update, since its windows only install', await w.js("!document.querySelector('.setup-row.is-ready .setup-act')"));
  const signIn = await w.js("document.querySelector('.setup-row[data-row=sign-in]')?.textContent ?? ''");
  check('sign-in is on page 2 once Codex works, with its fixed command', /codex login/u.test(signIn), signIn.slice(0, 80));
  const models = await w.js("[...document.querySelectorAll('#setup-model option')].map((o) => o.textContent)");
  check('the model list comes from the catalog', models.length > 3, models.join(','));
  await w.shot('4-ready');

  // Page 3: what the cat bot may do, then create.
  await w.click('#setup-next');
  await w.wait("document.querySelector('#setup-submit') && !document.querySelector('#setup-submit').disabled", 'page 3');
  const said = await w.js("document.querySelector('#setup-permission').textContent");
  check('page 3 says what the default lets it do', /Mochi reads and edits files in the filespace folder/u.test(said), said);
  const summary = await w.js("document.querySelector('.setup-summary').textContent");
  check('the summary names the Boss Cat role and the folder', /Boss Cat/u.test(summary) && /mochi-catsbot/u.test(summary), summary.slice(0, 160));
  check('nothing on page 3 counts changes or says nothing changed', !/changed|has changed nothing/iu.test(summary));
  check('start at login is ticked by default', await w.js("document.querySelector('#setup-start-at-login').checked"));
  const fit3 = await w.js("(() => { const p = document.querySelector('.setup-pane:not([hidden])'); return [p.scrollHeight, p.clientHeight]; })()");
  check('page 3 fits the minimum window', fit3[0] <= fit3[1], fit3.join(' '));
  await w.shot('5-page-three');
  await w.click('#setup-start-at-login');
  await w.submit();
  const input = w.created[0];
  check('the owner\'s choices reach creation', input?.name === 'Mochi' && input?.provider === 'codex' && input?.startAtLogin === false, JSON.stringify(input));
  check('no page error, Codex path', w.errors.length === 0, w.errors.join(' | ').slice(0, 200));
}

/* ---- What the check finds never stops creation (ADR-032) ---- */
{
  const world = { state: { grok: 'changes_required' } };
  const w = await open(world);
  await w.click('#setup-to-provider');
  await w.click('input[name=setup-provider][value=grok]');
  await w.wait("document.querySelector('#provider-check')", 'provider rows');
  await w.click('#setup-next');
  await w.wait("document.querySelector('#setup-submit') && !document.querySelector('#setup-submit').disabled", 'page 3 without a check');
  check('Create needs no check', true);
  await w.click('#setup-back');
  await w.click('#provider-check');
  await w.wait("document.querySelector('#setup-act-provider')", 'grok needs installing');
  await w.click('#setup-next');
  await w.wait("!document.querySelector('#setup-submit').disabled", 'create with a missing CLI');
  await w.submit();
  check('a missing CLI still creates the cat bot', w.created[0]?.provider === 'grok', JSON.stringify(w.created[0]));
  check('creation only looked where the CLI is, and changed nothing', !w.calls.some((call) => call.endsWith(':true')), w.calls.join(' '));
  check('no page error, missing CLI path', w.errors.length === 0, w.errors.join(' | ').slice(0, 200));
}

/* ---- A step goes on while another page shows; only Create waits for it ---- */
{
  const world = { state: { grok: 'changes_required' }, delay: 60 };
  const w = await open(world);
  await w.click('#setup-to-provider');
  await w.click('input[name=setup-provider][value=grok]');
  await w.click('#provider-check');
  await w.wait("document.querySelector('#setup-act-provider')", 'grok row');
  world.delay = 1500;
  await w.runRow('provider');
  await w.wait("document.querySelector('.setup-row[data-row=provider] .setup-spinner, .setup-row[data-row=provider].is-running')", 'running');
  await w.click('#setup-next');
  await w.wait("document.querySelector('#setup-submit')", 'page 3');
  check('Create waits while a step runs', await w.js("document.querySelector('#setup-submit').disabled"));
  check('the log bar names what runs', /grok/iu.test(await w.js("document.querySelector('.setup-log-last').textContent")), await w.js("document.querySelector('.setup-log-last').textContent"));
  await w.wait("!document.querySelector('#setup-submit').disabled", 'step finished');
  check('the step finished while page 3 showed', world.state.grok === 'ready');
  await w.click('#setup-back');
  await w.wait("document.querySelector('.setup-row[data-row=provider]')?.classList.contains('is-ready')", 'ready on page 2');
  check('page 2 shows the result when it comes back', true);
  w.window.destroy();
  await w.done;
  check('no page error, background step path', w.errors.length === 0, w.errors.join(' | ').slice(0, 200));
}

/* ---- A check that fails, a step it cannot confirm, and a restart that keeps the input ---- */
{
  const world = { state: { grok: 'failed' } };
  const kept = [];
  const w = await open(world, { restart: (draft) => { kept.push(draft); return true; } });
  await w.click('#setup-to-provider');
  await w.click('input[name=setup-provider][value=grok]');
  await w.click('#provider-check');
  await w.wait("document.querySelector('.setup-row[data-row=provider]')?.classList.contains('is-failed')", 'failed row');
  await sleep(1700);
  check('a failed check keeps the log open', await w.logOpen());
  check('a row that failed a check offers no retry', await w.js("!document.querySelector('#setup-retry-provider')"));
  check('a failed check does not hold Next', await w.js("!document.querySelector('#setup-next').disabled"));
  check('no script that changes anything ran', !w.calls.some((call) => call.endsWith(':true')), w.calls.join(' '));
  await w.shot('6-check-failed');
  world.applies = { grok: [{ status: 'relaunch_required', installed: false }] };
  await w.runRow('provider');
  await w.wait("document.querySelector('#setup-restart')", 'not found yet');
  check('a step Cats Bot cannot find yet offers a restart on its row', true);
  check('it does not hold Next', await w.js("!document.querySelector('#setup-next').disabled"));
  await w.shot('7-not-found');
  await w.click('#setup-restart');
  await sleep(150);
  check('a restart keeps the input', kept[0]?.name === 'Mochi' && kept[0]?.provider === 'grok', JSON.stringify(kept[0]));
  world.state.grok = 'ready';
  await w.click('#provider-check');
  await w.wait("document.querySelector('.setup-row[data-row=provider]')?.classList.contains('is-ready')", 'recovered');
  check('checking again recovers', true);
  await w.wait("document.querySelector('#setup-open-terminal')", 'sign-in row');
  // The real handler would open a real terminal, so this one answers that none was found.
  ipcMain.removeHandler('setup:openTerminal');
  ipcMain.handle('setup:openTerminal', () => ({ opened: false, command: 'grok' }));
  await w.click('#setup-open-terminal');
  await w.wait("/No terminal was found/.test(document.querySelector('.setup-row[data-row=sign-in]').textContent)", 'missing terminal');
  check('a terminal that cannot open says so on its row', true);
  w.window.destroy();
  await w.done;
  check('no page error, failure path', w.errors.length === 0, w.errors.join(' | ').slice(0, 200));
}

/* ---- Claude, installed but not signed in ---- */
{
  const world = { state: { claude: 'changes_required' }, planned: { claude: ['remove_legacy_npm_claude_shim'] } };
  const w = await open(world);
  await w.click('#setup-to-provider');
  await w.click('input[name=setup-provider][value=claude]');
  await w.click('#provider-check');
  await w.wait("document.querySelector('#setup-act-provider')", 'claude row');
  await w.click('#setup-act-provider');
  await w.wait("document.querySelector('.setup-row[data-row=provider] .setup-confirm')", 'box');
  check('removing something says so in the box', /Removes the npm version/u.test(await w.js("document.querySelector('.setup-row[data-row=provider] .setup-confirm').textContent")));
  check('one required row has no set-up-all', await w.js("!document.querySelector('#provider-setup-all')"));
  world.applies = { claude: [{ status: 'ready', installed: true, appliedChanges: ['remove_legacy_npm_claude_shim'] }] };
  world.state.claude = 'auth_required';
  await w.click('.setup-row[data-row=provider] .setup-confirm .run');
  await w.wait("/Not signed in|Sign in in a real terminal/.test(document.querySelector('.setup-row[data-row=sign-in]')?.textContent ?? '')", 'sign-in row');
  check('Claude reports not signed in', true);
  await w.click('#setup-next');
  await w.wait("!document.querySelector('#setup-submit').disabled", 'skip allowed');
  check('sign-in can be skipped', true);
  check('page 3 says what Claude Code may do', /follows your Claude Code settings/u.test(await w.js("document.querySelector('#setup-permission').textContent")));
  w.window.destroy();
  await w.done;
  check('no page error, Claude path', w.errors.length === 0, w.errors.join(' | ').slice(0, 200));
}

/* ---- Windows only (the shell records a machine restart there): a real Windows restart is distinct from a
   Cats Bot/PATH relaunch ---- */
if (process.platform === 'win32') {
  const world = {
    state: { node: 'changes_required', npm: 'ready', codex: 'ready', shell: 'ready' },
    applies: { node: [{ status: 'restart_required', installed: true, restartRequired: true,
      appliedChanges: ['fixture_msi_install'], warnings: ['Windows requires a system restart.'],
      interruptions: [{ kind: 'restart_required', requiresRestart: true }] }] },
  };
  const w = await open(world);
  await w.click('#setup-to-provider');
  await w.click('input[name=setup-provider][value=codex]');
  await w.click('#provider-check');
  await w.wait("document.querySelector('#setup-act-node')", 'Node plan');
  await w.runRow('node');
  await w.wait("document.querySelector('.setup-system-restart') && !document.querySelector('.provider-ops').getAttribute('aria-busy').includes('true')", 'Windows restart advice');
  check('a Windows reboot is not offered as a Cats Bot restart', await w.js("!document.querySelector('#setup-restart') && /Restart Windows/.test(document.querySelector('.setup-pane:not([hidden])').textContent)"));
  await w.click('#provider-check');
  await w.wait("!document.querySelector('.provider-ops').getAttribute('aria-busy').includes('true') && !!document.querySelector('.setup-system-restart')", 'unavailable Node keeps reboot advice');
  check('a missing Node offers no reinstall or app restart while a Windows reboot is pending', await w.js("!document.querySelector('#setup-act-node') && !document.querySelector('#setup-restart')"));
  world.state.node = 'ready';
  await w.click('#provider-check');
  await w.wait("document.querySelector('.setup-row[data-row=node]')?.classList.contains('is-ready')", 'Node usable after probe');
  check('a ready Node keeps the Windows restart advice visible', await w.js("!!document.querySelector('.setup-row[data-row=node] .setup-system-restart')"));
  check('the Windows restart advice has visible layout', await w.js("(() => { const node = document.querySelector('.setup-system-restart'); const box = node.getBoundingClientRect(); const style = getComputedStyle(node); return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; })()"));
  check('a usable Node can continue without hiding reboot advice', await w.js("!document.querySelector('#setup-next').disabled"));
  check('the log still counts the change', /changed 1 item/u.test(await w.js("document.querySelector('.setup-log-last').textContent")), await w.js("document.querySelector('.setup-log-last').textContent"));
  await w.shot('8-windows-system-restart');
  w.window.destroy();
  await w.done;
  check('no page error, Windows restart path', w.errors.length === 0, w.errors.join(' | ').slice(0, 200));
}

/* ---- Windows only: Codex first-time setup sits under sign-in on page 2, and never holds Create ---- */
if (process.platform === 'win32') {
  const world = { state: { node: 'ready', npm: 'ready', codex: 'ready', shell: 'changes_required' }, codexInitialization: 'required' };
  const w = await open(world);
  await w.click('#setup-to-provider');
  await w.click('input[name=setup-provider][value=codex]');
  await w.click('#provider-check');
  await w.wait("document.querySelector('#setup-open-codex')", 'initialization action');
  check('first-time setup follows the sign-in row', await w.js("!!document.querySelector('[data-row=sign-in] + [data-row=codex-initialization]')"));
  check('sign-in opens in Command Prompt while PowerShell scripts is not set up', /Command Prompt/u.test(await w.js("document.querySelector('.setup-row[data-row=sign-in]').textContent")));
  await w.click('#setup-open-codex');
  await w.wait("document.querySelector('[data-row=codex-initialization]').textContent.includes('Terminal opened.')", 'terminal result');
  check('first-time setup opens the fixed terminal action', w.calls.includes('open-codex-terminal'));
  await w.click('#setup-next');
  await w.wait("!document.querySelector('#setup-submit').disabled", 'Create');
  await w.submit();
  check('unfinished first-time setup still creates the cat bot', w.created[0]?.provider === 'codex');
  check('no page error, Windows first-time setup path', w.errors.length === 0, w.errors.join(' | '));
}

console.log(results.join('\n'));
const failed = results.filter((line) => line.startsWith('FAIL')).length;
console.log(`passed ${results.length - failed} of ${results.length}; screenshots in ${evidence}`);
assert.equal(failed, 0);
app.exit(0);
}).catch(fail);
