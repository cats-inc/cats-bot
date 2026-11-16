import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { BotProfile, BotStatus, ConversationRecord, ModelCatalog, ProviderInfo } from '../../src/core/types.ts';
import { acceptLanguage } from '../../src/renderer/localeStore.ts';
import { REPLY_LANGUAGE_CODES } from '../../src/shared/language.ts';
import {
  ago,
  appFacts,
  bossCatChoice,
  bossCatToolsHint,
  clampLimit,
  botSettings,
  editedPages,
  pendingNotice,
  staleLook,
  withPermission,
  withProvider,
  brandState,
  layerStack,
  removalCopy,
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
  sortNotes,
  telegramFacts,
} from '../../src/renderer/settings/settingsLogic.ts';
import { readPackagedModelCatalog, CLI_PROVIDERS } from '../../src/core/providers/catalog.ts';

/** SPEC-002 FR-1–FR-6, SPEC-003 FR-6: the settings and first-run decisions, apart from React. */

const PROFILE: BotProfile = {
  schemaVersion: 2,
  providerPolicy: null,
  id: 'nori',
  name: 'Nori',
  avatar: 'tuxedo',
  instructions: 'Be kind.',
  environment: { kind: 'native' },
  executionTarget: { provider: 'claude', model: 'haiku' },
  configRevision: 3,
  permissions: { workspaceAccess: 'read_write', permissionMode: 'default', cwd: 'C:/work' },
  heartbeat: { enabled: true, mode: 'auto', bedtime: '23:00', wakeWindowStart: '07:00', wakeWindowEnd: '09:00', wakeMinMinutes: 2, wakeMaxMinutes: 10, regularMinMinutes: 30, regularMaxMinutes: 120 },
  idleSleepMinutes: 15,
  telegram: { enabled: false, ownerChatId: null },
  desktopControl: { enabled: false },
  replyLanguage: 'hub',
  hubLanguage: null,
  showProgressDetails: false,
  showVerboseMessages: false,
  updatedAt: '2026-10-28T00:00:00.000Z',
};

const CLAUDE: ModelCatalog = {
  provider: 'claude',
  defaultModel: 'opus',
  models: [{ id: 'opus', label: 'Opus 5.5', default: true }, { id: 'haiku', label: 'Haiku 5.5', default: false }, { id: 'raw', label: 'raw', default: false }],
  source: 'runtime',
};

