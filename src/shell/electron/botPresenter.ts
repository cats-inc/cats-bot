import type { RemoteBotCore } from '../../core/host-api/remote.ts';
import type { BotHostEvent } from '../../core/types.ts';
import { translate, type LanguageState, type Locale } from '../../shared/language.ts';
import type { HostedCore } from './coreHost.ts';
import { FloatingBot } from './floatingBot.ts';
import { SettingsWindow } from './settingsWindow.ts';
import type { TrayDesktopControl, BotMenuModel } from './trayMenu.ts';
import type { DesktopHost } from './win32Desktop.ts';
import type { WindowIdentity } from './windowIdentity.ts';
import { NoteWindows } from './windows.ts';
import { diagnosticError } from '../../shared/diagnosticLog.ts';

/**
 * PLAN-009 2.3 (SPEC-008 FR-17): one bot as the hub presents it. Its notes,
 * floating Cat and settings window are bound to its id and reach only its
 * core; its events go only to its own windows. View state stays in the bot
 * root's `shell-state.json` (FR-18).
 */

export interface PresenterHost {
  preloadPath: string;
  rendererDir: string;
  iconPath: string;
  desktop: DesktopHost | null;
  log(line: string, level?: 'info' | 'warn' | 'error'): void;
  isQuitting(): boolean;
  /** The hub's display language (FR-18). */
  locale(): Locale;
  refreshTray(): void;
  /** Every event of this bot's core, after its windows had it. */
  event?(presenter: BotPresenter, event: BotHostEvent): void;
  /** A `cats-bot quit` handed to this bot's core. */
  quitRequested(presenter: BotPresenter): void;
}

export type WindowRole = 'note' | 'settings' | 'floating';

/** The per-Cat menu state; the hub adds only the display locale. */
export type BotTrayModel = Omit<BotMenuModel, 'locale'>;

export class BotPresenter {
  readonly botId: string;
  readonly root: string;
  readonly hosted: HostedCore;
  readonly core: RemoteBotCore;
  readonly windows: NoteWindows;
  readonly settings: SettingsWindow;
  readonly floating: FloatingBot;
  private readonly host: PresenterHost;
  private stopping = false;
  private unsubscribe: (() => void) | null = null;

  /**
   * `slot` is the bot's place among the hub's bots: windows that have no
   * remembered position open a step apart, so two bots never stack exactly.
   */
  constructor(host: PresenterHost, botId: string, root: string, hosted: HostedCore, identity: WindowIdentity, slot = 0) {
    this.host = host;
    this.botId = botId;
    this.root = root;
    this.hosted = hosted;
    this.core = hosted.core;
    const pages = { preloadPath: host.preloadPath, rendererDir: host.rendererDir, iconPath: host.iconPath, identity };
    this.windows = new NoteWindows({
      ...pages,
      core: this.core,
      botRoot: root,
      isQuitting: () => this.stopping || host.isQuitting(),
      desktop: host.desktop,
      log: host.log,
      slot,
    });
    this.settings = new SettingsWindow(pages);
    this.floating = new FloatingBot({
      ...pages,
      log: host.log,
      state: () => this.windows.shellState.floatingBot,
      persist: () => this.windows.persist(),
      slot,
    });
  }

  /** Which of this bot's windows a renderer belongs to, if any. */
  roleOf(webContentsId: number): WindowRole | null {
    if (this.windows.windowFor(webContentsId)) return 'note';
    if (this.settings.owns(webContentsId)) return 'settings';
    if (this.floating.owns(webContentsId)) return 'floating';
    return null;
  }

  t(message: string): string {
    return translate(this.host.locale(), message);
  }

  openSettings(tab?: string): void {
    void this.settings.open(tab).catch((error: unknown) => this.host.log(`open settings failed: ${errorMessage(error)}`, 'error'));
  }

  setFloatingVisible(visible: boolean): void {
    if (visible) {
      void this.floating.show().catch((error: unknown) => this.host.log(`floating bot failed: ${errorMessage(error)}`, 'error'));
    } else {
      this.floating.hide();
    }
    this.host.refreshTray();
  }

