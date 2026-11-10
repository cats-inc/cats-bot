import { t, useI18n } from '../i18n.ts';
import { useCallback, useEffect, useState } from 'react';

import type { BotAction, BotListing, BotRow } from '../bridge.ts';
import { avatarUrl } from '../avatarArt.ts';
import { errorText } from '../errors.ts';
import { Group, Row } from './Rows.tsx';
import { bossCatChoice, botStateLine } from './settingsLogic.ts';
import { useToast } from './toast.ts';

/**
 * SPEC-008 FR-5 and FR-6: Settings → Bots. Every bot that is not archived,
 * with its state, and create, start, stop, start automatically and order;
 * archived bots apart, with restore and delete. Removing a bot takes two
 * steps, and the hub asks before each one. Bot directories without an entry
 * can be added. SPEC-009 FR-2, FR-10, FR-11: the Boss Cat is chosen in its own
 * group, which also says why the holder has no tools.
 */

const api = window.catsBot;

function BotLine({ bot, first, last, ordered, act }: {
  bot: BotRow;
  first: boolean;
  last: boolean;
  /** More than one bot, so the order can change. */
  ordered: boolean;
  act(action: BotAction, value?: boolean): void
}) {
  useI18n();
  const running = bot.state === 'running' || bot.state === 'starting';
  const autoId = `bot-auto-${bot.id}`;
  return (
    <li className={`bot-line is-${bot.state}`} data-bot={bot.id}>
      <span className="bot-face" aria-hidden="true">
        <img src={avatarUrl(bot.avatar)} alt="" width="40" height="40" />
        <i className="bot-dot" />
      </span>
      <div className="bot-text">
        <div className="bot-name">
          <strong title={bot.name}>{bot.name}</strong>
          {bot.bossCat && <span className="tag">{t('Boss Cat')}</span>}
        </div>
        <small className="bot-state">{botStateLine(bot)}</small>
        {bot.error && bot.state === 'failed' ? <small className="bot-error">{bot.error}</small> : null}
      </div>
      {bot.state === 'archived' ? (
        <div className="bot-controls">
          <button type="button" onClick={() => act('restore')}>{t('Restore')}</button>
          <button type="button" className="quiet danger" onClick={() => act('delete')}>{t('Delete…')}</button>
        </div>
      ) : (
        <div className="bot-controls">
          <label className="bot-auto" htmlFor={autoId}>
            <span>{t('Auto-start')}</span>
            <input
              type="checkbox"
              className="switch"
              id={autoId}
              checked={bot.startAutomatically}
              onChange={(event) => act('startAutomatically', event.target.checked)}
            />
          </label>
          {running
            ? <button type="button" className="bot-run" onClick={() => act('stop')}>{t('Stop')}</button>
            : <button type="button" className="bot-run" disabled={bot.state === 'external' || bot.state === 'missing'} onClick={() => act('start')}>{t('Start')}</button>}
          {ordered && (
            <span className="bot-order">
              <button type="button" aria-label={t('Move up')} disabled={first} onClick={() => act('moveUp')}>↑</button>
              <button type="button" aria-label={t('Move down')} disabled={last} onClick={() => act('moveDown')}>↓</button>
            </span>
          )}
          <button type="button" className="quiet" disabled={bot.state === 'external'} onClick={() => act('archive')}>{t('Archive…')}</button>
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

  // SPEC-009 FR-8: the owner's limits on what the Boss Cat sends.
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
  const holder = active.find((bot) => bot.bossCat) ?? null;
  // SPEC-009 FR-2: one choice assigns the role, moves it or clears it; the hub asks where it must.
  const chooseBossCat = (chosen: string) => {
    const choice = bossCatChoice(holder?.id ?? null, chosen);
    if (choice) void act(choice.id)(choice.action);
  };
  const toolsHint = holder?.bossCatTools === false
    ? t('Boss Cat tools have not connected. Check provider access settings or start a conversation.')
    : holder?.bossCatTools === null ? t('Boss Cat tool availability has not been checked.') : null;
  return (
    <section className="panel" data-panel="bots">
      <div className="panel-head">
        <h2>
          {t('Cat bots')}
          {listing && <span className="count" id="bots-count">{listing.active} / {listing.maxBots}</span>}
        </h2>
        <button className="primary" id="bots-new" disabled={!listing || full} onClick={() => void create()}>
          {t('New cat bot')}
        </button>
      </div>
      {full && listing && (
        <p className="lead">{t('That is the most cat bots there can be. Archive one to add another.')}</p>
      )}
      {listing && active.length === 0 && (
        <p className="lead" id="bots-empty">{t('No cat bots yet. Choose New cat bot to make one.')}</p>
      )}
      {active.length > 0 && (
        <ul className="rows bot-list" id="bots-list">
          {active.map((bot, index) => (
            <BotLine
              key={bot.id}
              bot={bot}
              first={index === 0}
              last={index === active.length - 1}
              ordered={active.length > 1}
              act={act(bot.id)}
            />
          ))}
        </ul>
      )}
      {listing && (
        <Group
          title={t('Boss Cat')}
          id="bots-boss-cat"
          lead={t('The Boss Cat can hand work to the other cat bots. It asks you before it creates or starts a cat bot or passes the role on.')}
        >
          <Row label={t('Assigned to')} htmlFor="boss-cat-holder" hint={toolsHint} warn={holder?.bossCatTools === false}>
            <select id="boss-cat-holder" value={holder?.id ?? ''} onChange={(event) => chooseBossCat(event.target.value)}>
              <option value="">{t('None')}</option>
              {active.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
            </select>
          </Row>
          <Row label={t('Hops per chain')} htmlFor="boss-cat-hops">
            <input id="boss-cat-hops" type="number" min={2} max={100} defaultValue={listing.limits.hopsPerChain} key={`hops-${listing.limits.hopsPerChain}`}
              onBlur={(event) => void setLimit('hopsPerChain', Number(event.target.value))} />
          </Row>
          <Row label={t('Messages per hour')} htmlFor="boss-cat-rate">
            <input id="boss-cat-rate" type="number" min={1} max={1000} defaultValue={listing.limits.messagesPerHour} key={`rate-${listing.limits.messagesPerHour}`}
              onBlur={(event) => void setLimit('messagesPerHour', Number(event.target.value))} />
          </Row>
        </Group>
      )}
      {listing && listing.unregistered.length > 0 && (
        <Group title={t('Found in the bots folder')} id="bots-unregistered">
          {listing.unregistered.map((id) => (
            <Row key={id} label={id}>
              <button type="button" disabled={full} onClick={() => void act(id)('register')}>{t('Add')}</button>
            </Row>
          ))}
        </Group>
      )}
      {archived.length > 0 && (
        <section className="group">
          <h3>{t('Archived')}</h3>
          <ul className="rows" id="bots-archived">
            {archived.map((bot) => (
              <BotLine key={bot.id} bot={bot} first last ordered={false} act={act(bot.id)} />
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
