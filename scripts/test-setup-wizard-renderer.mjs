// Isolated Electron acceptance for the setup wizard (SPEC-010). Build first, then run:
//   electron scripts/test-setup-wizard-renderer.mjs
// It drives the real page, preload and first-run IPC with fake helpers. No window is shown, no
// script runs, no terminal opens and nothing is written outside tmp/, and no failure opens a dialog.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app, BrowserWindow, dialog } from 'electron';
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
    return { status, installed: false, plannedActions: world.planned?.[helper] ?? [`${helper}:plan`] };
  };
  return { calls, run };
}

async function open(world, extra = {}) {
  const { calls, run } = helpers(world);
  const providers = new ProviderSetup(run, {
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
    ...extra,
  });
  const window = BrowserWindow.getAllWindows().find((item) => !before.has(item));
  const { webContents } = window;
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
    writeFileSync(join(evidence, `${name}.png`), (await webContents.capturePage()).toPNG());
  };
  const logOpen = () => js("document.querySelector('.setup-log').classList.contains('is-open')");
  const rows = () => js("[...document.querySelectorAll('.setup-rows > .setup-row:not(.setup-row-shortcut)')].map((row) => row.dataset.row + ':' + row.className.replace('setup-row', '').trim())");
  await wait("document.querySelector('#setup-name') && document.querySelectorAll('input[name=setup-provider]').length === 5", 'page 1');
  return { window, calls, created, done, errors, js, wait, click, type, shot, logOpen, rows };
}

await app.whenReady();

