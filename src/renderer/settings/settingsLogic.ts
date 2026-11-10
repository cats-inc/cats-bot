import { t } from '../localeStore.ts';
import { resolveBotAvatar, type BotAvatar } from '../../shared/avatars.ts';
import { botNameMessage, botNameProblem, botPersonaMessage, botPersonaProblem, normalizeBotName, normalizeBotPersona } from '../../shared/botText.ts';
import { heartbeatRhythmProblem } from '../../shared/heartbeatRhythm.ts';
import {
  LANGUAGE_OPTIONS,
  REPLY_LANGUAGE_CODES,
  replyLanguageName,
  type BotReplyLanguage,
  type HubLanguageReport,
  type HubReplyLanguage,
  type Locale,
} from '../../shared/language.ts';
import type {
  BotPermissions,
  BotProfile,
  BotProfilePatch,
  BotStatus,
  ConversationRecord,
  EffectiveHeartbeatMode,
  HeartbeatMode,
  HeartbeatPolicy,
  ModelCatalog,
  ModelSelection,
  ModelControl,
  ModelControlValue,
  ProviderInfo,
  TelegramSettingsStatus,
} from '../../core/types.ts';

/**
 * SPEC-002 FR-1–FR-6, SPEC-003 FR-6: what the settings and first-run pages
 * decide, apart from React, so it is tested with node:test.
 */

// ---- Providers and models ---------------------------------------------------------

export function providerLabel(provider: ProviderInfo): string {
  return provider.label;
}

/** Only the supported providers are selectable; saved legacy targets are preserved separately. */
export function providerChoices(
  providers: readonly ProviderInfo[],
  current: string | null,
): ProviderInfo[] {
  return ['codex', 'claude', 'antigravity', 'grok', 'muse'].flatMap((id) =>
    providers.filter((provider) => provider.id === id),
  );
}

/** First run uses the product's provider order, independently of installation state. */
export function preferredProvider(providers: readonly ProviderInfo[]): string {
  return providerChoices(providers, null)[0]?.id ?? 'codex';
}

export function providerHint(
  providers: readonly ProviderInfo[],
  id: string,
): { text: string; warn: boolean } {
  const provider = providers.find((item) => item.id === id);
  if (!provider || provider.installed === null) return { text: '', warn: false };
  if (provider.installed === false) {
    return {
      text: t(
        '"{value0}" was not found on PATH. Install it and sign in once in a terminal before the cat bot can answer.',
        { value0: provider.command },
      ),
      warn: true,
    };
  }
  return {
    text: t('Uses your own "{value0}" sign-in and subscription.', { value0: provider.command }),
    warn: false,
  };
}

export interface MenuOption {
  value: string;
  text: string;
}

/** SPEC-010 FR-16: as Cats Chat's formatDefaultLabel marks the catalog's own default. */
function withDefault(label: string, isDefault: boolean): string {
  return isDefault ? `${label} (default)` : label;
}

export function modelOptions(catalog: ModelCatalog): MenuOption[] {
  return catalog.models.map((model) => ({ value: model.id, text: withDefault(model.label, model.default === true) }));
}

/** New choices use catalog order; unknown saved IDs remain outside the selectable menu. */
export function modelSelection(
  catalog: ModelCatalog,
  current: string | null,
): { select: string; custom: string } {
  if (!current) return { select: catalog.defaultModel ?? catalog.models[0]?.id ?? '', custom: '' };
  if (catalog.models.some((model) => model.id === current)) return { select: current, custom: '' };
  return { select: '', custom: current };
}

export function modelControls(catalog: ModelCatalog, entryId: string): ModelControl[] {
  const entry = catalog.models.find((model) => model.id === entryId);
  if (!entry) return [];
  if (entry.controls?.length === 0) return [];
  const controls = new Map((catalog.controls ?? []).map((control) => [control.key, control]));
  for (const control of entry.controls ?? []) controls.set(control.key, control);
  // A request-scoped control is set per message, so it is not a saved setting (listPersistentControlOptions).
  return [...controls.values()].filter(
    (control) => control.scope !== 'request' && (!control.applicableEntryIds || control.applicableEntryIds.includes(entryId)),
  );
}

