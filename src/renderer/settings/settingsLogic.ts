import type {
  BotPermissions,
  BotProfile,
  BotProfilePatch,
  BotStatus,
  ConversationRecord,
  HeartbeatPolicy,
  ModelCatalog,
  ProviderInfo,
  TelegramSettingsStatus,
} from '../../core/types.ts';

/**
 * SPEC-002 FR-1–FR-6, SPEC-003 FR-6: what the settings and first-run pages
 * decide, apart from React, so it is tested with node:test.
 */

// ---- Providers and models ---------------------------------------------------------

/** The model menu's "type your own" entry. */
export const CUSTOM_MODEL = '__custom__';

export function providerLabel(provider: ProviderInfo): string {
  return `${provider.label} · ${provider.command}${provider.installed === false ? ' (not found)' : ''}`;
}

/** The provider menu; a saved provider this build does not list is kept so it is not lost on save. */
export function providerChoices(providers: readonly ProviderInfo[], current: string | null): ProviderInfo[] {
  const list = [...providers];
  if (current && !list.some((provider) => provider.id === current)) list.push({ id: current, label: current, command: current, installed: null });
  return list;
}

/** First run: Claude when installed, else any installed CLI, else the first one. */
export function preferredProvider(providers: readonly ProviderInfo[]): string {
  return (providers.find((provider) => provider.id === 'claude' && provider.installed)
    ?? providers.find((provider) => provider.installed)
    ?? providers[0])?.id ?? 'claude';
}

export function providerHint(providers: readonly ProviderInfo[], id: string): { text: string; warn: boolean } {
  const provider = providers.find((item) => item.id === id);
  if (!provider || provider.installed === null) return { text: '', warn: false };
  if (provider.installed === false) {
    return { text: `"${provider.command}" was not found on PATH. Install it and sign in once in a terminal before the bot can answer.`, warn: true };
  }
  return { text: `Uses your own "${provider.command}" sign-in and subscription.`, warn: false };
}

export interface MenuOption {
  value: string;
  text: string;
}

export function modelOptions(catalog: ModelCatalog): MenuOption[] {
  const fallback = catalog.models.find((model) => model.id === catalog.defaultModel);
  return [
    { value: '', text: `Provider default${fallback ? ` (${fallback.label})` : ''}` },
    ...catalog.models.map((model) => ({ value: model.id, text: model.label === model.id ? model.id : `${model.label} · ${model.id}` })),
    { value: CUSTOM_MODEL, text: 'Other model id…' },
  ];
}

/** Where the menu starts for a saved model: the default, a listed model, or "other" with the id typed in. */
export function modelSelection(catalog: ModelCatalog, current: string | null): { select: string; custom: string } {
  if (!current) return { select: '', custom: '' };
  if (catalog.models.some((model) => model.id === current)) return { select: current, custom: '' };
  return { select: CUSTOM_MODEL, custom: current };
}

export function readModel(select: string, custom: string): string | null {
  if (select === CUSTOM_MODEL) return custom.trim() || null;
  return select || null;
}

export function modelSourceHint(source: ModelCatalog['source']): string {
  if (source === 'runtime') return 'Models reported by the running runtime.';
  if (source === 'packaged') return 'Models from the catalog shipped with cats-runtime.';
  return 'No catalog for this CLI; type a model id or keep the default.';
}

