import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderSetupState, SetupChange, SetupStepId } from '../../shared/providerSetup.ts';
import { errorText } from '../errors.ts';
import { useI18n } from '../i18n.ts';
import { ActionRow, changeVerb } from './setup/ActionRow.tsx';
import { LogButton, LogSheet } from './setup/LogSheet.tsx';
import { liveRow, pendingSteps, retryChange, rowKind, stoppedStep, tickableSteps, type LogRun } from './setup/setupLogic.ts';
import { CheckIcon, CodexSetupRow, PlainRow, SignInRow, WaitIcon } from './setup/StepRow.tsx';
import { useElapsed, useSetupLog } from './setup/useSetupLog.ts';

/**
 * SPEC-013 FR-13, ADR-030: the chosen provider's CLI on this computer, on Provider and model.
 * A row's action asks in a box and runs at once; it is not part of the page's Save, and
 * Save never waits for it. Looking at a provider starts nothing. What was read stays with
 * its provider while another is looked at, and a run goes on when the page or the provider
 * changes; only one setup step runs at a time across Cats Bot (SPEC-013 FR-12).
 */

const api = window.catsBot;

type Item = { id: SetupStepId; change: SetupChange };
type Running = { provider: string; id: SetupStepId };

const BUSY_ELSEWHERE = /Wait for the current setup operation to finish/u;

