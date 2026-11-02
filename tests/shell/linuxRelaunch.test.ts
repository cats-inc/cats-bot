import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createLinuxRelaunch } from '../../src/shell/electron/linuxRelaunch.ts';
import { relaunchForLinuxWindowing } from '../../src/shell/electron/linuxWindowing.ts';

async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await delay(20);
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

const NO_NEW_PRIVS = String.raw`readFileSync('/proc/self/status', 'utf8').match(/^NoNewPrivs:\s*(\d)/m)[1]`;

for (const restrict of [false, true]) {
  test(`Linux relaunch preserves the privilege state and waits for exit (restricted=${restrict})`, {
    skip: process.platform !== 'linux',
    timeout: 15_000,
  }, async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'cats bot relaunch '));
    const readyPath = join(root, 'ready.json');
    const resultPath = join(root, 'result.jsonl');
    const parentPath = join(root, 'parent.mjs');
    const replacementPath = join(root, 'replacement with spaces.mjs');
    const moduleUrl = new URL('../../src/shell/electron/linuxRelaunch.ts', import.meta.url).href;
    const originalArgs = ['--literal=$HOME;echo nope', "quotes'\"", 'two words'];
    let parent: ChildProcess | undefined;
    try {
      await writeFile(replacementPath, `
        import { appendFileSync, readFileSync } from 'node:fs';
        let parentState = 'gone';
        try { parentState = readFileSync('/proc/' + process.argv[2] + '/status', 'utf8')
          .match(/^State:\\s*(\\w)/m)[1]; } catch {}
        appendFileSync(${JSON.stringify(resultPath)}, JSON.stringify({
          parentState, args: process.argv.slice(3), nodeMode: process.env.ELECTRON_RUN_AS_NODE,
          nnp: ${NO_NEW_PRIVS},
        }) + '\\n');
      `);
      await writeFile(parentPath, `
        import { readFileSync, writeFileSync } from 'node:fs';
        import { createLinuxRelaunch } from ${JSON.stringify(moduleUrl)};
        const relaunch = createLinuxRelaunch({ executable: process.execPath, logger: console.error });
        const args = [${JSON.stringify(replacementPath)}, String(process.pid), ...${JSON.stringify(originalArgs)}];
        relaunch(args); relaunch(args);
        writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({ nnp: ${NO_NEW_PRIVS} }));
        process.stdin.resume();
        process.stdin.once('data', () => process.exit(0));
      `);
      const command = [process.execPath, '--no-warnings', parentPath];
      parent = spawn(restrict ? 'setpriv' : command[0]!, restrict ? ['--no-new-privs', ...command] : command.slice(1),
        { stdio: ['pipe', 'ignore', 'pipe'], signal: context.signal });
      const exited = once(parent, 'exit');
      let stderr = '';
      parent.stderr!.on('data', (chunk) => { stderr += chunk; });
      const before = JSON.parse(await waitForFile(readyPath)) as { nnp: string };
      if (restrict) assert.equal(before.nnp, '1');
      // Outlives two node startups, so a barrier replaced by a short delay fails here.
      await delay(1500);
      await assert.rejects(readFile(resultPath), { code: 'ENOENT' });
      parent.stdin!.write('exit');
      assert.deepEqual(await exited, [0, null], stderr);
      const result = JSON.parse((await waitForFile(resultPath)).trim()) as { parentState: string; nnp: string; args: string[]; nodeMode?: string };
      assert.ok(['gone', 'Z'].includes(result.parentState), result.parentState);
      assert.equal(result.nnp, before.nnp);
      assert.deepEqual(result.args, originalArgs);
      assert.equal(result.nodeMode, undefined);
      await delay(100);
      assert.equal((await readFile(resultPath, 'utf8')).trim().split('\n').length, 1);
      assert.equal(stderr, '');
    } finally {
      if (parent && parent.exitCode === null) parent.kill();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('a failed Linux relaunch helper is reported and may be retried', async () => {
  const messages: string[] = [];
  const relaunch = createLinuxRelaunch({
    executable: join(tmpdir(), 'cats-bot-nonexistent-relaunch-executable'),
    logger: (message) => messages.push(message),
  });
  relaunch([]);
  for (let attempt = 0; messages.length < 1 && attempt < 100; attempt += 1) await delay(10);
  assert.match(messages[0]!, /helper launch failed:.*ENOENT/u);
  relaunch([]);
  for (let attempt = 0; messages.length < 2 && attempt < 100; attempt += 1) await delay(10);
  assert.equal(messages.length, 2);
});

test('a relaunch that cannot start is logged, never thrown, so the caller still quits', () => {
  const messages: string[] = [];
  const relaunch = createLinuxRelaunch({ executable: 'invalid\0executable', logger: (message) => messages.push(message) });
  assert.doesNotThrow(() => relaunch([]));
  assert.match(messages[0]!, /helper launch failed/u);
});

test('a relaunch still works after the host working directory was deleted', { skip: process.platform !== 'linux', timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cats bot relaunch cwd '));
  const cwd = join(root, 'deleted');
  const resultPath = join(root, 'result.txt');
  const replacementPath = join(root, 'replacement.mjs');
  const parentPath = join(root, 'parent.mjs');
  const moduleUrl = new URL('../../src/shell/electron/linuxRelaunch.ts', import.meta.url).href;
  try {
    await mkdir(cwd);
    await writeFile(replacementPath, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(resultPath)}, 'started');`);
    await writeFile(parentPath, `
      import { rmSync } from 'node:fs';
      import { createLinuxRelaunch } from ${JSON.stringify(moduleUrl)};
      rmSync(${JSON.stringify(cwd)}, { recursive: true });
      createLinuxRelaunch({ executable: process.execPath, logger: console.error })([${JSON.stringify(replacementPath)}]);
    `);
    const parent = spawn(process.execPath, ['--no-warnings', parentPath], { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    parent.stderr.on('data', (chunk) => { stderr += chunk; });
    assert.deepEqual(await once(parent, 'exit'), [0, null], stderr);
    assert.equal(await waitForFile(resultPath), 'started');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the windowing relaunch goes through the supplied relaunch, then exits; X11 does neither', { skip: process.platform !== 'linux' }, (context) => {
  const saved = { DISPLAY: process.env.DISPLAY, XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE };
  context.after(() => { Object.assign(process.env, saved); });
  process.env.DISPLAY = ':0';
  process.env.XDG_SESSION_TYPE = 'wayland';
  const calls: unknown[] = [];
  const app = (requested: string) => ({ commandLine: { getSwitchValue: () => requested }, exit: (code: number) => calls.push(['exit', code]) });
  const relaunch = (args: string[]) => calls.push(['relaunch', args.at(-1)]);
  assert.equal(relaunchForLinuxWindowing(app('x11'), relaunch), false);
  assert.deepEqual(calls, []);
  assert.equal(relaunchForLinuxWindowing(app('wayland'), relaunch), true);
  assert.deepEqual(calls, [['relaunch', '--ozone-platform=x11'], ['exit', 0]]);
});

test('no shipped relaunch path reaches Electron on Linux', async () => {
  const main = await readFile(new URL('../../src/shell/electron/main.ts', import.meta.url), 'utf8');
  // The one native call is the non-Linux branch of the host's single relaunch.
  assert.equal(main.match(/app\.relaunch\(/gu)?.length, 1);
  assert.match(main, /process\.platform === 'linux'\s+\? createLinuxRelaunch\([\s\S]+?: \(args: string\[\]\) => app\.relaunch\(\{ args \}\);/u);
  assert.doesNotMatch(await readFile(new URL('../../src/shell/electron/linuxWindowing.ts', import.meta.url), 'utf8'), /app\.relaunch\(/u);
  // A host that cannot elevate must be refused by the shipped wiring, not only in the adapter's tests.
  assert.match(main, /assertCanInstall: assertCanElevate,/u);
});

// CI runs these after `npm run build`, without the windowing case, which needs a display:
//   CATS_TEST_ELECTRON_RELAUNCH=1 node --test tests/shell/linuxRelaunch.test.ts
// Each app uses a disposable profile and opens no window; no installed Cats Bot state is accessed.
const electronEnabled = process.platform === 'linux' && process.env.CATS_TEST_ELECTRON_RELAUNCH === '1';

interface ElectronRow { second: boolean; lock: boolean; electron: string; nnp: string; ozone: string; args: string[]; nodeMode?: string }

async function runElectronRelaunch(context: { signal: AbortSignal; diagnostic(message: string): void }, options: { restricted: boolean; windowing: boolean }): Promise<ElectronRow[]> {
  const root = await mkdtemp(join(tmpdir(), 'cats bot electron relaunch '));
  const resultPath = join(root, 'result.jsonl');
  const relaunchModule = new URL('../../dist/shell/electron/linuxRelaunch.js', import.meta.url).href;
  const windowingModule = new URL('../../dist/shell/electron/linuxWindowing.js', import.meta.url).href;
  const electron = createRequire(import.meta.url)('electron') as string;
  const literals = ['--literal=$HOME;echo nope', '繁體中文 with spaces', "quotes'\""];
  let child: ChildProcess | undefined;
  try {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'cats-bot-relaunch-test', version: '0.0.0', main: 'main.cjs' }));
    await writeFile(join(root, 'main.cjs'), `
      const { app } = require('electron');
      const { appendFileSync, readFileSync } = require('node:fs');
      app.setPath('userData', ${JSON.stringify(join(root, 'profile'))});
      const second = process.argv.includes('--second') || ${options.windowing} && app.commandLine.getSwitchValue('ozone-platform') === 'x11';
      const lock = app.requestSingleInstanceLock();
      if (!lock) { console.error('profile lock unavailable'); app.exit(2); }
      app.whenReady().then(async () => {
        const { createLinuxRelaunch } = await import(${JSON.stringify(relaunchModule)});
        const { relaunchForLinuxWindowing } = await import(${JSON.stringify(windowingModule)});
        const relaunch = createLinuxRelaunch({ executable: process.execPath, logger: console.error });
        appendFileSync(${JSON.stringify(resultPath)}, JSON.stringify({
          second, lock, electron: process.versions.electron, nnp: ${NO_NEW_PRIVS},
          ozone: app.commandLine.getSwitchValue('ozone-platform'),
          args: process.argv.includes('--second') ? process.argv.slice(process.argv.indexOf('--second') + 1) : [],
          nodeMode: process.env.ELECTRON_RUN_AS_NODE,
        }) + '\\n');
        ${options.windowing
          ? `if (!second) { if (!relaunchForLinuxWindowing(app, relaunch)) { console.error('windowing did not relaunch'); app.exit(4); } return; }`
          : `if (!second) { const args = [${JSON.stringify(root)}, '--ozone-platform=headless', '--no-sandbox', '--second', ...${JSON.stringify(literals)}]; relaunch(args); relaunch(args); }`}
        app.quit();
      }).catch((error) => { console.error(error); app.exit(3); });
    `);
    const env: NodeJS.ProcessEnv = { ...process.env, ...(options.windowing ? { XDG_SESSION_TYPE: 'wayland' } : {}) };
    delete env.ELECTRON_RUN_AS_NODE;
    const launch = options.windowing ? [root, '--no-sandbox'] : [root, '--ozone-platform=headless', '--no-sandbox'];
    child = spawn(options.restricted ? 'setpriv' : electron, options.restricted ? ['--no-new-privs', electron, ...launch] : launch,
      { env, stdio: ['ignore', 'ignore', 'pipe'], signal: context.signal });
    let stderr = '';
    child.stderr!.on('data', (chunk) => { stderr += chunk; });
    assert.deepEqual(await once(child, 'exit'), [0, null], stderr);
    let rows: ElectronRow[] = [];
    for (let attempt = 0; attempt < 400; attempt += 1) {
      rows = (await waitForFile(resultPath)).trim().split('\n').map((line) => JSON.parse(line) as ElectronRow);
      if (rows.length === 2) break;
      await delay(25);
    }
    assert.equal(rows.length, 2, stderr);
    await delay(200);
    assert.equal((await readFile(resultPath, 'utf8')).trim().split('\n').length, 2);
    context.diagnostic(`Electron ${rows[0]!.electron}: NoNewPrivs ${rows[0]!.nnp} -> ${rows[1]!.nnp}, ozone ${rows[0]!.ozone || '(default)'} -> ${rows[1]!.ozone}`);
    assert.equal(rows[0]!.second, false);
    assert.equal(rows[1]!.second, true);
    assert.equal(rows[0]!.lock, true);
    assert.equal(rows[1]!.lock, true);
    assert.equal(rows[1]!.nodeMode, undefined);
    if (!options.windowing) assert.deepEqual(rows[1]!.args, literals);
    return rows;
  } finally {
    if (child && child.exitCode === null) child.kill();
    await rm(root, { recursive: true, force: true });
  }
}

// Started from a restricted runner, nothing could show that the relaunch added the flag.
const runnerNoNewPrivs = async () => /^NoNewPrivs:\s*(\d)/mu.exec(await readFile('/proc/self/status', 'utf8'))![1];

test('Electron relaunch does not add NoNewPrivs and releases the profile lock', { skip: !electronEnabled, timeout: 30_000 }, async (context) => {
  if (await runnerNoNewPrivs() !== '0') { context.skip('the test runner already has NoNewPrivs'); return; }
  const rows = await runElectronRelaunch(context, { restricted: false, windowing: false });
  assert.equal(rows[0]!.nnp, '0');
  assert.equal(rows[1]!.nnp, '0');
});

test('Electron relaunch keeps an inherited NoNewPrivs and releases the profile lock', { skip: !electronEnabled, timeout: 30_000 }, async (context) => {
  const rows = await runElectronRelaunch(context, { restricted: true, windowing: false });
  assert.equal(rows[0]!.nnp, '1');
  assert.equal(rows[1]!.nnp, '1');
});

test('Electron windowing relaunch switches to X11 without adding NoNewPrivs', { skip: !electronEnabled || !process.env.DISPLAY, timeout: 30_000 }, async (context) => {
  if (await runnerNoNewPrivs() !== '0') { context.skip('the test runner already has NoNewPrivs'); return; }
  const rows = await runElectronRelaunch(context, { restricted: false, windowing: true });
  assert.equal(rows[0]!.nnp, '0');
  assert.equal(rows[1]!.nnp, '0');
  assert.equal(rows[1]!.ozone, 'x11');
});
