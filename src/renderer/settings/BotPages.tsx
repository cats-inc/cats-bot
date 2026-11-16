import { useCallback, useEffect, useMemo, useState } from 'react';

import type { BotProfile, DesktopControlState, ExecutionAccess, ModelCatalog, ProviderInfo } from '../../core/types.ts';
import { BOT_AVATARS, BOT_AVATAR_LABELS } from '../../shared/avatars.ts';
import { BOT_NAME_MAX } from '../../shared/botText.ts';
import { avatarUrl } from '../avatarArt.ts';
import { enabledNotesText, settingsRow } from '../desktopControl/desktopControl.ts';
import { errorText } from '../errors.ts';
import { useI18n } from '../i18n.ts';
import { ModelField, useModelMenu } from './ModelField.tsx';
import {
  askChoices,
  askDetail,
  askTitle,
  desktopControlAllowed,
  folderName,
  permissionSummary,
  reachOf,
  withAsk,
  withLevel,
  type Reach,
} from './permissionChoices.ts';
import { ProviderOps } from './ProviderOps.tsx';
import { Group, Row } from './Rows.tsx';
import {
  botPatch,
  botReplyLanguageOptions,
  botSettings,
  botTextErrors,
  editedPages,
  liveEdits,
  pendingNotice,
  providerChoices,
  staleLook,
  withPermission,
  withProvider,
  type BotEdits,
  type BotPage,
  type BotSettings,
} from './settingsLogic.ts';
import { PROVIDER_VENDORS } from './setup/setupFacts.ts';
import { PERSONA_PRESETS } from './setup/setupLogic.ts';
import { useToast } from './toast.ts';

/**
 * ADR-030, SPEC-002 FR-2–FR-3: a cat bot's Name and look, Provider and model, and Permissions,
 * in the setup wizard's order and with its controls. The three pages share one save bar, so a
 * provider and the permissions it allows are saved together; what each save will do is said
 * before it is pressed. The pages stay mounted, so edits and a running setup step survive a
 * look at another tab. Every change goes through `updateProfile`; only what changed is sent.
 */

const api = window.catsBot;
const BOT_PAGES: readonly string[] = ['look', 'brain', 'perm'];