export function emptyCatalog(provider: string): ModelCatalog {
  return { provider, defaultModel: null, models: [], source: 'none' };
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

// ---- Bot tab ----------------------------------------------------------------------

export interface BotForm {
  name: string;
  provider: string;
  model: string | null;
  /** Applies only while the provider is Claude Code. */
  claudeInChrome: boolean;
  instructions: string;
  cwd: string;
  workspaceAccess: BotPermissions['workspaceAccess'];
  permissionMode: BotPermissions['permissionMode'];
  allowedTools: string;
}

export function botForm(profile: BotProfile): BotForm {
  return {
    name: profile.name,
    provider: profile.executionTarget.provider,
    model: profile.executionTarget.model,
    claudeInChrome: profile.executionTarget.claudeInChrome === true,
    instructions: profile.instructions,
    cwd: profile.permissions.cwd,
    workspaceAccess: profile.permissions.workspaceAccess,
    permissionMode: profile.permissions.permissionMode,
    allowedTools: (profile.permissions.allowedTools ?? []).join(', '),
  };
}

export function parseTools(text: string): string[] {
  return text.split(',').map((tool) => tool.trim()).filter(Boolean);
}

/** Only what changed, so an unchanged target or permission never bumps the configuration revision. */
export function botPatch(profile: BotProfile, form: BotForm): BotProfilePatch | null {
  const patch: BotProfilePatch = {};
  const name = form.name.trim();
  if (name && name !== profile.name) patch.name = name;
  const chrome = form.provider === 'claude' && form.claudeInChrome;
  if (form.provider !== profile.executionTarget.provider || form.model !== profile.executionTarget.model
    || chrome !== (profile.executionTarget.claudeInChrome === true)) {
    patch.executionTarget = { provider: form.provider, model: form.model,
      ...(chrome || profile.executionTarget.claudeInChrome ? { claudeInChrome: chrome } : {}) };
  }
  if (form.instructions !== profile.instructions) patch.instructions = form.instructions;
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
    lines.push('Each conversation continues in a fresh session that gets a summary of what was said so far.');
  }
  if (patch.executionTarget && patch.executionTarget.provider !== before.executionTarget.provider) {
    lines.push(`The runtime restarts for ${patch.executionTarget.provider} once the current reply has finished.`);
  } else if (patch.executionTarget && (after.executionTarget.claudeInChrome === true) !== (before.executionTarget.claudeInChrome === true)) {
    lines.push(`The runtime restarts with Claude in Chrome ${after.executionTarget.claudeInChrome ? 'on' : 'off'} once the current reply has finished.`);
  }
  return lines.join(' ');
}

export function brandState(profile: BotProfile | null, status: BotStatus): string {
  const target = profile ? `${profile.executionTarget.provider}${profile.executionTarget.model ? ` · ${profile.executionTarget.model}` : ''}` : '';
  return `${target} · runtime ${status.runtime.state}`;
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

export function ago(iso: string | null, now = Date.now(), formatDate = (at: Date) => at.toLocaleDateString()): string {
  if (!iso) return 'no messages yet';
  const minutes = Math.round((now - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return formatDate(new Date(iso));
}

export function noteMeta(record: ConversationRecord, now = Date.now()): string {
  return `${ago(lastActivity(record), now)} · ${SESSION_WORDS[record.attachment.state] ?? record.attachment.state}`;
}

// ---- Life, Telegram and App tabs --------------------------------------------------

export interface LifeForm {
  heartbeat: boolean;
  wakeMin: string;
  wakeMax: string;
  regularMin: string;
  regularMax: string;
  idle: string;
}

export function lifeForm(profile: BotProfile): LifeForm {
  return {
    heartbeat: profile.heartbeat.enabled,
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
  return {
    heartbeat: {
      enabled: form.heartbeat,
      wakeMinMinutes: minutes(form.wakeMin),
      wakeMaxMinutes: minutes(form.wakeMax),
      regularMinMinutes: minutes(form.regularMin),
      regularMaxMinutes: minutes(form.regularMax),
    },
    idleSleepMinutes: minutes(form.idle),
  };
}

export function nextHeartbeatText(status: BotStatus, formatTime = (at: Date) => at.toLocaleTimeString()): string {
  if (status.heartbeat.enabled && status.heartbeat.nextAt) return `Next heartbeat around ${formatTime(new Date(status.heartbeat.nextAt))}.`;
  return status.heartbeat.enabled ? 'The next heartbeat is drawn once the bot is up.' : 'Heartbeat is paused.';
}

export type Fact = [label: string, value: string];

export function telegramFacts(status: TelegramSettingsStatus, profile: BotProfile): Fact[] {
  const facts: Fact[] = [
    ['Token', status.tokenStored ? `stored, ${status.protection === 'os' ? 'encrypted by the OS' : 'in a plain file'}` : 'not set'],
    ['Polling', status.transport?.polling ? `on (${status.transport.health})` : 'off'],
    ['Owner chat', profile.telegram.ownerChatId !== null ? String(profile.telegram.ownerChatId) : 'not bound yet: send your bot a private message'],
  ];
  if (status.transport?.lastError) facts.push(['Last error', status.transport.lastError]);
  return facts;
}

export function appFacts(status: BotStatus, version: string): Fact[] {
  return [
    ['Bot id', status.id],
    ['Data folder', status.root],
    ['Runtime', `${status.runtime.state}${status.runtime.pid ? ` (pid ${status.runtime.pid})` : ''}`],
    ['Version', version],
  ];
}
