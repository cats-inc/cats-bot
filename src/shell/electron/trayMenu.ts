import type { BotStatus } from '../../core/bot.ts';
import type { ConversationRecord, DesktopControlHolding } from '../../core/types.ts';
import { translate, type Locale } from '../../shared/language.ts';

/**
 * SPEC-001 FR-33: what the tray menu offers, as plain data so it can be
 * tested without Electron. The tray turns these items into native menu items.
 *
 * Menu shape adapted from cats-platform `desktop/host/trayMenu.ts` at
 * revision 595e9ca (MIT), per ADR-001 §1.
 */

/** SPEC-006 BDC-10: what the tray shows of desktop control. */
export interface TrayDesktopControl {
  /** The profile switch (BDC-02). */
  enabled: boolean;
  /** Grant requests waiting for the owner, in every conversation. */
  pendingRequests: number;
  /** A conversation with a request waiting, so the tray can open its note. */
  waitingConversationId: string | null;
  /** Conversations whose turn holds control, with the app (SPEC-133 DC-11). */
  holding: DesktopControlHolding[];
}

export interface TrayMenuModel {
  locale?: Locale;
  botName: string;
  status: BotStatus;
  conversations: ConversationRecord[];
  heartbeatEnabled: boolean;
  openAtLogin: boolean;
  openAtLoginAvailable: boolean;
  awaitingOwner: number;
  /** SPEC-002 FR-7. */
  floatingVisible: boolean;
  desktopControl: TrayDesktopControl;
}

export interface TrayMenuActions {
  onOpenConversation(conversationId: string): void;
  onNewNote(): void;
  /** SPEC-002 FR-4: opens the settings window, on a given tab when one is named. */
  onOpenSettings(tab?: string): void;
  onCheckForUpdates?(): void;
  onToggleHeartbeat(enabled: boolean): void;
  onToggleOpenAtLogin(enabled: boolean): void;
  onToggleFloating(visible: boolean): void;
  /** SPEC-006 BDC-10: stops desktop control in every conversation. */
  onStopDesktopControl(): void;
  onQuit(): void;
}

export interface TrayMenuItem {
  label?: string;
  type?: 'normal' | 'separator' | 'checkbox';
  enabled?: boolean;
  checked?: boolean;
  click?: () => void;
  submenu?: TrayMenuItem[];
}

export function runtimeLabel(status: BotStatus, locale: Locale = 'en'): string {
  const t = (text: string) => translate(locale, text);
  switch (status.runtime.state) {
    case 'ready':
      return t('runtime ready');
    case 'starting':
      return t('runtime starting');
    case 'failed':
      return t('runtime failed, retrying');
    default:
      return t('runtime stopped');
  }
}

export function unreadTotal(conversations: ConversationRecord[]): number {
  return conversations.reduce((sum, record) => sum + record.unreadCount, 0);
}

/** The apps held now, each once. */
export function heldApps(desktop: TrayDesktopControl): string[] {
  return [...new Set(desktop.holding.map((row) => row.app))];
}

export function desktopControlLabel(desktop: TrayDesktopControl, locale: Locale = 'en'): string {
  const t = (message: string, values?: Record<string, unknown>) =>
    translate(locale, message, values);
  const held = heldApps(desktop);
  if (held.length) return t('the bot is operating {apps}', { apps: held.join(', ') });
  if (desktop.pendingRequests) return t('desktop control request waiting');
  return desktop.enabled ? t('desktop control on') : '';
}

export function buildTrayTooltip(model: TrayMenuModel): string {
  const unread = unreadTotal(model.conversations);
  const desktop = desktopControlLabel(model.desktopControl, model.locale);
  return `${model.botName} (${runtimeLabel(model.status, model.locale)})${unread ? ` - ${translate(model.locale ?? 'en', '{count} unread', { count: unread })}` : ''}${desktop ? ` - ${desktop}` : ''}`;
}

