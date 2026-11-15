import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

/**
 * SPEC-003 FR-11: clickable controls take the cat's paw, except on macOS, where the system showed only the
 * paw's top-left quarter on a Retina screen. The shared preload marks the root element with the platform and
 * `paw.css` keys the system pointing hand to that mark.
 */
const root = resolve(import.meta.dirname, '..', '..');
const preloadSource = readFileSync(join(root, 'assets', 'preload.cjs'), 'utf8');
const pawCss = readFileSync(join(root, 'src', 'renderer', 'paw.css'), 'utf8');

interface FakeRoot { attributes: Map<string, string>; setAttribute(name: string, value: string): void }

function fakeRoot(): FakeRoot {
  const attributes = new Map<string, string>();
  return { attributes, setAttribute: (name, value) => { attributes.set(name, value); } };
}

/** Runs the preload as Electron would, with the root element present from the start or added later. */
function runPreload(platform: string, rootAtStart: boolean) {
  const listeners: Array<{ type: string; listener: () => void }> = [];
  const document = {
    documentElement: rootAtStart ? fakeRoot() : null as FakeRoot | null,
    addEventListener(type: string, listener: () => void) { listeners.push({ type, listener }); },
  };
  const ipcRenderer = { invoke: async () => undefined, on() {}, removeListener() {}, send() {} };
  const electron = { contextBridge: { exposeInMainWorld() {} }, ipcRenderer };
  const globals = {
    require: (name: string) => { assert.equal(name, 'electron'); return electron; },
    process: { platform },
    document,
    location: { search: '?conversation=home' },
    URLSearchParams,
  };
  runInNewContext(preloadSource, { ...globals, globalThis: globals });
  return { document, listeners };
}

test('the preload marks the root element with the platform at once', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const { document } = runPreload(platform, true);
    assert.equal(document.documentElement?.attributes.get('data-platform'), platform);
  }
});

test('the preload marks a root element that did not exist yet once the document is parsed', () => {
  const { document, listeners } = runPreload('darwin', false);
  const later = listeners.filter(({ type }) => type === 'readystatechange');
  assert.equal(later.length, 1);
  document.documentElement = fakeRoot();
  later[0]!.listener();
  assert.equal(document.documentElement.attributes.get('data-platform'), 'darwin');
});

test('macOS keeps the system pointing hand; other systems keep the paw', () => {
  const declarations = (selector: string) => {
    const start = pawCss.indexOf(`${selector} {`);
    assert.notEqual(start, -1, `${selector} has a rule`);
    return pawCss.slice(start, pawCss.indexOf('}', start));
  };
  assert.match(declarations(':root'), /--paw-cursor:\s*url\("data:image\/svg\+xml,[^"]+"\) 12 4, pointer;/u);
  assert.match(declarations(':root[data-platform="darwin"]'), /--paw-cursor:\s*pointer;/u);
});
