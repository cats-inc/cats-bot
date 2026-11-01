import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { App, BrowserWindow, Screen } from 'electron';
import {
  createHostLogger,
  logLevel,
  observeDisplays,
  observeHostApp,
} from '../../src/shell/electron/hostDiagnostics.ts';
import { CoreRunner } from '../../src/shell/electron/hub/coreRunner.ts';

function fixture(t: TestContext, level?: string) {
  const root = mkdtempSync(join(tmpdir(), 'cats-host-diagnostics-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const logger = createHostLogger(root, { level });
  return { logger, read: () => readFileSync(logger.file, 'utf8') };
}

class Window extends EventEmitter {
  id = 7;
  webContents = Object.assign(new EventEmitter(), {
    id: 9,
    getURL: () => 'file:///private/note.html?conversation=PRIVATE&token=PRIVATE',
  });
  isDestroyed() {
    return false;
  }
  isVisible() {
    return true;
  }
  isMinimized() {
    return false;
  }
  getBounds() {
    return { x: 2000, y: 10, width: 300, height: 400 };
  }
}

test('release logging covers window/renderer/GPU failures without URLs, titles or event payloads', (t) => {
  const { logger, read } = fixture(t);
  const app = new EventEmitter(),
    window = new Window();
  observeHostApp(app as App, () => [window as unknown as BrowserWindow], logger);
  app.emit('browser-window-created', {}, window);
  app.emit('second-instance');
  window.emit('show');
  window.emit('move');
  window.emit('hide');
  window.webContents.emit('did-fail-load', {}, -6, 'PRIVATE error', 'https://PRIVATE', true);
  app.emit('render-process-gone', {}, window.webContents, {
    reason: 'crashed',
    exitCode: 42,
    extra: 'PRIVATE',
  });
  app.emit(
    'child-process-gone',
    {},
    { type: 'GPU', reason: 'oom', exitCode: 9, serviceName: 'PRIVATE' },
  );
  window.emit('closed');
  app.emit('quit', {}, 0);
  const log = read();
  for (const event of [
    'window-created',
    'window-show',
    'window-hide',
    'page-load-failed',
    'renderer-gone',
    'child-process-gone',
    'window-closed',
    'quit',
  ])
    assert.ok(log.includes(event), event);
  assert.match(log, /"exitCode":42/u);
  assert.match(log, /"page":"note"/u);
  assert.match(log, /second-instance-handoff/u);
  assert.ok(!log.includes('PRIVATE'));
  assert.ok(!log.includes('window-move'));
});

test('a core startup failure remains visible at warn and error thresholds', async (t) => {
  for (const level of ['warn', 'error']) {
    const { logger, read } = fixture(t, level);
    const runner = new CoreRunner('mochi', {
      start: async () => {
        throw new Error('PRIVATE prompt');
      },
      stop: async () => {},
      onLost: () => {},
      isExternal: () => false,
      changed: () => {},
      log: logger.log,
      maxRestarts: 0,
    });
    await runner.start();
    assert.match(read(), /ERROR.*did not start/u);
    assert.ok(!read().includes('PRIVATE'));
    await runner.stop();
  }
});

test('display records include topology and window placement, and tolerate transient API failures', (t) => {
  const { logger, read } = fixture(t);
  let unavailable = false;
  const display = {
    id: 1,
    label: 'PRIVATE monitor name',
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    scaleFactor: 1.5,
    rotation: 0,
  };
  const screen = Object.assign(new EventEmitter(), {
    getAllDisplays: () => {
      if (unavailable) throw new Error('PRIVATE');
      return [display];
    },
    getPrimaryDisplay: () => display,
  });
  observeDisplays(
    screen as unknown as Screen,
    () => [new Window() as unknown as BrowserWindow],
    logger,
  );
  screen.emit('display-metrics-changed', {}, display, ['bounds', 'scaleFactor']);
  screen.emit('display-removed', {}, display);
  unavailable = true;
  assert.doesNotThrow(() => screen.emit('display-added', {}, display));
  assert.match(read(), /"scaleFactor":1.5/u);
  assert.match(read(), /"x":2000/u);
  assert.match(read(), /displays-unavailable/u);
  assert.ok(!read().includes('PRIVATE'));
});

test('diagnostic verbosity is opt-in, errors remain, and legacy credential strings are redacted', (t) => {
  const { logger, read } = fixture(t, 'debug');
  logger.record('detail', {}, 'debug');
  logger.record('too-fine', {}, 'trace');
  logger.log(
    'token=SECRET Bearer SECRET https://user:SECRET@example.test/path sk-SECRET123456789012345',
  );
  assert.match(read(), /detail/u);
  assert.ok(!read().includes('too-fine'));
  assert.ok(!read().includes('SECRET'));
  assert.equal(logLevel('invalid'), 'info');
  const errors = fixture(t, 'error');
  errors.logger.record('ordinary');
  errors.logger.error('failure', new Error('PRIVATE'));
  assert.ok(!errors.read().includes('ordinary'));
  assert.match(errors.read(), /failure/u);
});