  /** SPEC-006 BDC-10: whether desktop control is on, which note has a grant request waiting, and what is held. */
  private async trayDesktopControl(): Promise<TrayDesktopControl> {
    const state = await this.core.desktopControlState();
    let waitingConversationId: string | null = null;
    if (state.pendingRequests > 0) {
      for (const conversationId of state.conversations) {
        const one = await this.core.desktopControlState(conversationId).catch(() => null);
        if (one?.conversation?.pendingRequests.length) {
          waitingConversationId = conversationId;
          break;
        }
      }
    }
    return { enabled: state.enabled, pendingRequests: state.pendingRequests, waitingConversationId, holding: state.holding };
  }

  async trayModel(): Promise<BotTrayModel> {
    const [profile, conversations, desktopControl, status] = await Promise.all([
      this.core.getProfile(), this.core.listConversations(), this.trayDesktopControl(), this.core.status(),
    ]);
    return {
      botName: profile.name,
      status,
      conversations,
      heartbeatEnabled: profile.heartbeat.enabled,
      awaitingOwner: status.awaitingOwner,
      floatingVisible: this.windows.shellState.floatingBot.visible,
      desktopControl,
    };
  }

  private async showBubble(conversationId: string, text: string): Promise<void> {
    const [profile, conversations] = await Promise.all([this.core.getProfile(), this.core.listConversations()]);
    const record = conversations.find((item) => item.id === conversationId);
    const from = !record || record.role === 'home' ? profile.name : `${profile.name} · ${record.title}`;
    this.floating.bubble({ conversationId, from, text });
  }

  private onEvent(event: BotHostEvent): void {
    this.windows.broadcast(event);
    this.settings.broadcast(event);
    this.floating.broadcast(event);
    const refresh = () => this.host.refreshTray();
    if (event.type === 'provider.interactions') {
      if (event.notify && !this.windows.isFocused(event.conversationId)) {
        void this.showBubble(event.conversationId, this.t('The provider is waiting for your response.'));
      }
      refresh();
    }
    if (event.type === 'desktop.control') {
      // BDC-12: like the Telegram notice, the bubble names no app, path or request.
      if (event.notify && event.conversationId && !this.windows.isFocused(event.conversationId)) {
        void this.showBubble(event.conversationId, this.t('A desktop control request is waiting for you.'));
      }
      refresh();
    }
    if (event.type === 'turn.completed' && event.workItem.state === 'completed' && event.workItem.result?.text
      && !this.windows.isFocused(event.conversationId)) {
      void this.showBubble(event.conversationId, event.workItem.result.text);
    }
    if (event.type === 'host.handoff' && event.message.kind === 'open') {
      void this.windows.open(event.message.conversationId ?? 'home');
    }
    if (event.type === 'host.handoff' && event.message.kind === 'quit') this.host.quitRequested(this);
    if (event.type === 'conversation.updated' || event.type === 'runtime.status' || event.type === 'work.awaitingOwner'
      || event.type === 'turn.completed') {
      refresh();
    }
    this.host.event?.(this, event);
  }

  /** Follows the core's events and opens what was open before. */
  async start(): Promise<void> {
    this.unsubscribe = this.core.subscribe((event) => this.onEvent(event));
    // A token the CLI stored as a file is re-stored with the OS facility.
    void this.core.protectSecretsAtRest().catch((error: unknown) => this.host.log(`secret re-store failed: ${errorMessage(error)}`, 'error'));
    if (this.windows.shellState.floatingBot.visible) this.setFloatingVisible(true);
    for (const conversationId of this.windows.previouslyOpen()) {
      await this.windows.open(conversationId, { restore: true }).catch((error: unknown) => {
        this.host.log(`reopen conversation failed: ${errorMessage(error)}`, 'error');
      });
    }
  }

  sendLanguage(state: LanguageState): void {
    this.windows.sendLanguage(state);
    this.settings.browserWindow?.webContents.send('ui:languageChanged', state);
    this.floating.browserWindow?.webContents.send('ui:languageChanged', state);
  }

  /** Keeps where everything was, so the next start reopens it. */
  remember(): void {
    this.floating.remember();
    this.windows.flush();
  }

  /** Closes this bot's windows without touching its core. */
  close(): void {
    this.stopping = true;
    // A closed presenter acts on no later event, a second quit handed to its core included.
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.windows.destroyAll();
    this.settings.destroy();
    this.floating.destroy();
  }

  /** SPEC-008 FR-10: stops the core through the channel; a timeout kills its process tree. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.remember();
    this.host.log(`bot ${this.botId}: core stop requested pid=${this.hosted.pid}`);
    await this.hosted.stop();
  }
}

function errorMessage(error: unknown): string {
  return diagnosticError(error);
}
