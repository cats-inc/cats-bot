// Native phase B check for the desktop control helper (SPEC-006 B7, PLAN-006 P5; SPEC-133 A7).
// It sends real input, but only to its own probe window, and waits until the owner has been
// idle for 5 seconds before each action.
// Usage: node input-check.mjs [helper.exe]   (Windows only; builds the probe app if needed)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const helperPath = process.argv[2]
  ?? join(here, '..', 'bin', 'Release', 'net8.0-windows10.0.19041.0', 'cats-desktop-control-windows.exe');
const probePath = join(here, 'probe', 'bin', 'Release', 'net8.0-windows', 'cats-desktop-control-probe.exe');
if (!existsSync(probePath)) spawnSync('dotnet', ['build', join(here, 'probe'), '-c', 'Release', '-nologo', '-v', 'q'], { stdio: 'inherit' });

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const probe = spawn(probePath, ['300', '200', '700', '520'], { stdio: 'ignore' });
await sleep(2500);
// An observe-only window (PowerShell) covering the probe's bottom-right corner.
const cover = spawn('powershell.exe', ['-NoProfile', '-STA', '-File', join(here, 'probe-window.ps1'), '-Title', 'Cats DC probe cover',
  '-Color', 'Red', '-X', '800', '-Y', '520', '-W', '300', '-H', '220', '-TopMost'], { stdio: 'ignore' });
await sleep(2500);

const child = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'inherit'] });
const waiting = new Map();
createInterface({ input: child.stdout }).on('line', (line) => { const m = JSON.parse(line); waiting.get(m.id)?.(m); waiting.delete(m.id); });
let next = 1;
const call = (op, params = {}) => new Promise((resolve) => { const id = next++; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ id, op, params })}\n`); });
const send = (op, params = {}) => { const id = next++; const reply = new Promise((resolve) => waiting.set(id, resolve)); child.stdin.write(`${JSON.stringify({ id, op, params })}\n`); return reply; };

let toldOwner = false;
/** Waits for 5 quiet seconds from the owner, then runs one input op; operator_active is retried. */
async function input(op, params) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const state = (await call('state')).result;
    if (state.operatorIdleMs < 5_000) {
      if (!toldOwner) { console.log('… waiting for 5 quiet seconds (please keep your hands off the keyboard and mouse)'); toldOwner = true; }
      await sleep(1_000); continue;
    }
    const reply = await call(op, params);
    if (reply.ok || reply.error.code !== 'operator_active') return reply;
    await sleep(1_500);
  }
  throw new Error('The owner was not idle for 3 minutes; run the check again when the computer is free.');
}

const failCode = (reply) => (reply.ok ? 'ok' : reply.error.code);
try {
  await call('hello', { protocol: 1, selfProcessIds: [process.pid], selfExecutables: [] });
  const probeWindow = (await call('list_windows', { paths: [probePath] })).result.windows.find((w) => w.title === 'Cats DC input probe');
  const hwnd = probeWindow.hwnd; const frame = probeWindow.bounds;
  const read = async () => (await call('read_ui', { hwnd, maxNodes: 200 })).result;
  const named = (ui, name) => ui.nodes.find((node) => node.name === name);
  const center = (node) => ({ x: frame.x + node.bounds.x + Math.floor(node.bounds.width / 2), y: frame.y + node.bounds.y + Math.floor(node.bounds.height / 2) });
  const has = (ui, name) => ui.nodes.some((node) => node.name === name);
  let ui = await read();

  let reply = await input('click', { hwnd, bounds: frame, ...center(named(ui, 'Probe button')), button: 'left', count: 1 });
  ui = await read();
  check('click lands on the button', reply.ok && has(ui, 'Clicks: 1'), failCode(reply));

  reply = await input('invoke', { hwnd, readId: ui.readId, elementId: named(ui, 'Probe check').elementId, action: 'toggle' });
  ui = await read();
  check('invoke toggles the checkbox', reply.ok && has(ui, 'Checked: True'), failCode(reply));
  reply = await input('invoke', { hwnd, readId: ui.readId, elementId: named(ui, 'Probe button').elementId, action: 'invoke' });
  ui = await read();
  check('invoke presses the button', reply.ok && has(ui, 'Clicks: 2'), failCode(reply));

  await input('click', { hwnd, bounds: frame, ...center(named(ui, 'Probe text')), button: 'left', count: 1 });
  reply = await input('type', { hwnd, text: 'hello cats 喵' });
  ui = await read();
  check('type_text fills the focused text box', reply.ok && named(ui, 'Probe text')?.value === 'hello cats 喵', named(ui, 'Probe text')?.value ?? failCode(reply));
  reply = await input('key', { hwnd, keys: 'enter' });
  ui = await read();
  check('key sends an allowlisted key', reply.ok && (has(ui, 'Last key: Return') || has(ui, 'Last key: Enter')), failCode(reply));

  await input('click', { hwnd, bounds: frame, ...center(named(ui, 'Probe secret')), button: 'left', count: 1 });
  check('typing into a password field is refused', failCode(await input('type', { hwnd, text: 'x' })) === 'password_field');
  check('pasting into a password field is refused', failCode(await input('key', { hwnd, keys: 'ctrl+v' })) === 'password_field');
  ui = await read();
  check('the password value is never read', !JSON.stringify(ui).includes('hunter2'));

  reply = await input('scroll', { hwnd, bounds: frame, ...center(named(ui, 'Probe text')), direction: 'down', amount: 2 });
  ui = await read();
  check('scroll turns the wheel over the window', reply.ok && has(ui, 'Wheel: -2'), failCode(reply));

  check('a point under another window is refused', failCode(await input('click', { hwnd, bounds: frame, x: 900, y: 650, button: 'left', count: 1 })) === 'covered');
  check('a moved window is refused', failCode(await input('click', { hwnd, bounds: { ...frame, x: frame.x + 1 }, ...center(named(ui, 'Probe button')) })) === 'window_changed');
  const coverWindow = (await call('list_windows', { paths: [join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')] }))
    .result.windows.find((w) => w.title === 'Cats DC probe cover');
  check('input to an observe-only app is refused', failCode(await input('click', { hwnd: coverWindow.hwnd, bounds: coverWindow.bounds,
    x: coverWindow.bounds.x + 50, y: coverWindow.bounds.y + 50 })) === 'observe_only');

  await input('click', { hwnd, bounds: frame, ...center(named(ui, 'Probe text')), button: 'left', count: 1 });
  await input('key', { hwnd, keys: 'ctrl+a' }); await input('key', { hwnd, keys: 'delete' });
  const long = send('type', { hwnd, text: 'a'.repeat(2000) });
  await sleep(300);
  const cancelled = (await call('cancel', {})).result.cancelled;
  reply = await long;
  ui = await read();
  const typed = named(ui, 'Probe text')?.value?.length ?? 0;
  check('cancel stops typing between chunks', cancelled && failCode(reply) === 'stopped' && typed > 0 && typed < 2000, `typed ${typed} of 2000`);
} catch (error) {
  check('input check run', false, String(error?.message ?? error).slice(0, 300));
} finally {
  child.stdin.end();
  for (const p of [probe, cover]) try { process.kill(p.pid); } catch {}
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
