import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BotProfile, BotStatus, ConversationRecord, ModelCatalog, ProviderInfo } from '../../src/core/types.ts';
import { acceptLanguage } from '../../src/renderer/localeStore.ts';
import { REPLY_LANGUAGE_CODES } from '../../src/shared/language.ts';
import {
  ago,
  appFacts,
  bossCatChoice,
  botForm,
  botStateLine,
  botPatch,
  botReplyLanguageOptions,
  hubReplyLanguageOptions,
  heartbeatModeOptions,
  lifeForm,
  nextHeartbeatText,
  lifePatch,
  modelOptions,
  modelSelection,
  modelControls,
  controlOptions,
  selectedModel,
  preferredProvider,
  providerChoices,
  providerHint,
  RequestGate,
  saveNotice,
  sortNotes,
  telegramFacts,
} from '../../src/renderer/settings/settingsLogic.ts';
import { readPackagedModelCatalog, CLI_PROVIDERS } from '../../src/core/providers/catalog.ts';

/** SPEC-002 FR-1–FR-6, SPEC-003 FR-6: the settings and first-run decisions, apart from React. */

const PROFILE: BotProfile = {
  schemaVersion: 3,
  providerPolicy: null,
  id: 'nori',
  name: 'Nori',
  avatar: 'tuxedo',
  instructions: 'Be kind.',
  environment: { kind: 'native' },
  executionTarget: { provider: 'claude', model: 'haiku' },
  configRevision: 3,
  permissions: { workspaceAccess: 'read_write', permissionMode: 'whitelist', allowedTools: ['Read', 'Grep'], cwd: 'C:/work' },
  heartbeat: { enabled: true, mode: 'auto', bedtime: '23:00', wakeWindowStart: '07:00', wakeWindowEnd: '09:00', wakeMinMinutes: 2, wakeMaxMinutes: 10, regularMinMinutes: 30, regularMaxMinutes: 120 },
  idleSleepMinutes: 15,
  telegram: { enabled: false, ownerChatId: null },
  desktopControl: { enabled: false },
  replyLanguage: 'hub',
  hubLanguage: null,
  updatedAt: '2026-10-28T00:00:00.000Z',
};

const CLAUDE: ModelCatalog = {
  provider: 'claude',
  defaultModel: 'opus',
  models: [{ id: 'opus', label: 'Opus 5.5', default: true }, { id: 'haiku', label: 'Haiku 5.5', default: false }, { id: 'raw', label: 'raw', default: false }],
  source: 'runtime',
};

test('the five provider menus keep Runtime catalog model and effort order without synthetic options', () => {
  assert.deepEqual(
    CLI_PROVIDERS.map((provider) => provider.id),
    ['codex', 'claude', 'antigravity', 'grok', 'muse'],
  );
  assert.deepEqual(
    CLI_PROVIDERS.map((provider) => provider.label),
    ['Codex', 'Claude', 'Antigravity', 'Grok', 'Muse'],
  );
  for (const provider of CLI_PROVIDERS) {
    const catalog = readPackagedModelCatalog(provider.id);
    assert.deepEqual(
      modelOptions(catalog),
      // SPEC-010 FR-16: the catalog's own default is marked, as Cats Chat marks it; nothing is added.
      catalog.models.map((model) => ({ value: model.id, text: model.default ? `${model.label} (default)` : model.label })),
    );
    for (const model of catalog.models) {
      const selection = selectedModel(catalog, model.id);
      assert.equal(selection?.entryId, model.id);
      for (const control of modelControls(catalog, model.id)) {
        if (control.kind === 'enum') {
          assert.deepEqual(
            controlOptions(control).map((option) => option.value),
            control.values?.map((option) => (typeof option === 'object' ? option.value : option)),
          );
          assert.ok(
            controlOptions(control).some(
              (option) => option.value === selection?.controls?.[control.key],
            ),
          );
        }
      }
      if (model.controls?.length === 0)
        assert.deepEqual(
          selection?.controls,
          {},
          'models without effort never invent an effort control',
        );
    }
  }
  const catalog = readPackagedModelCatalog('codex'),
    entryId = catalog.models[0]!.id;
  const saved = {
    entryMode: 'explicit' as const,
    entryId,
    controls: { 'codex.reasoning_effort': 'max' },
  };
  assert.equal(selectedModel(catalog, entryId, saved)?.controls?.['codex.reasoning_effort'], 'max');
});

test('an explicit empty per-model control list opts out of shared controls like Runtime', () => {
  const shared = { key: 'effort', label: 'Effort', kind: 'enum' as const, values: ['low', 'high'] };
  const catalog: ModelCatalog = {
    ...CLAUDE,
    controls: [shared],
    models: [
      { id: 'inherit', label: 'Inherit', default: false },
      { id: 'opt-out', label: 'Opt out', default: false, controls: [] },
    ],
  };
  assert.deepEqual(modelControls(catalog, 'inherit'), [shared]);
  assert.deepEqual(modelControls(catalog, 'opt-out'), []);
});

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

