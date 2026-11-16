import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import {
  applyHubLanguage,
  applyProfilePatch,
  createProfile,
  effectiveReplyLanguage,
  HEARTBEAT_DEFAULTS,
  loadProfile,
  normalizeProfile,
  saveProfile,
} from '../../src/core/profile/profile.ts';
import { initializeBot, readBotProfile } from '../../src/core/profile/initialize.ts';
import { botPathsFor } from '../../src/core/store/paths.ts';
import { makeTempHome, type TempHome } from '../support/harness.ts';

let home: TempHome;
before(() => {
  home = makeTempHome('cats-bot-profile-');
});
after(() => home.cleanup());

const now = new Date('2026-10-27T10:00:00.000Z');

test('a profile from before the choice of look shows the default Cat and is not rewritten (SPEC-008 FR-29)', () => {
  const paths = botPathsFor(`${home.botsHome}/old-look`);
  mkdirSync(paths.root, { recursive: true });
  const profile = createProfile({ id: 'old-look', name: 'Bot', provider: 'claude', cwd: paths.root, now });
  assert.equal(profile.avatar, 'ginger');
  for (const stored of [undefined, 'dragon', 7, null]) {
    const text = JSON.stringify({ ...profile, avatar: stored });
    writeFileSync(paths.profile, text);
    // The way a core opens its profile, which may write when it upgrades one.
    const loaded = loadProfile(paths, profile, true);
    assert.ok(loaded.ok);
    assert.equal(loaded.profile.avatar, 'ginger');
    assert.equal(readFileSync(paths.profile, 'utf8'), text);
  }
  writeFileSync(paths.profile, JSON.stringify({ ...profile, avatar: 'siamese' }));
  const chosen = loadProfile(paths, profile);
  assert.ok(chosen.ok);
  assert.equal(chosen.profile.avatar, 'siamese');
});

test('changing the look replaces no session and refuses what is not a look (SPEC-008 FR-29)', () => {
  const profile = createProfile({ id: 'look', name: 'Bot', provider: 'claude', cwd: home.root, now });
  const changed = applyProfilePatch(profile, { avatar: 'tuxedo' }, now);
  assert.equal(changed.profile.avatar, 'tuxedo');
  assert.equal(changed.profile.configRevision, profile.configRevision);
  assert.equal(changed.sessionChanged, false);
  assert.equal(applyProfilePatch(changed.profile, { name: 'Renamed' }, now).profile.avatar, 'tuxedo', 'another change keeps it');
  assert.throws(() => applyProfilePatch(profile, { avatar: 'dragon' as never }, now), /avatar/u);
});

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

