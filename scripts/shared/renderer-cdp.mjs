#!/usr/bin/env node
/**
 * Inspect a running Cats Desktop renderer through the Chrome DevTools Protocol.
 *
 * The Desktop app must already be listening for CDP on loopback, for example via
 * scripts/macos/restart-desktop-with-cdp.sh. Only 127.0.0.1 is ever contacted.
 *
 * Usage:
 *   node scripts/testing/desktop-renderer-cdp.mjs targets
 *   node scripts/testing/desktop-renderer-cdp.mjs info
 *   node scripts/testing/desktop-renderer-cdp.mjs screenshot [--out shot.png]
 *   node scripts/testing/desktop-renderer-cdp.mjs text
 *   node scripts/testing/desktop-renderer-cdp.mjs eval "location.pathname"
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const DEFAULT_PORT = 9222;
const DEFAULT_TIMEOUT_MS = 10_000;
const COMMANDS = ['targets', 'info', 'screenshot', 'text', 'eval'];

const INFO_EXPRESSION = `({
  url: location.href,
  title: document.title,
  desktopBridge: typeof window.catsDesktopHost === 'object' && window.catsDesktopHost !== null,
  viewport: { width: innerWidth, height: innerHeight },
  devicePixelRatio,
  visibilityState: document.visibilityState,
})`;

function usage(profile = {}) {
  return [
    'Usage: node scripts/testing/desktop-renderer-cdp.mjs <command> [options]',
    '',
    'Commands:',
    '  targets              List debuggable targets (type, id, url, title)',
    '  info                 Report url, title, desktop bridge presence, viewport and visibility',
    '  screenshot           Capture the renderer viewport as PNG and print its path',
    '  text                 Print document.body.innerText',
    '  eval <expression>    Evaluate a JavaScript expression in the page; print the JSON value',
    '',
    'Options:',
    '  --port <n>           CDP port on 127.0.0.1',
    `                       (default: CATS_DESKTOP_CDP_PORT or ${DEFAULT_PORT})`,
    '  --target <text>      Use the first page target whose URL contains <text>',
    '                       (default: the first http(s) page target)',
    '  --out <file>         Screenshot path (default: a new private temporary directory)',
    `  --timeout <ms>       Per-request timeout (default: ${DEFAULT_TIMEOUT_MS})`,
    '  -h, --help           Show this help',
    '',
    'Notes:',
    '  - Start Desktop with remote debugging first (macOS:',
    '    scripts/macos/restart-desktop-with-cdp.sh).',
    '  - The screenshot covers the web contents only, not the native title bar, menus or tray.',
  ].join('\n').replaceAll('(default: the first http(s) page target)', profile.allowFile ? '(default: note.html, then settings.html; includes file: pages)' : '(default: the first http(s) page target)')
    .replaceAll('desktop-renderer-cdp.mjs', profile.script ?? 'desktop-renderer-cdp.mjs')
    .replaceAll('CATS_DESKTOP_CDP_PORT', profile.envKey ?? 'CATS_DESKTOP_CDP_PORT')
    .replaceAll('9222', String(profile.port ?? DEFAULT_PORT))
    .replaceAll('restart-desktop-with-cdp.sh', profile.restartScript ?? 'restart-desktop-with-cdp.sh');
}

function readPositiveInteger(name, value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${value}`);
  }
  return parsed;
}

export function parseArgs(argv = process.argv.slice(2), env = process.env, profile = {}) {
  const envKey = profile.envKey ?? 'CATS_DESKTOP_CDP_PORT';
  const options = {
    command: null,
    expression: null,
    port: readPositiveInteger(envKey, env[envKey] ?? profile.port ?? DEFAULT_PORT),
    target: null,
    out: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  };
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (['--port', '--target', '--out', '--timeout'].includes(argument)) {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`Missing value for ${argument}`);
      }
      index += 1;
      if (argument === '--port') options.port = readPositiveInteger('--port', value);
      if (argument === '--target') options.target = value;
      if (argument === '--out') options.out = value;
      if (argument === '--timeout') options.timeoutMs = readPositiveInteger('--timeout', value);
      continue;
    }
    if (argument.startsWith('--')) {
      throw new Error(`Unknown option: ${argument}`);
    }
    positionals.push(argument);
  }

  if (options.help) {
    return options;
  }
  if (options.port > 65535) throw new Error('CDP port must be between 1 and 65535.');
  const [command, ...rest] = positionals;
  if (!COMMANDS.includes(command)) {
    throw new Error(`Expected one of ${COMMANDS.join(', ')}. Use --help.`);
  }
  options.command = command;
  if (command === 'eval') {
    if (rest.length === 0) {
      throw new Error('eval requires a JavaScript expression.');
    }
    options.expression = rest.join(' ');
  } else if (rest.length > 0) {
    throw new Error(`Unexpected argument for ${command}: ${rest[0]}`);
  }
  return options;
}

/** Pick the renderer page; the main window shows a data: bootstrap page before the app URL. */
export function selectPageTarget(targets, filter = null, { allowFile = false, preferred = [] } = {}) {
  const pages = targets.filter((target) => target.type === 'page' && target.webSocketDebuggerUrl);
  const match = filter
    ? pages.find((target) => target.url.includes(filter))
    : preferred.map(text => pages.find(target => (allowFile ? /^(?:https?|file):\/\//u : /^https?:\/\//u).test(target.url) && target.url.includes(text))).find(Boolean)
      ?? pages.find((target) => (allowFile ? /^(?:https?|file):\/\//u : /^https?:\/\//u).test(target.url));
  if (!match) {
    const seen = pages.map((target) => target.url).join(', ') || 'none';
    throw new Error(
      filter
        ? `No page target URL contains "${filter}". Page targets: ${seen}`
        : `No http(s) page target yet (page targets: ${seen}). `
          + 'The window may still be on its bootstrap page; retry shortly.',
    );
  }
  return match;
}

export async function listTargets({
  port,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  profile = {},
}) {
  const endpoint = `http://127.0.0.1:${port}/json/list`;
  let response;
  try {
    response = await fetchImpl(endpoint, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new Error(
      `No CDP endpoint at ${endpoint}. Start ${profile.name ?? 'Cats Desktop'} with --remote-debugging-port=${port} `
      + `(macOS: scripts/macos/${profile.restartScript ?? 'restart-desktop-with-cdp.sh'}).`,
    );
  }
  if (!response.ok) {
    throw new Error(`${endpoint} returned HTTP ${response.status}.`);
  }
  return response.json();
}

export async function openCdpSession(webSocketUrl, {
  WebSocketImpl = globalThis.WebSocket,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const endpoint = new URL(webSocketUrl);
  if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password)
    throw new Error('CDP WebSocket must use ws://127.0.0.1.');
  const socket = new WebSocketImpl(webSocketUrl);
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { try { socket.close(); } catch {} reject(error); }
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error(`CDP WebSocket handshake timed out after ${timeoutMs} ms.`)), timeoutMs);
    socket.addEventListener('open', () => finish(), { once: true });
    socket.addEventListener(
      'error',
      () => finish(new Error(`Could not open the CDP WebSocket ${webSocketUrl}.`)),
      { once: true },
    );
    socket.addEventListener('close', () => finish(new Error('CDP WebSocket closed during handshake.')), { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  const settle = (id) => {
    const entry = pending.get(id);
    pending.delete(id);
    clearTimeout(entry?.timer);
    return entry;
  };
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) {
      return;
    }
    const { resolve, reject } = settle(message.id);
    if (message.error) {
      reject(new Error(`${message.error.message} (${message.error.code})`));
    } else {
      resolve(message.result);
    }
  });
  socket.addEventListener('close', () => {
    for (const id of [...pending.keys()]) {
      settle(id).reject(new Error('CDP connection closed.'));
    }
  });

  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        nextId += 1;
        const id = nextId;
        const timer = setTimeout(() => {
          if (pending.has(id)) {
            settle(id);
            reject(new Error(`${method} timed out after ${timeoutMs} ms.`));
          }
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    async evaluate(expression) {
      const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (exceptionDetails) {
        throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      }
      return result.value;
    },
    close() {
      socket.close();
    },
  };
}

async function resolveScreenshotPath(out) {
  if (out) {
    return out;
  }
  const directory = await mkdtemp(join(tmpdir(), 'cats-desktop-cdp-'));
  return join(directory, 'renderer.png');
}

export async function runRendererCdp(argv = process.argv.slice(2), options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const parsed = parseArgs(argv, options.env ?? process.env, options.profile);
  if (parsed.help) {
    stdout.write(`${usage(options.profile)}\n`);
    return null;
  }

  const targets = await listTargets({
    port: parsed.port,
    fetchImpl: options.fetchImpl,
    timeoutMs: parsed.timeoutMs,
    profile: options.profile,
  });
  if (parsed.command === 'targets') {
    for (const target of targets) {
      stdout.write(`${target.type}\t${target.id}\t${target.url}\t${target.title}\n`);
    }
    return targets;
  }

  const page = selectPageTarget(targets, parsed.target, options.profile);
  const session = await openCdpSession(page.webSocketDebuggerUrl, {
    WebSocketImpl: options.WebSocketImpl,
    timeoutMs: parsed.timeoutMs,
  });
  try {
    if (parsed.command === 'screenshot') {
      const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
      const path = await resolveScreenshotPath(parsed.out);
      await writeFile(path, Buffer.from(data, 'base64'), { mode: 0o600 });
      stdout.write(`${path}\n`);
      return path;
    }
    const expression = {
      info: options.infoExpression ?? INFO_EXPRESSION,
      text: 'document.body.innerText',
      eval: parsed.expression,
    }[parsed.command];
    const value = await session.evaluate(expression);
    stdout.write(
      `${typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2)}\n`,
    );
    return value;
  } finally {
    session.close();
  }
}

function isDirectExecution(metaUrl) {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return new URL(`file://${entry.replace(/\\/gu, '/')}`).href === metaUrl;
}

if (isDirectExecution(import.meta.url)) {
  try {
    await runRendererCdp();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
