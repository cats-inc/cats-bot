import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { BRIDGE_COMMANDS, BRIDGE_NOTE_LAYERS } from '../../src/renderer/bridge.ts';
import { HOST_COMMANDS } from '../../src/shell/electron/ipc.ts';
import { NOTE_LAYERS } from '../../src/shell/electron/viewState.ts';

/**
 * ADR-003: the renderer types `window.catsBot` in `src/renderer/bridge.ts`;
 * the shell implements it in `ipc.ts` and `assets/preload.cjs`. A command or
 * layer added on one side only fails here instead of in a click.
 */

test('the renderer bridge lists the same host commands as the shell', () => {
  assert.deepEqual([...BRIDGE_COMMANDS].sort(), [...HOST_COMMANDS].sort());
});

test('the renderer bridge knows the same note layers as the shell', () => {
  assert.deepEqual([...BRIDGE_NOTE_LAYERS], [...NOTE_LAYERS]);
});

test('every bridge namespace method exists in the preload script', () => {
  const preload = readFileSync(join(resolve(import.meta.dirname, '..', '..'), 'assets', 'preload.cjs'), 'utf8');
  const bridge = readFileSync(join(resolve(import.meta.dirname, '..', '..'), 'src', 'renderer', 'bridge.ts'), 'utf8');
  const interfaceBody = bridge.slice(bridge.indexOf('export interface CatsBotBridge {'));
  const methods = [...interfaceBody.matchAll(/^\s{4}(\w+)\(/gmu)].map((match) => match[1]!);
  assert.ok(methods.length > 20, `found only ${methods.length} bridge methods`);
  const missing = methods.filter((name) => !new RegExp(`^\\s+${name}\\(`, 'mu').test(preload));
  assert.deepEqual(missing, []);
});