test('a heartbeat written before SPEC-011 reads as auto on Desktop\'s rhythm, and changes follow Desktop\'s rules', () => {
  const fallback = createProfile({ id: 'b1', name: 'Bot', provider: 'claude', cwd: 'C:/work', now });
  const old = normalizeProfile(
    { ...fallback, heartbeat: { enabled: false, wakeMinMinutes: 2, wakeMaxMinutes: 10, regularMinMinutes: 30, regularMaxMinutes: 120 } },
    fallback,
  );
  assert.deepEqual(old.heartbeat, { ...HEARTBEAT_DEFAULTS, enabled: false });
  assert.equal(old.heartbeat.mode, 'auto');
  assert.deepEqual([old.heartbeat.bedtime, old.heartbeat.wakeWindowStart, old.heartbeat.wakeWindowEnd], ['23:00', '07:00', '09:00']);
  const damaged = normalizeProfile({ ...fallback, heartbeat: { ...fallback.heartbeat, mode: 'chatty', bedtime: '25:00' } }, fallback);
  assert.equal(damaged.heartbeat.mode, 'auto');
  assert.equal(damaged.heartbeat.bedtime, '23:00');

  const assist = applyProfilePatch(fallback, { heartbeat: { mode: 'assist', bedtime: '00:30', wakeWindowStart: '06:00', wakeWindowEnd: '08:00' } }, now);
  assert.equal(assist.profile.heartbeat.mode, 'assist');
  assert.equal(assist.profile.heartbeat.bedtime, '00:30');
  assert.equal(assist.profile.configRevision, fallback.configRevision, 'the heartbeat is not a session setting');
  assert.throws(() => applyProfilePatch(fallback, { heartbeat: { mode: 'chatty' as never } }, now), /auto, assist or companion/u);
  assert.throws(() => applyProfilePatch(fallback, { heartbeat: { bedtime: '7pm' } }, now), /bedtime must be HH:MM/u);
  assert.throws(() => applyProfilePatch(fallback, { heartbeat: { bedtime: '08:00' } }, now), /bedtime must fall outside the wake window/u);
  assert.throws(() => applyProfilePatch(fallback, { heartbeat: { wakeWindowEnd: '06:00' } }, now), /must not end before it starts/u);
  const handEdited = { ...fallback, heartbeat: { ...fallback.heartbeat, bedtime: '08:00' } };
  assert.equal(applyProfilePatch(handEdited, { heartbeat: { enabled: false } }, now).profile.heartbeat.enabled, false,
    'pausing never fails over times it did not change');
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

test('a tool allowlist is upgraded once to asking first, keeping a read-only filespace read-only (ADR-030)', () => {
  const base = createProfile({ id: 'list', name: 'List', provider: 'claude', cwd: 'C:/work', now });
  const stored = (provider: string, permissions: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ ...base, executionTarget: { provider, model: null }, configRevision: 3, providerPolicy: null,
      permissions: { workspaceAccess: 'read_write', permissionMode: 'whitelist', allowedTools: ['Read', 'Grep'], cwd: 'C:/work', ...permissions }, ...extra });
  const asks = (approval: string) => ({ version: 1, mode: 'explicit', access: 'full-access', network: true, approval });
  const cases: Array<[string, string, Record<string, unknown>, Record<string, unknown>, unknown, string, number]> = [
    ['claude asks first', 'claude', {}, {}, asks('on-request'), 'read_write', 4],
    ['codex asks first', 'codex', {}, {}, asks('untrusted'), 'read_write', 4],
    ['claude stays read-only', 'claude', { workspaceAccess: 'read_only' }, {}, null, 'read_only', 4],
    ['codex stays read-only', 'codex', { workspaceAccess: 'read_only' }, {}, null, 'read_only', 4],
    ['grok keeps its default', 'grok', {}, {}, null, 'read_write', 4],
    ['a list beside another mode is only dropped', 'codex', { permissionMode: 'skip' }, {}, null, 'read_write', 3],
    ['a version 1 profile moves too', 'claude', {}, { schemaVersion: 1 }, asks('on-request'), 'read_write', 4],
  ];
  for (const [name, provider, permissions, extra, policy, access, revision] of cases) {
    const paths = botPathsFor(`${home.botsHome}/allowlist-${name.replaceAll(' ', '-')}`);
    mkdirSync(paths.root, { recursive: true });
    const original = stored(provider, permissions, extra);
    writeFileSync(paths.profile, original);
    const peek = loadProfile(paths, base);
    assert.ok(peek.ok, name);
    assert.equal(readFileSync(paths.profile, 'utf8'), original, `${name}: reading alone writes nothing`);
    const loaded = loadProfile(paths, base, true);
    assert.ok(loaded.ok, name);
    const profile = loaded.profile;
    assert.deepEqual(profile.providerPolicy, policy, name);
    assert.equal(profile.permissions.workspaceAccess, access, name);
    assert.equal(profile.permissions.permissionMode, permissions.permissionMode === 'skip' ? 'skip' : 'default', name);
    assert.equal(Object.hasOwn(profile.permissions, 'allowedTools'), false, name);
    assert.equal(profile.configRevision, revision, `${name}: sessions made with the list are replaced`);
    const written = JSON.parse(readFileSync(paths.profile, 'utf8'));
    assert.equal(written.permissions.permissionMode === 'whitelist' || 'allowedTools' in written.permissions, false, name);
    assert.equal(readFileSync(extra.schemaVersion === 1 ? `${paths.profile}.v1.bak` : `${paths.profile}.allowlist.bak`, 'utf8'), original, name);
    const again = readFileSync(paths.profile, 'utf8');
    assert.ok(loadProfile(paths, base, true).ok);
    assert.equal(readFileSync(paths.profile, 'utf8'), again, `${name}: upgraded once`);
  }
});

test('an allowlist written again by an older Bot is upgraded again, keeping both copies (ADR-030)', () => {
  const paths = botPathsFor(`${home.botsHome}/allowlist-twice`);
  mkdirSync(paths.root, { recursive: true });
  const base = createProfile({ id: 'twice', name: 'Twice', provider: 'codex', cwd: 'C:/work', now });
  const first = JSON.stringify({ ...base, permissions: { ...base.permissions, permissionMode: 'whitelist', allowedTools: ['Read'] } });
  writeFileSync(paths.profile, first);
  assert.ok(loadProfile(paths, base, true).ok);
  const second = JSON.stringify({ ...base, permissions: { ...base.permissions, permissionMode: 'whitelist', allowedTools: ['Grep'] } });
  writeFileSync(paths.profile, second);
  const loaded = loadProfile(paths, base, true);
  assert.ok(loaded.ok, 'a different earlier copy never stops the bot');
  assert.equal(readFileSync(`${paths.profile}.allowlist.bak`, 'utf8'), first);
  const copies = readdirSync(paths.root).filter((file) => /^profile\.json\.allowlist\.\d+\.bak$/u.test(file));
  assert.equal(copies.length, 1);
  assert.equal(readFileSync(join(paths.root, copies[0]!), 'utf8'), second);
});

test('a malformed allowlist profile is left as it was, with no copy (ADR-030)', () => {
  const base = createProfile({ id: 'bad-list', name: 'Bad', provider: 'claude', cwd: 'C:/work', now });
  const cases: Array<[string, Record<string, unknown>]> = [
    ['tools not a list', { allowedTools: 'Read' }],
    ['a tool not a string', { allowedTools: [1] }],
    ['no working directory', { cwd: undefined }],
    ['an unknown filespace', { workspaceAccess: 'everywhere' }],
  ];
  for (const [name, permissions] of cases) {
    const paths = botPathsFor(`${home.botsHome}/bad-list-${name.replaceAll(' ', '-')}`);
    mkdirSync(paths.root, { recursive: true });
    const original = JSON.stringify({ ...base, permissions: { workspaceAccess: 'read_write', permissionMode: 'whitelist',
      allowedTools: ['Read'], cwd: 'C:/work', ...permissions } });
    writeFileSync(paths.profile, original);
    const loaded = loadProfile(paths, base, true);
    assert.equal(loaded.ok, false, name);
    assert.equal(loaded.ok ? null : loaded.reason, 'corrupt', name);
    assert.equal(readFileSync(paths.profile, 'utf8'), original, `${name}: the original stays`);
    assert.deepEqual(readdirSync(paths.root).filter((file) => file.endsWith('.bak')), [], `${name}: no copy is made`);
  }
});

test('an allowlist upgrade stopped after its copy finishes on the next start, with no second copy (ADR-030)', () => {
  const paths = botPathsFor(`${home.botsHome}/allowlist-interrupted`);
  mkdirSync(paths.root, { recursive: true });
  const base = createProfile({ id: 'stopped', name: 'Stopped', provider: 'claude', cwd: 'C:/work', now });
  const original = JSON.stringify({ ...base, permissions: { ...base.permissions, permissionMode: 'whitelist', allowedTools: ['Read'] } });
  writeFileSync(paths.profile, original);
  // The copy was made and the profile not yet replaced.
  writeFileSync(`${paths.profile}.allowlist.bak`, original);
  const loaded = loadProfile(paths, base, true);
  assert.ok(loaded.ok);
  assert.equal(loaded.profile.permissions.permissionMode, 'default');
  assert.equal(JSON.parse(readFileSync(paths.profile, 'utf8')).permissions.permissionMode, 'default');
  assert.equal(readFileSync(`${paths.profile}.allowlist.bak`, 'utf8'), original);
  assert.deepEqual(readdirSync(paths.root).filter((file) => file.endsWith('.bak')), ['profile.json.allowlist.bak']);
});

test('nothing writes an allowlist any more (ADR-030)', () => {
  const profile = createProfile({ id: 'w', name: 'W', provider: 'claude', cwd: 'C:/work', now });
  assert.throws(() => applyProfilePatch(profile, { permissions: { permissionMode: 'whitelist' as never } }, now), /default or skip/u);
  assert.throws(() => applyProfilePatch(profile, { permissions: { allowedTools: ['Read'] } as never }, now), /no longer supported/u);
  assert.throws(() => createProfile({ name: 'W', provider: 'claude', cwd: 'C:/work', permissionMode: 'whitelist' as never }), /default or skip/u);
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

test('live progress details are off by default and when absent, and turning them on never bumps the revision (SPEC-003 FR-12)', () => {
  const profile = createProfile({ id: 'b1', name: 'Bot', provider: 'claude', cwd: 'C:/work', now });
  assert.equal(profile.showProgressDetails, false);

  const on = applyProfilePatch(profile, { showProgressDetails: true }, now);
  assert.equal(on.profile.showProgressDetails, true);
  assert.equal(on.sessionChanged, false, 'not a session setting: only how the notes draw a reply');
  assert.equal(on.profile.configRevision, profile.configRevision);
  assert.equal(applyProfilePatch(on.profile, { name: 'Renamed' }, now).profile.showProgressDetails, true, 'other edits keep it');
  assert.throws(() => applyProfilePatch(profile, { showProgressDetails: 'yes' as unknown as boolean }, now), /true or false/u);

  // A profile written before the setting, or by an older Bot that drops it, reads as off.
  const { showProgressDetails: _dropped, ...older } = on.profile;
  assert.equal(normalizeProfile(older, on.profile).showProgressDetails, false);
  assert.equal(normalizeProfile({ ...older, showProgressDetails: 1 }, on.profile).showProgressDetails, false);
  assert.equal(normalizeProfile({ ...older, showProgressDetails: true }, profile).showProgressDetails, true);
});

test('verbose messages are off by default and when absent, and turning them on never bumps the revision (SPEC-003 FR-14)', () => {
  const profile = createProfile({ id: 'b1', name: 'Bot', provider: 'claude', cwd: 'C:/work', now });
  assert.equal(profile.showVerboseMessages, false);
  const on = applyProfilePatch(profile, { showVerboseMessages: true }, now);
  assert.equal(on.profile.showVerboseMessages, true);
  assert.equal(on.sessionChanged, false);
  assert.equal(on.profile.configRevision, profile.configRevision);
  assert.equal(on.profile.showProgressDetails, false, 'the two switches are apart');
  assert.throws(() => applyProfilePatch(profile, { showVerboseMessages: 1 as unknown as boolean }, now), /true or false/u);
  const { showVerboseMessages: _dropped, ...older } = on.profile;
  assert.equal(normalizeProfile(older, on.profile).showVerboseMessages, false);
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

test('a bot follows the hub reply language by default, and an older writer reads as following it (SPEC-008 FR-28)', () => {
  const profile = createProfile({ name: 'Mochi', provider: 'claude', cwd: 'C:/work' });
  assert.equal(profile.replyLanguage, 'hub');
  assert.equal(profile.hubLanguage, null);
  assert.equal(effectiveReplyLanguage(profile), null);
  const { replyLanguage: _r, hubLanguage: _h, ...older } = profile;
  const read = normalizeProfile(older, profile);
  assert.equal(read.replyLanguage, 'hub');
  assert.equal(read.hubLanguage, null);
  const odd = normalizeProfile({ ...profile, replyLanguage: 'klingon', hubLanguage: { reply: 'xx', display: 'en' } }, profile);
  assert.equal(odd.replyLanguage, 'hub');
  assert.equal(odd.hubLanguage, null);
  const kept = normalizeProfile({ ...profile, replyLanguage: 'ko', hubLanguage: { reply: null, display: 'zh-TW' } }, profile);
  assert.equal(kept.replyLanguage, 'ko');
  assert.deepEqual(kept.hubLanguage, { reply: null, display: 'zh-TW' });
});

test('only a change in the language sessions are told bumps the revision (SPEC-008 FR-28)', () => {
  const now = new Date('2026-11-01T00:00:00Z');
  const base = createProfile({ name: 'Mochi', provider: 'claude', cwd: 'C:/work' });

  const reported = applyHubLanguage(base, { reply: 'ja', display: 'en' }, now)!;
  assert.equal(reported.sessionChanged, true);
  assert.equal(reported.replyLanguageOnly, true);
  assert.equal(reported.profile.configRevision, base.configRevision + 1);
  assert.equal(effectiveReplyLanguage(reported.profile), 'ja');
  assert.equal(applyHubLanguage(reported.profile, { reply: 'ja', display: 'en' }, now), null, 'the same report');

  // The display language matters only to a bot that follows it.
  const display = applyHubLanguage(reported.profile, { reply: 'ja', display: 'zh-TW' }, now)!;
  assert.equal(display.sessionChanged, false);
  assert.equal(display.profile.configRevision, reported.profile.configRevision);
  const follows = applyProfilePatch(display.profile, { replyLanguage: 'display' }, now);
  assert.equal(follows.sessionChanged, true);
  assert.equal(follows.replyLanguageOnly, true);
  assert.equal(effectiveReplyLanguage(follows.profile), 'zh-TW');

  // Choosing what the bot already gets is not a session change.
  const same = applyProfilePatch(reported.profile, { replyLanguage: 'ja' }, now);
  assert.equal(same.sessionChanged, false);
  assert.equal(same.profile.replyLanguage, 'ja');

  // With other session settings in the same save, the notice is the general one.
  const mixed = applyProfilePatch(reported.profile, { replyLanguage: 'unspecified', instructions: 'Be brief.' }, now);
  assert.equal(mixed.sessionChanged, true);
  assert.equal(mixed.replyLanguageOnly, false);
  assert.equal(effectiveReplyLanguage(mixed.profile), null);

  assert.throws(() => applyProfilePatch(base, { replyLanguage: 'klingon' as never }, now), /replyLanguage/u);
});

test('a new bot works in its own filespace; a bot made before keeps the folder its profile names', () => {
  const temp = makeTempHome('cats-bot-filespace-');
  try {
    const { profile, root } = initializeBot(temp.botsHome, { id: 'fresh', name: 'Fresh', provider: 'claude' });
    assert.equal(profile.permissions.cwd, join(root, 'filespace'));
    assert.equal(existsSync(join(root, 'filespace')), true);
    assert.equal(existsSync(join(root, 'workspace')), false);
    // No migration: an older bot's stored `workspace` folder stays its working folder.
    const older = botPathsFor(join(temp.botsHome, 'older'));
    mkdirSync(older.root, { recursive: true });
    saveProfile(older, createProfile({ id: 'older', name: 'Older', provider: 'claude', cwd: join(older.root, 'workspace') }));
    assert.equal(readBotProfile(older.root)?.permissions.cwd, join(older.root, 'workspace'));
  } finally {
    temp.cleanup();
  }
});
