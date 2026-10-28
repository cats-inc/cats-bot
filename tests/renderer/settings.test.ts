import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BotProfile, BotStatus, ConversationRecord, ModelCatalog, ProviderInfo } from '../../src/core/types.ts';
import {
  ago,
  appFacts,
  botForm,
  botPatch,
  CUSTOM_MODEL,
  lifeForm,
  lifePatch,
  modelOptions,
  modelSelection,
  preferredProvider,
  providerChoices,
  providerHint,
  readModel,
  RequestGate,
  saveNotice,
  sortNotes,
  telegramFacts,
} from '../../src/renderer/settings/settingsLogic.ts';

/** SPEC-002 FR-1–FR-6, SPEC-003 FR-6: the settings and first-run decisions, apart from React. */

const PROFILE: BotProfile = {
  schemaVersion: 2,
  providerPolicy: null,
  id: 'nori',
  name: 'Nori',
  instructions: 'Be kind.',
  executionTarget: { provider: 'claude', model: 'haiku' },
  configRevision: 3,
  permissions: { workspaceAccess: 'read_write', permissionMode: 'whitelist', allowedTools: ['Read', 'Grep'], cwd: 'C:/work' },
  heartbeat: { enabled: true, wakeMinMinutes: 2, wakeMaxMinutes: 10, regularMinMinutes: 30, regularMaxMinutes: 120 },
  idleSleepMinutes: 15,
  telegram: { enabled: false, ownerChatId: null },
  updatedAt: '2026-10-28T00:00:00.000Z',
};

const CLAUDE: ModelCatalog = {
  provider: 'claude',
  defaultModel: 'opus',
  models: [{ id: 'opus', label: 'Opus 5.5', default: true }, { id: 'haiku', label: 'Haiku 5.5', default: false }, { id: 'raw', label: 'raw', default: false }],
  source: 'runtime',
};

test('only the newest model request may fill the menu (2026-10-28 review)', () => {
  const gate = new RequestGate();
  const claude = gate.begin();
  const codex = gate.begin();
  assert.equal(gate.isLatest(claude), false, 'the late Claude answer is dropped');
  assert.equal(gate.isLatest(codex), true);
  const again = gate.begin();
  assert.equal(gate.isLatest(codex), false);
  assert.equal(gate.isLatest(again), true);
});

test('the model menu starts on the default, a listed model or a typed id, and reads back the same', () => {
  assert.deepEqual(modelOptions(CLAUDE).map((option) => option.text), [
    'Provider default (Opus 5.5)', 'Opus 5.5 · opus', 'Haiku 5.5 · haiku', 'raw', 'Other model id…',
  ]);
  assert.deepEqual(modelSelection(CLAUDE, null), { select: '', custom: '' });
  assert.deepEqual(modelSelection(CLAUDE, 'haiku'), { select: 'haiku', custom: '' });
  assert.deepEqual(modelSelection(CLAUDE, 'claude-next'), { select: CUSTOM_MODEL, custom: 'claude-next' });
  assert.equal(readModel('', ''), null);
  assert.equal(readModel('haiku', 'ignored'), 'haiku');
  assert.equal(readModel(CUSTOM_MODEL, '  claude-next '), 'claude-next');
  assert.equal(readModel(CUSTOM_MODEL, '  '), null);
});

test('providers: a saved one this build does not list is kept, first run prefers an installed Claude', () => {
  const providers: ProviderInfo[] = [
    { id: 'codex', label: 'Codex', command: 'codex', installed: true },
    { id: 'claude', label: 'Claude Code', command: 'claude', installed: false },
  ];
  assert.deepEqual(providerChoices(providers, 'kimi').map((provider) => provider.id), ['codex', 'claude', 'kimi']);
  assert.equal(preferredProvider(providers), 'codex', 'Claude is not installed');
  assert.equal(preferredProvider([{ id: 'claude', label: 'Claude Code', command: 'claude', installed: true }, providers[0]!]), 'claude');
  assert.equal(providerHint(providers, 'claude').warn, true);
  assert.match(providerHint(providers, 'codex').text, /own "codex" sign-in/u);
  assert.deepEqual(providerHint(providers, 'kimi'), { text: '', warn: false });
});

