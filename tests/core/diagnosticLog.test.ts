import assert from 'node:assert/strict';
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, type TestContext } from 'node:test';
import {
  boundedText,
  createLogWriter,
  diagnosticError,
  LOG_MAX_BYTES,
} from '../../src/shared/diagnosticLog.ts';
import { createFileLogger } from '../../src/core/log.ts';
import { boundStderrLog, rotateStderrLog } from '../../src/shared/stderrLog.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'cats-diagnostics-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('rotation retains the latest records and enforces the budget across writer restarts', (t) => {
  const root = fixture(t),
    file = join(root, 'test.log');
  for (let n = 0; n < 30; n++)
    createLogWriter(file, { maxBytes: 128, backups: 2 })(`${n}: ${'貓'.repeat(15)}\n`);
  assert.deepEqual(readdirSync(root).sort(), ['test.log', 'test.log.1', 'test.log.2']);
  for (const name of readdirSync(root)) {
    assert.ok(statSync(join(root, name)).size <= 128);
    assert.ok(!readFileSync(join(root, name), 'utf8').includes('\ufffd'));
  }
  assert.match(readFileSync(file, 'utf8'), /29:/u);
  createLogWriter(file, { maxBytes: 128, backups: 2 })('x'.repeat(10_000));
  assert.ok(statSync(file).size <= 128);
  assert.match(readFileSync(file, 'utf8'), /truncated/u);
});

test('a broken file or stderr mirror never stops the caller', (t) => {
  const root = fixture(t),
    obstacle = join(root, 'file');
  writeFileSync(obstacle, 'not a directory');
  assert.doesNotThrow(() => createLogWriter(join(obstacle, 'log'))('diagnostic\n'));
  assert.doesNotThrow(() =>
    createFileLogger(root, () => {
      throw new Error('EPIPE');
    })('running'),
  );
  assert.match(readFileSync(join(root, 'core.log'), 'utf8'), /^\d{4}-.*Z running\n$/u);
});

test('core.log rotates without losing its existing timestamp/line contract', (t) => {
  const root = fixture(t),
    file = join(root, 'core.log');
  writeFileSync(file, 'x'.repeat(LOG_MAX_BYTES * 8));
  writeFileSync(`${file}.1`, 'old'.repeat(LOG_MAX_BYTES));
  writeFileSync(`${file}.2`, 'old'.repeat(LOG_MAX_BYTES));
  createFileLogger(root)('core start bot=mochi pid=123');
  assert.equal(statSync(`${file}.1`).size, LOG_MAX_BYTES);
  assert.equal(statSync(`${file}.2`).size, LOG_MAX_BYTES);
  assert.equal(statSync(`${file}.3`).size, LOG_MAX_BYTES);
  assert.match(readFileSync(file, 'utf8'), /Z core start bot=mochi pid=123/u);
});

test('quiet stderr also bounds an oversized previous snapshot from older versions', (t) => {
  const root = fixture(t),
    file = join(root, 'core-stderr.log');
  const previous = join(root, 'core-stderr.previous.log');
  writeFileSync(previous, 'x'.repeat(8192) + 'prior crash\n');
  const fd = openSync(file, 'a+');
  try {
    rotateStderrLog(file, fd, true, 128);
    assert.equal(statSync(file).size, 0);
    assert.equal(statSync(previous).size, 128);
    assert.match(readFileSync(previous, 'utf8'), /prior crash\n$/u);
  } finally {
    closeSync(fd);
  }
});

test('exception summaries retain type, OS code and frames without message or source content', () => {
  const error = Object.assign(new Error('SECRET prompt Bearer abc'), { code: 'EACCES' });
  error.stack =
    'Error: SECRET prompt\n  at fail (C:\\test\\main.ts:12:3)\n  SECRET source\n  at run (file:///test/run.ts:1:2)';
  assert.equal(
    diagnosticError(error),
    'Error code=EACCES\n    at C:\\test\\main.ts:12:3\n    at file:///test/run.ts:1:2',
  );
  assert.equal(diagnosticError('SECRET'), 'non-Error (string)');
  const unicode = boundedText('貓'.repeat(100), 64);
  assert.ok(Buffer.byteLength(unicode) <= 64);
  assert.ok(!unicode.includes('\ufffd'));
});

test('managed stderr keeps a bounded previous tail and remains writable after in-place rotation', (t) => {
  const root = fixture(t),
    file = join(root, 'core-stderr.log');
  const fd = openSync(file, 'a+');
  const guard = boundStderrLog(file, { fd, maxBytes: 128 });
  t.after(() => {
    guard.stop();
    closeSync(fd);
  });
  writeSync(fd, 'a'.repeat(1024) + 'last crash\n');
  guard.check();
  assert.equal(statSync(file).size, 0);
  const previous = join(root, 'core-stderr.previous.log');
  assert.equal(statSync(previous).size, 128);
  assert.match(readFileSync(previous, 'utf8'), /last crash\n$/u);
  writeSync(fd, 'next error\n');
  assert.equal(
    readFileSync(file, 'utf8'),
    'next error\n',
    'O_APPEND avoids a hole after truncation',
  );
  rotateStderrLog(file, fd, true, 128);
  assert.equal(readFileSync(previous, 'utf8'), 'next error\n');
  rotateStderrLog(file, fd, true, 128);
  assert.equal(
    readFileSync(previous, 'utf8'),
    'next error\n',
    'an empty start preserves the last useful evidence',
  );
});

test('stderr maintenance does not truncate a file identified by a different descriptor', (t) => {
  const root = fixture(t),
    file = join(root, 'core-stderr.log'),
    other = join(root, 'other');
  writeFileSync(file, 'mine');
  writeFileSync(other, 'unrelated');
  const fd = openSync(other, 'a+');
  try {
    rotateStderrLog(file, fd, true, 4);
  } finally {
    closeSync(fd);
  }
  assert.equal(readFileSync(other, 'utf8'), 'unrelated');
  assert.equal(readFileSync(file, 'utf8'), 'mine');
});

test('fatal monitoring writes evidence synchronously and leaves the process exit nonzero', (t) => {
  const root = fixture(t);
  const module = new URL('../../src/shell/electron/hostDiagnostics.ts', import.meta.url).href;
  const script = `import { createHostLogger, observeHostProcess } from ${JSON.stringify(module)};
    observeHostProcess(createHostLogger(${JSON.stringify(root)}));
    throw new Error('PRIVATE conversation content');`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
  });
  assert.equal(child.status, 1, child.stderr);
  const log = readFileSync(join(root, 'logs', 'host.log'), 'utf8');
  assert.match(log, /fatal/u);
  assert.match(log, /process-exit.*"code":1/u);
  assert.ok(!log.includes('PRIVATE conversation content'));
});
