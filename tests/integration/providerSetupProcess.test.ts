import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createHelperRunner, ProviderSetup } from '../../src/shell/electron/providerSetup.ts';

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('cancelling a packaged check stops its helper and hung CLI descendants before idle', { timeout: 20_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'cats-setup-process-'));
  const childFile = join(root, 'child.pid');
  const grandchildFile = join(root, 'grandchild.pid');
  const helperFile = join(root, 'helper.pid');
  const probe = join(root, 'probe.mjs');
  writeFileSync(probe, `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(childFile)}, String(process.pid));
    spawn(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(grandchildFile)}, String(process.pid)); setInterval(() => {}, 1000);`)}], { stdio: 'ignore', windowsHide: true });
    setInterval(() => {}, 1000);
  `);
  const quotePS = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const quoteSH = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  if (process.platform === 'win32') {
    writeFileSync(join(root, 'Invoke-SetupHelper.ps1'), `
      param([string]$Helper)
      [IO.File]::WriteAllText(${quotePS(helperFile)}, [string]$PID)
      & ${quotePS(process.execPath)} ${quotePS(probe)}
    `);
  } else {
    const scripts = join(root, process.platform === 'darwin' ? 'macos' : 'linux');
    mkdirSync(scripts);
    writeFileSync(join(scripts, 'install-claude-code.sh'), `echo $$ > ${quoteSH(helperFile)}\n${quoteSH(process.execPath)} ${quoteSH(probe)}\n`);
  }
  const setup = new ProviderSetup(createHelperRunner(root));
  t.after(async () => {
    setup.cancelCheck();
    await setup.whenIdle();
    for (const file of [grandchildFile, childFile, helperFile]) {
      if (existsSync(file)) {
        try { process.kill(Number(readFileSync(file, 'utf8')), 'SIGKILL'); } catch { /* already stopped */ }
      }
    }
    rmSync(root, { recursive: true, force: true });
  });
  const checking = assert.rejects(setup.check('claude'), { name: 'AbortError' });
  const deadline = Date.now() + 10_000;
  while (!existsSync(grandchildFile) && Date.now() < deadline) await delay(20);
  assert.equal(existsSync(grandchildFile), true, 'the helper must start both CLI descendants');
  const pids = [helperFile, childFile, grandchildFile].map(file => Number(readFileSync(file, 'utf8')));
  assert.ok(pids.every(alive));
  setup.cancelCheck();
  await Promise.all([checking, setup.whenIdle()]);
  for (const pid of pids) assert.equal(alive(pid), false, `owned process ${pid} stopped before idle`);
});
