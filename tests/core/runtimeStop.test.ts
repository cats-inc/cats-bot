import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { RuntimeSupervisor } from '../../src/core/runtime/supervisor.ts';

test('stop fences a startup waiting for its port, and the supervisor can subsequently restart', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cats-stop-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const supervisor = new RuntimeSupervisor({ runtimeDir: root, providers: { provider: 'codex' }, runtimeEntry: resolve(import.meta.dirname, '../support/fake-runtime.mjs'), stopTimeoutMs: 500 });
  t.after(() => supervisor.stop());
  const start = supervisor.start();
  const cancelled = assert.rejects(start, /cancelled/u);
  assert.equal(supervisor.pid, null, 'startup is suspended before spawn');
  await supervisor.stop(); await cancelled;
  assert.equal(supervisor.pid, null); assert.equal(supervisor.state, 'stopped'); assert.equal(supervisor.client, null);
  await supervisor.start(); assert.equal(supervisor.state, 'ready'); assert.ok(supervisor.pid);
  await supervisor.stop(); assert.equal(supervisor.state, 'stopped'); assert.equal(supervisor.pid, null);
});

test('a late health response after stop cannot revive the Runtime client', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cats-stop-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  let entered!: () => void, respond!: (response: Response) => void;
  const requested = new Promise<void>(resolve => { entered = resolve; });
  const response = new Promise<Response>(resolve => { respond = resolve; });
  const supervisor = new RuntimeSupervisor({ runtimeDir: root, providers: { provider: 'codex' },
    runtimeEntry: resolve(import.meta.dirname, '../support/fake-runtime.mjs'), stopTimeoutMs: 500,
    fetch: (() => { entered(); return response; }) as typeof fetch });
  t.after(() => supervisor.stop());
  const starting = assert.rejects(supervisor.start(), /exited/u);
  await requested; await supervisor.stop(); await starting;
  respond(new Response(JSON.stringify({ readiness: { ready: true } }), { status: 200 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(supervisor.state, 'stopped'); assert.equal(supervisor.pid, null); assert.equal(supervisor.client, null);
});

test('failed child creation still settles stop instead of awaiting a nonexistent process', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cats-stop-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const supervisor = new RuntimeSupervisor({ runtimeDir: root, providers: { provider: 'codex' },
    nodeExecPath: join(root, 'missing-node'), runtimeEntry: resolve(import.meta.dirname, '../support/fake-runtime.mjs'), stopTimeoutMs: 50 });
  await assert.rejects(supervisor.start(), /ENOENT/u);
  await supervisor.stop(); assert.equal(supervisor.state, 'stopped'); assert.equal(supervisor.pid, null);
});
