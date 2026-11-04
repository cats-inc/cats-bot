import { useCallback, useEffect, useRef, useState } from 'react';
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
import type { ProviderSetupState, SetupEnvironment, SetupStepId } from '../../../shared/providerSetup.ts';
import { avatarSvg, avatarUrl } from '../../avatarArt.ts';
import { errorText } from '../../errors.ts';
import { useI18n } from '../../i18n.ts';
import { ModelField, useModelMenu } from '../ModelField.tsx';
import { PROVIDER_VENDORS } from './setupFacts.ts';
import {
  addLogEntry,
  checksToRun,
  elapsedLabel,
  liveRow,
  logTotals,
  PERSONA_PRESETS,
  pendingSteps,
  queueOf,
  requiredPending,
  requiredTickable,
  retryQueue,
  rowKind,
  stoppedStep,
  type LogRun,
} from './setupLogic.ts';
import { SetupLog } from './SetupLog.tsx';
import { CheckIcon, CommandSnippet, PlainRow, StepRow, WaitIcon } from './StepRow.tsx';

/**
 * SPEC-010: creating a cat bot, in three pages. Each page touches more than the one
 * before, and nothing runs until the owner asks: page 1 starts no process, page 2's
 * check only reads, and only what the owner ticks changes anything.
 */

const api = window.catsBot;
const fetchModels = (provider: string): Promise<ModelCatalog> => api.setup.models(provider);
/** FR-14: how long a finished run's log stays open before it gives the room back. */
const LOG_SETTLE_MS = 1400;

type Phase = 'idle' | 'checking' | 'applying' | 'creating';

function useElapsed(since: number | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [since]);
  return since === null ? null : elapsedLabel(now - since);
}

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