export function BotPages({
  profile,
  tab,
  onSaved,
  onPages,
  onBusy,
}: {
  profile: BotProfile;
  tab: string;
  onSaved(profile: BotProfile): void;
  /** The pages with an edit not yet saved, for the dots in the rail. */
  onPages(pages: ReadonlySet<BotPage>): void;
  /** A setup step runs on Provider and model. */
  onBusy(busy: boolean): void;
}) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const [edits, setEdits] = useState<BotEdits>({});
  const [floating, setFloating] = useState<boolean | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [desktop, setDesktop] = useState<DesktopControlState | null>(null);
  const [saving, setSaving] = useState(false);
  const [menuEpoch, setMenuEpoch] = useState(0);

  const loadDesktop = useCallback(async () => {
    try { setDesktop(await api.invoke('desktopControlState')); } catch { setDesktop(null); }
  }, []);
  useEffect(() => {
    const loadShell = () => void api.shell.state().then((state) => setFloating(state?.floatingVisible ?? null)).catch(() => {});
    loadShell();
    void api.invoke('listProviders').then(setProviders);
    void loadDesktop();
    window.addEventListener('focus', loadShell);
    const off = api.onEvent((event) => { if (event.type === 'desktop.control') void loadDesktop(); });
    return () => { window.removeEventListener('focus', loadShell); off(); };
  }, [loadDesktop]);

  const base = useMemo(() => botSettings(profile, floating ?? true), [profile, floating]);
  const live = liveEdits(base, edits);
  const view: BotSettings = { ...base, ...live };
  const edit = (next: BotEdits) => setEdits((current) => ({ ...current, ...next }));

  // The saved model until the menu is touched; a profile read again on focus does not reset the menu.
  const sameProvider = view.provider === profile.executionTarget.provider;
  const savedSelectionKey = JSON.stringify(profile.executionTarget.modelSelection ?? null);
  const savedSelection = useMemo(() => profile.executionTarget.modelSelection, [savedSelectionKey]);
  const fetchModels = useCallback((provider: string): Promise<ModelCatalog> => api.invoke('listModels', provider), [menuEpoch]);
  const { menu, setMenu, ready, model, selection } = useModelMenu(
    view.provider,
    sameProvider ? profile.executionTarget.model : null,
    fetchModels,
    sameProvider ? savedSelection : undefined,
    sameProvider,
  );
  const keepTarget = sameProvider && !menu.edited;
  const target = keepTarget
    ? { model: profile.executionTarget.model, ...(profile.executionTarget.modelSelection ? { modelSelection: profile.executionTarget.modelSelection } : {}) }
    : { model, ...(selection ? { modelSelection: selection } : {}) };
  const modelDirty = sameProvider && !keepTarget
    && (target.model !== profile.executionTarget.model || JSON.stringify(target.modelSelection ?? null) !== savedSelectionKey);

  const textErrors = botTextErrors(profile, view);
  const patch = botPatch(profile, view, target);
  const floatingChanged = floating !== null && view.floating !== floating;
  const pages = editedPages(base, live, modelDirty);
  const pagesKey = [...pages].sort().join(',');
  useEffect(() => { onPages(pages); }, [pagesKey]);
  const label = (id: string) => providers.find((item) => item.id === id)?.label ?? id;
  const notice = pendingNotice(profile, view, patch, label(view.provider), floatingChanged);
  const blockedBy = textErrors.name ?? textErrors.instructions;
  const canSave = !saving && !blockedBy && (keepTarget || ready);

  const revert = () => {
    setEdits({});
    if (menu.edited) setMenuEpoch((epoch) => epoch + 1);
  };
  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      if (patch) {
        const saved = await api.invoke('updateProfile', patch);
        onSaved(saved);
        if (staleLook(patch, saved)) toast(t('This cat bot runs an older version that cannot change its look. Restart it and choose again.'));
      }
      if (floatingChanged) {
        const actual = await api.shell.setFloatingVisible(view.floating);
        setFloating(actual ?? view.floating);
      }
      setEdits({});
      if (menu.edited) setMenuEpoch((epoch) => epoch + 1);
      toast(t('Saved'));
    } catch (failure) {
      toast(t('Could not save: {value0}', { value0: errorText(failure) }));
    } finally {
      setSaving(false);
      void loadDesktop();
    }
  };

  const known = providers.some((item) => item.id === view.provider);
  const providerLabel = label(view.provider);
  const reach = reachOf(view.provider, providerLabel, view.permission);
  const choices = askChoices(view.provider);
  const deskRow = settingsRow(desktop);
  const deskOffered = (view.provider === 'claude' || view.provider === 'codex') && !deskRow.hidden;
  const deskAllowed = desktopControlAllowed(view.provider, view.permission);
  const browse = async () => {
    const chosen = await api.shell.chooseFolder(view.cwd);
    if (chosen) edit({ cwd: chosen });
  };
  const summary = [
    permissionSummary(view.name.trim() || profile.name, view.provider, providerLabel, folderName(view.cwd), view.permission),
    view.provider === 'claude' && view.claudeInChrome ? t('It can also use Chrome.') : '',
    view.desktopControl && deskAllowed ? t('In conversations where you turn it on, it can use the apps you allow.') : '',
  ].filter(Boolean).join(' ');

  return (
    <>
      <section className="panel bot-page" data-panel="look" hidden={tab !== 'look'}>
        <h2>{t('Name and look')}</h2>
        <div className="form">
          <label className="field">
            <span>{t('Name')}</span>
            <input id="bot-name" required maxLength={BOT_NAME_MAX} aria-invalid={Boolean(textErrors.name)} value={view.name}
              onChange={(event) => edit({ name: event.target.value })} />
            {textErrors.name && <small className="hint warn" role="alert">{t(textErrors.name)}</small>}
          </label>
          <fieldset className="setup-fieldset" id="bot-avatar">
            <legend>{t('Appearance')}</legend>
            <div className="setup-avatars">
              {BOT_AVATARS.map((avatar) => (
                <label key={avatar} className="setup-choice">
                  <input type="radio" name="bot-avatar" value={avatar} checked={view.avatar === avatar} onChange={() => edit({ avatar })} />
                  <img src={avatarUrl(avatar)} alt="" width="38" height="38" />
                  <span>{t(BOT_AVATAR_LABELS[avatar])}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="field setup-persona">
            <label htmlFor="bot-instructions">{t('Personality')} <em>{t('(optional)')}</em></label>
            <div className="setup-chips">
              {PERSONA_PRESETS.map((preset, index) => (
                <button key={preset.label} type="button" className="setup-chip" id={`bot-persona-${index}`}
                  aria-pressed={view.instructions === t(preset.text)} onClick={() => edit({ instructions: t(preset.text) })}>
                  {t(preset.label)}
                </button>
              ))}
            </div>
            <textarea id="bot-instructions" rows={4} aria-invalid={Boolean(textErrors.instructions)} placeholder={t(PERSONA_PRESETS[0]!.text)}
              value={view.instructions} onChange={(event) => edit({ instructions: event.target.value })} />
            {textErrors.instructions && <small className="hint warn" role="alert">{t(textErrors.instructions)}</small>}
          </div>
        </div>
        <Group>
          <Row label={t('Reply language')} htmlFor="bot-reply-language">
            <select id="bot-reply-language" value={view.replyLanguage}
              onChange={(event) => edit({ replyLanguage: event.target.value as BotSettings['replyLanguage'] })}>
              {botReplyLanguageOptions(locale, profile.hubLanguage).map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </Row>
          <Row label={t('Show the floating cat above other windows')} htmlFor="bot-floating" hint={t('When it is hidden, the tray brings it back.')}>
            <input type="checkbox" className="switch" id="bot-floating" checked={view.floating} disabled={floating === null}
              onChange={(event) => edit({ floating: event.target.checked })} />
          </Row>
        </Group>
      </section>

      <section className="panel bot-page" data-panel="brain" hidden={tab !== 'brain'}>
        <h2>{t('Provider and model')}</h2>
        <div className="form">
          <fieldset className="setup-fieldset" id="bot-provider">
            <legend>{t('Agent CLI')}</legend>
            <div className="setup-providers">
              {providerChoices(providers, profile.executionTarget.provider).map((item) => (
                <label key={item.id} className="setup-choice">
                  <input type="radio" name="bot-provider" value={item.id} checked={view.provider === item.id}
                    onChange={() => edit(withProvider(view, item.id))} />
                  <strong>{item.label}</strong>
                  <small>{PROVIDER_VENDORS[item.id]}</small>
                </label>
              ))}
            </div>
          </fieldset>
          {providers.length > 0 && !known && (
            <p className="hint">{t('Saved provider: {provider}. It is kept until you choose a supported provider.', { provider: view.provider })}</p>
          )}
          {known && (
            <ProviderOps provider={view.provider} label={providerLabel} who={view.name.trim() || profile.name} onBusy={onBusy}
              onState={(state) => { if (state) void api.invoke('listProviders').then(setProviders); }} />
          )}
          <ModelField idPrefix="bot" menu={menu} onChange={setMenu} />
        </div>
      </section>

      <section className="panel bot-page" data-panel="perm" hidden={tab !== 'perm'}>
        <h2>{t('Permissions')}</h2>
        <div className="perm-summary" id="perm-summary">
          <img src={avatarUrl(view.avatar)} alt="" width="32" height="32" />
          <p>{summary}</p>
        </div>
        <div className="form">
          <label className="field">
            <span>{t('Filespace')}</span>
            <div className="row">
              <input id="bot-cwd" value={view.cwd} onChange={(event) => edit({ cwd: event.target.value })} />
              <button type="button" id="bot-cwd-browse" onClick={() => void browse()}>{t('Browse…')}</button>
            </div>
            <small className="hint">{t('{name} works in this folder, and attachments from your conversations go here too.', { name: view.name.trim() || profile.name })}</small>
          </label>
          <fieldset className="field perm-asks" id="bot-ask">
            <legend>{t('Ask before it acts?')}</legend>
            {choices.map((ask) => (
              <label key={ask} className={ask === 'never' ? 'perm-ask is-warn' : 'perm-ask'}>
                <input type="radio" name="bot-ask" value={ask} checked={view.permission.ask === ask} disabled={choices.length === 1}
                  onChange={() => edit(withPermission(view, withAsk(view.provider, view.permission, ask)))} />
                <span>
                  <strong>{askTitle(view.provider, providerLabel, ask)}</strong>
                  {askDetail(view.provider, providerLabel, ask) && <small>{askDetail(view.provider, providerLabel, ask)}</small>}
                </span>
              </label>
            ))}
          </fieldset>
          {reach && (
            <fieldset className="field" id="bot-reach">
              <legend>{t('What it can reach')}</legend>
              <ReachMap reach={reach} folder={folderName(view.cwd)} provider={providerLabel}
                onLevel={(level) => edit(withPermission(view, withLevel(view.permission, level)))}
                onNetwork={() => edit(withPermission(view, { ...view.permission, network: view.permission.network !== true }))} />
              {reach.note && <p className="hint">{reach.note}</p>}
            </fieldset>
          )}
        </div>
        {(view.provider === 'claude' || deskOffered) && (
          <Group title={t('Extras')}>
            {view.provider === 'claude' && (
              <Row label={t('Use Chrome or Edge')} hint={t('Through the Claude extension (Claude in Chrome).')} htmlFor="bot-chrome">
                <input type="checkbox" className="switch" id="bot-chrome" checked={view.claudeInChrome}
                  onChange={(event) => edit({ claudeInChrome: event.target.checked })} />
              </Row>
            )}
            {deskOffered && (
              <Row label={t('Desktop control')} htmlFor="desktop-control-enabled" warn={Boolean(deskRow.note)}
                hint={!deskAllowed
                  ? <>{t('Only with Ask me first, since every action needs your OK.')}{' '}
                      <button type="button" className="setup-more" id="desktop-control-ask" onClick={() => edit(withPermission(view, withAsk(view.provider, view.permission, 'ask')))}>{t('Use Ask me first')}</button></>
                  : deskRow.note ?? (view.desktopControl && desktop?.enabled ? enabledNotesText(desktop)
                    : t('In conversations where you turn it on, it sees and uses the apps you allow, asking each time. Only messages you send from this computer can use it.'))}>
                <input type="checkbox" className="switch" id="desktop-control-enabled" checked={view.desktopControl}
                  disabled={!deskAllowed || deskRow.disabled && !view.desktopControl}
                  onChange={(event) => edit({ desktopControl: event.target.checked })} />
              </Row>
            )}
          </Group>
        )}
        <p className="hint perm-foot">{t('What is in force for a session, and the tools it has, are under Details.')}</p>
      </section>

      {BOT_PAGES.includes(tab) && pages.size > 0 && (
        <div className="savebar" role="region" aria-label={t('Unsaved changes')}>
          <p id="bot-save-note">{blockedBy ? t(blockedBy) : notice.join(' ')}</p>
          <button type="button" className="quiet" id="bot-revert" disabled={saving} onClick={revert}>{t('Revert')}</button>
          <button type="button" className="primary" id="bot-save" disabled={!canSave} onClick={() => void save()}>
            {saving ? t('Saving…') : t('Save')}
          </button>
        </div>
      )}
    </>
  );
}

const RANK: Record<ExecutionAccess, number> = { 'read-only': 1, 'workspace-write': 2, 'full-access': 3 };

/** What it can reach: the whole computer holds the filespace, and the network sits beside both. */
function ReachMap({ reach, folder, provider, onLevel, onNetwork }: {
  reach: Reach;
  folder: string;
  provider: string;
  onLevel(level: ExecutionAccess): void;
  onNetwork(): void;
}) {
  const { t } = useI18n();
  const rank = RANK[reach.level];
  const zone = (inside: boolean, edge: boolean, extra: string) => `reach-zone ${extra}${inside ? ' is-in' : ' is-out'}${edge ? ' is-edge' : ''}`;
  const state = (inside: boolean) => (inside ? t('Can reach') : t('Cannot reach'));
  return (
    <div className={reach.locked ? 'reach is-locked' : 'reach'}>
      <div className={zone(rank >= 3, rank === 3, 'reach-machine')}>
        <div className="reach-head">
          <button type="button" className="reach-pick" id="reach-full" aria-pressed={rank === 3} disabled={reach.locked || !reach.wholeComputer}
            onClick={() => onLevel('full-access')}>{t('The whole computer')}</button>
          <span className="reach-state">{state(rank >= 3)}</span>
        </div>
        <div className={zone(true, rank === 2, 'reach-space')}>
          <div className="reach-head"><span><strong>{t('Filespace')}</strong> <code>{folder}</code></span></div>
          <div className="reach-halves">
            <button type="button" className={zone(true, rank === 1, 'reach-half')} id="reach-read" aria-pressed={rank === 1} disabled={reach.locked}
              onClick={() => onLevel('read-only')}>{t('Only read')}<small>{t('Looks at files')}</small></button>
            <button type="button" className={zone(rank >= 2, false, 'reach-half')} id="reach-write" aria-pressed={rank === 2} disabled={reach.locked}
              onClick={() => onLevel('workspace-write')}>{t('Read and edit')}<small>{t('Changes files too')}</small></button>
          </div>
        </div>
      </div>
      <button type="button" className={`reach-zone reach-net${reach.network === true ? ' is-in' : reach.network === false ? ' is-out' : ' is-unset'}`}
        id="reach-network" aria-pressed={reach.network === true} disabled={reach.locked || reach.level !== 'workspace-write'} onClick={onNetwork}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M3 12h18M12 3c2.8 3 2.8 15 0 18M12 3c-2.8 3-2.8 15 0 18" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
        <strong>{t('Network')}</strong>
        <span className="reach-state">{reach.network === null ? t('As {provider} is set', { provider }) : state(reach.network)}</span>
      </button>
    </div>
  );
}