test('the six provider menus keep Runtime catalog model and effort order without synthetic options', () => {
  assert.deepEqual(
    CLI_PROVIDERS.map((provider) => provider.id),
    ['codex', 'claude', 'antigravity', 'grok', 'muse', 'kimi'],
  );
  assert.deepEqual(
    CLI_PROVIDERS.map((provider) => provider.label),
    ['Codex', 'Claude', 'Antigravity', 'Grok', 'Muse', 'Kimi'],
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

const KEEP = { model: 'haiku' };

test('an untouched page saves nothing, and only what changed is sent (SPEC-002 FR-2, ADR-030)', () => {
  const view = botSettings(PROFILE, true);
  assert.equal(botPatch(PROFILE, view, KEEP), null, 'an untouched page changes nothing');
  assert.deepEqual(botPatch(PROFILE, { ...view, name: '  Mochi ' }, KEEP), { name: 'Mochi' });
  assert.deepEqual(botPatch(PROFILE, view, { model: null }), { executionTarget: { provider: 'claude', model: null } });
  // A new provider takes its permission choice with it, and its policy always goes too.
  assert.deepEqual(botPatch(PROFILE, { ...view, ...withProvider(view, view, 'codex') }, { model: 'gpt-6.1-sol' }),
    { executionTarget: { provider: 'codex', model: 'gpt-6.1-sol' }, providerPolicy: null });
  assert.deepEqual(botPatch(PROFILE, { ...view, cwd: '  ' }, KEEP), null, 'an emptied folder is not saved');
  const asks = withPermission(view, { ask: 'ask', level: 'full-access', network: true });
  assert.deepEqual(botPatch(PROFILE, { ...view, ...asks }, KEEP),
    { providerPolicy: { version: 1, mode: 'explicit', access: 'full-access', network: true, approval: 'on-request' } });
});

test('the look is sent only when it changed (SPEC-008 FR-29)', () => {
  const view = botSettings(PROFILE, true);
  assert.equal(view.avatar, 'tuxedo');
  assert.deepEqual(botPatch(PROFILE, { ...view, avatar: 'calico' }, KEEP), { avatar: 'calico' });
  // A core still running the previous version sends no look: the page shows the default Cat and saves nothing for it.
  const { avatar: _none, ...older } = PROFILE;
  const fromOlderCore = older as BotProfile;
  assert.equal(botSettings(fromOlderCore, true).avatar, 'ginger');
  assert.equal(botPatch(fromOlderCore, botSettings(fromOlderCore, true), KEEP), null);
  assert.equal(staleLook({ avatar: 'calico' }, fromOlderCore), true);
  assert.equal(staleLook({ avatar: 'calico' }, { ...PROFILE, avatar: 'calico' }), false);
});

test('Claude in Chrome is saved for Claude only and turned off when the provider changes', () => {
  const view = botSettings(PROFILE, true);
  assert.equal(view.claudeInChrome, false);
  assert.deepEqual(botPatch(PROFILE, { ...view, claudeInChrome: true }, KEEP),
    { executionTarget: { provider: 'claude', model: 'haiku', claudeInChrome: true } });
  assert.equal(botPatch(PROFILE, { ...view, ...withProvider(view, view, 'codex'), claudeInChrome: true }, { model: null })?.executionTarget?.claudeInChrome, undefined,
    'never sent for another provider when it was off');
  const chrome = { ...PROFILE, executionTarget: { provider: 'claude', model: 'haiku', claudeInChrome: true } };
  const on = botSettings(chrome, true);
  assert.equal(on.claudeInChrome, true);
  assert.equal(botPatch(chrome, on, KEEP), null);
  assert.deepEqual(botPatch(chrome, { ...on, ...withProvider(on, on, 'codex') }, { model: null }),
    { executionTarget: { provider: 'codex', model: null, claudeInChrome: false }, providerPolicy: null });
  const patch = botPatch(PROFILE, { ...view, claudeInChrome: true }, KEEP);
  assert.match(pendingNotice(PROFILE, { ...view, claudeInChrome: true }, patch, 'Claude Code', false).join(' '), /Claude in Chrome on/u);
});

test('the save bar says before saving what saving does (SPEC-002 FR-2, ADR-030)', () => {
  const view = botSettings(PROFILE, true);
  const say = (next: typeof view, target: { model: string | null } = KEEP, floating = false) => pendingNotice(PROFILE, next, botPatch(PROFILE, next, target), 'Codex', floating).join(' ');
  assert.match(say({ ...view, instructions: 'x' }), /fresh session/u);
  assert.match(say({ ...view, ...withProvider(view, view, 'codex') }, { model: null }), /Switching to Codex: the runtime restarts/u);
  assert.match(say({ ...view, name: 'Mochi' }), /name and look change no conversation/u);
  assert.doesNotMatch(say({ ...view, name: 'Mochi' }), /fresh session/u);
  assert.match(say({ ...view, floating: false }, KEEP, true), /name and look/u);
  const desktop = { ...PROFILE, desktopControl: { enabled: true }, providerPolicy: { version: 1, mode: 'explicit', access: 'full-access', network: true, approval: 'on-request' } } as BotProfile;
  const withDesk = botSettings(desktop, true);
  const away = { ...withDesk, ...withPermission(withDesk, { ask: 'cli', level: 'full-access', network: true }) };
  assert.equal(away.desktopControl, false, 'desktop control cannot stay on without Ask me first');
  assert.match(pendingNotice(desktop, away, botPatch(desktop, away, KEEP), 'Claude Code', false).join(' '), /revokes every app grant/u);
});

test('looking at another provider and coming back changes nothing (ADR-030)', () => {
  const asking = { ...PROFILE, desktopControl: { enabled: true },
    providerPolicy: { version: 1, mode: 'explicit', access: 'full-access', network: true, approval: 'on-request' } } as BotProfile;
  const base = botSettings(asking, true);
  const away = { ...base, ...withProvider(base, base, 'kimi') };
  assert.equal(away.permission.ask, 'cli');
  assert.equal(away.desktopControl, false, 'Kimi cannot keep desktop control');
  const back = { ...away, ...withProvider(base, away, 'claude') };
  assert.deepEqual(back.permission, base.permission);
  assert.equal(back.desktopControl, true);
  assert.equal(botPatch(asking, back, KEEP), null, 'nothing to save');
});

test('the rail marks the pages with an edit not saved; an edit put back is none (ADR-030)', () => {
  const base = botSettings(PROFILE, true);
  assert.deepEqual([...editedPages(base, {}, false)], []);
  assert.deepEqual([...editedPages(base, { name: 'Mochi' }, false)], ['look']);
  assert.deepEqual([...editedPages(base, { name: PROFILE.name }, false)], [], 'put back');
  assert.deepEqual([...editedPages(base, withProvider(base, base, 'codex'), false)].sort(), ['brain', 'perm']);
  assert.deepEqual([...editedPages(base, {}, true)], ['brain'], 'a model chosen on the menu');
  assert.deepEqual([...editedPages(base, { floating: false }, false)], ['look']);
});

test('notes: home first, then the most recently active; ages read like a person would say them', () => {
  const record = (id: string, role: 'home' | 'note', last: string | null, created = '2026-10-01T00:00:00.000Z'): ConversationRecord => ({
    schemaVersion: 1, id, role, title: id, titleSource: 'owner', createdAt: created, updatedAt: created,
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

test('the conversation list stacks layers from the top down and says what Delete and Clear take (FR-5, FR-5b)', () => {
  assert.deepEqual(layerStack(['normal', 'top', 'desktop', 'wallpaper']), ['top', 'normal', 'desktop', 'wallpaper']);
  assert.deepEqual(layerStack(['normal', 'top']), ['top', 'normal'], 'without the desktop layers');
  const base: ConversationRecord = {
    schemaVersion: 1, id: 'home', role: 'home', title: 'Direct message', titleSource: 'default',
    createdAt: '2026-11-16T00:00:00.000Z', updatedAt: '2026-11-16T00:00:00.000Z',
    attachment: { state: 'none', sessionId: null, provider: null, model: null, configRevision: null } as unknown as ConversationRecord['attachment'],
    unreadCount: 0, lastOwnerMessageAt: null, lastBotMessageAt: null, checkpoint: null, contactOf: null, contactName: null,
  };
  const clear = removalCopy(base, false);
  assert.equal(clear.action, 'Clear');
  assert.match(clear.detail, /schedules stay/u);
  assert.doesNotMatch(clear.detail, /Telegram/u);
  assert.match(removalCopy(base, true).detail, /Telegram chat keeps its own copy/u);
  const note = removalCopy({ ...base, id: 'conv-1', role: 'note', title: 'Plans' }, false);
  assert.equal(note.action, 'Delete');
  assert.equal(note.title, 'Delete “Plans”?');
  assert.equal(note.done, 'Deleted Plans');
  const contact = removalCopy({ ...base, id: 'bot-mochi', role: 'note', title: 'Messages from Mochi', contactOf: 'mochi', contactName: 'Mochi' }, false);
  assert.equal(contact.title, 'Delete “Contact with Mochi”?');
  assert.match(contact.detail, /When Mochi writes again, a new contact note starts/u);
  const status = (state: BotStatus['runtime']['state']) => ({ runtime: { state } }) as unknown as BotStatus;
  assert.equal(brandState(status('ready')), 'Runtime ready');
  assert.equal(brandState(status('starting')), 'Runtime starting');
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
  assert.match(nextHeartbeatText(status({ unanswered: 5, waitingForOwner: true })), /waiting for you: 5 own-initiative messages/u);
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

test('Name and look sends a reply language only when it changed (SPEC-008 FR-28)', () => {
  const view = botSettings(PROFILE, true);
  assert.equal(view.replyLanguage, 'hub');
  assert.deepEqual(botPatch(PROFILE, { ...view, replyLanguage: 'ko' }, KEEP), { replyLanguage: 'ko' });
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

test('the Boss Cat row says when its tools come, and in red only why they cannot (SPEC-009 FR-11)', () => {
  const qq = { name: 'QQ', provider: 'claude', providerLabel: 'Claude' };
  assert.equal(bossCatToolsHint({ ...qq, bossCatTools: null }), null);
  const pending = bossCatToolsHint({ ...qq, bossCatTools: 'pending' });
  assert.equal(pending?.warn, false);
  assert.match(pending!.text, /QQ gets the Boss Cat tools at its next reply/u);
  assert.match(pending!.text, /nothing needs restarting/u);
  assert.doesNotMatch(pending!.text, /start a conversation/iu);
  assert.deepEqual(bossCatToolsHint({ ...qq, bossCatTools: 'connected' }), { text: 'The Boss Cat tools are connected.', warn: false });
  const access = bossCatToolsHint({ name: 'QQ', provider: 'grok', providerLabel: 'Grok', bossCatTools: 'needsAccess' });
  assert.equal(access?.warn, true);
  assert.match(access!.text, /Grok/u);
  assert.match(access!.text, /Settings → Permissions/u);
  const unsupported = bossCatToolsHint({ name: 'QQ', provider: 'antigravity', providerLabel: null, bossCatTools: 'unsupported' });
  assert.equal(unsupported?.warn, true);
  assert.match(unsupported!.text, /antigravity does not support/u);
  // A holder that is not running is not promised its tools without a start.
  const stopped = bossCatToolsHint({ ...qq, bossCatTools: 'notRunning' });
  assert.equal(stopped?.warn, false);
  assert.match(stopped!.text, /QQ is not running\. It gets the Boss Cat tools at its next reply after it starts\./u);
  assert.doesNotMatch(stopped!.text, /nothing needs restarting/u);
  const external = bossCatToolsHint({ ...qq, bossCatTools: 'external' });
  assert.equal(external?.warn, true);
  assert.match(external!.text, /QQ runs in another program, so it does not get the Boss Cat tools/u);
});

test('the Boss Cat menu assigns, moves and clears the role, and choosing the holder again does nothing (SPEC-009 FR-2)', () => {
  assert.deepEqual(bossCatChoice(null, 'qq'), { id: 'qq', action: 'makeBossCat' });
  assert.deepEqual(bossCatChoice('qq', 'mochi'), { id: 'mochi', action: 'makeBossCat' });
  assert.deepEqual(bossCatChoice('qq', ''), { id: 'qq', action: 'clearBossCat' });
  assert.equal(bossCatChoice('qq', 'qq'), null);
  assert.equal(bossCatChoice(null, ''), null);
});

test('a Boss Cat limit saves a whole number the hub accepts, or keeps the value it had (SPEC-009 FR-8, ADR-031)', () => {
  const hops = [2, 100] as const;
  assert.equal(clampLimit('6', 4, hops), 6);
  assert.equal(clampLimit('1', 4, hops), 2, 'below the range: the smallest');
  assert.equal(clampLimit('250', 4, hops), 100, 'above the range: the largest');
  assert.equal(clampLimit('7.6', 4, hops), 8, 'a whole number');
  assert.equal(clampLimit('', 4, hops), 4, 'emptied: what it was');
  assert.equal(clampLimit('abc', 4, hops), 4);
});
