import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { hasSetupDraft, parseSetupDraft, takeSetupDraft, writeSetupDraft } from '../../src/shell/electron/setupDraft.ts';

function home(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'cats-bot-draft-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const draft = { name: 'Mochi', instructions: 'Be kind.', provider: 'claude', avatar: 'calico' };

test('a draft survives until it is read, once (SPEC-010 FR-13)', (t) => {
  const root = home(t);
  assert.equal(hasSetupDraft(root), false);
  assert.equal(takeSetupDraft(root), null);
  assert.equal(writeSetupDraft(root, draft), true);
  assert.equal(hasSetupDraft(root), true);
  assert.deepEqual(takeSetupDraft(root), draft);
  assert.equal(hasSetupDraft(root), false, 'read once and removed');
  assert.equal(takeSetupDraft(root), null);
});

test('a draft follows the same rule as the page, on the way in and on the way out', (t) => {
  const root = home(t);
  const hidden = String.fromCodePoint(0xE0068);
  for (const bad of [
    null,
    'text',
    { ...draft, name: '' },
    { ...draft, name: 'a\nb' },
    { ...draft, name: 'x'.repeat(41) },
    { ...draft, instructions: `Be kind.${hidden}` },
    { ...draft, instructions: 'x'.repeat(4_001) },
    { ...draft, provider: 'calc.exe' },
    { ...draft, provider: 'constructor' },
  ]) {
    assert.equal(parseSetupDraft(bad), null, JSON.stringify(bad));
    assert.equal(writeSetupDraft(root, bad), false);
  }
  assert.equal(hasSetupDraft(root), false, 'nothing was written');
  // A look it does not know is dropped alone; the rest of the input is still the owner's.
  assert.deepEqual(parseSetupDraft({ ...draft, avatar: '../evil' }), { name: 'Mochi', instructions: 'Be kind.', provider: 'claude' });
  // A file edited outside the app is held to the rule, and does not come back.
  writeFileSync(join(root, 'setup-draft.json'), JSON.stringify({ ...draft, name: 'a\nb' }));
  assert.equal(takeSetupDraft(root), null);
  assert.equal(existsSync(join(root, 'setup-draft.json')), false);
  writeFileSync(join(root, 'setup-draft.json'), '{not json');
  assert.equal(takeSetupDraft(root), null);
  assert.equal(existsSync(join(root, 'setup-draft.json')), false);
});
