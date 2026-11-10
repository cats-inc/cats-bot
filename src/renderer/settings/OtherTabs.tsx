import { t, useI18n } from '../i18n.ts';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import type { BotProfile, BotStatus, TelegramSettingsStatus } from '../../core/types.ts';
import type { ShellStateView } from '../bridge.ts';
import { errorText } from '../errors.ts';
import {
  appFacts,
  heartbeatModeOptions,
  lifeForm,
  lifePatch,
  nextHeartbeatText,
  telegramFacts,
  type LifeForm,
} from './settingsLogic.ts';
import type { HeartbeatMode } from '../../core/types.ts';
import { FactRow, Group, Row } from './Rows.tsx';
import { useToast } from './toast.ts';
import { Updates } from './Updates.tsx';
import { LanguageField } from '../LanguageField.tsx';
import { ReplyLanguageField } from './ReplyLanguageField.tsx';

/** SPEC-002 FR-4, FR-6: a bot's Life, Telegram and Details tabs, and Cats Bot Settings' General tab (PLAN-010). */

const api = window.catsBot;

export function LifeTab({ onSaved }: { onSaved(profile: BotProfile): void }) {
  useI18n();
  const toast = useToast();
  const [form, setForm] = useState<LifeForm | null>(null);
  const [status, setStatus] = useState<BotStatus | null>(null);

  const load = useCallback(async () => {
    const [profile, current] = await Promise.all([api.invoke('getProfile'), api.invoke('status')]);
    setForm(lifeForm(profile));
    setStatus(current);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (!form) return <section className="panel" data-panel="life" />;
  const update = (patch: Partial<LifeForm>) => setForm({ ...form, ...patch });
  const save = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const saved = await api.invoke('updateProfile', lifePatch(form));
      onSaved(saved);
      toast(t('Saved'));
      await load();
    } catch (failure) {
      toast(t('Could not save: {value0}', { value0: errorText(failure) }));
    }
  };
  const number = (key: 'wakeMin' | 'wakeMax' | 'regularMin' | 'regularMax' | 'idle', id: string, max: number) => (
    <input type="number" id={id} min={1} max={max} value={form[key]} onChange={(event) => update({ [key]: event.target.value })} />
  );
  const clock = (key: 'bedtime' | 'wakeWindowStart' | 'wakeWindowEnd', id: string, label?: string) => (
    <input type="time" id={id} aria-label={label} value={form[key]} onChange={(event) => update({ [key]: event.target.value })} />
  );
  const minutes = (low: 'wakeMin' | 'regularMin', high: 'wakeMax' | 'regularMax', id: string, max: number) => (
    <>
      {number(low, `${id}-min`, max)}
      <span aria-hidden="true">–</span>
      {number(high, `${id}-max`, max)}
      <span>{t('minutes')}</span>
    </>
  );
  return (
    <section className="panel" data-panel="life">
      <h2>{t('Life')}</h2>
      <form id="life-form" onSubmit={(event) => void save(event)}>
        <Group>
          <Row label={t('Own initiative')} htmlFor="life-heartbeat" hint={t('Stays awake on its daily rhythm and does things on its own now and then.')}>
            <input
              type="checkbox"
              className="switch"
              id="life-heartbeat"
              checked={form.heartbeat}
              onChange={(event) => update({ heartbeat: event.target.checked })}
            />
          </Row>
          <Row label={t('What it does')} htmlFor="life-mode" stack>
            <select
              id="life-mode"
              value={form.mode}
              onChange={(event) => update({ mode: event.target.value as HeartbeatMode })}
            >
              {heartbeatModeOptions(status?.heartbeat.mode ?? null).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Row>
        </Group>
        <Group title={t('Daily rhythm')} lead={t('While asleep it takes no initiative; a message from you wakes it.')}>
          <Row label={t('Bedtime')} htmlFor="life-bedtime">{clock('bedtime', 'life-bedtime')}</Row>
          <Row label={t('Wakes up between')} htmlFor="life-wake-start">
            {clock('wakeWindowStart', 'life-wake-start')}
            <span>{t('and')}</span>
            {clock('wakeWindowEnd', 'life-wake-end', t('Wakes up between'))}
          </Row>
          <Row label={t('First initiative after waking')} htmlFor="life-wake-min">
            {minutes('wakeMin', 'wakeMax', 'life-wake', 1440)}
          </Row>
          <Row label={t('After that, every')} htmlFor="life-regular-min" hint={<span id="life-rhythm">{t('Each unanswered message doubles the wait; after 5 in a row it waits for you.')}</span>}>
            {minutes('regularMin', 'regularMax', 'life-regular', 10080)}
          </Row>
          <Row label={t('A conversation sleeps after')} htmlFor="life-idle" hint={t('At night its direct message sleeps after 15 quiet minutes.')}>
            {number('idle', 'life-idle', 1440)}
            <span>{t('idle minutes')}</span>
          </Row>
        </Group>
        <div className="group-foot">
          <p className="hint" id="life-next">
            {status ? nextHeartbeatText(status) : ''}
          </p>
          <button type="submit" className="primary">
            {t('Save')}
          </button>
        </div>
      </form>
    </section>
  );
}

export function TelegramTab() {
  useI18n();
  const toast = useToast();
  const [profile, setProfile] = useState<BotProfile | null>(null);
  const [status, setStatus] = useState<TelegramSettingsStatus | null>(null);
  const [token, setToken] = useState('');

  const load = useCallback(async () => {
    const [current, telegram] = await Promise.all([api.invoke('getProfile'), api.invoke('telegramStatus')]);
    setProfile(current);
    setStatus(telegram);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const saveToken = async (event: FormEvent) => {
    event.preventDefault();
    if (!token.trim()) {
      toast(t('Paste the token from @BotFather first'));
      return;
    }
    try {
      await api.invoke('setTelegramToken', token.trim());
      setToken('');
      toast(t('Token saved'));
      await load();
    } catch (failure) {
      toast(t('Could not save: {value0}', { value0: errorText(failure) }));
    }
  };
  const setPolling = async (enabled: boolean) => {
    await api.invoke('updateProfile', { telegram: { enabled } });
    toast(enabled ? t('Telegram polling on') : t('Telegram polling off'));
    await load();
  };
  const clearToken = async () => {
    await api.invoke('setTelegramToken', null);
    toast(t('Token removed'));
    await load();
  };

  const facts = profile && status ? telegramFacts(status, profile) : null;
  return (
    <section className="panel" data-panel="telegram">
      <h2>{t('Telegram')}</h2>
      <p className="lead">
        {t('Create a bot with @BotFather, paste its token here, then send it a private message to chat from your phone.')}
      </p>
      <form id="telegram-form" onSubmit={(event) => void saveToken(event)}>
        <Group>
          <Row label={t('Bot token')} htmlFor="telegram-token" hint={facts?.[0]?.[1]} id="telegram-facts">
            <input
              id="telegram-token"
              type="password"
              autoComplete="off"
              placeholder={t('123456:ABC…')}
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
            <button type="submit">{t('Save token')}</button>
          </Row>
          <Row label={t('Poll Telegram for messages')} htmlFor="telegram-enabled" hint={facts?.[1]?.[1]}>
            <input
              type="checkbox"
              className="switch"
              id="telegram-enabled"
              checked={profile?.telegram.enabled ?? false}
              onChange={(event) => void setPolling(event.target.checked)}
            />
          </Row>
          <Row label={t('Your account')} hint={facts?.[2]?.[1]} />
        </Group>
        {status?.tokenStored && (
          <div className="group-foot">
            <button type="button" className="quiet danger" id="telegram-clear" onClick={() => void clearToken()}>
              {t('Remove token')}
            </button>
          </div>
        )}
      </form>
    </section>
  );
}

/** D20: Cats Bot Settings' own tab: what belongs to the app, not to one bot. */
export function GeneralTab() {
  useI18n();
  const toast = useToast();
  const [shell, setShell] = useState<ShellStateView | null>(null);

  const load = useCallback(async () => {
    setShell(await api.shell.state());
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const setLogin = async (enabled: boolean) => {
    const actual = await api.shell.setOpenAtLogin(enabled);
    toast((actual ?? enabled) ? t('Starts at sign-in') : t('No longer starts at sign-in'));
    await load();
  };

  return (
    <section className="panel" data-panel="general">
      <h2>{t('General')}</h2>
      <Group>
        <LanguageField />
        <ReplyLanguageField />
        <Row label={t('Start Cats Bot when I sign in')} htmlFor="app-login" id="app-login-row" hidden={!shell?.openAtLoginAvailable}>
          <input
            type="checkbox"
            className="switch"
            id="app-login"
            checked={shell?.openAtLogin ?? false}
            onChange={(event) => void setLogin(event.target.checked)}
          />
        </Row>
        {/* ADR-020: macOS registered the login item but waits for the owner's approval. */}
        {shell?.loginItemNeedsApproval && (
          <Row
            id="app-login-approval"
            tone="warn"
            label={t('Waiting for your approval in macOS')}
            hint={t('Turn on Cats Bot in System Settings > General > Login Items.')}
          >
            {api.systemSettings && (
              <button type="button" id="app-login-approval-open"
                onClick={() => { void api.systemSettings?.open('login_items').catch(() => undefined); }}>
                {t('Open System Settings')}
              </button>
            )}
          </Row>
        )}
      </Group>
      <Updates />
      <Group id="general-facts">
        <Row label={t('Data folder')} hint={shell?.root ?? '…'}>
          <button type="button" id="general-open-data" onClick={() => void api.shell.openDataFolder()}>
            {t('Open')}
          </button>
        </Row>
      </Group>
    </section>
  );
}

/** A bot's own presence and facts; the app's items are in Cats Bot Settings (D20). */
export function AppTab() {
  useI18n();
  const toast = useToast();
  const [shell, setShell] = useState<ShellStateView | null>(null);
  const [status, setStatus] = useState<BotStatus | null>(null);

  const load = useCallback(async () => {
    const [view, current] = await Promise.all([api.shell.state(), api.invoke('status')]);
    setShell(view);
    setStatus(current);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const setFloating = async (visible: boolean) => {
    await api.shell.setFloatingVisible(visible);
    toast(visible ? t('The cat is back') : t('The cat is hidden; the tray can bring it back'));
    await load();
  };

  return (
    <section className="panel" data-panel="app">
      <h2>{t('Details')}</h2>
      <Group>
        <Row label={t('Show the floating cat above other windows')} htmlFor="app-floating">
          <input
            type="checkbox"
            className="switch"
            id="app-floating"
            checked={shell?.floatingVisible ?? false}
            onChange={(event) => void setFloating(event.target.checked)}
          />
        </Row>
      </Group>
      <Group id="app-facts">
        {shell && status && appFacts(status, shell.version)
          .filter(([label]) => label !== 'Data folder')
          .map(([label, value]) => <FactRow key={label} label={t(label)} value={value} />)}
        <Row label={t('Data folder')} hint={status?.root ?? '…'}>
          <button type="button" id="app-open-data" onClick={() => void api.shell.openDataFolder()}>
            {t('Open')}
          </button>
        </Row>
      </Group>
    </section>
  );
}
