import { t, useI18n } from '../i18n.ts';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { BotProfile, BotStatus } from '../../core/types.ts';
import catUrl from '../cat.svg';
import { BotTab } from './BotTab.tsx';
import { BotsTab } from './BotsTab.tsx';
import { NotesTab } from './NotesTab.tsx';
import { AppTab, LifeTab, TelegramTab } from './OtherTabs.tsx';
import { brandState } from './settingsLogic.ts';
import { ToastContext } from './toast.ts';

/**
 * The settings window (SPEC-002 FR-4): one per bot, opened from the tray, the
 * note's ⚙ or the floating cat's menu, on the tab given by `?tab=` or later
 * by the shell. Like the note it keeps no durable state. With `?scope=hub` it
 * is the hub's Bots page (SPEC-008 FR-5), which reaches no bot.
 */

const api = window.catsBot;
const TABS = ['bot', 'notes', 'life', 'telegram', 'app', 'bots'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = {
  bot: 'Bot',
  notes: 'Conversations',
  life: 'Life',
  telegram: 'Telegram',
  app: 'App',
  bots: 'Bots',
};

function isTab(value: string | null): value is Tab {
  return value !== null && (TABS as readonly string[]).includes(value);
}

export function SettingsApp({ initialTab, scope }: { initialTab: string | null; scope: 'bot' | 'hub' }) {
  const { locale } = useI18n();
  const tabs: readonly Tab[] = scope === 'hub' ? ['bots'] : TABS;
  const [tab, setTab] = useState<Tab>(scope === 'hub' ? 'bots' : isTab(initialTab) ? initialTab : 'bot');
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
      document.title = `Cats Bot ${t('Bots')}`;
      return undefined;
    }
    void api.invoke('getProfile').then(setProfile);
    void refreshStatus();
    const offEvent = api.onEvent((event) => {
      if (event.type === 'runtime.status') void refreshStatus();
    });
    const offNavigate = api.onNavigate((next) => {
      if (isTab(next)) setTab(next);
    });
    return () => {
      offEvent();
      offNavigate();
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
              <small id="brand-state">{scope === 'hub' ? t('Bots') : status ? brandState(profile, status) : '…'}</small>
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
          {tab === 'bots' && <BotsTab />}
        </main>
      </div>
      <div className="toast" id="toast" role="status" hidden={!toastText}>
        {toastText ? t(toastText) : null}
      </div>
    </ToastContext.Provider>
  );
}