/* ---- Codex on a clean Windows machine ---- */
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
  check('no provider is preselected', await w.js("!document.querySelector('input[name=setup-provider]:checked')"));
  check('the name has focus', await w.js("document.activeElement?.id === 'setup-name'"));
  check('the button waits for a provider', await w.js("document.querySelector('#setup-check').disabled"));
  const fit = await w.js("(() => { const p = document.querySelector('.setup-pane'); return [p.scrollHeight, p.clientHeight, document.documentElement.clientWidth, document.documentElement.clientHeight]; })()");
  check('page 1 fits the minimum window', fit[0] <= fit[1], fit.join(' '));
  const order = await w.js("[...document.querySelectorAll('.setup-pane .field > span, .setup-pane .field > label, .setup-pane legend')].map((n) => n.firstChild.textContent.trim())");
  check('fields keep their order', order.join('>') === 'Name>Appearance>Agent CLI>Personality', order.join('>'));
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
  check('clearing keeps the placeholder', (await w.js("document.querySelector('#setup-instructions').placeholder")) === hint);
  check('clearing unpresses', await w.js("[...document.querySelectorAll('.setup-chip')].every((c) => c.getAttribute('aria-pressed') === 'false')"));

  // The rule, on the page.
  await w.click('input[name=setup-provider][value=codex]');
  check('choosing a provider runs nothing', w.calls.length === 0);
  check('the hint counts the checks', /at most 4 read-only checks/u.test(await w.js("document.querySelector('.setup-foot-hint').textContent")) || process.platform !== 'win32');
  await w.type('#setup-name', 'a\nb');
  await w.type('#setup-name', 'Mo\u202Echi');
  await w.wait("document.querySelector('#setup-name-error')", 'name error');
  check('a hidden character in the name blocks the button', await w.js("document.querySelector('#setup-check').disabled"));
  await w.type('#setup-name', 'Mochi');
  await w.type('#setup-instructions', `Be kind.${String.fromCodePoint(0xE0068, 0xE0069)}`);
  await w.wait("document.querySelector('#setup-persona-error')", 'persona error');
  check('hidden text in the persona blocks the button', await w.js("document.querySelector('#setup-check').disabled"));
  await w.type('#setup-instructions', 'x'.repeat(4001));
  await w.wait("/4,000/.test(document.querySelector('#setup-persona-error')?.textContent ?? '')", 'length error');
  await w.type('#setup-instructions', '');
  await w.wait("!document.querySelector('#setup-check').disabled", 'button enabled');

  // The check.
  await w.click('#setup-check');
  await w.wait("document.querySelector('.setup-log').classList.contains('is-open')", 'log opens');
  check('the log opens for a read-only check', true);
  await w.wait("document.querySelector('.setup-row[data-row=shell] input')", 'first round');
  const round1 = await w.rows();
  check('round 1: Node.js and the optional step can be ticked, the rest wait', round1.join(' ') === 'node:is-needs npm:is-waiting provider:is-waiting shell:is-needs', round1.join(' '));
  check('the check ran only what it could', w.calls.join(' ') === 'node:false shell:false', w.calls.join(' '));
  check('nothing is ticked by default', await w.js("![...document.querySelectorAll('.setup-rows input[type=checkbox]')].some((n) => n.checked)"));
  check('details are closed', await w.js("document.querySelectorAll('.setup-details').length === 0"));
  check('optional is words in the title', await w.js("document.querySelector('.setup-row[data-row=shell] .setup-optional').textContent === '(optional step)'"));
  await w.wait("!document.querySelector('.setup-log').classList.contains('is-open')", 'log closes after success');
  check('the log closes after success', true);
  check('next waits for what is required', await w.js("document.querySelector('#setup-next').disabled"));
  await w.shot('2-round-one');

  // A declined UAC prompt.
  await w.click('#setup-tick-node');
  await w.wait("document.querySelector('#setup-apply')", 'apply');
  check('apply says Windows will ask', /administrator permission/u.test(await w.js("document.querySelector('.setup-foot-hint').textContent")) || process.platform !== 'win32');
  await w.click('#setup-apply');
  await w.wait("document.querySelector('#setup-retry')", 'failure');
  const declined = await w.js("document.querySelector('.setup-row[data-row=node]').textContent");
  check('a declined prompt says nothing changed', /chose No/u.test(declined) && world.state.node !== 'ready', declined.slice(0, 80));
  check('a failure opens the log', await w.logOpen());
  check('a failure opens only its details', await w.js("document.querySelectorAll('.setup-details').length === 1 && !!document.querySelector('.setup-row[data-row=node] .setup-details')"));
  check('commands share one style', await w.js("document.querySelectorAll('.setup-details .setup-command').length === 2"));
  await w.shot('3-declined');

  // Try again needs no new tick, and round 2 lists the rest.
  await w.click('#setup-retry');
  await w.wait("document.querySelector('.setup-row[data-row=npm] input')", 'second round');
  const round2 = await w.rows();
  check('round 2: everything else is read at once', round2.join(' ') === 'node:is-ready npm:is-needs provider:is-needs shell:is-needs', round2.join(' '));
  check('the shortcut closes the list', await w.js("document.querySelector('.setup-rows').lastElementChild.classList.contains('setup-row-shortcut')"));
  await w.click('#setup-tick-required');
  await w.wait("document.querySelector('#setup-tick-provider')?.checked", 'shortcut ticks');
  const ticks = await w.js("[...document.querySelectorAll('.setup-rows input[type=checkbox]')].filter((n) => n.checked).map((n) => n.id).join(' ')");
  check('the shortcut ticks only what is required', ticks === 'setup-tick-npm setup-tick-provider', ticks);
  check('the shortcut turns into its undo', (await w.js("document.querySelector('#setup-tick-required').textContent")) === 'Untick all required');
  await w.shot('4-round-two');
  await w.click('#setup-apply');
  await w.wait("document.querySelector('.setup-row[data-row=provider]')?.classList.contains('is-ready') && !document.querySelector('.setup-foot .primary').disabled", 'applied');
  check('only ticked scripts changed anything', w.calls.filter((call) => call.endsWith(':true')).join(' ') === 'node:true node:true npm:true codex:true', w.calls.filter((call) => call.endsWith(':true')).join(' '));
  check('the optional step did not run', world.state.shell !== 'ready');
  await w.wait("!document.querySelector('#setup-next').disabled", 'next');
  check('the optional step does not block', true);
  await w.shot('5-ready');

  // Page 3.
  await w.click('#setup-next');
  await w.wait("document.querySelector('#setup-submit') && !document.querySelector('#setup-submit').disabled", 'page 3');
  const signIn = await w.js("document.querySelector('.setup-row[data-row=sign-in]').textContent");
  check('Codex gives no sign-in signal, and the row says so', /Cannot tell/u.test(signIn), signIn.slice(0, 80));
  check('sign-in opens in Command Prompt without the PowerShell step', /Command Prompt/u.test(signIn) || process.platform !== 'win32');
  check('the fixed command is shown', /codex login/u.test(signIn));
  check('the summary names the changes', /changed 3 item/u.test(await w.js("document.querySelector('.setup-summary').textContent")), await w.js("document.querySelector('.setup-summary .hint').textContent"));
  check('the summary names the Boss Cat role', /Boss Cat/u.test(await w.js("document.querySelector('.setup-summary').textContent")));
  check('the summary names the folder', /mochi-catsbot/u.test(await w.js("document.querySelector('.setup-summary').textContent")));
  const models = await w.js("[...document.querySelectorAll('#setup-model option')].map((o) => o.textContent)");
  check('the model list comes from the catalog', models.length > 3 && models.includes('GPT-6.1-Sol'), models.join(','));
  const effort = await w.js("[...document.querySelectorAll('.setup-fields select')][1]?.selectedOptions[0]?.textContent");
  check('effort shows the catalog default', effort === 'Low (default)', String(effort));
  check('catalog text is not translated', await w.js("[...document.querySelectorAll('.setup-fields .field > span')].map((n) => n.textContent).join('/') === 'Model/Reasoning effort'"));
  check('start at login is ticked by default', await w.js("document.querySelector('#setup-start-at-login').checked"));
  await w.shot('6-page-three');
  await w.click('#setup-start-at-login');
  await w.click('#setup-submit');
  await w.done;
  const input = w.created[0];
  check('the owner\'s choices reach creation', input?.name === 'Mochi' && input?.provider === 'codex' && input?.startAtLogin === false, JSON.stringify(input));
  check('no page error, Codex path', w.errors.length === 0, w.errors.join(' | ').slice(0, 200));
}

