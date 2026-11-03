import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';
import { openSignInTerminal, signInCommand, signInScript, terminalInvocation } from '../../src/shell/electron/setupTerminal.ts';

test('each provider has one fixed sign-in command, and nothing else has any (SPEC-010 FR-15)', () => {
  assert.equal(signInCommand('codex'), 'codex login');
  assert.equal(signInCommand('claude'), 'claude');
  assert.equal(signInCommand('antigravity'), 'agy');
  assert.equal(signInCommand('grok'), 'grok login');
  assert.equal(signInCommand('muse'), 'muse login');
  for (const value of ['calc.exe', 'constructor', '__proto__', 'codex & calc', '', 42, null, {}]) {
    assert.equal(signInCommand(value), null, String(value));
  }
});

test('Windows opens Command Prompt in a window of its own, which needs no PowerShell policy', () => {
  const invocation = terminalInvocation('win32', 'codex login', { ComSpec: 'C:\\Windows\\system32\\cmd.exe', Path: 'C:\\bin' })!;
  assert.equal(invocation.command, 'C:\\Windows\\system32\\cmd.exe');
  assert.deepEqual(invocation.args, ['/c', 'start', 'Cats Bot', 'C:\\Windows\\system32\\cmd.exe', '/k', 'codex login']);
  assert.equal(invocation.script, undefined);
  assert.equal(terminalInvocation('win32', 'claude', {})!.command, 'cmd.exe');
});

test('macOS runs a script in Terminal, carrying the PATH a GUI launch lacks', () => {
  const invocation = terminalInvocation('darwin', 'grok login', { PATH: '/Users/cat/.grok/bin:/usr/bin' })!;
  assert.equal(invocation.command, 'open');
  assert.deepEqual(invocation.args, ['-a', 'Terminal', '{script}']);
  assert.match(invocation.script!, /^#!\/bin\/sh\nrm -f -- "\$0"\nexport PATH='\/Users\/cat\/\.grok\/bin:\/usr\/bin'\ngrok login\n/u);
});

test('Linux tries known terminals in order, and says when there is none', () => {
  const installed = (...programs: string[]) => (program: string) => programs.includes(program);
  assert.equal(terminalInvocation('linux', 'agy', { PATH: '/usr/bin' }, installed('xterm', 'konsole'))!.command, 'konsole');
  const x = terminalInvocation('linux', 'agy', { PATH: '/usr/bin' }, installed('x-terminal-emulator', 'xterm'))!;
  assert.equal(x.command, 'x-terminal-emulator');
  assert.deepEqual(x.args, ['-e', '{script}']);
  assert.equal(terminalInvocation('linux', 'agy', { PATH: '/usr/bin' }, installed()), null);
  assert.equal(terminalInvocation('freebsd', 'agy', {}), null);
});

test('the script quotes PATH, so a folder name cannot run anything', () => {
  assert.equal(signInScript('claude', "/a'b;rm -rf ~"), `#!/bin/sh\nrm -f -- "$0"\nexport PATH='/a'\\''b;rm -rf ~'\nclaude\nexec "\${SHELL:-/bin/sh}"\n`);
});

function fakeLaunch(result: 'spawn' | 'error') {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  const launch = ((command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    const child = Object.assign(new EventEmitter(), { unref() {} });
    queueMicrotask(() => child.emit(result, new Error('no such program')));
    return child;
  }) as never;
  return { calls, launch };
}

test('opening is detached from the app and reports what happened', async () => {
  const opened = fakeLaunch('spawn');
  assert.deepEqual(await openSignInTerminal('codex', { platform: 'win32', env: {}, launch: opened.launch }), { opened: true, command: 'codex login' });
  assert.equal(opened.calls[0]!.options.detached, true);
  assert.equal(opened.calls[0]!.options.stdio, 'ignore');
  const missing = fakeLaunch('error');
  assert.deepEqual(await openSignInTerminal('codex', { platform: 'win32', env: {}, launch: missing.launch }), { opened: false, command: 'codex login' });
});

test('a launcher that exits with an error right away did not open anything', async () => {
  const launch = ((_command: string) => {
    const child = Object.assign(new EventEmitter(), { unref() {} });
    queueMicrotask(() => {
      child.emit('spawn');
      child.emit('exit', 1);
    });
    return child;
  }) as never;
  assert.deepEqual(await openSignInTerminal('codex', { platform: 'win32', env: {}, launch }), { opened: false, command: 'codex login' });
});

test('a provider outside the table starts nothing', async () => {
  const launch = fakeLaunch('spawn');
  assert.deepEqual(await openSignInTerminal('calc', { platform: 'win32', env: {}, launch: launch.launch }), { opened: false, command: null });
  assert.equal(launch.calls.length, 0);
});

test('with no terminal the page still gets the command to copy', async () => {
  const launch = fakeLaunch('spawn');
  assert.deepEqual(await openSignInTerminal('muse', { platform: 'linux', env: { PATH: '' }, launch: launch.launch }), { opened: false, command: 'muse login' });
  assert.equal(launch.calls.length, 0);
});

test('on macOS the script is written where only the account can read it, and handed to Terminal', async () => {
  const launch = fakeLaunch('spawn');
  const result = await openSignInTerminal('claude', { platform: 'darwin', env: { PATH: '/usr/bin' }, launch: launch.launch });
  assert.equal(result.opened, true);
  const file = launch.calls[0]!.args.at(-1)!;
  assert.match(file, /sign-in\.command$/u);
  assert.ok(existsSync(file));
  assert.match(readFileSync(file, 'utf8'), /\nclaude\n/u);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o700);
});