export function controlOptions(
  control: ModelControl,
): Array<{ value: ModelControlValue; label: string }> {
  return (control.values ?? []).map((value) =>
    typeof value === 'object' ? value : { value, label: String(value) },
  );
}

/** A control's choices for this model, with the catalog's default marked. */
export function controlChoices(
  catalog: ModelCatalog,
  entryId: string,
  control: ModelControl,
): Array<{ value: ModelControlValue; label: string }> {
  const fallback = catalog.models.find((model) => model.id === entryId)?.controlDefaults?.[control.key] ?? control.default;
  return controlOptions(control).map((option) => ({ value: option.value, label: withDefault(option.label, option.value === fallback) }));
}

export function selectedModel(
  catalog: ModelCatalog,
  entryId: string,
  saved?: ModelSelection,
): ModelSelection | undefined {
  const entry = catalog.models.find((model) => model.id === entryId);
  if (!entry) return undefined;
  const controls: Record<string, ModelControlValue> = {};
  for (const control of modelControls(catalog, entryId)) {
    const options = controlOptions(control);
    const previous = saved?.entryId === entryId ? saved.controls?.[control.key] : undefined;
    const fallback =
      entry.controlDefaults?.[control.key] ??
      control.default ??
      (catalog.defaultSelection?.entryId === entryId
        ? catalog.defaultSelection.controls?.[control.key]
        : undefined);
    const valid = (value: ModelControlValue | undefined) =>
      value !== undefined &&
      (control.kind !== 'enum' || options.some((option) => option.value === value));
    const value = valid(previous)
      ? previous
      : valid(fallback)
        ? fallback
        : control.kind === 'enum'
          ? options[0]?.value
          : undefined;
    if (value !== undefined) controls[control.key] = value;
  }
  return {
    entryMode: 'explicit',
    entryId,
    ...(catalog.catalogRevision ? { catalogRevision: catalog.catalogRevision } : {}),
    controls,
  };
}

/**
 * Provider changes can overlap: only the newest model request may fill the
 * menu (2026-10-28 review: a late Claude list used to replace Codex's).
 */
export class RequestGate {
  private latest = 0;

  begin(): number {
    this.latest += 1;
    return this.latest;
  }

  isLatest(ticket: number): boolean {
    return ticket === this.latest;
  }
}

// ---- Reply language (SPEC-008 FR-28) ---------------------------------------------

export interface ReplyLanguageOption<T extends string> {
  value: T;
  label: string;
}

/** Cats Bot Settings' choices: the display language first, each language, Unspecified last. */
export function hubReplyLanguageOptions(locale: Locale): ReplyLanguageOption<HubReplyLanguage>[] {
  const display = LANGUAGE_OPTIONS.find((option) => option.value === locale)?.label ?? locale;
  return [
    { value: 'display', label: t('Same as display language ({language})', { language: t(display) }) },
    ...REPLY_LANGUAGE_CODES.map((code) => ({ value: code, label: replyLanguageName(code, locale) })),
    { value: 'unspecified', label: t('Unspecified') },
  ];
}

/** A bot's choices: following Cats Bot Settings first, naming what it resolves to, then the same list. */
export function botReplyLanguageOptions(
  locale: Locale,
  hub: HubLanguageReport | null,
): ReplyLanguageOption<BotReplyLanguage>[] {
  const follow = hub
    ? t('Follow Cats Bot Settings ({language})', {
      language: hub.reply ? replyLanguageName(hub.reply, locale) : t('Unspecified'),
    })
    : t('Follow Cats Bot Settings');
  return [{ value: 'hub', label: follow }, ...hubReplyLanguageOptions(locale)];
}

// ---- Bot tab ----------------------------------------------------------------------

