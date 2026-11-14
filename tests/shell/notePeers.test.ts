import assert from 'node:assert/strict';
import { test } from 'node:test';

import { notePeers } from '../../src/shell/electron/notePeers.ts';

/** SPEC-003 FR-16, SPEC-012 FR-5: a note gets the faces of the cats it can hear from, and no others. */

const looks: Record<string, { name: string; avatar: 'ginger' | 'tuxedo' | 'calico' }> = {
  boss: { name: 'Boss', avatar: 'ginger' },
  mochi: { name: 'Mochi', avatar: 'tuxedo' },
  tama: { name: 'Tama', avatar: 'calico' },
};
const registry = {
  bots: [
    { id: 'boss', archivedAt: null },
    { id: 'mochi', archivedAt: null },
    { id: 'tama', archivedAt: null },
    { id: 'old', archivedAt: '2026-11-01T00:00:00.000Z' },
  ],
  bossCat: { holder: 'boss' },
};
const profileOf = (id: string) => looks[id] ?? null;

test('the Boss Cat hears from every other active cat', () => {
  assert.deepEqual(notePeers(registry, 'boss', profileOf), [
    { id: 'mochi', name: 'Mochi', avatar: 'tuxedo', bossCat: false },
    { id: 'tama', name: 'Tama', avatar: 'calico', bossCat: false },
  ]);
});

test('any other cat hears only from the Boss Cat, and without a Boss Cat from no one', () => {
  assert.deepEqual(notePeers(registry, 'mochi', profileOf), [{ id: 'boss', name: 'Boss', avatar: 'ginger', bossCat: true }]);
  assert.deepEqual(notePeers({ ...registry, bossCat: { holder: null } }, 'mochi', profileOf), []);
});

test('a profile that cannot be read shows by id, without a face', () => {
  assert.deepEqual(notePeers(registry, 'mochi', () => { throw new Error('corrupt'); }),
    [{ id: 'boss', name: 'boss', avatar: null, bossCat: true }]);
});
