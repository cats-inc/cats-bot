import assert from 'node:assert/strict';
import { test } from 'node:test';

import { discoverShellHosts, shellHostsChanged, type Hwnd, type ShellWindows } from '../../src/shell/electron/shellHosts.ts';

/**
 * SPEC-002 FR-8: the Explorer host rules ported from desktop-work-fleet
 * NativeShellLayers, against a fake window tree (no real Explorer is touched).
 */

interface FakeWindow {
  id: Hwnd;
  className: string;
  parent: Hwnd;
  process: number;
  visible?: boolean;
}

class FakeShell implements ShellWindows {
  windows: FakeWindow[];
  requests: Array<[number, number]> = [];
  onRequest: ((shell: FakeShell) => void) | null = null;
  constructor(windows: FakeWindow[]) {
    this.windows = windows;
  }
  /** Children of a parent in Z order, top first (the array order). */
  private children(parent: Hwnd): FakeWindow[] {
    return this.windows.filter((window) => window.parent === parent);
  }
  progman(): Hwnd {
    return this.windows.find((window) => window.className === 'Progman' && window.parent === 0)?.id ?? 0;
  }
  topLevel(): Hwnd[] {
    return this.children(0).map((window) => window.id);
  }
  findChild(parent: Hwnd, after: Hwnd, className: string): Hwnd {
    const list = this.children(parent);
    const start = after === 0 ? 0 : list.findIndex((window) => window.id === after) + 1;
    return list.slice(start).find((window) => window.className === className)?.id ?? 0;
  }
  next(window: Hwnd): Hwnd {
    const self = this.windows.find((item) => item.id === window);
    if (!self) return 0;
    const siblings = this.children(self.parent);
    return siblings[siblings.findIndex((item) => item.id === window) + 1]?.id ?? 0;
  }
  processOf(window: Hwnd): number {
    return this.windows.find((item) => item.id === window)?.process ?? 0;
  }
  visible(window: Hwnd): boolean {
    return this.windows.find((item) => item.id === window)?.visible !== false;
  }
  alive(window: Hwnd): boolean {
    return this.windows.some((item) => item.id === window);
  }
  requestWallpaper(_shell: Hwnd, wParam: number, lParam: number): void {
    this.requests.push([wParam, lParam]);
    this.onRequest?.(this);
  }
}

const EXPLORER = 10;

test('modern Explorer: the icons host is Progman and the wallpaper is its WorkerW child below the icons', () => {
  const shell = new FakeShell([
    { id: 1, className: 'Chrome_WidgetWin_1', parent: 0, process: 99 },
    { id: 2, className: 'Progman', parent: 0, process: EXPLORER },
    { id: 3, className: 'SHELLDLL_DefView', parent: 2, process: EXPLORER },
    { id: 4, className: 'WorkerW', parent: 2, process: EXPLORER },
  ]);
  assert.deepEqual(discoverShellHosts(shell), { desktop: 2, wallpaper: 4, shell: 2 });
  assert.deepEqual(shell.requests, [], 'no request when the wallpaper host exists');
});

test('a WorkerW above the icons or hidden is not the wallpaper; Explorer is asked for one', () => {
  const shell = new FakeShell([
    { id: 2, className: 'Progman', parent: 0, process: EXPLORER },
    { id: 5, className: 'WorkerW', parent: 2, process: EXPLORER },
    { id: 3, className: 'SHELLDLL_DefView', parent: 2, process: EXPLORER },
    { id: 6, className: 'WorkerW', parent: 2, process: EXPLORER, visible: false },
  ]);
  shell.onRequest = (fake) => {
    if (fake.requests.length === 2) fake.windows.push({ id: 7, className: 'WorkerW', parent: 2, process: EXPLORER });
  };
  assert.deepEqual(discoverShellHosts(shell), { desktop: 2, wallpaper: 7, shell: 2 });
  assert.deepEqual(shell.requests, [[13, 0], [13, 1]]);
});

test('classic Explorer: the icons live in a WorkerW and the wallpaper is a WorkerW sibling behind it', () => {
  const shell = new FakeShell([
    { id: 8, className: 'WorkerW', parent: 0, process: EXPLORER },
    { id: 3, className: 'SHELLDLL_DefView', parent: 8, process: EXPLORER },
    { id: 9, className: 'WorkerW', parent: 0, process: EXPLORER },
    { id: 2, className: 'Progman', parent: 0, process: EXPLORER },
  ]);
  assert.deepEqual(discoverShellHosts(shell), { desktop: 8, wallpaper: 9, shell: 2 });
});

test('windows of other processes never host notes', () => {
  const shell = new FakeShell([
    { id: 20, className: 'WorkerW', parent: 0, process: 77 },
    { id: 21, className: 'SHELLDLL_DefView', parent: 20, process: 77 },
    { id: 2, className: 'Progman', parent: 0, process: EXPLORER },
    { id: 3, className: 'SHELLDLL_DefView', parent: 2, process: EXPLORER },
    { id: 22, className: 'WorkerW', parent: 2, process: 77 },
  ]);
  assert.deepEqual(discoverShellHosts(shell), { desktop: 2, wallpaper: 0, shell: 2 });
  assert.equal(shell.requests.length, 3, 'all three bounded requests were tried');
});

test('no Progman means no hosts; a new Progman or a dead host means Explorer restarted', () => {
  assert.deepEqual(discoverShellHosts(new FakeShell([])), { desktop: 0, wallpaper: 0, shell: 0 });
  const shell = new FakeShell([
    { id: 2, className: 'Progman', parent: 0, process: EXPLORER },
    { id: 3, className: 'SHELLDLL_DefView', parent: 2, process: EXPLORER },
    { id: 4, className: 'WorkerW', parent: 2, process: EXPLORER },
  ]);
  const hosts = discoverShellHosts(shell);
  assert.equal(shellHostsChanged(hosts, shell), false);
  shell.windows = shell.windows.filter((window) => window.id !== 4);
  assert.equal(shellHostsChanged(hosts, shell), true);
  shell.windows = [{ id: 30, className: 'Progman', parent: 0, process: 11 }];
  assert.equal(shellHostsChanged(hosts, shell), true);
});
