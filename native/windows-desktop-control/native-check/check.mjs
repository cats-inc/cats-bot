// Native phase A check for the desktop control helper (SPEC-006 B4, PLAN-006 P1; SPEC-133 A4).
// Observe-only: it opens two throwaway windows and never sends input. Windows only.
// Usage: node check.mjs [helper.exe]   (default: the Release build output)
import { spawn, execFileSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const helperPath = process.argv[2]
  ?? join(here, '..', 'bin', 'Release', 'net8.0-windows10.0.19041.0', 'cats-desktop-control-windows.exe');
const probeScript = join(here, 'probe-window.ps1');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

function startProbe(title, color, x, y, w, h, extra = []) {
  return spawn('powershell.exe', ['-NoProfile', '-STA', '-File', probeScript, '-Title', title, '-Color', color,
    '-X', String(x), '-Y', String(y), '-W', String(w), '-H', String(h), ...extra], { stdio: 'ignore' });
}

function helper() {
  const child = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  let next = 1;
  const call = (op, params = {}) => new Promise((resolve) => {
    const id = next++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ id, op, params })}\n`);
  });
  return { call, close: () => child.stdin.end() };
}

// Minimal PNG decoder for 8-bit RGB/RGBA, non-interlaced (what WIC writes).
function decodePng(buffer) {
  let offset = 8; let width = 0; let height = 0; let colorType = 0; const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset); const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]; }
    if (type === 'IDAT') idat.push(data);
    offset += length + 12;
  }
  const channels = colorType === 6 ? 4 : 3; const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat)); const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x];
      const left = x >= channels ? out[y * stride + x - channels] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const upLeft = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) { const p = left + up - upLeft; const pa = Math.abs(p - left); const pb = Math.abs(p - up); const pc = Math.abs(p - upLeft);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft; }
      out[y * stride + x] = (value + predictor) & 255;
    }
  }
  return { width, height, channels, pixels: out };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const target = startProbe('Cats DC probe target', 'Blue', 300, 200, 700, 500, ['-Controls']);
await sleep(2500);
const cover = startProbe('Cats DC probe cover', 'Red', 500, 300, 400, 300, ['-TopMost']);
await sleep(2500);

const h = helper();
try {
  const hello = await h.call('hello', { protocol: 1, selfProcessIds: [process.pid], selfExecutables: [] });
  check('hello handshake', hello.ok && hello.result.protocol === 1, JSON.stringify(hello.result));

  const bad = await h.call('nope');
  check('unknown op is refused', !bad.ok && bad.error.code === 'invalid_request');

  const powershell = execFileSync('where.exe', ['powershell.exe']).toString().split(/\r?\n/)[0].trim();
  const listed = await h.call('list_windows', { paths: [powershell] });
  const probe = listed.result?.windows.find((w) => w.title === 'Cats DC probe target');
  check('list_windows finds the probe window', Boolean(probe), probe ? JSON.stringify(probe.bounds) : JSON.stringify(listed));

  const resolved = await h.call('resolve_apps', { queries: ['記事本', 'Notepad', 'powershell'] });
  for (const match of resolved.result?.matches ?? []) {
    console.log(`   resolve "${match.query}": ${match.candidates.map((c) => `${c.displayName} [${c.category}${c.aumid ? ', packaged' : ''}] ${c.path.split('\\').pop()}`).join(' | ') || '(none)'}`);
  }
  const shell = resolved.result?.matches.find((m) => m.query === 'powershell')?.candidates[0];
  check('PowerShell resolves as observe_only', shell?.category === 'observe_only', shell?.category);

  const shot = await h.call('capture_window', { hwnd: probe.hwnd, maxEdge: 1568 });
  check('capture_window returns a PNG', shot.ok && shot.result.pngBase64.length > 100, shot.ok ? `${shot.result.width}x${shot.result.height} scale ${shot.result.scale}` : JSON.stringify(shot.error));
  if (shot.ok) {
    const png = Buffer.from(shot.result.pngBase64, 'base64');
    writeFileSync(join(tmpdir(), 'cats-desktop-control-probe.png'), png);
    const image = decodePng(png);
    // Only the area the red cover window overlaps is checked; the title bar icon has red in it.
    const left = 500 - probe.bounds.x + 10; const top = 300 - probe.bounds.y + 10;
    let red = 0; let blue = 0; let total = 0;
    for (let y = top; y < Math.min(image.height, top + 280); y++) {
      for (let x = left; x < Math.min(image.width, left + 380); x++) {
        const i = (y * image.width + x) * image.channels;
        const [r, g, b] = [image.pixels[i], image.pixels[i + 1], image.pixels[i + 2]];
        total++;
        if (r > 200 && g < 60 && b < 60) red++;
        if (b > 200 && r < 60 && g < 60) blue++;
      }
    }
    check('A4: covering ungranted window leaves no pixels', red === 0 && blue > total * 0.95, `overlap ${total} px: red ${red}, blue ${blue}`);
  }

  const small = await h.call('capture_window', { hwnd: probe.hwnd, maxEdge: 256 });
  check('maxEdge scales the image', small.ok && Math.max(small.result.width, small.result.height) <= 256, small.ok ? `${small.result.width}x${small.result.height}` : '');

  const ui = await h.call('read_ui', { hwnd: probe.hwnd, maxNodes: 200 });
  const nodes = ui.result?.nodes ?? [];
  const button = nodes.find((n) => n.name === 'Probe button');
  const edits = nodes.filter((n) => n.role === 'edit');
  check('read_ui lists the button with invoke', Boolean(button) && button.actions.includes('invoke'), button ? JSON.stringify(button) : `${nodes.length} nodes`);
  check('read_ui reads the plain edit value', edits.some((n) => n.value === 'visible text'));
  check('read_ui never returns the password value', !JSON.stringify(ui).includes('hunter2'), `${edits.length} edit nodes`);
  const limited = await h.call('read_ui', { hwnd: probe.hwnd, maxNodes: 2 });
  check('maxNodes bounds the tree', limited.result?.nodes.length === 2 && limited.result.truncated === true);

  const state = await h.call('state');
  check('state reports lock and idle', state.ok && typeof state.result.locked === 'boolean', JSON.stringify(state.result));

  // A second helper that treats the probe's process as "self" must refuse it.
  const selfHelper = helper();
  await selfHelper.call('hello', { protocol: 1, selfProcessIds: [target.pid, probe.pid], selfExecutables: [] });
  const refused = await selfHelper.call('capture_window', { hwnd: probe.hwnd, maxEdge: 512 });
  check('self windows are excluded', !refused.ok && refused.error.code === 'excluded_app', JSON.stringify(refused.error));
  selfHelper.close();
} finally {
  h.close();
  for (const child of [target, cover]) try { process.kill(child.pid); } catch {}
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
