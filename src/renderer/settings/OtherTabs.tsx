import { t, useI18n } from '../i18n.ts';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import type { BotProfile, BotStatus, TelegramSettingsStatus } from '../../core/types.ts';
import type { ShellStateView } from '../bridge.ts';
import { errorText } from '../errors.ts';
import { appFacts, lifeForm, lifePatch, nextHeartbeatText, telegramFacts, type Fact, type LifeForm } from './settingsLogic.ts';
import { useToast } from './toast.ts';
import { Updates } from './Updates.tsx';
import { LanguageField } from '../LanguageField.tsx';

/** SPEC-002 FR-4, FR-6: the Life, Telegram and App tabs. */

const api = window.catsBot;

function Facts({ id, facts }: { id: string; facts: Fact[] }) {
  useI18n();
  return (
    <ul className="facts" id={id}>
      {facts.map(([label, value]) => (
        <li key={label}>
          <span>{t(label)}: </span>
          {value}
        </li>
      ))}
    </ul>
  );
}

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
  const number = (key: keyof Omit<LifeForm, 'heartbeat'>, id: string, max: number) => (
    <input type="number" id={id} min={1} max={max} value={form[key]} onChange={(event) => update({ [key]: event.target.value })} />
  );
  return (
    <section className="panel" data-panel="life">
      <h2>{t('Life')}</h2>
      <form id="life-form" className="form" onSubmit={(event) => void save(event)}>
        <label className="check">
          <input
            type="checkbox"
            id="life-heartbeat"
            checked={form.heartbeat}
            onChange={(event) => update({ heartbeat: event.target.checked })}
          />
          <span>
            {t('Heartbeat: the bot wakes up on its own and may say something unprompted')}
          </span>
        </label>
        <div className="pair">
          <span>{t('Right after you talk, check in after')}</span>
          {number('wakeMin', 'life-wake-min', 1440)} – {number('wakeMax', 'life-wake-max', 1440)}
          {t('minutes')}
        </div>
        <div className="pair">
          <span>{t('Otherwise, every')}</span>
          {number('regularMin', 'life-regular-min', 10080)} –{' '}
          {number('regularMax', 'life-regular-max', 10080)}
          {t('minutes')}
        </div>
        <div className="pair">
          <span>{t("A conversation's session goes to sleep after")}</span>
          {number('idle', 'life-idle', 1440)}
          {t('idle minutes')}
        </div>
        <p className="hint" id="life-next">
          {status ? nextHeartbeatText(status) : ''}
        </p>
        <div className="actions">
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

  return (
    <section className="panel" data-panel="telegram">
      <h2>{t('Telegram')}</h2>
      <p className="lead">
        {t(
          'Send a direct message from your phone. Create a bot with @BotFather, paste its token here, then send your bot a private message to link your account.',
        )}
      </p>
      {profile && status && <Facts id="telegram-facts" facts={telegramFacts(status, profile)} />}
      <form id="telegram-form" className="form" onSubmit={(event) => void saveToken(event)}>
        <label className="field">
          <span>{t('Bot token')}</span>
          <div className="row">
            <input
              id="telegram-token"
              type="password"
              autoComplete="off"
              placeholder={t('123456:ABC…')}
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
            <button type="submit">{t('Save token')}</button>
          </div>
        </label>
        <div className="row">
          <label className="check">
            <input
              type="checkbox"
              id="telegram-enabled"
              checked={profile?.telegram.enabled ?? false}
              onChange={(event) => void setPolling(event.target.checked)}
            />
            <span>{t('Poll Telegram for messages')}</span>
          </label>
          <span className="spacer" />
          <button
            type="button"
            id="telegram-clear"
            disabled={!status?.tokenStored}
            onClick={() => void clearToken()}
          >
            {t('Remove token')}
          </button>
        </div>
      </form>
    </section>
  );
}

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
  const setLogin = async (enabled: boolean) => {
    await api.shell.setOpenAtLogin(enabled);
    toast(enabled ? t('Starts at sign-in') : t('No longer starts at sign-in'));
    await load();
  };

  return (
    <section className="panel" data-panel="app">
      <h2>{t('App')}</h2>
      <div className="form">
        <LanguageField />
        <label className="check">
          <input
            type="checkbox"
            id="app-floating"
            checked={shell?.floatingVisible ?? false}
            onChange={(event) => void setFloating(event.target.checked)}
          />
          <span>{t('Show the floating cat above other windows')}</span>
        </label>
        <label className="check" id="app-login-row" hidden={!shell?.openAtLoginAvailable}>
          <input
            type="checkbox"
            id="app-login"
            checked={shell?.openAtLogin ?? false}
            onChange={(event) => void setLogin(event.target.checked)}
          />
          <span>{t('Start Cats Bot when I sign in')}</span>
        </label>
        {shell && status && <Facts id="app-facts" facts={appFacts(status, shell.version)} />}
        <Updates />
        <div className="row">
          <button type="button" id="app-open-data" onClick={() => void api.shell.openDataFolder()}>
            {t('Open data folder')}
          </button>
        </div>
      </div>
    </section>
  );
}