export function ProviderOps({
  provider,
  label,
  who,
  onState,
  onBusy,
}: {
  provider: string;
  label: string;
  /** Who cannot answer until sign-in is done. */
  who: string;
  onState?(state: ProviderSetupState | null): void;
  onBusy?(busy: boolean): void;
}) {
  const { t } = useI18n();
  const [platform, setPlatform] = useState('');
  const [states, setStates] = useState<Readonly<Record<string, ProviderSetupState>>>({});
  const [checking, setChecking] = useState<string | null>(null);
  const [running, setRunning] = useState<Running | null>(null);
  const [queue, setQueue] = useState<string[]>([]);
  const [runStart, setRunStart] = useState<number | null>(null);
  const [stopAfter, setStopAfter] = useState(false);
  const stopRequested = useRef(false);
  const [confirming, setConfirming] = useState<{ id: string; change: SetupChange } | null>(null);
  const [batchAsked, setBatchAsked] = useState(false);
  const [applied, setApplied] = useState<ReadonlySet<string>>(new Set());
  const [attempted, setAttempted] = useState<ReadonlyMap<string, SetupChange>>(new Map());
  const [notices, setNotices] = useState<ReadonlyMap<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [checkFrom, setCheckFrom] = useState(0);
  const [terminal, setTerminal] = useState<'opened' | 'missing' | null>(null);
  const [codexTerminal, setCodexTerminal] = useState<'opened' | 'missing' | null>(null);
  const [opening, setOpening] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const callbacks = useRef({ onState, onBusy });
  callbacks.current = { onState, onBusy };
  const log = useSetupLog();
  const elapsed = useElapsed(runStart);
  const key = (id: string, of = provider) => `${of}/${id}`;

  useEffect(() => {
    void api.setup.environment().then((environment) => setPlatform(environment.platform)).catch(() => {});
  }, []);
  useEffect(() => {
    setConfirming(null);
    setBatchAsked(false);
    setError(null);
    setTerminal(null);
    setCodexTerminal(null);
  }, [provider]);
  const busy = checking !== null || running !== null;
  useEffect(() => { callbacks.current.onBusy?.(busy); }, [busy]);
  useEffect(() => { callbacks.current.onState?.(states[provider] ?? null); }, [states, provider]);

  const remember = (of: string, next: ProviderSetupState) => setStates((current) => ({ ...current, [of]: next }));
  const fail = (failure: unknown, id?: string) => {
    const text = errorText(failure);
    if (BUSY_ELSEWHERE.test(text)) {
      const notice = t('Another Cats Bot window is running a setup step. Try again when it finishes.');
      if (id) setNotices((current) => new Map(current).set(key(id), notice));
      else setError(notice);
    } else setError(text);
  };

  const check = useCallback(async () => {
    const of = provider;
    setChecking(of);
    setError(null);
    setNotices(new Map());
    setCheckFrom(log.runsRef.current.length);
    setRunStart(Date.now());
    try {
      remember(of, await api.setup.check(of));
    } catch (failure) {
      fail(failure);
    } finally {
      setChecking(null);
      setRunStart(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, log]);

  // The shell installs only for the provider it checked last, which another page may have changed.
  const install = async (of: string, item: Item): Promise<ProviderSetupState> => {
    try {
      return await api.setup.install(of, item.id, item.change);
    } catch (failure) {
      if (!/Check this provider before installing it/u.test(errorText(failure))) throw failure;
      remember(of, await api.setup.check(of));
      return api.setup.install(of, item.id, item.change);
    }
  };

  const apply = async (items: readonly Item[]) => {
    if (items.length === 0 || busy) return;
    const of = provider;
    stopRequested.current = false;
    setStopAfter(false);
    setConfirming(null);
    setBatchAsked(false);
    setError(null);
    setQueue(items.map((item) => key(item.id, of)));
    let current: Item | null = null;
    try {
      for (const item of items) {
        if (stopRequested.current) break;
        current = item;
        setRunning({ provider: of, id: item.id });
        setRunStart(Date.now());
        setNotices((current) => { const rest = new Map(current); rest.delete(key(item.id, of)); return rest; });
        setAttempted((current) => new Map(current).set(key(item.id, of), item.change));
        const next = await install(of, item);
        remember(of, next);
        setQueue((current) => current.filter((id) => id !== key(item.id, of)));
        const done = next.steps.find((step) => step.id === item.id);
        const kind = done ? rowKind(done) : 'failed';
        const updateFailed = item.change === 'upgrade' && ['failed', 'declined'].includes(done?.lastUpdate?.outcome ?? '');
        if (kind === 'ready' && !updateFailed) {
          setApplied((current) => new Set(current).add(key(item.id, of)));
          setAttempted((current) => { const rest = new Map(current); rest.delete(key(item.id, of)); return rest; });
          continue;
        }
        if (updateFailed) setAttempted((current) => { const rest = new Map(current); rest.delete(key(item.id, of)); return rest; });
        break;
      }
    } catch (failure) {
      fail(failure, current?.id);
    } finally {
      setRunning(null);
      setQueue([]);
      setRunStart(null);
    }
  };

  const openTerminal = async (codex = false) => {
    setOpening(true);
    try {
      const result = codex ? await api.setup.openCodexInitialization() : await api.setup.openTerminal(provider);
      (codex ? setCodexTerminal : setTerminal)(result.opened ? 'opened' : 'missing');
    } catch (failure) {
      fail(failure);
    } finally {
      setOpening(false);
    }
  };

  const state = states[provider] ?? null;
  const steps = state?.steps ?? [];
  const stopped = stoppedStep(state);
  const windows = platform === 'win32';
  const needs = tickableSteps(state).filter((step) => !step.optional);
  const lastRun = (helper: string): LogRun | null => log.runs.findLast((run) => run.helper === helper && run.kind === 'change') ?? null;
  const ranHere = (id: string) => attempted.get(key(id));

  const rows = steps.length === 0 || checking === provider
    ? pendingSteps(provider, label, platform).map((item) => {
        if (checking !== provider) {
          return <PlainRow key={item.id} id={item.id} label={item.label} optional={item.optional} glyph={<WaitIcon />} state={t('Not checked yet')} />;
        }
        const live = liveRow(log.runs, checkFrom, item.helper);
        return (
          <PlainRow key={item.id} id={item.id} label={item.label} optional={item.optional}
            glyph={live === 'checking' ? <span className="setup-spinner" /> : live === 'ready' ? <CheckIcon /> : live === 'needs' ? <WaitIcon /> : null}
            state={t(live === 'pending' ? 'Waiting' : live === 'checking' ? 'Checking' : live === 'ready' ? 'Ready' : 'Needs work')} />
        );
      })
    : steps.map((step) => {
        const attemptedChange = ranHere(step.id);
        const retry = stopped?.id === step.id && attemptedChange && rowKind(step) !== 'restart' ? retryChange(step, attemptedChange) : null;
        return (
          <ActionRow
            key={step.id}
            step={step}
            provider={provider}
            platform={platform}
            running={running?.provider === provider && running.id === step.id}
            queued={queue.includes(key(step.id)) && !(running?.provider === provider && running.id === step.id)}
            elapsed={elapsed}
            justApplied={applied.has(key(step.id))}
            retry={retry}
            lastRun={lastRun(step.id === 'provider' ? provider : step.id)}
            disabled={busy}
            confirming={confirming?.id === step.id ? confirming.change : null}
            notice={notices.get(key(step.id)) ?? null}
            onAsk={(change) => { setBatchAsked(false); setConfirming({ id: step.id, change }); }}
            onCancel={() => setConfirming(null)}
            onRun={(change) => void apply([{ id: step.id, change }])}
            onCheckAgain={() => void check()}
          />
        );
      });

  const mainReady = steps.some((step) => (step.id === provider || step.id === 'provider') && rowKind(step) === 'ready');
  const elsewhere = running && running.provider !== provider
    ? states[running.provider]?.steps.find((step) => step.id === running.id)?.label ?? running.id
    : null;
  return (
    <section className="provider-ops" aria-busy={busy}>
      <div className="provider-ops-head">
        <div>
          <h3>{t('{provider} on this computer', { provider: label })}</h3>
          <small className="hint">{t('Every cat bot on this computer shares it.')}</small>
        </div>
        <div className="provider-ops-tools">
          {running && queue.length > 1 && running.provider === provider
            ? <button type="button" id="provider-stop" disabled={stopAfter} onClick={() => { stopRequested.current = true; setStopAfter(true); }}>{t('Stop after this one')}</button>
            : <>
                {needs.length >= 2 && <button type="button" id="provider-setup-all" disabled={busy} aria-expanded={batchAsked}
                  onClick={() => { setConfirming(null); setBatchAsked(!batchAsked); }}>{t('Set up all {count}', { count: needs.length })}</button>}
                <button type="button" id="provider-check" disabled={busy || !provider} onClick={() => void check()}>
                  {checking === provider ? t('Checking…') : state ? t('Check again') : t('Check this computer')}
                </button>
              </>}
          <LogButton runs={log.runs} onOpen={() => setLogOpen(true)} />
          <button type="button" className="setup-more" id="provider-all-clis" onClick={() => void api.shell.openAgentClis()}>{t('All agent CLIs')}</button>
        </div>
      </div>
      {elsewhere && <p className="hint">{t('{step} is still running.', { step: t(elsewhere) })}</p>}
      {error && <p className="error" id="provider-error" role="alert">{error}</p>}
      {batchAsked && (
        <div className="setup-confirm" role="group" aria-label={t('Set up all {count}', { count: needs.length })}>
          <strong>{t('Set up all {count}?', { count: needs.length })}</strong>
          <p className="hint">{t('One at a time, top down. Each one is read again after it runs.')}</p>
          <ul className="setup-confirm-list">
            {needs.map((step) => <li key={step.id}>{changeVerb(step, 'apply', t)} {t(step.label)}{step.applyCommand && <code className="setup-command">{step.applyCommand}</code>}</li>)}
          </ul>
          <div className="setup-confirm-actions">
            <button type="button" className="quiet" onClick={() => setBatchAsked(false)}>{t('Cancel')}</button>
            <button type="button" className="run" data-initial-focus onClick={() => void apply(needs.map((step) => ({ id: step.id, change: 'apply' as const })))}>
              {t('Set up all {count}', { count: needs.length })}
            </button>
          </div>
        </div>
      )}
      <ul className="setup-rows" aria-busy={busy}>
        {rows}
        {state && mainReady && (
          <SignInRow id="provider" label={label} signIn={state.signIn} command={state.signInCommand} who={who}
            busy={busy || opening} terminal={terminal} powerShellLeft={false} changedPath={applied.size > 0}
            onOpen={() => void openTerminal()} />
        )}
        {state && mainReady && provider === 'codex' && windows && (
          <CodexSetupRow status={state.codexInitialization?.status} who={who} busy={busy || opening} terminal={codexTerminal}
            onOpen={() => void openTerminal(true)} />
        )}
      </ul>
      {logOpen && <LogSheet runs={log.runs} onClose={() => setLogOpen(false)} />}
    </section>
  );
}
