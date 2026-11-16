import { t, useI18n } from '../i18n.ts';
import { useCallback, useEffect, useState } from 'react';

import type { BotAction, BotListing, BotRow } from '../bridge.ts';
import { avatarUrl } from '../avatarArt.ts';
import { errorText } from '../errors.ts';
import { Group, Row } from './Rows.tsx';
import { bossCatChoice, bossCatToolsHint, botStateLine, clampLimit } from './settingsLogic.ts';
import { useToast } from './toast.ts';

/**
 * SPEC-008 FR-5 and FR-6: Settings → Cat bots. Every cat bot that is not archived, with its state, and
 * create, start, stop, start automatically, order and its own settings; archived ones apart, with restore
 * and delete. Removing a cat bot takes two steps, and the hub asks before each one in its own dialog.
 * Folders without an entry can be added. SPEC-009 FR-2, FR-8, FR-11 and SPEC-012 FR-12: everything about
 * the Boss Cat is in its own group (ADR-031).
 *
 * ADR-031: one grid, the same columns in every row, as the conversation list (ADR-026). A control that
 * cannot apply to a row leaves its cell empty; nothing wraps. Order is changed in its own mode.
 */

const api = window.catsBot;

function GearIcon() {
  return (
    <svg className="bot-glyph" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="2.3" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 1.6v1.8M8 12.6v1.8M1.6 8h1.8M12.6 8h1.8M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M3.5 12.5l1.3-1.3M11.2 4.8l1.3-1.3"
        fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function BoxIcon() {
  return (
    <svg className="bot-glyph" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2" y="3" width="12" height="3" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3 6v6.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6M6.5 9h3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function BotLine({ bot, first, last, ordering, act }: {
  bot: BotRow;
  first: boolean;
  last: boolean;
  /** The list is in its order mode: each row moves up or down instead. */
  ordering: boolean;
  act(action: BotAction, value?: boolean): void
}) {
  useI18n();
  const running = bot.state === 'running' || bot.state === 'starting';
  const elsewhere = bot.state === 'external';
  const archived = bot.state === 'archived';
  let cells;
  if (ordering) {
    cells = (
      <span className="bot-order">
        <button type="button" aria-label={t('Move {name} up', { name: bot.name })} disabled={first} onClick={() => act('moveUp')}>↑</button>
        <button type="button" aria-label={t('Move {name} down', { name: bot.name })} disabled={last} onClick={() => act('moveDown')}>↓</button>
      </span>
    );
  } else if (archived) {
    cells = (
      <>
        <span className="bot-cell" />
        <span className="bot-cell"><button type="button" className="bot-run" onClick={() => act('restore')}>{t('Restore')}</button></span>
        <span className="bot-cell" />
        <span className="bot-cell">
          <button type="button" className="quiet danger bot-icon" aria-label={t('Delete {name}…', { name: bot.name })} onClick={() => act('delete')}>
            <span className="bot-word">{t('Delete…')}</span><BoxIcon />
          </button>
        </span>
      </>
    );
  } else {
    cells = (
      <>
        <span className="bot-cell">
          {!elsewhere && (
            <input type="checkbox" className="switch" id={`bot-auto-${bot.id}`} aria-label={t('Auto-start {name}', { name: bot.name })}
              checked={bot.startAutomatically} onChange={(event) => act('startAutomatically', event.target.checked)} />
          )}
        </span>
        <span className="bot-cell">
          {!elsewhere && bot.state !== 'missing' && (running
            ? <button type="button" className="bot-run" onClick={() => act('stop')}>{t('Stop')}</button>
            : <button type="button" className="bot-run" onClick={() => act('start')}>{t('Start')}</button>)}
        </span>
        <span className="bot-cell">
          {running && (
            <button type="button" className="bot-icon" id={`bot-settings-${bot.id}`} aria-label={t('Settings for {name}', { name: bot.name })}
              onClick={() => act('openSettings')}>
              <span className="bot-word">{t('Settings')}</span><GearIcon />
            </button>
          )}
        </span>
        <span className="bot-cell">
          {!elsewhere && (
            <button type="button" className="quiet bot-icon" aria-label={t('Archive {name}…', { name: bot.name })} onClick={() => act('archive')}>
              <span className="bot-word">{t('Archive…')}</span><BoxIcon />
            </button>
          )}
        </span>
      </>
    );
  }
  return (
    <li className={`bot-line is-${bot.state}`} data-bot={bot.id}>
      <span className="bot-face" aria-hidden="true">
        <img src={avatarUrl(bot.avatar)} alt="" width="36" height="36" />
        <i className="bot-dot" />
      </span>
      <div className="bot-text">
        <div className="bot-name">
          <strong title={bot.name}>{bot.name}</strong>
          {bot.bossCat && <span className="tag">{t('Boss Cat')}</span>}
        </div>
        <small className="bot-state">{botStateLine(bot)}</small>
      </div>
      {cells}
      {bot.error && bot.state === 'failed' ? <small className="bot-error">{bot.error}</small> : null}
    </li>
  );
}

/** SPEC-009 FR-8: a limit saved when the owner leaves the field; a value out of range becomes the nearest one. */
function LimitField({ id, value, range, unit, onSave }: {
  id: string;
  value: number;
  range: readonly [number, number];
  unit: string;
  onSave(value: number): void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const next = clampLimit(text, value, range);
    setText(String(next));
    if (next !== value) onSave(next);
  };
  return (
    <span className="limit-field">
      <input id={id} type="number" min={range[0]} max={range[1]} value={text} onChange={(event) => setText(event.target.value)}
        onBlur={commit} onKeyDown={(event) => { if (event.key === 'Enter') commit(); }} />
      <span>{unit}</span>
    </span>
  );
}

export function BotsTab() {
  useI18n();
  const toast = useToast();
  const [listing, setListing] = useState<BotListing | null>(null);
  const [ordering, setOrdering] = useState(false);

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
    if (!listing) return;
    try {
      setListing(await api.hub.setLimits({ ...listing.limits, [key]: value }));
      toast(t('Saved'));
    } catch (failure) {
      toast(errorText(failure));
      await load();
    }
  };

  const active = listing?.bots.filter((bot) => bot.state !== 'archived') ?? [];
  const archived = listing?.bots.filter((bot) => bot.state === 'archived') ?? [];
  const full = listing ? listing.active >= listing.maxBots : false;
  const holder = active.find((bot) => bot.bossCat) ?? null;
  const others = active.filter((bot) => !bot.bossCat);
  const showOrder = ordering && active.length > 1;
  // SPEC-009 FR-2: one choice assigns the role, moves it or clears it; the hub asks where it must.
  const chooseBossCat = (chosen: string) => {
    const choice = bossCatChoice(holder?.id ?? null, chosen);
    if (choice) void act(choice.id)(choice.action);
  };
  const toolsHint = holder ? bossCatToolsHint(holder) : null;
  return (
    <section className="panel" data-panel="bots">
      <div className="panel-head">
        <h2>
          {t('Cat bots')}
          {listing && <span className="count" id="bots-count">{listing.active} / {listing.maxBots}</span>}
        </h2>
        <div className="panel-head-tools">
          {active.length > 1 && (
            <button type="button" className="setup-more" id="bots-order" aria-pressed={showOrder} onClick={() => setOrdering(!showOrder)}>
              {showOrder ? t('Done') : t('Change order')}
            </button>
          )}
          {!showOrder && (
            <button className="primary" id="bots-new" disabled={!listing || full} onClick={() => void create()}>
              {t('New cat bot')}
            </button>
          )}
        </div>
      </div>
      {full && listing && (
        <p className="lead">{t('That is the most cat bots there can be. Archive one to add another.')}</p>
      )}
      {listing && active.length === 0 && (
        <p className="lead" id="bots-empty">{t('No cat bots yet. Choose New cat bot to make one.')}</p>
      )}
      {active.length > 0 && (
        <div className="bot-list-wrap">
          {!showOrder && <div className="bot-head" aria-hidden="true"><span /><span /><span>{t('Auto-start')}</span></div>}
          <ul className="rows bot-list" id="bots-list">
            {active.map((bot, index) => (
              <BotLine key={bot.id} bot={bot} first={index === 0} last={index === active.length - 1} ordering={showOrder} act={act(bot.id)} />
            ))}
          </ul>
          {showOrder && <p className="hint bot-order-hint">{t('The order is which cat bot starts first, where its floating Cat first sits, and its place in the tray.')}</p>}
        </div>
      )}
      {listing && (
        <Group
          title={t('Boss Cat')}
          id="bots-boss-cat"
          lead={t('The Boss Cat can hand work to the other cat bots. It asks you before it creates or starts a cat bot or passes the role on.')}
        >
          <Row label={t('Assigned to')} htmlFor="boss-cat-holder" hint={toolsHint?.text} warn={toolsHint?.warn}>
            <select id="boss-cat-holder" value={holder?.id ?? ''} onChange={(event) => chooseBossCat(event.target.value)}>
              <option value="">{t('None')}</option>
              {active.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
            </select>
          </Row>
          {holder && (
            <>
              <Row label={t('Hand-offs for one request, at most')} htmlFor="boss-cat-hops">
                <LimitField id="boss-cat-hops" value={listing.limits.hopsPerChain} range={listing.limitRanges.hopsPerChain} unit={t('times')}
                  onSave={(value) => void setLimit('hopsPerChain', value)} />
              </Row>
              <Row label={t('Messages from the Boss Cat per hour, at most')} htmlFor="boss-cat-rate">
                <LimitField id="boss-cat-rate" value={listing.limits.messagesPerHour} range={listing.limitRanges.messagesPerHour} unit={t('messages')}
                  onSave={(value) => void setLimit('messagesPerHour', value)} />
              </Row>
            </>
          )}
        </Group>
      )}
      {holder && others.length > 0 && (
        // SPEC-012 FR-12: per cat bot, on by default; the holder has nothing to show itself.
        <Group title={t('What the Boss Cat can see')} id="bots-boss-cat-sees"
          lead={t('It sees their state, failed turns, waiting decisions and conversation titles, never their messages. Turning it off does not stop the Boss Cat from messaging them.')}>
          {others.map((bot) => (
            <Row key={bot.id} label={bot.name} htmlFor={`bot-sees-${bot.id}`}>
              <input type="checkbox" className="switch" id={`bot-sees-${bot.id}`} checked={bot.bossCatSees}
                onChange={(event) => void act(bot.id)('bossCatSees', event.target.checked)} />
            </Row>
          ))}
        </Group>
      )}
      {listing && listing.unregistered.length > 0 && (
        <Group title={t('In the folder but not added yet')} id="bots-unregistered">
          {listing.unregistered.map((id) => (
            <Row key={id} label={id}>
              <button type="button" disabled={full} onClick={() => void act(id)('register')}>{t('Add')}</button>
            </Row>
          ))}
        </Group>
      )}
      {archived.length > 0 && (
        <section className="group bot-list-wrap">
          <h3>{t('Archived')}</h3>
          <ul className="rows bot-list" id="bots-archived">
            {archived.map((bot) => (
              <BotLine key={bot.id} bot={bot} first last ordering={false} act={act(bot.id)} />
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