export interface BotForm {
  name: string;
  avatar: BotAvatar;
  provider: string;
  model: string | null;
  modelSelection?: ModelSelection;
  /** Applies only while the provider is Claude Code. */
  claudeInChrome: boolean;
  instructions: string;
  cwd: string;
  workspaceAccess: BotPermissions['workspaceAccess'];
  permissionMode: BotPermissions['permissionMode'];
  allowedTools: string;
  replyLanguage: BotReplyLanguage;
}

export function botForm(profile: BotProfile): BotForm {
  return {
    name: profile.name,
    avatar: resolveBotAvatar(profile.avatar),
    provider: profile.executionTarget.provider,
    model: profile.executionTarget.model,
    ...(profile.executionTarget.modelSelection
      ? { modelSelection: profile.executionTarget.modelSelection }
      : {}),
    claudeInChrome: profile.executionTarget.claudeInChrome === true,
    instructions: profile.instructions,
    cwd: profile.permissions.cwd,
    workspaceAccess: profile.permissions.workspaceAccess,
    permissionMode: profile.permissions.permissionMode,
    allowedTools: (profile.permissions.allowedTools ?? []).join(', '),
    replyLanguage: profile.replyLanguage,
  };
}

export function parseTools(text: string): string[] {
  return text.split(',').map((tool) => tool.trim()).filter(Boolean);
}

/** Only what changed, so an unchanged target or permission never bumps the configuration revision. */
/**
 * SPEC-010 FR-19: what is wrong with the form's text, as translation keys. A value
 * unchanged from the profile is not judged: it predates the rule and keeps working.
 */
export function botTextErrors(profile: BotProfile, form: Pick<BotForm, 'name' | 'instructions'>): { name: string | null; instructions: string | null } {
  const name = normalizeBotName(form.name);
  const persona = normalizeBotPersona(form.instructions);
  const nameProblem = name === normalizeBotName(profile.name) ? null : botNameProblem(name);
  const personaProblem = persona === normalizeBotPersona(profile.instructions) ? null : botPersonaProblem(persona);
  return {
    name: nameProblem ? botNameMessage(nameProblem) : null,
    instructions: personaProblem ? botPersonaMessage(personaProblem) : null,
  };
}

export function botPatch(profile: BotProfile, form: BotForm): BotProfilePatch | null {
  const patch: BotProfilePatch = {};
  const name = form.name.trim();
  if (name && name !== profile.name.trim()) patch.name = name;
  if (form.avatar !== resolveBotAvatar(profile.avatar)) patch.avatar = form.avatar;
  const chrome = form.provider === 'claude' && form.claudeInChrome;
  if (
    form.provider !== profile.executionTarget.provider ||
    form.model !== profile.executionTarget.model ||
    JSON.stringify(form.modelSelection) !==
      JSON.stringify(profile.executionTarget.modelSelection) ||
    chrome !== (profile.executionTarget.claudeInChrome === true)
  ) {
    patch.executionTarget = {
      provider: form.provider,
      model: form.model,
      ...(form.modelSelection ? { modelSelection: form.modelSelection } : {}),
      ...(chrome || profile.executionTarget.claudeInChrome ? { claudeInChrome: chrome } : {}),
    };
  }
  if (form.instructions !== profile.instructions) patch.instructions = form.instructions;
  if (form.replyLanguage !== profile.replyLanguage) patch.replyLanguage = form.replyLanguage;
  const permissions: Partial<BotPermissions> = {};
  const cwd = form.cwd.trim();
  if (cwd && cwd !== profile.permissions.cwd) permissions.cwd = cwd;
  if (form.workspaceAccess !== profile.permissions.workspaceAccess) permissions.workspaceAccess = form.workspaceAccess;
  if (form.permissionMode !== profile.permissions.permissionMode) permissions.permissionMode = form.permissionMode;
  const tools = parseTools(form.allowedTools);
  if (form.permissionMode === 'whitelist' && JSON.stringify(tools) !== JSON.stringify(profile.permissions.allowedTools ?? [])) {
    permissions.allowedTools = tools;
  }
  if (Object.keys(permissions).length > 0) patch.permissions = permissions;
  return Object.keys(patch).length > 0 ? patch : null;
}