test('the model menu contains exactly catalog entries; legacy custom models are retained outside the menu', () => {
  assert.deepEqual(
    modelOptions(CLAUDE).map((option) => option.text),
    ['Opus 5.5 (default)', 'Haiku 5.5', 'raw'],
  );
  assert.deepEqual(modelSelection(CLAUDE, null), { select: 'opus', custom: '' });
  assert.deepEqual(modelSelection(CLAUDE, 'haiku'), { select: 'haiku', custom: '' });
  assert.deepEqual(modelSelection(CLAUDE, 'claude-next'), { select: '', custom: 'claude-next' });
});

test('providers: only supported choices are offered, always in the requested order', () => {
  const providers: ProviderInfo[] = [
    { id: 'codex', label: 'Codex', command: 'codex', installed: true },
    { id: 'claude', label: 'Claude Code', command: 'claude', installed: false },
  ];
  assert.deepEqual(
    providerChoices(providers, 'kimi').map((provider) => provider.id),
    ['codex', 'claude'],
  );
  assert.equal(preferredProvider(providers), 'codex', 'Claude is not installed');
  assert.equal(
    preferredProvider([
      { id: 'claude', label: 'Claude Code', command: 'claude', installed: true },
      providers[0]!,
    ]),
    'codex',
  );
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

test('the look is sent only when it changed (SPEC-008 FR-29)', () => {
  const form = botForm(PROFILE);
  assert.equal(form.avatar, 'tuxedo');
  assert.deepEqual(botPatch(PROFILE, { ...form, avatar: 'calico' }), { avatar: 'calico' });
  // A core still running the previous version sends no look: the page shows the default Cat and saves nothing for it.
  const { avatar: _none, ...older } = PROFILE;
  const fromOlderCore = older as BotProfile;
  assert.equal(botForm(fromOlderCore).avatar, 'ginger');
  assert.equal(botPatch(fromOlderCore, botForm(fromOlderCore)), null);
});

test('Claude in Chrome is saved for Claude only and turned off when the provider changes', () => {
  const form = botForm(PROFILE);
  assert.equal(form.claudeInChrome, false);
  assert.deepEqual(botPatch(PROFILE, { ...form, claudeInChrome: true }),
    { executionTarget: { provider: 'claude', model: 'haiku', claudeInChrome: true } });
  assert.equal(botPatch(PROFILE, { ...form, provider: 'codex', claudeInChrome: true })?.executionTarget?.claudeInChrome, undefined,
    'never sent for another provider when it was off');
  const chrome = { ...PROFILE, executionTarget: { provider: 'claude', model: 'haiku', claudeInChrome: true } };
  assert.equal(botForm(chrome).claudeInChrome, true);
  assert.equal(botPatch(chrome, botForm(chrome)), null);
  assert.deepEqual(botPatch(chrome, { ...botForm(chrome), provider: 'codex', model: null }),
    { executionTarget: { provider: 'codex', model: null, claudeInChrome: false } });
  assert.match(saveNotice(PROFILE, chrome, { executionTarget: chrome.executionTarget }), /Claude in Chrome on/u);
});

test('after a save the page says when sessions are replaced and when the runtime restarts', () => {
  const after = { ...PROFILE, configRevision: 4 };
  assert.match(saveNotice(PROFILE, after, { instructions: 'x' }), /fresh session/u);
  assert.match(saveNotice(PROFILE, after, { executionTarget: { provider: 'codex', model: null } }), /runtime restarts for codex/u);
  assert.equal(saveNotice(PROFILE, PROFILE, { name: 'Mochi' }), '');
  assert.equal(saveNotice(PROFILE, { ...PROFILE, avatar: 'calico' }, { avatar: 'calico' }), '', 'a new look replaces no session');
  const { avatar: _none, ...olderCore } = PROFILE;
  assert.match(saveNotice(PROFILE, olderCore as BotProfile, { avatar: 'calico' }), /older version/u);
});

test('notes: home first, then the most recently active; ages read like a person would say them', () => {
  const record = (id: string, role: 'home' | 'note', last: string | null, created = '2026-10-01T00:00:00.000Z'): ConversationRecord => ({
    schemaVersion: 1, id, role, title: id, createdAt: created, updatedAt: created,
    attachment: { state: 'none', sessionId: null, provider: null, model: null, configRevision: null } as unknown as ConversationRecord['attachment'],
    unreadCount: 0, lastOwnerMessageAt: last, lastBotMessageAt: null, checkpoint: null, contactOf: null, contactName: null,
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
  assert.deepEqual(appFacts(status, '0.1.0'), [['Cat bot id', 'nori'], ['Data folder', 'C:/bots/nori'], ['Runtime', 'ready (pid 42)'], ['Version', '0.1.0']]);
});

test('the Life tab sends the mode and Desktop\'s rhythm, refuses times Desktop refuses, and says when it waits (SPEC-011)', () => {
  const form = lifeForm(PROFILE);
  assert.equal(form.mode, 'auto');
  const patch = lifePatch({ ...form, mode: 'assist', bedtime: '00:30' });
  assert.equal(patch.heartbeat.mode, 'assist');
  assert.equal(patch.heartbeat.bedtime, '00:30');
  assert.throws(() => lifePatch({ ...form, bedtime: '08:00' }), /bedtime must fall outside the wake window/u);
  assert.deepEqual(heartbeatModeOptions(null).map((option) => option.value), ['auto', 'assist', 'companion']);
  assert.match(heartbeatModeOptions('assist')[0]!.label, /now Assist/u);
  const status = (heartbeat: Partial<BotStatus['heartbeat']>) => ({
    heartbeat: { enabled: true, nextAt: null, mode: 'companion', phase: 'awake_hours', unanswered: 0, waitingForOwner: false, ...heartbeat },
  }) as BotStatus;
  assert.match(nextHeartbeatText(status({ unanswered: 5, waitingForOwner: true })), /waiting for you: 5 unprompted messages/u);
  assert.equal(nextHeartbeatText(status({ nextAt: '2026-11-10T10:00:00.000Z' }), () => 'Tue 18:00'), 'Next activity on its own around Tue 18:00.');
  assert.equal(nextHeartbeatText(status({ enabled: false })), 'Own initiative is paused.');
});

test('reply language choices: the display language first and Unspecified last, as on Desktop (SPEC-008 FR-28)', () => {
  const hub = hubReplyLanguageOptions('en');
  assert.deepEqual(hub.map((option) => option.value), ['display', ...REPLY_LANGUAGE_CODES, 'unspecified']);
  assert.equal(hub[0]!.label, 'Same as display language (English)');
  assert.equal(hub.find((option) => option.value === 'ja')!.label, 'Japanese');
  assert.equal(hub.at(-1)!.label, 'Unspecified');

  const bot = botReplyLanguageOptions('en', { reply: 'ja', display: 'en' });
  assert.deepEqual(bot.map((option) => option.value), ['hub', 'display', ...REPLY_LANGUAGE_CODES, 'unspecified']);
  assert.equal(bot[0]!.label, 'Follow Cats Bot Settings (Japanese)');
  assert.equal(botReplyLanguageOptions('en', { reply: null, display: 'en' })[0]!.label, 'Follow Cats Bot Settings (Unspecified)');
  assert.equal(botReplyLanguageOptions('en', null)[0]!.label, 'Follow Cats Bot Settings');

  acceptLanguage({ preference: 'zh-TW', locale: 'zh-TW' });
  try {
    const zh = hubReplyLanguageOptions('zh-TW');
    assert.equal(zh[0]!.label, '與顯示語言相同（繁體中文）');
    assert.equal(zh.at(-1)!.label, '不指定');
    assert.equal(botReplyLanguageOptions('zh-TW', { reply: 'zh-TW', display: 'zh-TW' })[0]!.label, '跟隨 Cats Bot 設定（繁體中文）');
  } finally {
    acceptLanguage({ preference: 'en', locale: 'en' });
  }
});

test('the Bot tab sends a reply language only when it changed (SPEC-008 FR-28)', () => {
  assert.equal(botForm(PROFILE).replyLanguage, 'hub');
  assert.equal(botPatch(PROFILE, botForm(PROFILE)), null);
  assert.deepEqual(botPatch(PROFILE, { ...botForm(PROFILE), replyLanguage: 'ko' }), { replyLanguage: 'ko' });
});

test('a Bots row names the provider and state, and a pid only for another program (SPEC-008 FR-5)', () => {
  acceptLanguage({ preference: 'en', locale: 'en' });
  assert.equal(botStateLine({ state: 'running', pid: 93136, provider: 'claude', providerLabel: 'Claude' }), 'Claude · Running');
  assert.equal(botStateLine({ state: 'external', pid: 4410, provider: 'claude', providerLabel: 'Claude' }), 'Claude · Running in another program (pid 4410)');
  assert.equal(botStateLine({ state: 'stopped', pid: null, provider: 'kiro', providerLabel: null }), 'kiro · Stopped', 'an unknown provider shows its id');
  assert.equal(botStateLine({ state: 'missing', pid: null, provider: null, providerLabel: null }), 'Folder missing');
  acceptLanguage({ preference: 'zh-TW', locale: 'zh-TW' });
  assert.equal(botStateLine({ state: 'running', pid: 1, provider: 'codex', providerLabel: 'Codex' }), 'Codex · 執行中');
  acceptLanguage({ preference: 'en', locale: 'en' });
});

test('the Boss Cat menu assigns, moves and clears the role, and choosing the holder again does nothing (SPEC-009 FR-2)', () => {
  assert.deepEqual(bossCatChoice(null, 'qq'), { id: 'qq', action: 'makeBossCat' });
  assert.deepEqual(bossCatChoice('qq', 'mochi'), { id: 'mochi', action: 'makeBossCat' });
  assert.deepEqual(bossCatChoice('qq', ''), { id: 'qq', action: 'clearBossCat' });
  assert.equal(bossCatChoice('qq', 'qq'), null);
  assert.equal(bossCatChoice(null, ''), null);
});
