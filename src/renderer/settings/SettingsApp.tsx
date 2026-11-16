import { t, useI18n } from '../i18n.ts';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { BotProfile, BotStatus } from '../../core/types.ts';
import { DEFAULT_BOT_AVATAR } from '../../shared/avatars.ts';
import { avatarUrl } from '../avatarArt.ts';
import { executionSummary } from '../note/executionSummary.ts';
import { AgentClisTab } from './AgentClisTab.tsx';
import { BotPages } from './BotPages.tsx';
import { BotsTab } from './BotsTab.tsx';
import { NotesTab } from './NotesTab.tsx';
import { AppTab, GeneralTab, LifeTab, TelegramTab } from './OtherTabs.tsx';
import { brandState, type BotPage } from './settingsLogic.ts';
import { ToastContext } from './toast.ts';
import { DataTab } from './DataTab.tsx';

/**
 * The settings window (SPEC-002 FR-4): one per bot, opened from the tray, the
 * note's ⚙ or the floating cat's menu, on the tab given by `?tab=` or later
 * by the shell. Like the note it keeps no durable state. With `?scope=hub` it
 * is Cats Bot Settings, the hub's General and Bots tabs (SPEC-008 FR-5,
 * PLAN-010) and the Agent CLIs every cat bot shares (SPEC-013), which reaches
 * no bot's core.
 */

const api = window.catsBot;
// A bot's settings reach only that bot; Cats Bot Settings holds the app and the bots (D17, D20). The
// first three follow the setup wizard's order and share one save bar (ADR-030).
const BOT_TABS = ['look', 'brain', 'perm', 'notes', 'life', 'telegram', 'app'] as const;
const HUB_TABS = ['general', 'bots', 'clis', 'data'] as const;
type Tab = (typeof BOT_TABS)[number] | (typeof HUB_TABS)[number];
const TAB_LABELS: Record<Tab, string> = {
  look: 'Name and look',
  brain: 'Provider and model',
  perm: 'Permissions',
  notes: 'Conversations',
  life: 'Life',
  telegram: 'Telegram',
  app: 'Details',
  general: 'General',
  bots: 'Cat bots',
  clis: 'Agent CLIs',
  data: 'Data',
};

function isTabOf(tabs: readonly Tab[], value: string | null): value is Tab {
  return value !== null && (tabs as readonly string[]).includes(value);
}

/** The old single Cat bot tab opens on the first of the three that replaced it. */
const tabName = (value: string | null): string | null => (value === 'bot' ? 'look' : value);

export function SettingsApp({ initialTab, scope }: { initialTab: string | null; scope: 'bot' | 'hub' }) {
  const { locale } = useI18n();
  const tabs: readonly Tab[] = scope === 'hub' ? HUB_TABS : BOT_TABS;
  const asked = tabName(initialTab);
  const [tab, setTab] = useState<Tab>(isTabOf(tabs, asked) ? asked : tabs[0]!);
  const [editedPages, setEditedPages] = useState<ReadonlySet<BotPage>>(new Set());
  const [setupRunning, setSetupRunning] = useState(false);
  // SPEC-013 FR-3: once opened, the Agent CLIs tab stays mounted, so its results, ticks and
  // log survive a look at another tab while a run goes on.
  const [clisOpened, setClisOpened] = useState(tab === 'clis');
  useEffect(() => {
    if (tab === 'clis') setClisOpened(true);
  }, [tab]);
  const [profile, setProfile] = useState<BotProfile | null>(null);
  const [status, setStatus] = useState<BotStatus | null>(null);
  // The provider, model and effort under the bot's name, as its note header names them (SPEC-003 FR-11).
  const [target, setTarget] = useState('');
  const targetSettled = useRef('');
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
      const name = tabName(next);
      if (isTabOf(BOT_TABS, name)) setTab(name);
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

  useEffect(() => {
    if (scope === 'hub' || !profile) return;
    const executionTarget = profile.executionTarget;
    const key = `${JSON.stringify(executionTarget)}|${locale}`;
    if (key === targetSettled.current) return;
    let live = true;
    setTarget((current) => current || executionSummary('', executionTarget, null));
    void api.invoke('listModels', executionTarget.provider).catch(() => null).then((catalog) => {
      if (!live) return;
      setTarget(executionSummary('', executionTarget, catalog));
      // Only Runtime's own catalog settles the names; until it answers, the next read asks again.
      if (catalog?.source === 'runtime') targetSettled.current = key;
    });
    return () => { live = false; };
  }, [profile, status?.runtime.state, scope, locale]);

  const saved = (next: BotProfile) => {
    setProfile(next);
    void refreshStatus();
  };

  return (
    <ToastContext.Provider value={toast}>
      <div className="settings" id="settings">
        <nav className="tabs" aria-label={t('Settings sections')}>
          <div className="brand">
            {/* A bot's window shows its own look, Cats Bot Settings the app's; nothing until the profile is read. */}
            <img
              src={scope === 'hub' ? avatarUrl(DEFAULT_BOT_AVATAR) : profile ? avatarUrl(profile.avatar) : undefined}
              alt=""
              width="40"
              height="40"
            />
            <div>
              <strong id="brand-name">{status?.name ?? t('Cats Bot')}</strong>
              <small id="brand-state">{scope === 'hub' ? t('Settings') : status ? brandState(status) : '…'}</small>
            </div>
          </div>
          {scope === 'bot' && target && <p className="brand-target" id="brand-target">{target}</p>}
          {tabs.map((name) => (
            <button
              key={name}
              className={name === 'notes' && scope === 'bot' ? 'tab is-after-rule' : 'tab'}
              data-tab={name}
              aria-selected={tab === name}
              onClick={() => setTab(name)}
            >
              {t(TAB_LABELS[name])}
              {name === 'brain' && setupRunning
                ? <i className="tab-mark is-running" aria-label={t('A setup step is running')} />
                : editedPages.has(name as BotPage) && <i className="tab-mark" aria-label={t('Not saved')} />}
            </button>
          ))}
        </nav>
        <main className="panels">
          {scope === 'bot' && profile && (
            <BotPages profile={profile} tab={tab} onSaved={saved} onPages={setEditedPages} onBusy={setSetupRunning} />
          )}
          {tab === 'notes' && <NotesTab />}
          {tab === 'life' && <LifeTab onSaved={saved} />}
          {tab === 'telegram' && <TelegramTab />}
          {tab === 'app' && <AppTab />}
          {tab === 'general' && <GeneralTab />}
          {tab === 'bots' && <BotsTab />}
          {tab === 'data' && <DataTab />}
          {scope === 'hub' && clisOpened && <div className="clis-host" hidden={tab !== 'clis'}><AgentClisTab /></div>}
        </main>
      </div>
      <div className="toast" id="toast" role="status" hidden={!toastText}>
        {toastText ? t(toastText) : null}
      </div>
    </ToastContext.Provider>
  );
}