/** What the page tells the owner after a save (SPEC-002 FR-2). */
export function saveNotice(before: BotProfile, after: BotProfile, patch: BotProfilePatch): string {
  const lines: string[] = [];
  if (after.configRevision !== before.configRevision) {
    lines.push(
      t(
        'Each conversation continues in a fresh session that gets a summary of what was said so far.',
      ),
    );
  }
  if (patch.executionTarget && patch.executionTarget.provider !== before.executionTarget.provider) {
    lines.push(
      t('The runtime restarts for {value0} once the current reply has finished.', {
        value0: patch.executionTarget.provider,
      }),
    );
  } else if (
    patch.executionTarget &&
    (after.executionTarget.claudeInChrome === true) !==
      (before.executionTarget.claudeInChrome === true)
  ) {
    lines.push(
      t(
        'The runtime restarts with Claude in Chrome {value0} once the current reply has finished.',
        { value0: after.executionTarget.claudeInChrome ? 'on' : 'off' },
      ),
    );
  }
  // A core still running the previous version keeps nothing it does not know.
  if (patch.avatar && after.avatar !== patch.avatar) {
    lines.push(t('This cat bot runs an older version that cannot change its look. Restart it and choose again.'));
  }
  return lines.join(' ');
}

export function brandState(profile: BotProfile | null, status: BotStatus): string {
  const target = profile ? `${profile.executionTarget.provider}${profile.executionTarget.model ? ` · ${profile.executionTarget.model}` : ''}` : '';
  return t('{value0} · runtime {value1}', { value0: target, value1: status.runtime.state });
}

// ---- Notes tab --------------------------------------------------------------------

export const SESSION_WORDS: Record<string, string> = {
  none: 'not started yet',
  initializing: 'waking up',
  ready: 'awake',
  sleeping: 'asleep',
  closed: 'asleep',
  stale: 'restarts on the next message',
  failed: 'session failed',
};

export function lastActivity(record: ConversationRecord): string | null {
  const times = [record.lastOwnerMessageAt, record.lastBotMessageAt].filter((time): time is string => Boolean(time)).sort();
  return times.at(-1) ?? null;
}

/** Home first, then the most recently active. */
export function sortNotes(records: readonly ConversationRecord[]): ConversationRecord[] {
  return [...records].sort((a, b) => {
    if (a.role === 'home') return -1;
    if (b.role === 'home') return 1;
    return (lastActivity(b) ?? b.createdAt).localeCompare(lastActivity(a) ?? a.createdAt);
  });
}

