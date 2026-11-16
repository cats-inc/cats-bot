import { useEffect, useMemo, useRef, useState } from 'react';
import type { ModelCatalog, ProviderInfo } from '../../../core/types.ts';
import { DEFAULT_BOT_AVATAR, BOT_AVATARS, BOT_AVATAR_LABELS, type BotAvatar } from '../../../shared/avatars.ts';
import {
  BOT_NAME_MAX,
  BOT_PERSONA_MAX,
  botNameMessage,
  botNameProblem,
  botPersonaMessage,
  botPersonaProblem,
  normalizeBotName,
  normalizeBotPersona,
} from '../../../shared/botText.ts';
import { LANGUAGE_OPTIONS, translate, type LanguagePreference, type Locale } from '../../../shared/language.ts';
import type { SetupEnvironment } from '../../../shared/providerSetup.ts';
import { avatarSvg, avatarUrl } from '../../avatarArt.ts';
import { errorText } from '../../errors.ts';
import { useI18n } from '../../i18n.ts';
import { ModelField, useModelMenu } from '../ModelField.tsx';
import { defaultChoice, permissionSummary } from '../permissionChoices.ts';
import { ProviderOps, type DockedLog } from '../ProviderOps.tsx';
import { PROVIDER_VENDORS } from './setupFacts.ts';
import { PERSONA_PRESETS } from './setupLogic.ts';
import { SetupLog } from './SetupLog.tsx';
import { CheckIcon } from './StepRow.tsx';
import { useElapsed, useSetupLog } from './useSetupLog.ts';

/**
 * SPEC-010, ADR-032: creating a cat bot on the three pages of its settings: Name and look,
 * Provider and model, Permissions. Page 1 starts no process. Page 2 is the settings page's own
 * Provider and model: its check only reads, and a row changes the computer only after its box is
 * confirmed. What the check finds never stops Next or Create; only a step that is running holds
 * Create until it ends. Page 3 says what the new cat bot may do, with its provider's defaults.
 */

const api = window.catsBot;
const fetchModels = (provider: string): Promise<ModelCatalog> => api.setup.models(provider);

/** The new cat bot's filespace is the folder of that name inside its own (`paths.filespace`). */
const FILESPACE = 'filespace';

/** The owner's Cat, sitting on the log. The markup is constant art, chosen by a checked id. */
function Perch({ avatar, name, provider, busy }: { avatar: BotAvatar; name: string; provider: string | null; busy: boolean }) {
  const { t } = useI18n();
  return (
    <div className={busy ? 'setup-perch is-busy' : 'setup-perch'}>
      <div className="setup-cat" aria-hidden="true">
        <div className="setup-cat-art" dangerouslySetInnerHTML={{ __html: avatarSvg(avatar) }} />
        <div className="setup-cat-dots"><i /><i /><i /></div>
      </div>
      <div className="setup-note">
        <strong>{name.trim() || t('No name yet')}</strong>
        <span>{provider ?? t('No provider yet')}</span>
      </div>
    </div>
  );
}

/** ADR-032: the same three pages, under the same names, as a cat bot's settings. */
const STEPS: ReadonlyArray<{ number: 1 | 2 | 3; title: string }> = [
  { number: 1, title: 'Name and look' },
  { number: 2, title: 'Provider and model' },
  { number: 3, title: 'Permissions' },
];

