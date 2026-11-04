import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createHelperRunner } from '../../src/shell/electron/providerSetup.ts';

const assets = fileURLToPath(new URL('../../assets/setup/', import.meta.url));
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;

for (const launch of ['child', 'missing-result'] as const) {
  test(`packaged Node elevation returns JSON through the Bot runner: ${launch}`, {
    skip: process.platform !== 'win32',
  }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'cats-bot-node-relay-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const setup = join(root, 'Cats Bot (test)', 'setup');
    const windows = join(setup, 'windows');
    const temp = join(root, "Owner's Temp 測試");
    await Promise.all([mkdir(windows, { recursive: true }), mkdir(temp)]);
    const source = (await readFile(join(assets, 'windows', 'Install-Node.ps1'), 'utf8')).replaceAll('\r\n', '\n');
    const admin = '$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).\n' +
      '  IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)';
    assert.ok(source.includes(admin));
    // Select the unelevated branch without UAC; all real probes/installers are
    // disabled in the packaged invocation below. The child and relay stay real.
    await writeFile(join(windows, 'Install-Node.ps1'), source.replace(admin, '$isAdmin = $false'));
    await copyFile(join(assets, 'windows', '_HiddenProcess.ps1'), join(windows, '_HiddenProcess.ps1'));
    const actualLaunch = launch === 'child'
      ? `Microsoft.PowerShell.Management\\Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput ${literal(join(root, 'child.stdout'))} -RedirectStandardError ${literal(join(root, 'child.stderr'))}`
      : '[pscustomobject]@{ ExitCode = 17 }';
    const stop = "$ErrorActionPreference = 'Stop'";
    let wrapper = await readFile(join(assets, 'Invoke-SetupHelper.ps1'), 'utf8');
    assert.ok(wrapper.includes(stop));
    assert.ok(wrapper.includes('-Apply -Json @scoped'));
    wrapper = wrapper.replace(stop, `${stop}
$env:TEMP = ${literal(temp)}
$env:TMP = ${literal(temp)}
function Start-Process {
  param($FilePath, $ArgumentList, $Verb, [switch]$Wait, [switch]$PassThru)
  if ($Verb -ne 'RunAs' -or -not $Wait -or -not $PassThru) { throw 'Unexpected elevation request' }
  ${actualLaunch}
}
`).replace('-Apply -Json @scoped', '-Apply -Json @scoped -InstallState missing -SkipNodeProbe');
    await writeFile(join(setup, 'Invoke-SetupHelper.ps1'), '\uFEFF' + wrapper);
    const result = await createHelperRunner(setup)('node', true);
    assert.equal(result.status, 'failed');
    assert.equal(result.installed, false);
    assert.deepEqual(result.appliedChanges, []);
    if (launch === 'child') {
      assert.deepEqual(result.warnings, [], 'the child returned its real no-install result');
    } else {
      assert.match(result.warnings!.join('\n'), /did not return a valid result.*exit code 17/iu);
      assert.deepEqual(result.interruptions, []);
    }
  });
}
