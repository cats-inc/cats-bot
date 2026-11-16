import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeGrants, grantCategoryText, STANDING_GRANT_MINUTES } from '../../src/renderer/interactions/grantText.ts';

test('the note shows only grants still in force, and names each kind of action (ADR-027)', () => {
  const now = Date.parse('2026-11-16T10:00:00.000Z');
  const grants = [
    { category: 'computer_use' as const, until: 'session' as const, grantedAt: '2026-11-16T09:00:00.000Z' },
    { category: 'command' as const, until: 'time' as const, grantedAt: '2026-11-16T09:40:00.000Z', expiresAt: '2026-11-16T10:10:00.000Z' },
    { category: 'file' as const, until: 'time' as const, grantedAt: '2026-11-16T09:00:00.000Z', expiresAt: '2026-11-16T09:30:00.000Z' },
  ];
  assert.deepEqual(activeGrants(grants, now).map((grant) => grant.category), ['computer_use', 'command']);
  assert.deepEqual(activeGrants(undefined, now), []);
  assert.equal(grantCategoryText('computer_use'), 'operate the desktop');
  assert.equal(grantCategoryText('command'), 'run commands');
  assert.equal(grantCategoryText('file'), 'change files');
  assert.equal(STANDING_GRANT_MINUTES, 30);
});
