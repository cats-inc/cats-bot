import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { after, before, test } from 'node:test';

import {
  applyProfilePatch,
  createProfile,
  HEARTBEAT_DEFAULTS,
  loadProfile,
  normalizeProfile,
  saveProfile,
} from '../../src/core/profile/profile.ts';
import { botPathsFor } from '../../src/core/store/paths.ts';
import { makeTempHome, type TempHome } from '../support/harness.ts';

let home: TempHome;
before(() => {
  home = makeTempHome('cats-bot-profile-');
});
after(() => home.cleanup());

const now = new Date('2026-10-27T10:00:00.000Z');

test('catalog selection and controls survive restart and changing effort invalidates the session', () => {
  const paths = botPathsFor(`${home.botsHome}/selection`);
  mkdirSync(paths.root, { recursive: true });
  const selection = {
    entryMode: 'explicit' as const,
    entryId: 'gpt-6.1-sol',
    catalogRevision: 'factory:fixture',
    controls: { 'codex.reasoning_effort': 'high' },
  };
  const profile = createProfile({
    id: 'selection',
    name: 'Bot',
    provider: 'codex',
    model: selection.entryId,
    modelSelection: selection,
    cwd: paths.root,
    now,
  });
  saveProfile(paths, profile);
  const loaded = loadProfile(paths, profile);
  assert.ok(loaded.ok);
  assert.deepEqual(loaded.profile.executionTarget.modelSelection, selection);
  const rename = applyProfilePatch(loaded.profile, { name: 'Renamed' }, now);
  assert.equal(rename.sessionChanged, false);
  assert.deepEqual(rename.profile.executionTarget, profile.executionTarget);
  const changed = applyProfilePatch(
    profile,
    {
      executionTarget: {
        ...profile.executionTarget,
        modelSelection: { ...selection, controls: { 'codex.reasoning_effort': 'max' } },
      },
    },
    now,
  );
  assert.equal(changed.sessionChanged, true);
  assert.equal(changed.providerChanged, false);
  assert.equal(changed.profile.configRevision, profile.configRevision + 1);
  const same = applyProfilePatch(
    changed.profile,
    { executionTarget: { provider: 'codex', model: selection.entryId } },
    now,
  );
  assert.equal(
    same.sessionChanged,
    false,
    'an older caller omitting the selection does not erase saved effort',
  );
  const provider = applyProfilePatch(
    changed.profile,
    { executionTarget: { provider: 'claude', model: 'opus' } },
    now,
  );
  assert.equal(
    provider.profile.executionTarget.modelSelection,
    undefined,
    'old provider controls never bleed into a new target',
  );
});

test('legacy providers, null models and custom model IDs remain unchanged on unrelated saves', () => {
  for (const provider of ['codex', 'copilot', 'custom-cli'])
    for (const model of [null, 'private-model']) {
      const profile = createProfile({
        id: 'old',
        name: 'Bot',
        provider,
        model,
        cwd: 'C:/work',
        now,
      });
      const saved = applyProfilePatch(profile, { name: 'New name' }, now);
      assert.deepEqual(saved.profile.executionTarget, { provider, model });
      assert.equal(saved.sessionChanged, false);
    }
});

test('createProfile applies the SPEC-001 FR-1 defaults', () => {
  const profile = createProfile({ id: 'b1', name: 'Bot', provider: 'claude', cwd: 'C:/work', now });
  assert.equal(profile.schemaVersion, 2);
  assert.equal(profile.providerPolicy, null);
  assert.equal(profile.configRevision, 1);
  assert.deepEqual(profile.executionTarget, { provider: 'claude', model: null });
  assert.deepEqual(profile.heartbeat, HEARTBEAT_DEFAULTS);
  assert.equal(profile.idleSleepMinutes, 15);
  assert.equal(profile.permissions.permissionMode, 'default');
  assert.equal(profile.permissions.workspaceAccess, 'read_write');
  assert.equal(profile.updatedAt, now.toISOString());
});

test('normalizeProfile fills every missing or invalid field from the fallback (FR-4)', () => {
  const fallback = createProfile({ id: 'b1', name: 'Bot', provider: 'claude', cwd: 'C:/work', now });
  const normalized = normalizeProfile(
    {
      id: 'kept',
      name: 42,
      executionTarget: { provider: 'codex', model: 7 },
      heartbeat: { enabled: 'yes', wakeMinMinutes: 20, wakeMaxMinutes: 5 },
      permissions: { permissionMode: 'everything', cwd: 'D:/elsewhere' },
      configRevision: -3,
      idleSleepMinutes: 'soon',
    },
    fallback,
  );
  assert.equal(normalized.id, 'kept');
  assert.equal(normalized.name, 'Bot');
  assert.deepEqual(normalized.executionTarget, { provider: 'codex', model: null });
  assert.equal(normalized.heartbeat.enabled, true);
  assert.equal(normalized.heartbeat.wakeMinMinutes, 20);
  assert.equal(normalized.heartbeat.wakeMaxMinutes, 20, 'max is lifted to min');
  assert.equal(normalized.permissions.permissionMode, 'default');
  assert.equal(normalized.permissions.cwd, 'D:/elsewhere');
  assert.equal(normalized.configRevision, 1);
  assert.equal(normalized.idleSleepMinutes, 15);
});

