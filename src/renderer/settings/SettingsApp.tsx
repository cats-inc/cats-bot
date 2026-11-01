import { t, useI18n } from '../i18n.ts';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { BotProfile, BotStatus } from '../../core/types.ts';
import catUrl from '../cat.svg';
import { BotTab } from './BotTab.tsx';
import { BotsTab } from './BotsTab.tsx';
import { NotesTab } from './NotesTab.tsx';
import { AppTab, GeneralTab, LifeTab, TelegramTab } from './OtherTabs.tsx';
import { brandState } from './settingsLogic.ts';
import { ToastContext } from './toast.ts';

/**
 * The settings window (SPEC-002 FR-4): one per bot, opened from the tray, the
 * note's ⚙ or the floating cat's menu, on the tab given by `?tab=` or later
 * by the shell. Like the note it keeps no durable state. With `?scope=hub` it
 * is Cats Bot Settings, the hub's General and Bots tabs (SPEC-008 FR-5,
 * PLAN-010), which reaches no bot's core.
 */

const api = window.catsBot;
// A bot's settings reach only that bot; Cats Bot Settings holds the app and the bots (D17, D20).
const BOT_TABS = ['bot', 'notes', 'life', 'telegram', 'app'] as const;
const HUB_TABS = ['general', 'bots'] as const;
type Tab = (typeof BOT_TABS)[number] | (typeof HUB_TABS)[number];
const TAB_LABELS: Record<Tab, string> = {
  bot: 'Bot',
  notes: 'Conversations',
  life: 'Life',
  telegram: 'Telegram',
  app: 'Details',
  general: 'General',
  bots: 'Bots',
};

function isTabOf(tabs: readonly Tab[], value: string | null): value is Tab {
  return value !== null && (tabs as readonly string[]).includes(value);
}

export function SettingsApp({ initialTab, scope }: { initialTab: string | null; scope: 'bot' | 'hub' }) {
  const { locale } = useI18n();
  const tabs: readonly Tab[] = scope === 'hub' ? HUB_TABS : BOT_TABS;
  const [tab, setTab] = useState<Tab>(isTabOf(tabs, initialTab) ? initialTab : tabs[0]!);
  const [profile, setProfile] = useState<BotProfile | null>(null);
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [toastText, setToastText] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const toast = useCallback((text: string) => {
    setToastText(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastText(null), 2600);
  }, []);

  const refreshStatus = useCallback(async () => {
    const current = await api.invoke('status');
    setStatus(current);
    document.title = `${current.name} ${t('Settings')}`;
  }, [locale]);

  useEffect(() => {
    if (scope === 'hub') {
      document.title = `Cats Bot ${t('Settings')}`;
      return api.onNavigate((next) => {
        if (isTabOf(HUB_TABS, next)) setTab(next);
      });
    }
    void api.invoke('getProfile').then(setProfile);
    void refreshStatus();
    const offEvent = api.onEvent((event) => {
      if (event.type === 'runtime.status') void refreshStatus();
    });
    const offNavigate = api.onNavigate((next) => {
      if (isTabOf(BOT_TABS, next)) setTab(next);
    });
    // SPEC-008 FR-28: Cats Bot Settings can change what this bot follows while
    // the window is open; coming back to it reads the profile again.
    const onFocus = () => void api.invoke('getProfile').then(setProfile);
    window.addEventListener('focus', onFocus);
    return () => {
      offEvent();
      offNavigate();
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshStatus, scope, locale]);

  const saved = (next: BotProfile) => {
    setProfile(next);
    void refreshStatus();
  };

  return (
    <ToastContext.Provider value={toast}>
      <div className="settings" id="settings">
        <nav className="tabs" aria-label={t('Settings sections')}>
          <div className="brand">
            <img src={catUrl} alt="" width="40" height="40" />
            <div>
              <strong id="brand-name">{status?.name ?? t('Cats Bot')}</strong>
              <small id="brand-state">{scope === 'hub' ? t('Settings') : status ? brandState(profile, status) : '…'}</small>
            </div>
          </div>
          {tabs.map((name) => (
            <button
              key={name}
              className="tab"
              data-tab={name}
              aria-selected={tab === name}
              onClick={() => setTab(name)}
            >
              {t(TAB_LABELS[name])}
            </button>
          ))}
        </nav>
        <main className="panels">
          {tab === 'bot' && profile && <BotTab profile={profile} onSaved={saved} />}
          {tab === 'notes' && <NotesTab />}
          {tab === 'life' && <LifeTab onSaved={saved} />}
          {tab === 'telegram' && <TelegramTab />}
          {tab === 'app' && <AppTab />}
          {tab === 'general' && <GeneralTab />}
          {tab === 'bots' && <BotsTab />}
        </main>
      </div>
      <div className="toast" id="toast" role="status" hidden={!toastText}>
        {toastText ? t(toastText) : null}
      </div>
    </ToastContext.Provider>
  );
}