export function SetupWizard({ purpose }: { purpose: 'first-run' | 'create' }) {
  const { locale, preference, setLanguage, t } = useI18n();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [environment, setEnvironment] = useState<SetupEnvironment>({ platform: '', startAtLoginOffered: false });

  // Page 1
  const [name, setName] = useState('Mochi');
  const [suggested, setSuggested] = useState<BotAvatar>(DEFAULT_BOT_AVATAR);
  const [picked, setPicked] = useState<BotAvatar | null>(null);
  const avatar = picked ?? suggested;
  const [persona, setPersona] = useState('');
  const personaBox = useRef<HTMLTextAreaElement>(null);
  const nameProblem = botNameProblem(normalizeBotName(name));
  const personaProblem = botPersonaProblem(normalizeBotPersona(persona));

  // Page 2
  const [provider, setProvider] = useState('');
  const providerInfo = providers.find((item) => item.id === provider) ?? null;
  const label = providerInfo?.label ?? provider;
  const { menu, setMenu, ready: modelReady, model, selection } = useModelMenu(provider, null, fetchModels);
  const [opsBusy, setOpsBusy] = useState(false);

  // Page 3
  const [startAtLogin, setStartAtLogin] = useState(true);
  const [folder, setFolder] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The log, at the window's foot, hears every run; page 2 says when one starts and ends.
  const log = useSetupLog();
  const [running, setRunning] = useState<{ line: string; since: number } | null>(null);
  const elapsed = useElapsed(running?.since ?? null);
  const logRef = useRef(log);
  logRef.current = log;
  const dock = useMemo<DockedLog>(() => ({
    started: (line) => {
      setRunning({ line, since: Date.now() });
      logRef.current.openForRun();
    },
    ended: (failed) => {
      setRunning(null);
      if (failed) logRef.current.openForFailure();
      else logRef.current.settle();
    },
  }), []);

  const headings = [useRef<HTMLHeadingElement>(null), useRef<HTMLHeadingElement>(null), useRef<HTMLHeadingElement>(null)];

  useEffect(() => {
    document.title = purpose === 'create' ? t('New cat bot') : t('Set up Cats Bot');
  }, [locale, purpose, t]);

  // FR-3: none of this starts a process or looks at PATH.
  useEffect(() => {
    void Promise.all([
      api.setup.providers(),
      api.setup.environment(),
      purpose === 'create' ? api.setup.prefill() : Promise.resolve(null),
      purpose === 'create' ? api.setup.suggestedAvatar() : Promise.resolve(null),
      api.setup.draft(),
    ]).then(([list, env, request, look, draft]) => {
      setProviders(list);
      setEnvironment(env);
      if (look) setSuggested(look);
      // FR-4: a request fills in the pages, and still waits for the button.
      const filled = draft ? { name: draft.name, persona: draft.instructions, provider: draft.provider } : request;
      if (filled) {
        setName(filled.name);
        setPersona(filled.persona);
        if (list.some((item) => item.id === filled.provider)) setProvider(filled.provider);
      }
      if (draft?.avatar && BOT_AVATARS.includes(draft.avatar as BotAvatar)) setPicked(draft.avatar as BotAvatar);
    });
  }, [purpose]);

  // FR-5: a box still holding a preset follows a language change.
  const previousLocale = useRef<Locale>(locale);
  useEffect(() => {
    const before = previousLocale.current;
    previousLocale.current = locale;
    if (before === locale) return;
    const preset = PERSONA_PRESETS.find((item) => translate(before, item.text) === persona);
    if (preset) setPersona(translate(locale, preset.text));
  }, [locale, persona]);

  // A new page starts at its title, for the keyboard and for screen readers.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headings[step - 1]!.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const displayName = name.trim() || t('Cat bot');
  const goTo = (target: 1 | 2 | 3) => {
    setError(null);
    if (target === 3) void api.setup.folder(name).then(setFolder);
    setStep(target);
  };
  const draft = () => ({ name: normalizeBotName(name), instructions: normalizeBotPersona(persona), provider, ...(picked ? { avatar: picked } : {}) });

  const canCreate = Boolean(provider) && modelReady && !opsBusy && !creating && !nameProblem && !personaProblem;
  const create = async () => {
    if (!canCreate) return;
    setCreating(true);
    setError(null);
    try {
      await api.setup.finish({
        name: normalizeBotName(name),
        provider,
        model,
        modelSelection: selection,
        instructions: normalizeBotPersona(persona),
        ...(picked ? { avatar: picked } : {}),
        ...(environment.startAtLoginOffered ? { startAtLogin } : {}),
      });
    } catch (failure) {
      setError(errorText(failure));
      setCreating(false);
      log.openForFailure();
    }
  };

  const applyPreset = (text: string, button: HTMLButtonElement) => {
    const box = personaBox.current;
    if (!box) return;
    // Inserted as typing, so Ctrl+Z brings back what it replaced. The state follows from the input event.
    box.focus();
    box.select();
    if (!document.execCommand('insertText', false, text) || box.value !== text) setPersona(text);
    button.focus();
  };

  /* ---- Page 1: Name and look ---- */
  const pageOne = (
    <>
      <div className="setup-head">
        <h1 ref={headings[0]} tabIndex={-1}>{t('Meet your cat bot')}</h1>
        {purpose === 'first-run' && (
          <select
            className="setup-language"
            id="display-language"
            aria-label={t('Display language')}
            value={preference}
            onChange={(event) => void setLanguage(event.target.value as LanguagePreference)}
          >
            {LANGUAGE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{t(option.label)}</option>)}
          </select>
        )}
      </div>
      <label className="field setup-gap">
        <span>{t('Name')}</span>
        <input id="setup-name" autoFocus required maxLength={BOT_NAME_MAX} aria-invalid={Boolean(nameProblem)} value={name} onChange={(event) => setName(event.target.value)} />
        {nameProblem && <small className="hint warn" id="setup-name-error" role="alert">{t(botNameMessage(nameProblem))}</small>}
      </label>
      <fieldset className="setup-fieldset setup-gap" id="setup-avatar">
        <legend>{t('Appearance')}</legend>
        <div className="setup-avatars">
          {BOT_AVATARS.map((item) => (
            <label key={item} className="setup-choice">
              <input type="radio" name="setup-avatar" value={item} checked={avatar === item} onChange={() => setPicked(item)} />
              <img src={avatarUrl(item)} alt="" width="38" height="38" />
              <span>{t(BOT_AVATAR_LABELS[item])}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="field setup-persona">
        <label htmlFor="setup-instructions">{t('Personality')} <em>{t('(optional)')}</em></label>
        <div className="setup-chips">
          {PERSONA_PRESETS.map((preset, index) => (
            <button
              key={preset.label}
              type="button"
              className="setup-chip"
              id={`setup-persona-${index}`}
              aria-pressed={persona === t(preset.text)}
              onClick={(event) => applyPreset(t(preset.text), event.currentTarget)}
            >
              {t(preset.label)}
            </button>
          ))}
        </div>
        <textarea
          id="setup-instructions"
          ref={personaBox}
          rows={2}
          aria-invalid={Boolean(personaProblem)}
          placeholder={t(PERSONA_PRESETS[0]!.text)}
          value={persona}
          onChange={(event) => setPersona(event.target.value)}
        />
        {personaProblem && <small className="hint warn" id="setup-persona-error" role="alert">{t(botPersonaMessage(personaProblem))}</small>}
        {!personaProblem && persona.length > BOT_PERSONA_MAX - 400 && <small className="hint">{persona.length} / {BOT_PERSONA_MAX}</small>}
      </div>
    </>
  );

  const pageOneFoot = (
    <>
      <p className="hint setup-foot-hint">{nameProblem === 'empty' ? t('Give the cat bot a name') : ''}</p>
      <button type="button" className="primary" id="setup-to-provider" disabled={Boolean(nameProblem || personaProblem)} onClick={() => goTo(2)}>
        {t('Next')}
      </button>
    </>
  );

  /* ---- Page 2: Provider and model, as the settings page has it ---- */
  const pageTwo = (
    <>
      <h1 ref={headings[1]} tabIndex={-1}>{t('Which agent CLI {name} uses', { name: displayName })}</h1>
      <fieldset className="setup-fieldset setup-gap" id="setup-provider">
        <legend>{t('Agent CLI')}</legend>
        <div className="setup-providers">
          {providers.map((item) => (
            <label key={item.id} className="setup-choice">
              <input type="radio" name="setup-provider" value={item.id} checked={provider === item.id} onChange={() => setProvider(item.id)} />
              <strong>{item.label}</strong>
              <small>{PROVIDER_VENDORS[item.id]}</small>
            </label>
          ))}
        </div>
      </fieldset>
      {provider && (
        <ProviderOps provider={provider} label={label} who={displayName} onBusy={setOpsBusy} dock={dock} updates={false}
          onRestart={() => void api.setup.restart(draft())} />
      )}
      {provider && <div className="setup-fields"><ModelField idPrefix="setup" menu={menu} onChange={setMenu} /></div>}
    </>
  );

  const pageTwoFoot = (
    <>
      <p className="hint setup-foot-hint">{provider ? '' : t('Choose a provider first.')}</p>
      <button type="button" id="setup-back" onClick={() => goTo(1)}>{t('Back')}</button>
      <button type="button" className="primary" id="setup-next" disabled={!provider} onClick={() => goTo(3)}>{t('Next')}</button>
    </>
  );

  /* ---- Page 3: Permissions, then create ---- */
  const pageThree = (
    <>
      <h1 ref={headings[2]} tabIndex={-1}>{t('What {name} can do', { name: displayName })}</h1>
      {error && <p className="error" id="setup-error" role="alert">{t(error)}</p>}
      {provider && (
        <div className="perm-summary" id="setup-permission">
          <img src={avatarUrl(avatar)} alt="" width="32" height="32" />
          <p>{permissionSummary(displayName, provider, label, FILESPACE, defaultChoice(provider))}</p>
        </div>
      )}
      {environment.startAtLoginOffered && (
        <ul className="setup-rows">
          <li className="setup-row is-needs" data-row="start-at-login">
            <div className="setup-row-top">
              <label>
                <input type="checkbox" id="setup-start-at-login" checked={startAtLogin} onChange={(event) => setStartAtLogin(event.target.checked)} />
                <span className="setup-row-text">
                  <strong>{t('Start Cats Bot when I sign in')}</strong>
                  <p>{t('You can turn this off in Settings.')}</p>
                </span>
              </label>
              <span className="setup-tag">{t('Changes your login items')}</span>
            </div>
          </li>
        </ul>
      )}
      <div className="setup-summary">
        <h2>{t('When you press create')}</h2>
        <ul>
          {folder && <li>{t('Creates its data in {path}', { path: folder })}</li>}
          {purpose === 'first-run' && <li>{t('As your first cat bot it becomes the Boss Cat: it can manage your other cat bots and asks you before adding one. You can remove the role in Settings.')}</li>}
          <li>{t('Starts {name} and opens its first note', { name: displayName })}</li>
        </ul>
      </div>
    </>
  );

  const pageThreeFoot = (
    <>
      <p className="hint setup-foot-hint" />
      <button type="button" id="setup-back" disabled={creating} onClick={() => goTo(2)}>{t('Back')}</button>
      <button type="button" className="primary" id="setup-submit" disabled={!canCreate} onClick={() => void create()}>
        {creating ? t('Creating…') : t('Create and start {name}', { name: displayName })}
      </button>
    </>
  );

  return (
    <div className="setup-wizard">
      <div className="setup-frame">
        <nav className="setup-rail" aria-label={t('Setup steps')}>
          <div className="brand">Cats Bot<small>{purpose === 'first-run' ? t('First-time setup') : t('New cat bot')}</small></div>
          <ol className="setup-steps">
            {STEPS.map((item) => {
              const current = step === item.number;
              const done = step > item.number;
              return (
                <li key={item.number}>
                  <button
                    type="button"
                    className={done ? 'setup-step-link is-done' : current ? 'setup-step-link' : 'setup-step-link is-future'}
                    aria-current={current ? 'step' : undefined}
                    disabled={!done || creating}
                    onClick={() => goTo(item.number)}
                  >
                    <span className="setup-step-number">{done ? <CheckIcon /> : item.number}</span>
                    <span className="setup-step-title">{t(item.title)}</span>
                  </button>
                </li>
              );
            })}
          </ol>
          <Perch avatar={avatar} name={name} provider={providerInfo?.label ?? null} busy={opsBusy || creating} />
        </nav>
        <main className="setup-main">
          {/* Every page stays mounted, so a check or a step on page 2 goes on while another page shows. */}
          <div className="setup-pane" hidden={step !== 1}>{pageOne}</div>
          <div className="setup-pane" hidden={step !== 2}>{pageTwo}</div>
          <div className="setup-pane" hidden={step !== 3}>{pageThree}</div>
          <div className="setup-foot">{step === 1 ? pageOneFoot : step === 2 ? pageTwoFoot : pageThreeFoot}</div>
        </main>
      </div>
      <SetupLog
        runs={log.runs}
        open={log.open}
        running={creating ? t('Creating…') : running?.line ?? null}
        elapsed={elapsed}
        onToggle={log.toggle}
        onHover={log.hover}
      />
    </div>
  );
}
