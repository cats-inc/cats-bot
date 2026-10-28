import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import type { DesktopControlHelperProcess, DesktopControlSpawn } from '../../src/core/desktopControl/helper.ts';
import type { RuntimeMcpServer } from '../../src/core/runtime/client.ts';
import type { SessionCapabilitiesSnapshot } from '../../src/core/types.ts';

/**
 * Test doubles for SPEC-006 desktop control: a scripted helper that speaks protocol 1 (no
 * native code, so these tests run on every platform) and a Runtime capability snapshot.
 */

export const NOTEPAD = 'C:\\Program Files\\WindowsApps\\Microsoft.WindowsNotepad\\Notepad\\Notepad.exe';
export const SECRET_UI_VALUE = 'private-ui-value-7f3a';
export const SECRET_TITLE = 'private-window-title-91c2';
export const SECRET_TYPED = 'private-typed-text-4e8d';
export const SECRET_CLIPBOARD = 'private-clipboard-text-b05a';
/** What the fake helper's `capture_window` reports: a 200x100 window at (100, 200), captured at half scale. */
export const CAPTURE_BOUNDS = { x: 100, y: 200, width: 200, height: 100 };
export const PNG_BYTES = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk';

export interface FakeCandidate {
  path: string;
  publisher: string | null;
  productName: string;
  displayName: string;
  running: boolean;
  category: 'normal' | 'observe_only' | 'excluded';
  aumid: string | null;
}

export interface FakeWindow {
  hwnd: number;
  pid: number;
  path: string;
  title: string;
  bounds: { x: number; y: number; width: number; height: number };
  minimized: boolean;
  foreground: boolean;
}

export interface FakeWorld {
  apps: Record<string, FakeCandidate[]>;
  windows: FakeWindow[];
  locked?: boolean;
  protocol?: number;
  crashOn?: string;
  /** Delays the answer of these ops until `release()` is called. */
  holdOps?: string[];
  /** What `state` reports as the owner's idle time; 9000 when unset. */
  operatorIdleMs?: number;
  /** Ops that answer with this helper error code. */
  fail?: Record<string, string>;
  clipboard?: string | null;
}

export function defaultWorld(): FakeWorld {
  return {
    apps: {
      記事本: [{ path: NOTEPAD, publisher: 'Microsoft Corporation', productName: 'Notepad', displayName: '記事本', running: true,
        category: 'normal', aumid: 'Microsoft.WindowsNotepad!App' }],
      powershell: [{ path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', publisher: 'Microsoft Windows',
        productName: 'PowerShell', displayName: 'Windows PowerShell', running: true, category: 'observe_only', aumid: null }],
      // The helper does not know Cats Desktop's install path; the Bot refuses it by file name (BDC-08).
      cats: [{ path: 'D:\\Apps\\Cats\\Cats.exe', publisher: null, productName: 'Cats', displayName: 'Cats', running: true,
        category: 'normal', aumid: null }],
      bot: [{ path: 'C:\\Bot\\Cats Bot.exe', publisher: null, productName: 'Cats Bot', displayName: 'Cats Bot', running: true,
        category: 'excluded', aumid: null }],
    },
    windows: [{ hwnd: 7, pid: 1, path: NOTEPAD, title: SECRET_TITLE, bounds: { x: 0, y: 0, width: 800, height: 600 },
      minimized: false, foreground: true }],
  };
}

export interface FakeHelper {
  spawn: DesktopControlSpawn;
  /** Every op received, in order. */
  calls: string[];
  /** Every op received with its params, in order. */
  requests: Array<{ op: string; params: Record<string, unknown> }>;
  /** The params of every `hello`. */
  hellos: Array<Record<string, unknown>>;
  spawned: number;
  /** Answers every held op. */
  release(): void;
}