const STEPS: ReadonlyArray<{ number: 1 | 2 | 3; title: string; note: string }> = [
  { number: 1, title: 'Name and look', note: 'Changes nothing on your computer' },
  { number: 2, title: 'Check and install', note: 'Runs only what you tick' },
  { number: 3, title: 'Sign in and start', note: 'Nothing is created until you confirm' },
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
  const [provider, setProvider] = useState('');
  const personaBox = useRef<HTMLTextAreaElement>(null);
  const nameProblem = botNameProblem(normalizeBotName(name));
  const personaProblem = botPersonaProblem(normalizeBotPersona(persona));
  const providerInfo = providers.find((item) => item.id === provider) ?? null;

  // Page 2
  const [phase, setPhase] = useState<Phase>('idle');
  const [state, setState] = useState<ProviderSetupState | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<SetupStepId>>(new Set());
  const [details, setDetails] = useState<ReadonlySet<SetupStepId>>(new Set());
  const [applied, setApplied] = useState<ReadonlySet<SetupStepId>>(new Set());
  const [attempted, setAttempted] = useState<ReadonlySet<SetupStepId>>(new Set());
  const [queue, setQueue] = useState<SetupStepId[]>([]);
  const [runningStep, setRunningStep] = useState<SetupStepId | null>(null);
  const [runStart, setRunStart] = useState<number | null>(null);
  const [stopAfter, setStopAfter] = useState(false);
  const stopRequested = useRef(false);
  const ticket = useRef(0);
  const stopping = useRef<Promise<void>>(Promise.resolve());
  const [error, setError] = useState<string | null>(null);

  // The log
  const [runs, setRuns] = useState<LogRun[]>([]);
  const runsRef = useRef<LogRun[]>([]);
  const [checkFrom, setCheckFrom] = useState(0);
  const [logOpen, setLogOpen] = useState(false);
  const logChoice = useRef<'open' | 'closed' | null>(null);
  const hovering = useRef(false);
  const closeOnLeave = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Page 3
  const [modelProvider, setModelProvider] = useState('');
  const { menu, setMenu, ready: modelReady, model, selection } = useModelMenu(modelProvider, null, fetchModels);
  const [startAtLogin, setStartAtLogin] = useState(true);
  const [folder, setFolder] = useState<string | null>(null);
  const [terminal, setTerminal] = useState<'opened' | 'missing' | null>(null);
  const [openingTerminal, setOpeningTerminal] = useState(false);

  const heading = useRef<HTMLHeadingElement>(null);
  const elapsed = useElapsed(runStart);

  useEffect(() => {
    document.title = purpose === 'create' ? t('New cat bot') : t('Set up Cats Bot');
  }, [locale, purpose, t]);

  useEffect(() => api.setup.onLog((entry) => {
    runsRef.current = addLogEntry(runsRef.current, entry);
    setRuns(runsRef.current);
  }), []);

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
      // FR-4: a request fills in the page, and still waits for the button.
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
    heading.current?.focus();
  }, [step]);

  // FR-14: any script run opens the log, unless the owner closed it themselves.
  const openLogForRun = useCallback(() => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = null;
    closeOnLeave.current = false;
    setLogOpen(logChoice.current !== 'closed');
  }, []);
  const settleLog = useCallback(() => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      settleTimer.current = null;
      if (logChoice.current) return;
      if (hovering.current) {
        closeOnLeave.current = true;
        return;
      }
      setLogOpen(false);
    }, LOG_SETTLE_MS);
  }, []);
  useEffect(() => () => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
  }, []);
  const toggleLog = () => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    settleTimer.current = null;
    closeOnLeave.current = false;
    setLogOpen((open) => {
      logChoice.current = open ? 'closed' : 'open';
      return !open;
    });
  };

  /** FR-10, FR-14: a check can fail too, and then that row's details and the log stay open. */
  const showBroken = useCallback((next: ProviderSetupState): boolean => {
    const broken = next.steps.filter((item) => ['failed', 'declined'].includes(rowKind(item))).map((item) => item.id);
    if (broken.length === 0) return false;
    setDetails((current) => new Set([...current, ...broken]));
    setLogOpen(true);
    return true;
  }, []);

  const runCheck = useCallback(async (): Promise<void> => {
    const mine = ++ticket.current;
    setPhase('checking');
    setError(null);
    setCheckFrom(runsRef.current.length);
    setRunStart(Date.now());
    openLogForRun();
    let failed = false;
    try {
      await stopping.current;
      if (mine !== ticket.current) return;
      const next = await api.setup.check(provider);
      if (mine !== ticket.current) return;
      setState(next);
      // What is still open keeps its tick; what got done or stopped applying loses it.
      setTicked((current) => new Set([...current].filter((id) => next.steps.some((item) => item.id === id && rowKind(item) === 'needs'))));
      failed = showBroken(next);
    } catch (failure) {
      if (mine !== ticket.current) return;
      failed = true;
      setError(errorText(failure));
      setLogOpen(true);
    }
    setPhase('idle');
    setRunStart(null);
    if (!failed) settleLog();
  }, [openLogForRun, provider, settleLog, showBroken]);

  const startCheck = () => {
    if (state?.provider !== provider) {
      setState(null);
      setTicked(new Set());
      setDetails(new Set());
      setApplied(new Set());
      setAttempted(new Set());
    }
    setTerminal(null);
    setStep(2);
    void runCheck();
  };

  /** FR-6: Back stops a running check at once. */
  const goTo = (target: 1 | 2 | 3) => {
    if (phase === 'checking') {
      ticket.current += 1;
      stopping.current = api.setup.cancel();
      setPhase('idle');
      setRunStart(null);
      settleLog();
    }
    setError(null);
    if (target === 3) {
      setTerminal(null);
      setModelProvider(provider);
      void api.setup.folder(name).then(setFolder);
    }
    setStep(target);
  };

  /** FR-11: ticked rows, one at a time from the top, with a fresh check after each. */
  const apply = async (ids: SetupStepId[]) => {
    if (ids.length === 0) return;
    const mine = ++ticket.current;
    stopRequested.current = false;
    setStopAfter(false);
    setPhase('applying');
    setError(null);
    setQueue(ids);
    openLogForRun();
    let stopped = false;
    let latest: ProviderSetupState | null = null;
    try {
      for (const id of ids) {
        if (stopRequested.current) break;
        setRunningStep(id);
        setRunStart(Date.now());
        setAttempted((current) => new Set(current).add(id));
        const next = await api.setup.install(provider, id);
        if (mine !== ticket.current) return;
        latest = next;
        setState(next);
        setTicked((current) => {
          const rest = new Set(current);
          rest.delete(id);
          return rest;
        });
        setQueue((current) => current.filter((item) => item !== id));
        const done = next.steps.find((item) => item.id === id);
        const kind = done ? rowKind(done) : 'failed';
        if (kind === 'ready') {
          setApplied((current) => new Set(current).add(id));
          // It is done, so a check that fails on it later has nothing to try again.
          setAttempted((current) => {
            const rest = new Set(current);
            rest.delete(id);
            return rest;
          });
        } else if (kind === 'failed' || kind === 'declined' || kind === 'restart') {
          // FR-13: a failure stops the queue, and only then do the details open by themselves.
          stopped = true;
          if (kind !== 'restart') setDetails((current) => new Set(current).add(id));
          setLogOpen(true);
          break;
        } else if (done) {
          stopped = true;
          setError(t('{label} ran, but it is not done yet. The log below has its result.', { label: t(done.label) }));
          setDetails((current) => new Set(current).add(id));
          setLogOpen(true);
          break;
        }
      }
    } catch (failure) {
      stopped = true;
      setError(errorText(failure));
      setLogOpen(true);
    }
    setRunningStep(null);
    setRunStart(null);
    setQueue([]);
    setPhase('idle');
    // A row's fresh check can show another row failing, which is a failure too.
    const broken = latest ? showBroken(latest) : false;
    if (!stopped && !broken) settleLog();
  };

  const stopped = stoppedStep(state);
  const pending = requiredPending(state);
  const queued = queueOf(state, ticked);
  const retry = retryQueue(stopped, attempted, queued);
  const shortcut = requiredTickable(state);
  const allRequiredTicked = shortcut.length > 0 && shortcut.every((item) => ticked.has(item.id));
  const busy = phase !== 'idle';
  const changes = logTotals(runs).changes;
  const windows = environment.platform === 'win32';
  const adminAsked = queued.includes('node') && windows;
  const label = providerInfo?.label ?? provider;
  const displayName = name.trim() || t('Cat bot');

  const openTerminal = async () => {
    setOpeningTerminal(true);
    let opened = false;
    try {
      opened = (await api.setup.openTerminal(provider)).opened;
    } catch {
      opened = false;
    }
    setTerminal(opened ? 'opened' : 'missing');
    if (!opened) {
      // FR-14: a failure opens the log, and a close still waiting from an earlier run must not undo that.
      if (settleTimer.current) clearTimeout(settleTimer.current);
      settleTimer.current = null;
      closeOnLeave.current = false;
      setLogOpen(true);
    }
    setOpeningTerminal(false);
  };

  const create = async () => {
    if (!modelReady || busy) return;
    setPhase('creating');
    setError(null);
    openLogForRun();
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
      setPhase('idle');
      setLogOpen(true);
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

  /* ---- Page 1 ---- */
  const pageOne = (
    <>
      <div className="setup-head">
        <h1 ref={heading} tabIndex={-1}>{t('Meet your cat bot')}</h1>
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
      <fieldset className="setup-fieldset setup-gap" id="setup-provider">
        <legend>{t('Agent CLI')} <em>{t('(nothing checks whether it is installed yet)')}</em></legend>
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
      <p className="hint setup-foot-hint">
        {nameProblem === 'empty'
          ? t('Give the cat bot a name')
          : !provider
            ? t('Choose a provider first.')
            : provider === 'codex'
              ? t('Codex needs Node.js. The next step runs at most {count} read-only checks and changes nothing.', { count: checksToRun(provider, environment.platform) })
              : t('The next step runs 1 read-only check and changes nothing.')}
      </p>
      <button type="button" className="primary" id="setup-check" disabled={Boolean(nameProblem || personaProblem) || !provider} onClick={startCheck}>
        {t('Check this computer')}
      </button>
    </>
  );

  /* ---- Page 2 ---- */
  let title: string;
  let lead: string;
  if (phase === 'checking') {
    title = t('Checking this computer');
    lead = t('This only reads what is there and changes nothing. Back stops it, if you want another provider.');
  } else if (phase === 'applying') {
    title = t('Applying what you ticked');
    lead = t('One at a time. This window cannot close until it finishes.');
  } else if (stopped && rowKind(stopped) === 'restart') {
    title = stopped.systemRestartRequired ? t('Windows restart required') : t('Cannot find {label} yet', { label: t(stopped.label) });
    lead = stopped.systemRestartRequired ? t('Restart Windows to finish installation.') : t('Check again first. What you typed stays if Cats Bot has to restart.');
  } else if (stopped && retry.length > 0) {
    title = t('{label} did not finish', { label: t(stopped.label) });
    lead = t('What comes after it did not run. Try again, or set it up yourself and check again.');
  } else if (stopped) {
    title = t('Cannot check {label}', { label: t(stopped.label) });
    lead = t('Its script did not run. The log below says why. Set it up yourself, then check again.');
  } else if (state && pending.length > 0) {
    title = t('{count} more before you can use {provider}', { count: pending.length, provider: label });
    lead = t('Tick what Cats Bot should do. Nothing unticked runs. You can also set it up yourself, then check again.');
  } else if (state) {
    title = t('This computer is ready for {provider}', { provider: label });
    lead = changes > 0
      ? t('Changed {count} item(s). The log below has the details.', { count: changes })
      : t('Nothing needed installing, and nothing here changed.');
  } else if (error) {
    title = t('The check did not finish');
    lead = '';
  } else {
    title = t('Checking this computer');
    lead = t('This only reads what is there and changes nothing. Back stops it, if you want another provider.');
  }

  const showLive = phase === 'checking' || !state;
  const lastTickable = (state?.steps ?? []).map((item) => rowKind(item)).lastIndexOf('needs');
  const pageTwo = (
    <>
      <h1 ref={heading} tabIndex={-1}>{title}</h1>
      {lead && <p className="lead">{lead}</p>}
      {error && <p className="error" id="setup-error" role="alert">{t(error)}</p>}
      <ul className="setup-rows" aria-busy={busy}>
        {showLive
          ? pendingSteps(provider, label, environment.platform).map((item) => {
              const live = liveRow(runs, checkFrom, item.helper);
              return (
                <PlainRow
                  key={item.id}
                  id={item.id}
                  label={item.label}
                  optional={item.optional}
                  glyph={live === 'checking' ? <span className="setup-spinner" /> : live === 'ready' ? <CheckIcon /> : live === 'needs' ? <WaitIcon /> : null}
                  state={t(live === 'pending' ? 'Waiting' : live === 'checking' ? 'Checking' : live === 'ready' ? 'Ready' : 'Needs work')}
                />
              );
            })
          : state!.steps.flatMap((item, index) => {
              const row = (() => {
              if (item.id === runningStep) {
                const adminPrompt = item.id === 'node' && windows;
                return (
                  <PlainRow
                    key={item.id}
                    id={item.id}
                    label={item.label}
                    optional={item.optional}
                    glyph={<span className="setup-spinner" />}
                    state={elapsed ?? '00:00'}
                    note={adminPrompt
                      ? t('Windows asks for permission; choose Yes. The installer runs in that process, so this updates when it ends.')
                      : t('Running {file}', { file: item.script?.file ?? item.label })}
                  />
                );
              }
              if (queue.includes(item.id)) {
                return <PlainRow key={item.id} id={item.id} label={item.label} optional={item.optional} glyph={<WaitIcon />} state={t('Queued')} />;
              }
              return (
                <StepRow
                  key={item.id}
                  step={item}
                  provider={provider}
                  platform={environment.platform}
                  ticked={ticked.has(item.id)}
                  disabled={busy}
                  justApplied={applied.has(item.id)}
                  detailsOpen={details.has(item.id)}
                  onTick={(value) => setTicked((current) => {
                    const next = new Set(current);
                    if (value) next.add(item.id);
                    else next.delete(item.id);
                    return next;
                  })}
                  onDetails={(open) => setDetails((current) => {
                    const next = new Set(current);
                    if (open) next.add(item.id);
                    else next.delete(item.id);
                    return next;
                  })}
                />
              );
              })();
              // FR-9: the shortcut closes the rows it can tick, whatever comes after them.
              return !busy && shortcut.length >= 2 && index === lastTickable
                ? [row, (
                    <li className="setup-row setup-row-shortcut" key="shortcut">
                      <button
                        type="button"
                        className="setup-more"
                        id="setup-tick-required"
                        onClick={() => setTicked((current) => {
                          const next = new Set(current);
                          for (const required of shortcut) {
                            if (allRequiredTicked) next.delete(required.id);
                            else next.add(required.id);
                          }
                          return next;
                        })}
                      >
                        {allRequiredTicked ? t('Untick all required') : t('Tick all required')}
                      </button>
                    </li>
                  )]
                : [row];
            })}
      </ul>
    </>
  );

  const checkAgain = <button type="button" id="setup-recheck" disabled={busy} onClick={() => void runCheck()}>{t('Check again')}</button>;
  const back = <button type="button" id="setup-back" disabled={phase === 'applying' || phase === 'creating'} onClick={() => goTo(1)}>{t('Back')}</button>;
  const draft = () => ({ name: normalizeBotName(name), instructions: normalizeBotPersona(persona), provider, ...(picked ? { avatar: picked } : {}) });
  let pageTwoFoot;
  if (phase === 'checking') {
    pageTwoFoot = <><p className="hint setup-foot-hint" />{back}<button type="button" className="primary" disabled>{t('Checking…')}</button></>;
  } else if (phase === 'applying') {
    pageTwoFoot = (
      <>
        <p className="hint setup-foot-hint">{stopAfter ? t('Stops after this one.') : ''}</p>
        <button type="button" id="setup-stop" disabled={stopAfter} onClick={() => { stopRequested.current = true; setStopAfter(true); }}>{t('Stop after this one')}</button>
        <button type="button" className="primary" disabled>{t('Applying…')}</button>
      </>
    );
  } else if (stopped && rowKind(stopped) === 'restart') {
    pageTwoFoot = (
      <>
        <p className="hint setup-foot-hint" />
        {!stopped.systemRestartRequired && <button type="button" id="setup-restart" onClick={() => void api.setup.restart(draft())}>{t('Restart Cats Bot')}</button>}
        <button type="button" className="primary" id="setup-recheck" onClick={() => void runCheck()}>{t('Check again')}</button>
      </>
    );
  } else if (retry.length > 0) {
    pageTwoFoot = (
      <>
        <p className="hint setup-foot-hint" />
        {back}{checkAgain}
        {state?.canFinish && <button type="button" id="setup-next" onClick={() => goTo(3)}>{t('Next')}</button>}
        {/* FR-9: they ticked it once, so trying again needs no new tick. */}
        <button type="button" className="primary" id="setup-retry" onClick={() => void apply(retry)}>{t('Try again')}</button>
      </>
    );
  } else if (queued.length > 0) {
    pageTwoFoot = (
      <>
        <p className="hint setup-foot-hint">{adminAsked ? t('{count} ticked. Windows will ask for administrator permission.', { count: queued.length }) : t('{count} ticked.', { count: queued.length })}</p>
        {back}{checkAgain}
        <button type="button" className="primary" id="setup-apply" onClick={() => void apply(queued)}>{t('Apply {count} ticked', { count: queued.length })}</button>
      </>
    );
  } else {
    const blocked = !state?.canFinish;
    pageTwoFoot = (
      <>
        <p className="hint setup-foot-hint">{state && blocked ? t('Required items remain. Tick them, or set them up yourself and check again.') : ''}</p>
        {back}{checkAgain}
        <button type="button" className="primary" id="setup-next" disabled={blocked} onClick={() => goTo(3)}>{t('Next')}</button>
      </>
    );
  }

  /* ---- Page 3 ---- */
  const powerShellLeft = provider === 'codex' && windows && state?.steps.some((item) => item.id === 'shell' && rowKind(item) !== 'ready');
  const openTerminalNote = changes > 0 ? t('Terminals already open need reopening to see the new PATH; this button opens a new one.') : '';
  const signIn = state?.signIn ?? 'unknown';
  const pageThree = (
    <>
      <h1 ref={heading} tabIndex={-1}>{t('Sign in, then create {name}', { name: displayName })}</h1>
      <p className="lead">{t('Nothing is created yet. The button below starts it.')}</p>
      {error && <p className="error" id="setup-error" role="alert">{t(error)}</p>}
      <ul className="setup-rows">
        <li className={signIn === 'signed_in' ? 'setup-row is-ready' : 'setup-row'} data-row="sign-in">
          <div className="setup-row-top">
            <span className="setup-glyph">{signIn === 'signed_in' ? <CheckIcon /> : <WaitIcon />}</span>
            <div className="setup-row-text">
              <strong>{t('Sign in to {provider}', { provider: label })}</strong>
              {signIn === 'required' && <p>{t('Sign in in a real terminal. Cats Bot only asks the CLI whether it is signed in and reads no credential files. You can skip this, but {name} cannot answer until you do.', { name: displayName })} {openTerminalNote}</p>}
              {signIn === 'unknown' && <p>{t('This CLI does not report whether it is signed in. Run this once if it is not; if it is, you need not.')} {powerShellLeft ? t('PowerShell scripts is not set up, so this opens in Command Prompt.') : ''} {openTerminalNote}</p>}
            </div>
            <span className={signIn === 'required' ? 'setup-row-state is-attention' : 'setup-row-state'}>
              {t(signIn === 'signed_in' ? 'Signed in' : signIn === 'required' ? 'Not signed in' : 'Cannot tell')}
            </span>
          </div>
          {signIn !== 'signed_in' && (
            <div className="setup-row-actions">
              {state?.signInCommand && <CommandSnippet command={state.signInCommand} copyable />}
              <button type="button" id="setup-open-terminal" disabled={busy || openingTerminal} onClick={() => void openTerminal()}>{t('Open terminal and run')}</button>
              {terminal === 'opened' && <span className="hint">{t('Terminal opened.')}</span>}
              {terminal === 'missing' && <span className="hint warn" role="alert">{t('No terminal was found. Copy the command and run it in yours.')}</span>}
            </div>
          )}
        </li>
        {environment.startAtLoginOffered && (
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
        )}
      </ul>
      <div className="setup-fields"><ModelField idPrefix="setup" menu={menu} onChange={setMenu} /></div>
      <div className="setup-summary">
        <h2>{t('When you press create')}</h2>
        <ul>
          {folder && <li>{t('Creates its data in {path}', { path: folder })}</li>}
          {purpose === 'first-run' && <li>{t('As your first cat bot it becomes the Boss Cat: it can manage your other cat bots and asks you before adding one. You can remove the role in Settings.')}</li>}
          <li>{t('Starts {name} and opens its first note', { name: displayName })}</li>
        </ul>
        <p className="hint">
          {changes > 0
            ? t('So far this setup changed {count} item(s) on your computer; the log has them all.', { count: changes })
            : t('So far this setup has changed nothing on your computer.')}
        </p>
      </div>
    </>
  );

  const pageThreeFoot = (
    <>
      <p className="hint setup-foot-hint" />
      <button type="button" id="setup-back" disabled={phase === 'creating'} onClick={() => goTo(2)}>{t('Back')}</button>
      {provider === 'claude' && signIn === 'required' && (
        <button type="button" id="setup-recheck" disabled={busy} onClick={() => void runCheck()}>{t('Check again')}</button>
      )}
      <button type="button" className="primary" id="setup-submit" disabled={!modelReady || busy} onClick={() => void create()}>
        {phase === 'creating' ? t('Creating…') : t('Create and start {name}', { name: displayName })}
      </button>
    </>
  );

  const runningLine = phase === 'checking'
    ? t('Checking this computer')
    : phase === 'applying' && runningStep
      ? (state?.steps.find((item) => item.id === runningStep)?.script?.file ?? runningStep)
      : phase === 'creating'
        ? t('Creating…')
        : null;

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
                    disabled={!done || phase === 'applying' || phase === 'creating'}
                    onClick={() => goTo(item.number)}
                  >
                    <span className="setup-step-number">{done ? <CheckIcon /> : item.number}</span>
                    <span className="setup-step-title">{t(item.title)}<small>{t(item.note)}</small></span>
                  </button>
                </li>
              );
            })}
          </ol>
          <Perch avatar={avatar} name={name} provider={providerInfo?.label ?? null} busy={busy} />
        </nav>
        <main className="setup-main">
          <div className="setup-pane">{step === 1 ? pageOne : step === 2 ? pageTwo : pageThree}</div>
          <div className="setup-foot">{step === 1 ? pageOneFoot : step === 2 ? pageTwoFoot : pageThreeFoot}</div>
        </main>
      </div>
      <SetupLog
        runs={runs}
        open={logOpen}
        running={runningLine}
        elapsed={elapsed}
        onToggle={toggleLog}
        onHover={(value) => {
          hovering.current = value;
          if (!value && closeOnLeave.current) {
            closeOnLeave.current = false;
            settleLog();
          }
        }}
      />
    </div>
  );
}
