import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { DesktopControlSwitches } from '../../src/core/desktopControl/switches.ts';
import { makeTempHome } from '../support/harness.ts';

/** SPEC-006 BDC-03 (P0 decision): the per-conversation switch store, `desktop-control.json`. */

test('the switch store is versioned, atomic, fails closed and never overwrites a newer file', () => {
  const home = makeTempHome('cats-desktop-switches-');
  try {
    const file = join(home.botsHome, 'desktop-control.json');
    const switches = new DesktopControlSwitches(file);
    assert.deepEqual(switches.list(), [], 'a missing file means every switch is off');
    assert.equal(switches.set('conv-1', true), true);
    assert.equal(switches.set('conv-1', true), false);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 1, conversations: ['conv-1'] });
    assert.equal(new DesktopControlSwitches(file).isEnabled('conv-1'), true);
    switches.set('conv-1', false);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 1, conversations: [] });

    writeFileSync(file, '{ torn');
    const warnings: string[] = [];
    const corrupt = new DesktopControlSwitches(file, (line) => warnings.push(line));
    assert.deepEqual(corrupt.list(), []);
    assert.equal(warnings.length, 1);
    corrupt.set('conv-2', true);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 1, conversations: ['conv-2'] });

    const future = '{"version":2,"conversations":["conv-3"],"more":true}';
    writeFileSync(file, future);
    const newer = new DesktopControlSwitches(file);
    assert.equal(newer.isEnabled('conv-3'), false);
    assert.throws(() => newer.set('conv-3', true), /newer Bot/u);
    assert.equal(readFileSync(file, 'utf8'), future);
  } finally { home.cleanup(); }
});