export function fakeHelper(world: FakeWorld): FakeHelper {
  const calls: string[] = [];
  const requests: FakeHelper['requests'] = [];
  const hellos: Array<Record<string, unknown>> = [];
  let held: Array<() => void> = [];
  const state = { spawned: 0 };
  const spawn: DesktopControlSpawn = () => {
    state.spawned += 1;
    const stdout = new PassThrough();
    const child = new EventEmitter() as EventEmitter & DesktopControlHelperProcess;
    let alive = true;
    const exit = (code: number) => {
      if (!alive) return;
      alive = false;
      child.emit('exit', code);
    };
    Object.assign(child, {
      stdout,
      kill: () => { exit(0); return true; },
      stdin: {
        end() {},
        write(line: string) {
          const { id, op, params } = JSON.parse(line) as { id: number; op: string; params: Record<string, unknown> };
          calls.push(op);
          requests.push({ op, params });
          const reply = (result: unknown) => stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`);
          const fail = (code: string) => stdout.write(`${JSON.stringify({ id, ok: false, error: { code, message: code } })}\n`);
          if (world.crashOn === op) {
            exit(1);
            return true;
          }
          const answer = () => {
            if (op === 'hello') {
              hellos.push(params);
              if (params.protocol !== 1) fail('invalid_request');
              else reply({ protocol: world.protocol ?? 1, version: '1.0.0', platform: 'win32', dpiAwareness: 'per_monitor_v2' });
            } else if (op === 'state') reply({ locked: world.locked === true, idleMs: 9000, operatorIdleMs: world.operatorIdleMs ?? 9000 });
            else if (op === 'resolve_apps') {
              reply({ matches: (params.queries as string[]).map((query) => ({ query, candidates: world.apps[query] ?? [] })) });
            } else if (op === 'list_windows') {
              reply({ windows: world.windows.filter((window) => (params.paths as string[]).includes(window.path)) });
            } else if (op === 'capture_window') {
              if (!world.windows.some((window) => window.hwnd === params.hwnd)) fail('window_gone');
              else reply({ pngBase64: PNG_BYTES, width: 100, height: 50, scale: 0.5, bounds: CAPTURE_BOUNDS });
            } else if (op === 'read_ui') {
              reply({ readId: 5, nodes: [{ elementId: 'e0', parentId: null, role: 'window', name: 'Notepad', value: null },
                { elementId: 'e1', parentId: 'e0', role: 'edit', name: 'Text', value: SECRET_UI_VALUE }], truncated: false });
            } else if (op === 'open_app') reply({ pid: 42 });
            else if (world.fail?.[op]) fail(world.fail[op]!);
            else if (['click', 'scroll', 'type', 'key', 'invoke'].includes(op)) reply({ done: true });
            else if (op === 'clipboard_read') reply({ text: world.clipboard ?? null });
            else if (op === 'clipboard_write') {
              world.clipboard = params.text as string;
              reply({ done: true });
            } else if (op === 'cancel') reply({ cancelled: true });
            else fail('invalid_request');
          };
          if (world.holdOps?.includes(op)) held.push(answer);
          else answer();
          return true;
        },
      },
    });
    return child;
  };
  return {
    spawn,
    calls,
    requests,
    hellos,
    get spawned() { return state.spawned; },
    release() {
      const answers = held;
      held = [];
      for (const answer of answers) answer();
    },
  };
}

export function snapshot({ approval = 'on-request', status = 'verified', source = 'explicit', host = true }: {
  approval?: string; status?: string; source?: string; host?: boolean;
} = {}, sessionId = 's'): SessionCapabilitiesSnapshot {
  return {
    version: 1, sessionId, workerGeneration: null, supported: true, observation: {
      interactions: { version: 1, supported: ['tool_approval'], ...(host ? { host: { version: 1, kinds: ['tool_approval'], timeoutMs: 1 } } : {}) },
      policy: {
        source: source as 'explicit', status: status as 'verified', coverage: 'local-process-only', configurationSources: [],
        ...(source === 'explicit' ? { requested: { version: 1, mode: 'explicit', access: 'full-access', network: true,
          approval: approval as 'on-request' } } : {}),
      },
      inventory: { state: 'observed', observedAt: null, stale: false, coverage: 'top-level-mcp', pages: 1, servers: [],
        dynamicTools: [], builtins: 'observed' },
      dependencies: [{ kind: 'computer_use', status: 'unavailable', evidence: 'headless', remediation: 'none' }],
    },
  };
}

export interface McpToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  structuredContent: Record<string, any>;
  isError?: boolean;
}

/** A `tools/call` the way the provider CLI makes it: the descriptor's URL and bearer token. */
export async function callDesktopTool(server: RuntimeMcpServer | undefined, name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
  if (!server || server.auth.kind !== 'bearer_env') throw new Error('no cats-desktop descriptor');
  const response = await fetch(server.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${server.auth.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  return ((await response.json()) as { result: McpToolResult }).result;
}

export function errorCode(result: McpToolResult): string | undefined {
  return result.isError ? result.structuredContent?.error?.code : undefined;
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 5_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
