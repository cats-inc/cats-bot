import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test, type TestContext } from 'node:test';
import { ProviderSetup, type HelperResult, type SetupHelperRunner } from '../../src/shell/electron/providerSetup.ts';
import { BrowserWindow, ipcMain } from '../support/setup-electron.ts';

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === 'electron'
      ? { url: new URL('../support/setup-electron.ts', import.meta.url).href, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});
const { runFirstRunSetup } = await import('../../src/shell/electron/setup.ts');
hooks.deregister();

const ready = (): HelperResult => ({ status: 'ready', installed: true });
const input = { name: 'Mochi', provider: 'claude', model: null, instructions: '' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(t: TestContext, helper: SetupHelperRunner, create: () => Promise<void> = async () => {}) {
  BrowserWindow.instances = [];
  ipcMain.handlers.clear();
  const providers = new ProviderSetup(helper);
  const done = runFirstRunSetup({
    providers, create, preloadPath: '', rendererDir: '', iconPath: '', systemLocale: 'en',
    language: { read: () => 'system', write: () => {} },
  });
  const window = BrowserWindow.instances[0]! as BrowserWindow;
  t.after(() => { if (!window.isDestroyed()) window.destroy(); });
  return { providers, window, done };
}

test('closing first-run setup cancels a pending provider check and removes its IPC handlers', async t => {
  let signal!: AbortSignal;
  const f = fixture(t, async (_helper, _apply, current) => {
    signal = current!;
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const checking = assert.rejects(ipcMain.invoke(f.window, 'setup:check', 'claude'), { name: 'AbortError' });
  assert.equal(f.providers.busy, true);
  f.window.close();
  assert.equal(f.window.isDestroyed(), true);
  assert.equal(await f.done, false);
  assert.equal(signal.aborted, true);
  assert.equal(ipcMain.handlers.size, 0);
  await checking;
  await f.providers.whenIdle();
  assert.equal(f.providers.busy, false);
});

test('closing during the final provider recheck never creates a bot from a late result', async t => {
  const helper = deferred<HelperResult>();
  let created = false;
  const f = fixture(t, () => helper.promise, async () => { created = true; });
  const finishing = assert.rejects(ipcMain.invoke(f.window, 'setup:finish', input), { name: 'AbortError' });
  f.window.close();
  assert.equal(await f.done, false, 'cancellation does not wait for the helper result');
  helper.resolve(ready());
  await finishing;
  assert.equal(created, false);
});

test('a setup window closed during page load stays closed when the load completes', async t => {
  const f = fixture(t, async () => ready());
  f.window.close();
  assert.equal(await f.done, false);
  f.window.loaded();
  await Promise.resolve();
  assert.equal(f.window.isVisible(), false);
});

test('an explicit provider install finishes before setup closes', async t => {
  const installed = deferred<HelperResult>();
  const f = fixture(t, async (_helper, apply) => apply ? installed.promise : ready());
  await ipcMain.invoke(f.window, 'setup:check', 'claude');
  const installing = ipcMain.invoke(f.window, 'setup:install', 'claude', 'provider');
  assert.equal(f.providers.installing, true);
  f.window.close();
  assert.equal(f.window.isDestroyed(), false);
  installed.resolve(ready());
  await installing;
  f.window.close();
  assert.equal(await f.done, false);
});

test('a successful setup completes the bot creation before closing', async t => {
  const started = deferred<void>();
  const created = deferred<void>();
  const f = fixture(t, async () => ready(), async () => {
    started.resolve();
    await created.promise;
  });
  const finishing = ipcMain.invoke(f.window, 'setup:finish', input);
  await started.promise;
  f.window.close();
  assert.equal(f.window.isDestroyed(), false);
  created.resolve();
  await finishing;
  assert.equal(await f.done, true);
  assert.equal(f.window.isDestroyed(), true);
  assert.equal(ipcMain.handlers.size, 0);
});
