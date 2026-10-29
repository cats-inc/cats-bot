import { t, useI18n } from '../i18n.ts';
import { useCallback, useEffect, useState } from 'react';

import type { BotAction, BotListing, BotRow } from '../bridge.ts';
import { errorText } from '../errors.ts';
import { useToast } from './toast.ts';

/**
 * SPEC-008 FR-5 and FR-6: Settings → Bots. Every bot that is not archived,
 * with its state, and create, start, stop, start automatically and order;
 * archived bots apart, with restore and delete. Removing a bot takes two
 * steps, and the hub asks before each one. Bot directories without an entry
 * can be added.
 */

const api = window.catsBot;

const STATE_LABELS: Record<BotRow['state'], string> = {
  starting: 'Starting',
  running: 'Running',
  stopped: 'Stopped',
  failed: 'Failed',
  external: 'Running in another program',
  archived: 'Archived',
  missing: 'Folder missing',
};

function BotLine({ bot, first, last, act }: { bot: BotRow; first: boolean; last: boolean; act(action: BotAction, value?: boolean): void }) {
  useI18n();
  const running = bot.state === 'running' || bot.state === 'starting';
  return (
    <li className="note-row bot-row" data-bot={bot.id}>
      <div className="note-meta">
        <strong>{bot.name}</strong>
        <small>
          {bot.id}
          {bot.provider ? ` · ${bot.provider}` : ''} · {t(STATE_LABELS[bot.state])}
          {bot.pid ? ` · pid ${bot.pid}` : ''}
          {bot.coordinator ? ` · ${t('Coordinator')}` : ''}
        </small>
        {bot.error && bot.state === 'failed' ? <small className="error">{bot.error}</small> : null}
        {bot.coordinator && bot.coordinatorTools === false
          ? <small>{t('This provider gives the coordinator no tools; the role stays with the bot.')}</small>
          : null}
      </div>
      {bot.state === 'archived' ? (
        <div className="row">
          <button type="button" onClick={() => act('restore')}>{t('Restore')}</button>
          <button type="button" className="danger" onClick={() => act('delete')}>{t('Delete…')}</button>
        </div>
      ) : (
        <div className="row">
          {running
            ? <button type="button" onClick={() => act('stop')}>{t('Stop')}</button>
            : <button type="button" disabled={bot.state === 'external' || bot.state === 'missing'} onClick={() => act('start')}>{t('Start')}</button>}
          <label className="check">
            <input type="checkbox" checked={bot.startAutomatically} onChange={(event) => act('startAutomatically', event.target.checked)} />
            <span>{t('Start automatically')}</span>
          </label>
          <button type="button" aria-label={t('Move up')} disabled={first} onClick={() => act('moveUp')}>↑</button>
          <button type="button" aria-label={t('Move down')} disabled={last} onClick={() => act('moveDown')}>↓</button>
          {bot.coordinator
            ? <button type="button" onClick={() => act('clearCoordinator')}>{t('Clear coordinator')}</button>
            : <button type="button" onClick={() => act('makeCoordinator')}>{t('Make coordinator')}</button>}
          <button type="button" disabled={bot.state === 'external'} onClick={() => act('archive')}>{t('Archive…')}</button>
        </div>
      )}
    </li>
  );
}

export function BotsTab() {
  useI18n();
  const toast = useToast();
  const [listing, setListing] = useState<BotListing | null>(null);

  const load = useCallback(async () => {
    setListing(await api.hub.bots());
  }, []);
  useEffect(() => {
    void load();
    const off = api.hub.onChange(() => void load());
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      off();
      window.removeEventListener('focus', onFocus);
    };
  }, [load]);

  const act = (id: string) => async (action: BotAction, value?: boolean) => {
    try {
      setListing(await api.hub.action(action, id, value));
    } catch (failure) {
      toast(errorText(failure));
      await load();
    }
  };
  const create = async () => {
    try {
      await api.hub.create();
    } catch (failure) {
      toast(errorText(failure));
    }
  };

  // SPEC-009 FR-8: the owner's limits on what the coordinator sends.
  const setLimit = async (key: 'hopsPerChain' | 'messagesPerHour', value: number) => {
    if (!listing || !Number.isSafeInteger(value) || value < 1) return;
    try {
      setListing(await api.hub.setLimits({ ...listing.limits, [key]: value }));
    } catch (failure) {
      toast(errorText(failure));
      await load();
    }
  };

  const active = listing?.bots.filter((bot) => bot.state !== 'archived') ?? [];
  const archived = listing?.bots.filter((bot) => bot.state === 'archived') ?? [];
  const full = listing ? listing.active >= listing.maxBots : false;
  return (
    <section className="panel" data-panel="bots">
      <div className="panel-head">
        <h2>{t('Bots')}</h2>
        <button className="primary" id="bots-new" disabled={!listing || full} onClick={() => void create()}>
          {t('New bot')}
        </button>
      </div>
      <p className="lead">
        {listing
          ? t('Each bot runs on its own, with its own conversations and provider. Up to {max} bots; archived bots do not count.', { max: listing.maxBots })
          : '…'}
      </p>
      <ul className="notes" id="bots-list">
        {active.map((bot, index) => (
          <BotLine key={bot.id} bot={bot} first={index === 0} last={index === active.length - 1} act={act(bot.id)} />
        ))}
      </ul>
      {listing && (
        <>
          <h3>{t('Coordinator')}</h3>
          <p className="lead">
            {t('The coordinator can hand work to the other bots. Creating or starting bots and passing the role on wait for your confirmation.')}
          </p>
          <div className="row">
            <label>
              <span>{t('Hops per chain')}</span>
              <input type="number" min={2} max={1000} defaultValue={listing.limits.hopsPerChain} key={`hops-${listing.limits.hopsPerChain}`}
                onBlur={(event) => void setLimit('hopsPerChain', Number(event.target.value))} />
            </label>
            <label>
              <span>{t('Messages per hour')}</span>
              <input type="number" min={1} max={1000} defaultValue={listing.limits.messagesPerHour} key={`rate-${listing.limits.messagesPerHour}`}
                onBlur={(event) => void setLimit('messagesPerHour', Number(event.target.value))} />
            </label>
          </div>
        </>
      )}
      {listing && listing.unregistered.length > 0 && (
        <>
          <h3>{t('Found in the bots folder')}</h3>
          <ul className="notes" id="bots-unregistered">
            {listing.unregistered.map((id) => (
              <li key={id} className="note-row">
                <div className="note-meta"><strong>{id}</strong></div>
                <div className="row">
                  <button type="button" disabled={full} onClick={() => void act(id)('register')}>{t('Add')}</button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {archived.length > 0 && (
        <>
          <h3>{t('Archived')}</h3>
          <ul className="notes" id="bots-archived">
            {archived.map((bot) => (
              <BotLine key={bot.id} bot={bot} first last act={act(bot.id)} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