test('saving sends only what changed', () => {
  const form = botForm(PROFILE);
  assert.equal(botPatch(PROFILE, form), null, 'an untouched form changes nothing');
  assert.equal(botPatch(PROFILE, { ...form, allowedTools: 'Read,  Grep' }), null, 'the same tools, spaced differently');
  assert.deepEqual(botPatch(PROFILE, { ...form, name: '  Mochi ' }), { name: 'Mochi' });
  assert.deepEqual(botPatch(PROFILE, { ...form, model: null }), { executionTarget: { provider: 'claude', model: null } });
  assert.deepEqual(botPatch(PROFILE, { ...form, provider: 'codex', model: 'gpt-6.1-sol' }), { executionTarget: { provider: 'codex', model: 'gpt-6.1-sol' } });
  assert.deepEqual(botPatch(PROFILE, { ...form, allowedTools: 'Read, WebSearch' }), { permissions: { allowedTools: ['Read', 'WebSearch'] } });
  assert.deepEqual(botPatch(PROFILE, { ...form, permissionMode: 'skip', allowedTools: 'Read, WebSearch' }), { permissions: { permissionMode: 'skip' } },
    'tools only matter for the whitelist');
  assert.deepEqual(botPatch(PROFILE, { ...form, cwd: '  ' }), null, 'an emptied folder is not saved');
});

test('after a save the page says when sessions are replaced and when the runtime restarts', () => {
  const after = { ...PROFILE, configRevision: 4 };
  assert.match(saveNotice(PROFILE, after, { instructions: 'x' }), /fresh session/u);
  assert.match(saveNotice(PROFILE, after, { executionTarget: { provider: 'codex', model: null } }), /runtime restarts for codex/u);
  assert.equal(saveNotice(PROFILE, PROFILE, { name: 'Mochi' }), '');
});

test('notes: home first, then the most recently active; ages read like a person would say them', () => {
  const record = (id: string, role: 'home' | 'note', last: string | null, created = '2026-10-01T00:00:00.000Z'): ConversationRecord => ({
    schemaVersion: 1, id, role, title: id, createdAt: created, updatedAt: created,
    attachment: { state: 'none', sessionId: null, provider: null, model: null, configRevision: null } as unknown as ConversationRecord['attachment'],
    unreadCount: 0, lastOwnerMessageAt: last, lastBotMessageAt: null, checkpoint: null,
  });
  const sorted = sortNotes([
    record('old', 'note', '2026-10-02T00:00:00.000Z'),
    record('home', 'home', null),
    record('new', 'note', '2026-10-27T00:00:00.000Z'),
    record('never', 'note', null, '2026-10-20T00:00:00.000Z'),
  ]);
  assert.deepEqual(sorted.map((item) => item.id), ['home', 'new', 'never', 'old']);
  const now = Date.parse('2026-10-28T12:00:00.000Z');
  assert.equal(ago(null, now), 'no messages yet');
  assert.equal(ago('2026-10-28T11:59:50.000Z', now), 'just now');
  assert.equal(ago('2026-10-28T11:15:00.000Z', now), '45 min ago');
  assert.equal(ago('2026-10-27T12:00:00.000Z', now), '24 h ago');
  assert.equal(ago('2026-10-20T12:00:00.000Z', now, () => 'Oct 20'), 'Oct 20');
});

test('life minutes must be whole positive numbers; facts never show the Telegram token', () => {
  const form = lifeForm(PROFILE);
  assert.deepEqual(lifePatch(form), { heartbeat: PROFILE.heartbeat, idleSleepMinutes: 15 });
  assert.throws(() => lifePatch({ ...form, idle: '0' }), /at least 1/u);
  assert.throws(() => lifePatch({ ...form, wakeMin: '' }), /at least 1/u);
  const facts = telegramFacts({ enabled: true, tokenStored: true, protection: 'os', transport: null }, PROFILE);
  assert.deepEqual(facts, [['Token', 'stored, encrypted by the OS'], ['Polling', 'off'], ['Owner chat', 'not bound yet: send your bot a private message']]);
  const status = { id: 'nori', root: 'C:/bots/nori', runtime: { state: 'ready', pid: 42 } } as BotStatus;
  assert.deepEqual(appFacts(status, '0.1.0'), [['Bot id', 'nori'], ['Data folder', 'C:/bots/nori'], ['Runtime', 'ready (pid 42)'], ['Version', '0.1.0']]);
});