/* ---- Claude, installed but not signed in, with an old npm shim first ---- */
{
  const world = {
    state: { claude: 'changes_required' },
    planned: { claude: ['remove_legacy_npm_claude_shim'] },
  };
  const w = await open(world);
  await w.click('input[name=setup-provider][value=claude]');
  await w.click('#setup-check');
  await w.wait("document.querySelector('.setup-row[data-row=provider] input')", 'claude row');
  check('removing something says so', /Removes the npm version/u.test(await w.js("document.querySelector('.setup-row[data-row=provider]').textContent")));
  check('one required row has no shortcut', await w.js("!document.querySelector('#setup-tick-required')"));
  await w.click('#setup-tick-provider');
  await w.wait("document.querySelector('#setup-apply')", 'apply');
  world.applies = { claude: [{ status: 'ready', installed: true, appliedChanges: ['remove_legacy_npm_claude_shim'] }] };
  world.state.claude = 'auth_required';
  await w.click('#setup-apply');
  await w.wait("document.querySelector('#setup-next') && !document.querySelector('#setup-next').disabled", 'installed');
  await w.click('#setup-next');
  await w.wait("document.querySelector('#setup-recheck')", 'sign-in row');
  check('Claude reports not signed in', /Not signed in/u.test(await w.js("document.querySelector('.setup-row[data-row=sign-in]').textContent")));
  check('open terminals are mentioned after a change', /already open/u.test(await w.js("document.querySelector('.setup-row[data-row=sign-in]').textContent")));
  await w.wait("!document.querySelector('#setup-submit').disabled", 'skip allowed');
  check('sign-in can be skipped', true);
  world.state.claude = 'ready';
  await w.click('#setup-recheck');
  await w.wait("/Signed in/.test(document.querySelector('.setup-row[data-row=sign-in]').textContent)", 'signed in');
  check('asking again shows signed in', true);
  const default_ = await w.js("document.querySelector('#setup-model').selectedOptions[0].textContent");
  check('the catalog\'s default model is marked', default_ === 'Opus 5.5 (default)', default_);
  w.window.destroy();
  await w.done;
  check('no page error, Claude path', w.errors.length === 0, w.errors.join(' | ').slice(0, 200));
}

/* ---- Back stops a check; the log stays as the owner set it; a restart keeps the input ---- */
{
  const world = { state: { grok: 'ready' }, hang: { grok: true } };
  const kept = [];
  const w = await open(world, { restart: (draft) => { kept.push(draft); return true; } });
  await w.click('input[name=setup-provider][value=grok]');
  await w.click('#setup-check');
  await w.wait("document.querySelector('#setup-back') && document.querySelector('.setup-row .setup-spinner')", 'hanging check');
  await w.click('#setup-back');
  await w.wait("document.querySelector('#setup-name')", 'back on page 1');
  check('back stops the check', await w.js("!!document.querySelector('input[name=setup-provider]:checked')"));
  await w.wait("/Stopped/.test(document.querySelector('.setup-log-scroll').textContent)", 'stopped in log');
  check('the log records that it stopped', true);
  await w.click('#setup-log-toggle');
  await w.wait("!document.querySelector('.setup-log').classList.contains('is-open')", 'owner closes');
  world.hang = {};
  world.state.grok = 'changes_required';
  await w.click('#setup-check');
  await w.wait("document.querySelector('.setup-row[data-row=provider] input')", 'grok row');
  check('the log stays closed once the owner closed it', !(await w.logOpen()));
  check('a remote script is named', /x\.ai\/cli\/install/u.test(await w.js("document.querySelector('.setup-row[data-row=provider]').textContent")));
  await w.click('#setup-more-provider');
  await w.wait("document.querySelector('.setup-details')", 'details');
  check('details show the helper\'s own words', /grok:plan/u.test(await w.js("document.querySelector('.setup-details').textContent")));
  world.applies = { grok: [{ status: 'relaunch_required', installed: false }] };
  await w.click('#setup-tick-provider');
  await w.click('#setup-apply');
  await w.wait("document.querySelector('#setup-restart')", 'fallback');
  check('a step the check cannot confirm offers checking again first', (await w.js("document.querySelector('.setup-foot .primary').textContent")) === 'Check again');
  check('the failure opened the log even though the owner closed it', await w.logOpen());
  await w.shot('7-not-found');
  await w.click('#setup-restart');
  await sleep(150);
  check('a restart keeps the input', kept[0]?.name === 'Mochi' && kept[0]?.provider === 'grok', JSON.stringify(kept[0]));
  world.state.grok = 'ready';
  await w.click('#setup-recheck');
  await w.wait("document.querySelector('.setup-row[data-row=provider]')?.classList.contains('is-ready')", 'recovered');
  check('checking again recovers', true);
  w.window.destroy();
  await w.done;
  check('no page error, recovery path', w.errors.length === 0, w.errors.join(' | ').slice(0, 200));
}

console.log(results.join('\n'));
const failed = results.filter((line) => line.startsWith('FAIL')).length;
console.log(`passed ${results.length - failed} of ${results.length}; screenshots in ${evidence}`);
assert.equal(failed, 0);
app.exit(0);
