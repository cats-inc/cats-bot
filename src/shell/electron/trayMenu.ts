import type { BotStatus } from '../../core/bot.ts';
import type { ConversationRecord } from '../../core/types.ts';

/**
 * SPEC-001 FR-33: what the tray menu offers, as plain data so it can be
 * tested without Electron. The tray turns these items into native menu items.
 *
 * Menu shape adapted from cats-platform `desktop/host/trayMenu.ts` at
 * revision 595e9ca (MIT), per ADR-001 §1.
 */

export interface TrayMenuModel {
  botName: string;
  status: BotStatus;
  conversations: ConversationRecord[];
  heartbeatEnabled: boolean;
  openAtLogin: boolean;
  openAtLoginAvailable: boolean;
  awaitingOwner: number;
  /** SPEC-002 FR-7. */
  floatingVisible: boolean;
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

export function runtimeLabel(status: BotStatus): string {
  switch (status.runtime.state) {
    case 'ready':
      return 'runtime ready';
    case 'starting':
      return 'runtime starting';
    case 'failed':
      return 'runtime failed, retrying';
    default:
      return 'runtime stopped';
  }
}

export function unreadTotal(conversations: ConversationRecord[]): number {
  return conversations.reduce((sum, record) => sum + record.unreadCount, 0);
}

export function buildTrayTooltip(model: TrayMenuModel): string {
  const unread = unreadTotal(model.conversations);
  return `${model.botName} (${runtimeLabel(model.status)})${unread ? ` - ${unread} unread` : ''}`;
}

export function buildTrayMenuTemplate(model: TrayMenuModel, actions: TrayMenuActions): TrayMenuItem[] {
  const home = model.conversations.find((record) => record.role === 'home');
  const notes = model.conversations.filter((record) => record.role === 'note');
  const unread = unreadTotal(model.conversations);
  const template: TrayMenuItem[] = [
    {
      label: `${model.botName}: ${runtimeLabel(model.status)}${unread ? `, ${unread} unread` : ''}`
        + `${model.awaitingOwner ? `, ${model.awaitingOwner} waiting for you` : ''}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: home && home.unreadCount ? `Open home note (${home.unreadCount})` : 'Open home note',
      click: () => actions.onOpenConversation(home?.id ?? 'home'),
    },
  ];
  if (model.status.pendingInteractions && model.status.queue.running) {
    const conversationId = model.status.queue.running.conversationId;
    template.push({ label: `Provider requests (${model.status.pendingInteractions})`, click: () => actions.onOpenConversation(conversationId) });
  }
  if (notes.length > 0) {
    template.push({
      label: 'Notes',
      submenu: notes.map((note) => ({
        label: note.unreadCount ? `${note.title} (${note.unreadCount})` : note.title,
        click: () => actions.onOpenConversation(note.id),
      })),
    });
  }
  template.push(
    { label: 'New note', click: () => actions.onNewNote() },
    { label: 'Manage notes…', click: () => actions.onOpenSettings('notes') },
    { type: 'separator' },
    {
      label: model.heartbeatEnabled ? 'Pause heartbeat' : 'Resume heartbeat',
      click: () => actions.onToggleHeartbeat(!model.heartbeatEnabled),
    },
  );
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
  return template;
}