export function ago(
  iso: string | null,
  now = Date.now(),
  formatDate = (at: Date) => at.toLocaleDateString(),
): string {
  if (!iso) return t('no messages yet');
  const minutes = Math.round((now - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return t('just now');
  if (minutes < 60) return t('{value0} min ago', { value0: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t('{value0} h ago', { value0: hours });
  return formatDate(new Date(iso));
}

export function noteMeta(record: ConversationRecord, now = Date.now()): string {
  return `${ago(lastActivity(record), now)} · ${t(SESSION_WORDS[record.attachment.state] ?? record.attachment.state)}`;
}

// ---- Life, Telegram and App tabs --------------------------------------------------

export interface LifeForm {
  heartbeat: boolean;
  mode: HeartbeatMode;
  bedtime: string;
  wakeWindowStart: string;
  wakeWindowEnd: string;
  wakeMin: string;
  wakeMax: string;
  regularMin: string;
  regularMax: string;
  idle: string;
}

export function lifeForm(profile: BotProfile): LifeForm {
  return {
    heartbeat: profile.heartbeat.enabled,
    mode: profile.heartbeat.mode,
    bedtime: profile.heartbeat.bedtime,
    wakeWindowStart: profile.heartbeat.wakeWindowStart,
    wakeWindowEnd: profile.heartbeat.wakeWindowEnd,
    wakeMin: String(profile.heartbeat.wakeMinMinutes),
    wakeMax: String(profile.heartbeat.wakeMaxMinutes),
    regularMin: String(profile.heartbeat.regularMinMinutes),
    regularMax: String(profile.heartbeat.regularMaxMinutes),
    idle: String(profile.idleSleepMinutes),
  };
}

function minutes(value: string): number {
  const number = Number(value);
  if (value.trim() === '' || !Number.isFinite(number) || number < 1) throw new Error('Minutes must be at least 1');
  return number;
}

export function lifePatch(form: LifeForm): { heartbeat: HeartbeatPolicy; idleSleepMinutes: number } {
  const problem = heartbeatRhythmProblem(form);
  if (problem) throw new Error(t(problem));
  return {
    heartbeat: {
      enabled: form.heartbeat,
      mode: form.mode,
      bedtime: form.bedtime,
      wakeWindowStart: form.wakeWindowStart,
      wakeWindowEnd: form.wakeWindowEnd,
      wakeMinMinutes: minutes(form.wakeMin),
      wakeMaxMinutes: minutes(form.wakeMax),
      regularMinMinutes: minutes(form.regularMin),
      regularMaxMinutes: minutes(form.regularMax),
    },
    idleSleepMinutes: minutes(form.idle),
  };
}

/** SPEC-011 FR-1: the mode choices; `auto` names what it means for this bot right now. */
export function heartbeatModeOptions(effective: EffectiveHeartbeatMode | null): Array<{ value: HeartbeatMode; label: string }> {
  const auto = t('Automatic: Assist for the Boss Cat, Companion for the others');
  return [
    {
      value: 'auto',
      label: effective
        ? `${auto} (${effective === 'assist' ? t('now Assist') : t('now Companion')})`
        : auto,
    },
    { value: 'assist', label: t('Assist: follow up on work you left unfinished') },
    { value: 'companion', label: t('Companion: greetings and small talk') },
  ];
}

export function nextHeartbeatText(
  status: BotStatus,
  formatTime = (at: Date) => at.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }),
): string {
  if (status.heartbeat.enabled && status.heartbeat.waitingForOwner)
    return t('Own initiative is waiting for you: {value0} unprompted messages in a row went unanswered. It starts again when you write.', {
      value0: String(status.heartbeat.unanswered),
    });
  if (status.heartbeat.enabled && status.heartbeat.nextAt)
    return t('Next activity on its own around {value0}.', {
      value0: formatTime(new Date(status.heartbeat.nextAt)),
    });
  return status.heartbeat.enabled
    ? t('The next activity is planned once the cat bot is up.')
    : t('Own initiative is paused.');
}

export type Fact = [label: string, value: string];

export function telegramFacts(status: TelegramSettingsStatus, profile: BotProfile): Fact[] {
  const facts: Fact[] = [
    [
      'Token',
      status.tokenStored
        ? t('stored, {protection}', {
            protection: t(status.protection === 'os' ? 'encrypted by the OS' : 'in a plain file'),
          })
        : t('not set'),
    ],
    [
      'Polling',
      status.transport?.polling
        ? t('on ({health})', { health: t(status.transport.health) })
        : t('off'),
    ],
    [
      'Owner chat',
      profile.telegram.ownerChatId !== null
        ? String(profile.telegram.ownerChatId)
        : t('not bound yet: send your bot a private message'),
    ],
  ];
  if (status.transport?.lastError) facts.push(['Last error', status.transport.lastError]);
  return facts;
}

export function appFacts(status: BotStatus, version: string): Fact[] {
  return [
    ['Cat bot id', status.id],
    ['Data folder', status.root],
    [
      'Runtime',
      `${t(status.runtime.state)}${status.runtime.pid ? ` (pid ${status.runtime.pid})` : ''}`,
    ],
    ['Version', version],
  ];
}