export function buildTrayMenuTemplate(
  model: TrayMenuModel,
  actions: TrayMenuActions,
): TrayMenuItem[] {
  const t = (text: string, values?: Record<string, unknown>) =>
    translate(model.locale ?? 'en', text, values);
  const home = model.conversations.find((record) => record.role === 'home');
  const notes = model.conversations.filter((record) => record.role === 'note');
  const unread = unreadTotal(model.conversations);
  const desktop = model.desktopControl;
  const held = heldApps(desktop);
  const template: TrayMenuItem[] = [];
  if (held.length) {
    // SPEC-006 BDC-10 / SPEC-133 DC-12: while the bot holds control, Stop is the nearest item.
    template.push({ label: `Stop desktop control (${held.join(', ')})`, click: () => actions.onStopDesktopControl() },
      { type: 'separator' });
  }
  template.push(
    {
      label:
        `${model.botName}: ${runtimeLabel(model.status)}${unread ? `, ${unread} unread` : ''}` +
        `${model.awaitingOwner ? `, ${model.awaitingOwner} waiting for you` : ''}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label:
        home && home.unreadCount
          ? `Open direct message (${home.unreadCount})`
          : 'Open direct message',
      click: () => actions.onOpenConversation(home?.id ?? 'home'),
    },
  );
  if (model.status.pendingInteractions && model.status.queue.running) {
    const conversationId = model.status.queue.running.conversationId;
    template.push({ label: `Provider requests (${model.status.pendingInteractions})`, click: () => actions.onOpenConversation(conversationId) });
  }
  if (desktop.pendingRequests) {
    // Only the note (or the CLI) answers a grant request; the tray opens the note that waits.
    template.push({
      label: `Desktop control requests (${desktop.pendingRequests})`,
      click: () => actions.onOpenConversation(desktop.waitingConversationId ?? home?.id ?? 'home'),
    });
  }
  if (notes.length > 0) {
    template.push({
      label: 'Conversations',
      submenu: notes.map((note) => ({
        label: note.unreadCount ? `${note.title} (${note.unreadCount})` : note.title,
        click: () => actions.onOpenConversation(note.id),
      })),
    });
  }
  template.push(
    { label: 'New conversation', click: () => actions.onNewNote() },
    { label: 'Manage conversations…', click: () => actions.onOpenSettings('notes') },
    { type: 'separator' },
    {
      label: model.heartbeatEnabled ? 'Pause heartbeat' : 'Resume heartbeat',
      click: () => actions.onToggleHeartbeat(!model.heartbeatEnabled),
    },
  );
  if (!held.length && (desktop.enabled || desktop.pendingRequests)) {
    template.push({ label: 'Stop desktop control', click: () => actions.onStopDesktopControl() });
  }
  template.push({
    label: 'Show floating cat',
    type: 'checkbox',
    checked: model.floatingVisible,
    click: () => actions.onToggleFloating(!model.floatingVisible),
  });
  if (model.openAtLoginAvailable) {
    template.push({
      label: 'Start at login',
      type: 'checkbox',
      checked: model.openAtLogin,
      click: () => actions.onToggleOpenAtLogin(!model.openAtLogin),
    });
  }
  template.push(
    { label: 'Settings…', click: () => actions.onOpenSettings() },
    { label: 'Check for Updates…', click: () => actions.onCheckForUpdates?.() },
    { type: 'separator' },
    { label: 'Quit', click: () => actions.onQuit() },
  );
  // Translate only product-owned labels. Conversation titles remain the owner's words.
  for (const item of template) {
    if (item.label) {
      const count =
        /^(Open direct message|Provider requests|Desktop control requests|Stop desktop control) \((.+)\)$/u.exec(
          item.label,
        );
      item.label = count ? `${t(count[1]!)} (${count[2]})` : t(item.label);
    }
  }
  template.find((item) => item.enabled === false)!.label =
    `${model.botName}: ${runtimeLabel(model.status, model.locale)}` +
    (unread ? `, ${t('{count} unread', { count: unread })}` : '') +
    (model.awaitingOwner
      ? `, ${t('{count} waiting for you', { count: model.awaitingOwner })}`
      : '');
  return template;
}