test('loadProfile protects unknown and corrupt data instead of replacing it with defaults', () => {
  const paths = botPathsFor(`${home.botsHome}/load`);
  const fallback = createProfile({ id: 'load', name: 'Bot', provider: 'claude', cwd: 'C:/work', now });
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.profile, '{"id":"load","name":"Partial"}\n');
  const loaded = loadProfile(paths, fallback);
  assert.equal(loaded.ok, false);
  assert.equal(readFileSync(paths.profile, 'utf8'), '{"id":"load","name":"Partial"}\n');

  writeFileSync(paths.profile, '{not json');
  const corrupt = loadProfile(paths, fallback);
  assert.equal(corrupt.ok, false);
  assert.equal(!corrupt.ok && corrupt.reason, 'corrupt');
  assert.equal(readFileSync(paths.profile, 'utf8'), '{not json');

  saveProfile(paths, fallback);
  const saved = loadProfile(paths, fallback);
  assert.ok(saved.ok && saved.profile.id === 'load');
});

test('v1 upgrade preserves legacy permissions, backs up original bytes and replaces atomically', () => {
  const paths = botPathsFor(`${home.botsHome}/upgrade`);
  mkdirSync(paths.root, { recursive: true });
  const current = createProfile({ id: 'old', name: 'Old', provider: 'codex', cwd: 'C:/work', permissionMode: 'skip' });
  const { providerPolicy: _policy, ...old } = current;
  const original = JSON.stringify({ ...old, schemaVersion: 1 });
  writeFileSync(paths.profile, original);
  assert.ok(loadProfile(paths, current).ok, 'read-only inspection can project the old shape');
  assert.equal(readFileSync(paths.profile, 'utf8'), original, 'read-only inspection never migrates');
  const loaded = loadProfile(paths, current, true);
  assert.ok(loaded.ok);
  assert.equal(loaded.profile.providerPolicy, null);
  assert.equal(loaded.profile.permissions.permissionMode, 'skip');
  assert.equal(loaded.profile.configRevision, 1);
  assert.equal(readFileSync(`${paths.profile}.v1.bak`, 'utf8'), original);
  assert.equal(JSON.parse(readFileSync(paths.profile, 'utf8')).schemaVersion, 2);
  assert.ok(loadProfile(paths, current).ok);
  writeFileSync(paths.profile, JSON.stringify({ ...current, schemaVersion: 99 }));
  assert.equal(loadProfile(paths, current).ok, false, 'unknown primary never recovers from an older backup');
});

test('failed upgrade preserves original and backup; invalid policy cannot widen a boundary', () => {
  const paths = botPathsFor(`${home.botsHome}/failed-upgrade`);
  mkdirSync(paths.root, { recursive: true });
  const current = createProfile({ id: 'old', name: 'Old', provider: 'codex', cwd: 'C:/work' });
  const original = JSON.stringify({ ...current, schemaVersion: 1 });
  writeFileSync(paths.profile, original);
  writeFileSync(`${paths.profile}.v1.bak`, 'different backup');
  assert.equal(loadProfile(paths, current, true).ok, false);
  assert.equal(readFileSync(paths.profile, 'utf8'), original);
  assert.equal(readFileSync(`${paths.profile}.v1.bak`, 'utf8'), 'different backup');
  assert.throws(() => applyProfilePatch(current, { providerPolicy: { version: 2 } as never }, now));
  const policy = { version: 1, mode: 'explicit', access: 'workspace-write', network: false, approval: 'on-request' } as const;
  const next = applyProfilePatch(current, { providerPolicy: policy }, now);
  assert.equal(next.profile.configRevision, 2);
  assert.throws(() => applyProfilePatch(next.profile, { permissions: { workspaceAccess: 'read_only' } }, now));
});

test('applyProfilePatch bumps configRevision only for a real target change (FR-27)', () => {
  const profile = createProfile({ id: 'b1', name: 'Bot', provider: 'claude', model: 'opus', cwd: 'C:/work', now });
  const same = applyProfilePatch(profile, { executionTarget: { provider: 'claude', model: 'opus' } }, now);
  assert.equal(same.targetChanged, false);
  assert.equal(same.profile.configRevision, 1);

  const model = applyProfilePatch(profile, { executionTarget: { provider: 'claude', model: 'sonnet' } }, now);
  assert.equal(model.targetChanged, true);
  assert.equal(model.providerChanged, false);
  assert.equal(model.profile.configRevision, 2);

  const provider = applyProfilePatch(profile, { executionTarget: { provider: 'codex', model: null } }, now);
  assert.equal(provider.providerChanged, true);
  assert.equal(provider.profile.configRevision, 2);

  const renamed = applyProfilePatch(profile, { name: 'Other', heartbeat: { enabled: false } }, now);
  assert.equal(renamed.targetChanged, false);
  assert.equal(renamed.sessionChanged, false);
  assert.equal(renamed.profile.configRevision, 1);
  assert.equal(renamed.profile.name, 'Other');
  assert.equal(renamed.profile.heartbeat.enabled, false);
  assert.equal(renamed.profile.heartbeat.wakeMinMinutes, 2);
});

