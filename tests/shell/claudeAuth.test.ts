import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { ProviderSetup, type HelperResult } from '../../src/shell/electron/providerSetup.ts';

test(
  'the packaged Windows Claude helper recognizes subscription login without an API key',
  {
    skip: process.platform !== 'win32',
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'cats bot claude auth-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const assets = fileURLToPath(new URL('../../assets/setup/windows/', import.meta.url));
    await mkdir(join(root, '.local', 'bin'), { recursive: true });
    await writeFile(join(root, '.local', 'bin', 'claude.exe'), 'fixture: never executed');
    for (const name of [
      'Install-ClaudeCode.ps1',
      '_HiddenProcess.ps1',
      '_NativeInstallerSupport.ps1',
    ]) {
      await copyFile(join(assets, name), join(root, name));
    }
    // Execute the shipped helper with its real JSON-to-setup mapping; isolate only
    // the CLI process boundary so no test reads the developer's provider profile.
    const hidden = join(root, '_HiddenProcess.ps1');
    await writeFile(
      hidden,
      (await readFile(hidden, 'utf8')) +
        `
function Invoke-HiddenCommand {
  param([string]$FileName, [string[]]$ArgumentList, [int]$TimeoutMs)
  if (($ArgumentList -join ' ') -ne 'auth status --json') { throw 'Unexpected CLI call' }
  return [pscustomobject]@{
    ExitCode = 0
    Output = $env:CATS_TEST_AUTH_OUTPUT
    ErrorOutput = 'private fixture diagnostic'
  }
}
`,
    );
    for (const loggedIn of [true, false]) {
      const setup = new ProviderSetup(async (helper, apply) => {
        assert.equal(helper, 'claude');
        assert.equal(apply, false);
        const { stdout, stderr } = await promisify(execFile)(
          'powershell.exe',
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            join(root, 'Install-ClaudeCode.ps1'),
            '-CheckOnly',
            '-Json',
            // GitHub's Windows runner is elevated; this fixture never installs.
            '-AllowAdmin',
            '-InstallState',
            'installed',
            '-NpmShimState',
            'missing',
            '-DetectedVersion',
            'fixture',
          ],
          {
            env: {
              ...process.env,
              USERPROFILE: root,
              ANTHROPIC_API_KEY: '',
              CATS_TEST_AUTH_OUTPUT: JSON.stringify({
                loggedIn,
                authMethod: 'claude.ai',
                privateFixture: 'must-not-escape',
              }),
            },
            timeout: 20_000,
          },
        );
        assert.doesNotMatch(stdout + stderr, /must-not-escape|private fixture diagnostic/u);
        return JSON.parse(stdout) as HelperResult;
      });
      const state = await setup.check('claude');
      assert.equal(state.steps[0]?.status, loggedIn ? 'ready' : 'auth_required');
      assert.equal(state.canFinish, true);
      assert.equal(state.steps[0]?.manualSteps.length === 0, loggedIn);
    }
  },
);
