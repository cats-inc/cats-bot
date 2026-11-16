import { conversationTitle, t } from '../localeStore.ts';
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
import type { BotAction, BotRow, NoteLayer } from '../bridge.ts';
import {
  askTitle,
  carryChoice,
  currentChoice,
  desktopControlAllowed,
  permissionPatch,
  type PermissionChoice,
  type StoredPermissions,
} from './permissionChoices.ts';

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
  return ['codex', 'claude', 'antigravity', 'grok', 'muse', 'kimi'].flatMap((id) =>
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

// ---- The cat bot's three pages (ADR-030) ------------------------------------------

/**
 * What Name and look, Provider and model, and Permissions show. The pages keep only the
 * owner's edits on top of this, so the profile read again on focus never undoes one.
 */
export interface BotSettings {
  name: string;
  avatar: BotAvatar;
  instructions: string;
  replyLanguage: BotReplyLanguage;
  /** The floating Cat, the shell's and not the profile's. */
  floating: boolean;
  provider: string;
  /** Applies only while the provider is Claude Code. */
  claudeInChrome: boolean;
  cwd: string;
  permission: PermissionChoice;
  desktopControl: boolean;
}

export type BotEdits = Partial<BotSettings>;
export type BotPage = 'look' | 'brain' | 'perm';

const PAGE_OF: Record<keyof BotSettings, BotPage> = {
  name: 'look', avatar: 'look', instructions: 'look', replyLanguage: 'look', floating: 'look',
  provider: 'brain',
  claudeInChrome: 'perm', cwd: 'perm', permission: 'perm', desktopControl: 'perm',
};

export function storedPermissions(profile: BotProfile): StoredPermissions {
  return {
    provider: profile.executionTarget.provider,
    providerPolicy: profile.providerPolicy,
    workspaceAccess: profile.permissions.workspaceAccess,
    permissionMode: profile.permissions.permissionMode,
  };
}

export function botSettings(profile: BotProfile, floating: boolean): BotSettings {
  return {
    name: profile.name,
    avatar: resolveBotAvatar(profile.avatar),
    instructions: profile.instructions,
    replyLanguage: profile.replyLanguage,
    floating,
    provider: profile.executionTarget.provider,
    claudeInChrome: profile.executionTarget.claudeInChrome === true,
    cwd: profile.permissions.cwd,
    permission: currentChoice(storedPermissions(profile)),
    desktopControl: profile.desktopControl.enabled,
  };
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The edits that still differ from what is there; an edit put back is no edit. */
export function liveEdits(base: BotSettings, edits: BotEdits): BotEdits {
  const live: BotEdits = {};
  for (const [key, value] of Object.entries(edits) as Array<[keyof BotSettings, unknown]>) {
    if (!same(value, base[key])) (live as Record<string, unknown>)[key] = value;
  }
  return live;
}

/** The pages with an edit not yet saved; a model chosen on the menu counts for Provider and model. */
export function editedPages(base: BotSettings, edits: BotEdits, modelEdited: boolean): Set<BotPage> {
  const pages = new Set<BotPage>();
  for (const key of Object.keys(liveEdits(base, edits)) as Array<keyof BotSettings>) pages.add(PAGE_OF[key]);
  if (modelEdited) pages.add('brain');
  return pages;
}

/**
 * A provider chosen: the permission choice goes with it, and desktop control where it cannot stay.
 * Choosing the saved provider again brings back what is saved, so looking at another changes nothing.
 */
export function withProvider(base: BotSettings, view: BotSettings, provider: string): BotEdits {
  if (provider === base.provider) return { provider, permission: base.permission, desktopControl: base.desktopControl };
  const permission = carryChoice(view.permission, view.provider, provider);
  return {
    provider,
    permission,
    ...(view.desktopControl && !desktopControlAllowed(provider, permission) ? { desktopControl: false } : {}),
  };
}

/** A permission chosen: desktop control turns off where it cannot stay on. */
export function withPermission(view: BotSettings, permission: PermissionChoice): BotEdits {
  return {
    permission,
    ...(view.desktopControl && !desktopControlAllowed(view.provider, permission) ? { desktopControl: false } : {}),
  };
}

/**
 * SPEC-010 FR-19: what is wrong with the text, as translation keys. A value unchanged from
 * the profile is not judged: it predates the rule and keeps working.
 */
export function botTextErrors(profile: BotProfile, form: Pick<BotSettings, 'name' | 'instructions'>): { name: string | null; instructions: string | null } {
  const name = normalizeBotName(form.name);
  const persona = normalizeBotPersona(form.instructions);
  const nameProblem = name === normalizeBotName(profile.name) ? null : botNameProblem(name);
  const personaProblem = persona === normalizeBotPersona(profile.instructions) ? null : botPersonaProblem(persona);
  return {
    name: nameProblem ? botNameMessage(nameProblem) : null,
    instructions: personaProblem ? botPersonaMessage(personaProblem) : null,
  };
}

/** The model the save sends: the saved one until the menu is touched (`keepTarget`). */
export interface ModelTarget {
  model: string | null;
  modelSelection?: ModelSelection;
}

/** Only what changed, so nothing untouched bumps the configuration revision (SPEC-002 FR-2). */
export function botPatch(profile: BotProfile, view: BotSettings, target: ModelTarget): BotProfilePatch | null {
  const patch: BotProfilePatch = {};
  const name = view.name.trim();
  if (name && name !== profile.name.trim()) patch.name = name;
  if (view.avatar !== resolveBotAvatar(profile.avatar)) patch.avatar = view.avatar;
  if (view.instructions !== profile.instructions) patch.instructions = view.instructions;
  if (view.replyLanguage !== profile.replyLanguage) patch.replyLanguage = view.replyLanguage;
  const chrome = view.provider === 'claude' && view.claudeInChrome;
  if (
    view.provider !== profile.executionTarget.provider ||
    target.model !== profile.executionTarget.model ||
    !same(target.modelSelection, profile.executionTarget.modelSelection) ||
    chrome !== (profile.executionTarget.claudeInChrome === true)
  ) {
    patch.executionTarget = {
      provider: view.provider,
      model: target.model,
      ...(target.modelSelection ? { modelSelection: target.modelSelection } : {}),
      ...(chrome || profile.executionTarget.claudeInChrome ? { claudeInChrome: chrome } : {}),
    };
  }
  const permissions: Partial<BotPermissions> = {};
  const cwd = view.cwd.trim();
  if (cwd && cwd !== profile.permissions.cwd) permissions.cwd = cwd;
  const choice = permissionPatch(storedPermissions(profile), view.provider, view.permission);
  if (choice?.providerPolicy !== undefined) patch.providerPolicy = choice.providerPolicy;
  Object.assign(permissions, choice?.permissions);
  if (Object.keys(permissions).length > 0) patch.permissions = permissions;
  if (view.desktopControl !== profile.desktopControl.enabled) patch.desktopControl = { enabled: view.desktopControl };
  return Object.keys(patch).length > 0 ? patch : null;
}

/** What the save bar says saving will do (SPEC-002 FR-2), before it is pressed. */
export function pendingNotice(profile: BotProfile, view: BotSettings, patch: BotProfilePatch | null, providerLabel: string, floatingChanged: boolean): string[] {
  const lines: string[] = [];
  const providerChanged = view.provider !== profile.executionTarget.provider;
  if (providerChanged) {
    lines.push(t('Switching to {provider}: the runtime restarts once the current reply has finished.', { provider: providerLabel }));
    if (view.permission.ask !== currentChoice(storedPermissions(profile)).ask) {
      lines.push(t('Permissions become "{choice}".', { choice: askTitle(view.provider, providerLabel, view.permission.ask) }));
    }
  } else if (patch?.executionTarget && (patch.executionTarget.claudeInChrome === true) !== (profile.executionTarget.claudeInChrome === true)) {
    lines.push(patch.executionTarget.claudeInChrome
      ? t('The runtime restarts with Claude in Chrome on once the current reply has finished.')
      : t('The runtime restarts with Claude in Chrome off once the current reply has finished.'));
  }
  const replaces = patch !== null && (patch.executionTarget !== undefined || patch.instructions !== undefined
    || patch.replyLanguage !== undefined || patch.permissions !== undefined || patch.providerPolicy !== undefined);
  if (replaces) lines.push(t('Each conversation starts a fresh session with its next message, with a summary of what was said so far.'));
  else if (patch?.name !== undefined || patch?.avatar !== undefined || floatingChanged) {
    lines.push(t('The name and look change no conversation.'));
  }
  if (profile.desktopControl.enabled && !view.desktopControl) lines.push(t('Turning off desktop control revokes every app grant at once.'));
  return lines;
}

/** A core still running the previous version keeps nothing it does not know (SPEC-008 FR-29). */
export function staleLook(patch: BotProfilePatch, after: BotProfile): boolean {
  return patch.avatar !== undefined && after.avatar !== patch.avatar;
}

/**
 * The rail under the bot's name: its Runtime's state on the first line; the provider, model and effort follow on
 * a line of their own that wraps, so none of them is cut (`executionSummary`).
 */
const RUNTIME_WORDS: Record<string, string> = {
  stopped: 'Runtime stopped',
  starting: 'Runtime starting',
  ready: 'Runtime ready',
  failed: 'Runtime failed',
};

export function brandState(status: BotStatus): string {
  const words = RUNTIME_WORDS[status.runtime.state];
  return words ? t(words) : t('Runtime {value0}', { value0: status.runtime.state });
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

/**
 * SPEC-002 FR-5: where a note window lives, from the top of the screen down, as the list's layer menu orders
 * them and its glyph stacks them. A platform without the desktop layers offers the first two.
 */
export const NOTE_LAYER_ORDER: readonly NoteLayer[] = ['top', 'normal', 'desktop', 'wallpaper'];

/** The short name the list's layer button shows, and the line under it in the menu. */
export const NOTE_LAYER_NAMES: Record<NoteLayer, { name: string; detail: string }> = {
  top: { name: 'On top', detail: 'Stays above every other window' },
  normal: { name: 'Normal', detail: 'Comes forward and goes back like any window' },
  desktop: { name: 'Desktop', detail: 'Below every window, above the desktop icons' },
  wallpaper: { name: 'Wallpaper', detail: 'Below the desktop icons, to look at only' },
};

export function layerStack(available: readonly NoteLayer[]): NoteLayer[] {
  return NOTE_LAYER_ORDER.filter((layer) => available.includes(layer));
}

/** SPEC-002 FR-5 / FR-5b: what the confirmation under Delete, or the direct message's Clear, says. */
export interface RemovalCopy {
  title: string;
  detail: string;
  action: string;
  done: string;
}

export function removalCopy(record: ConversationRecord, telegram: boolean): RemovalCopy {
  const title = conversationTitle(record);
  if (record.role === 'home') {
    return {
      title: t('Clear every message in the direct message?'),
      detail: [
        t('Its history and its CLI sessions are deleted, and the next message starts from nothing. The direct message, its layer and its schedules stay.'),
        ...(telegram ? [t('The Telegram chat keeps its own copy.')] : []),
      ].join(' '),
      action: t('Clear'),
      done: t('Cleared the direct message'),
    };
  }
  return {
    title: t('Delete “{value0}”?', { value0: title }),
    detail: record.contactOf
      ? t('Only this side’s history and sessions are deleted. When {value0} writes again, a new contact note starts.', {
        value0: record.contactName ?? record.contactOf,
      })
      : t('Its history, its schedules and its CLI sessions are deleted. This cannot be undone.'),
    action: t('Delete'),
    done: t('Deleted {value0}', { value0: title }),
  };
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
    return t('Own initiative is waiting for you: {value0} own-initiative messages in a row went unanswered. It starts again when you write.', {
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

// ---- Cats Bot Settings → Bots ------------------------------------------------------

export const BOT_STATE_LABELS: Record<BotRow['state'], string> = {
  starting: 'Starting',
  running: 'Running',
  stopped: 'Stopped',
  failed: 'Failed',
  external: 'Running in another program',
  archived: 'Archived',
  missing: 'Folder missing',
};

/** A row's second line: the provider and the state, and the pid only of another program's process. */
export function botStateLine(bot: Pick<BotRow, 'state' | 'pid' | 'provider' | 'providerLabel'>): string {
  const state = t(BOT_STATE_LABELS[bot.state]);
  const detail = bot.state === 'external' && bot.pid ? ` (pid ${bot.pid})` : '';
  const provider = bot.providerLabel ?? bot.provider;
  return provider ? `${provider} · ${state}${detail}` : `${state}${detail}`;
}

/**
 * SPEC-009 FR-11: what the Boss Cat row says about the holder's tools. Waiting for its next reply is the normal
 * state after the role moves, said plainly; only a provider that cannot give the tools is a warning.
 */
export function bossCatToolsHint(holder: Pick<BotRow, 'name' | 'provider' | 'providerLabel' | 'bossCatTools'>): { text: string; warn: boolean } | null {
  const provider = holder.providerLabel ?? holder.provider ?? '';
  switch (holder.bossCatTools) {
    case 'connected':
      return { text: t('The Boss Cat tools are connected.'), warn: false };
    case 'pending':
      return { text: t('{name} gets the Boss Cat tools at its next reply: your next message or its own next activity. Its conversations stay as they are, and nothing needs restarting.', { name: holder.name }), warn: false };
    case 'notRunning':
      return { text: t('{name} is not running. It gets the Boss Cat tools at its next reply after it starts.', { name: holder.name }), warn: false };
    case 'external':
      return { text: t('{name} runs in another program, so it does not get the Boss Cat tools. They come once Cats Bot runs it.', { name: holder.name }), warn: true };
    case 'needsAccess':
      return { text: t('{provider} gives the Boss Cat tools once it uses its native tools: in {name}\'s Settings → Permissions, choose "Follow {provider}\'s own settings".', { provider, name: holder.name }), warn: true };
    case 'unsupported':
      return { text: t('{provider} does not support the Boss Cat tools. {name} keeps the role and gets them at its next reply after moving to another provider.', { provider, name: holder.name }), warn: true };
    default:
      return null;
  }
}

/**
 * SPEC-009 FR-2: the Boss Cat menu assigns, moves or clears the role. An empty
 * choice clears it from the holder; choosing the holder again changes nothing.
 */
export function bossCatChoice(holder: string | null, chosen: string): { id: string; action: Extract<BotAction, 'makeBossCat' | 'clearBossCat'> } | null {
  if (chosen === (holder ?? '')) return null;
  if (chosen) return { id: chosen, action: 'makeBossCat' };
  return holder ? { id: holder, action: 'clearBossCat' } : null;
}