test('Claude in Chrome restarts the runtime, survives other edits and stays off for older profiles', () => {
  const profile = createProfile({ id: 'b1', name: 'Bot', provider: 'claude', model: 'opus', cwd: 'C:/work', now });
  assert.equal(profile.executionTarget.claudeInChrome, undefined);
  const on = applyProfilePatch(profile, { executionTarget: { provider: 'claude', model: 'opus', claudeInChrome: true } }, now);
  assert.equal(on.providerChanged, true, 'the runtime launches the CLI with --chrome');
  assert.equal(on.profile.configRevision, 2);
  const model = applyProfilePatch(on.profile, { executionTarget: { provider: 'claude', model: 'sonnet' } }, now);
  assert.equal(model.profile.executionTarget.claudeInChrome, true, 'an edit that omits it keeps it');
  assert.equal(model.providerChanged, false);
  const off = applyProfilePatch(on.profile, { executionTarget: { provider: 'claude', model: 'opus', claudeInChrome: false } }, now);
  assert.equal(off.providerChanged, true);
  assert.equal(off.profile.executionTarget.claudeInChrome, undefined);
  const loaded = normalizeProfile({ ...profile, executionTarget: { provider: 'claude', model: 'opus' } }, profile);
  assert.equal(loaded.executionTarget.claudeInChrome, undefined);
});

test('applyProfilePatch bumps configRevision for instructions, permissions and cwd too (FR-27)', () => {
  const profile = createProfile({ id: 'b1', name: 'Bot', provider: 'claude', cwd: 'C:/work', now });
  for (const patch of [
    { instructions: 'You are Kettle.' },
    { permissions: { workspaceAccess: 'read_only' as const } },
    { permissions: { permissionMode: 'skip' as const } },
    { permissions: { cwd: 'C:/elsewhere' } },
    { permissions: { allowedTools: ['Read'] } },
  ]) {
    const result = applyProfilePatch(profile, patch, now);
    assert.equal(result.sessionChanged, true, JSON.stringify(patch));
    assert.equal(result.targetChanged, false);
    assert.equal(result.profile.configRevision, 2, JSON.stringify(patch));
  }
  const same = applyProfilePatch(profile, { instructions: '', permissions: { workspaceAccess: 'read_write', cwd: 'C:/work' } }, now);
  assert.equal(same.sessionChanged, false, 'identical values are a no-op');
  assert.equal(same.profile.configRevision, 1);
  const telegram = applyProfilePatch(profile, { telegram: { enabled: true }, idleSleepMinutes: 5 }, now);
  assert.equal(telegram.sessionChanged, false);
});

test('desktop control is off by default, off when absent or invalid, and its patch never bumps the revision (SPEC-006 BDC-02)', () => {
  const profile = createProfile({ id: 'b1', name: 'Bot', provider: 'claude', cwd: 'C:/work', now });
  assert.deepEqual(profile.desktopControl, { enabled: false });

  const on = applyProfilePatch(profile, { desktopControl: { enabled: true } }, now);
  assert.deepEqual(on.profile.desktopControl, { enabled: true });
  assert.equal(on.sessionChanged, false, 'not a session setting: the descriptor follows per send');
  assert.equal(on.profile.configRevision, profile.configRevision);
  assert.deepEqual(applyProfilePatch(on.profile, { name: 'Renamed' }, now).profile.desktopControl, { enabled: true },
    'other edits keep it');
  assert.deepEqual(applyProfilePatch(on.profile, { desktopControl: { enabled: 'yes' as unknown as boolean } }, now).profile.desktopControl,
    { enabled: false }, 'an invalid value is off');

  // A profile rewritten by an older Bot has no field: it reads as off even when the fallback is on.
  const { desktopControl: _dropped, ...older } = on.profile;
  assert.deepEqual(normalizeProfile(older, on.profile).desktopControl, { enabled: false });
  assert.deepEqual(normalizeProfile({ ...older, desktopControl: { enabled: 1 } }, on.profile).desktopControl, { enabled: false });

  const paths = botPathsFor(`${home.botsHome}/desktop-control`);
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.profile, JSON.stringify(older));
  const loaded = loadProfile(paths, on.profile, true);
  assert.ok(loaded.ok && loaded.profile.desktopControl.enabled === false);
  assert.equal(JSON.parse(readFileSync(paths.profile, 'utf8')).desktopControl, undefined, 'schema 2 needs no upgrade step');
  saveProfile(paths, on.profile);
  const saved = loadProfile(paths, profile);
  assert.ok(saved.ok && saved.profile.desktopControl.enabled === true);
  assert.equal(saved.ok && saved.profile.schemaVersion, 2);
});
