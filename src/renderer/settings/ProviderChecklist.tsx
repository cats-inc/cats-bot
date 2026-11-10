import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderSetupState, SetupChange, SetupStepId } from '../../shared/providerSetup.ts';
import { errorText } from '../errors.ts';
import { useI18n } from '../i18n.ts';
import { SetupLog } from './setup/SetupLog.tsx';
import { changeFor, liveRow, pendingSteps, retryChange, rowKind, stoppedStep } from './setup/setupLogic.ts';
import { CheckIcon, PlainRow, QueuedRow, RunningRow, StepRow, WaitIcon } from './setup/StepRow.tsx';
import { useElapsed, useSetupLog } from './setup/useSetupLog.ts';

/**
 * SPEC-012 FR-13: a cat bot's Cat bot tab shows only its own CLI's chain, in the setup
 * wizard's rows (SPEC-010). Looking at a provider starts nothing (SPEC-010 FR-21); a check
 * runs only when asked, and only ticked rows change anything. Every agent CLI, shared by
 * every cat bot, is in Cats Bot Settings' Agent CLIs tab.
 */

const api = window.catsBot;

type Phase = 'idle' | 'checking' | 'applying';
type Item = { id: SetupStepId; change: SetupChange };

export function ProviderChecklist({
  provider,
  label,
  onState,
  onBusy,
}: {
  provider: string;
  label: string;
  onState?(state: ProviderSetupState | null): void;
  onBusy?(busy: boolean): void;
}) {
  const { t } = useI18n();
  const [platform, setPlatform] = useState('');
  const [state, setState] = useState<ProviderSetupState | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [ticked, setTicked] = useState<ReadonlyMap<SetupStepId, SetupChange>>(new Map());
  const [details, setDetails] = useState<ReadonlySet<SetupStepId>>(new Set());
  const [applied, setApplied] = useState<ReadonlySet<SetupStepId>>(new Set());
  const [attempted, setAttempted] = useState<ReadonlyMap<SetupStepId, SetupChange>>(new Map());
  const [queue, setQueue] = useState<SetupStepId[]>([]);
  const [running, setRunning] = useState<SetupStepId | null>(null);
  const [runStart, setRunStart] = useState<number | null>(null);
  const [stopAfter, setStopAfter] = useState(false);
  const stopRequested = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [checkFrom, setCheckFrom] = useState(0);
  const generation = useRef(0);
  const callbacks = useRef({ onState, onBusy });
  callbacks.current = { onState, onBusy };
  const log = useSetupLog();
  const elapsed = useElapsed(runStart);

  useEffect(() => {
    void api.setup.environment().then((environment) => setPlatform(environment.platform)).catch(() => {});
    // Leaving the tab stops the queue after the install that runs now, which cannot be interrupted.
    return () => {
      generation.current += 1;
      stopRequested.current = true;
    };
  }, []);
  // SPEC-010 FR-21: choosing another provider drops what was read and starts nothing.
  useEffect(() => {
    generation.current += 1;
    setState(null);
    setTicked(new Map());
    setDetails(new Set());
    setApplied(new Set());
    setAttempted(new Map());
    setError(null);
  }, [provider]);

  const busy = phase !== 'idle';
  const begin = (next: Phase) => {
    setPhase(next);
    setError(null);
    callbacks.current.onBusy?.(true);
    log.openForRun();
  };
  const end = (failed: boolean) => {
    setPhase('idle');
    setRunStart(null);
    callbacks.current.onBusy?.(false);
    if (!failed) log.settle();
  };

  const check = useCallback(async () => {
    const mine = ++generation.current;
    begin('checking');
    setCheckFrom(log.runsRef.current.length);
    setRunStart(Date.now());
    setApplied(new Set());
    setAttempted(new Map());
    callbacks.current.onState?.(null);
    let failed = false;
    try {
      const next = await api.setup.check(provider);
      // Another provider was chosen meanwhile: what this read found is not its own.
      if (mine !== generation.current) {
        end(true);
        return;
      }
      setState(next);
      callbacks.current.onState?.(next);
      setTicked((current) => new Map([...current].filter(([id, change]) => {
        const step = next.steps.find((item) => item.id === id);
        return step !== undefined && changeFor(step) === change;
      })));
      const broken = next.steps.filter((item) => ['failed', 'declined'].includes(rowKind(item))).map((item) => item.id);
      if (broken.length) {
        failed = true;
        setDetails((current) => new Set([...current, ...broken]));
        log.openForFailure();
      }
    } catch (failure) {
      if (mine !== generation.current) {
        end(true);
        return;
      }
      failed = true;
      setError(errorText(failure));
      log.openForFailure();
    }
    end(failed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, log]);

  const apply = async (items: readonly Item[]) => {
    if (items.length === 0 || busy) return;
    const mine = ++generation.current;
    stopRequested.current = false;
    setStopAfter(false);
    begin('applying');
    setQueue(items.map((item) => item.id));
    let stoppedShort = false;
    try {
      for (const item of items) {
        if (stopRequested.current) break;
        setRunning(item.id);
        setRunStart(Date.now());
        setAttempted((current) => new Map(current).set(item.id, item.change));
        const next = await api.setup.install(provider, item.id, item.change);
        if (mine !== generation.current) {
          setRunning(null);
          setQueue([]);
          end(true);
          return;
        }
        setState(next);
        callbacks.current.onState?.(next);
        setTicked((current) => {
          const rest = new Map(current);
          rest.delete(item.id);
          return rest;
        });
        setQueue((current) => current.filter((id) => id !== item.id));
        const done = next.steps.find((step) => step.id === item.id);
        const kind = done ? rowKind(done) : 'failed';
        const updateFailed = item.change === 'upgrade' && ['failed', 'declined'].includes(done?.lastUpdate?.outcome ?? '');
        if (kind === 'ready' && !updateFailed) {
          setApplied((current) => new Set(current).add(item.id));
          setAttempted((current) => {
            const rest = new Map(current);
            rest.delete(item.id);
            return rest;
          });
          continue;
        }
        stoppedShort = true;
        if (updateFailed) {
          setAttempted((current) => {
            const rest = new Map(current);
            rest.delete(item.id);
            return rest;
          });
        } else if (kind !== 'restart') {
          setDetails((current) => new Set(current).add(item.id));
        }
        if (done && kind === 'needs') setError(t('{label} ran, but it is not done yet. The log below has its result.', { label: t(done.label) }));
        log.openForFailure();
        break;
      }
    } catch (failure) {
      stoppedShort = true;
      setError(errorText(failure));
      log.openForFailure();
    }
    setRunning(null);
    setQueue([]);
    end(stoppedShort);
  };

  const steps = state?.provider === provider ? state.steps : [];
  const isTicked = (step: ProviderSetupState['steps'][number]) => {
    const change = changeFor(step);
    return change !== null && ticked.get(step.id) === change;
  };
  const queued: Item[] = steps.filter(isTicked).map((step) => ({ id: step.id, change: changeFor(step)! }));
  const stopped = state?.provider === provider ? stoppedStep(state) : null;
  const retry: Item[] = stopped && rowKind(stopped) !== 'restart' && attempted.has(stopped.id)
    ? [{ id: stopped.id, change: retryChange(stopped, attempted.get(stopped.id)!) }, ...queued.filter((item) => item.id !== stopped.id)]
    : [];
  const windows = platform === 'win32';

  const rows = steps.length === 0 || phase === 'checking'
    ? pendingSteps(provider, label, platform).map((item) => {
        if (phase !== 'checking') {
          return <PlainRow key={item.id} id={item.id} label={item.label} optional={item.optional} glyph={<WaitIcon />} state={t('Not checked yet')} />;
        }
        const live = liveRow(log.runs, checkFrom, item.helper);
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
    : steps.map((step) => {
        if (step.id === running) return <RunningRow key={step.id} step={step} windows={windows} elapsed={elapsed} />;
        if (queue.includes(step.id)) return <QueuedRow key={step.id} step={step} />;
        return (
          <StepRow
            key={step.id}
            step={step}
            provider={provider}
            platform={platform}
            ticked={isTicked(step)}
            disabled={busy}
            justApplied={applied.has(step.id)}
            detailsOpen={details.has(step.id)}
            onTick={(value) => setTicked((current) => {
              const next = new Map(current);
              const change = changeFor(step);
              if (value && change) next.set(step.id, change);
              else next.delete(step.id);
              return next;
            })}
            onDetails={(open) => setDetails((current) => {
              const next = new Set(current);
              if (open) next.add(step.id);
              else next.delete(step.id);
              return next;
            })}
            update
          />
        );
      });

  const checkButton = (
    <button type="button" id="provider-check" className={queued.length || retry.length ? undefined : 'primary'} disabled={busy || !provider} onClick={() => void check()}>
      {state?.provider === provider ? t('Check again') : t('Check this computer')}
    </button>
  );
  let actions;
  if (phase === 'checking') {
    actions = <button type="button" className="primary" disabled>{t('Checking…')}</button>;
  } else if (phase === 'applying') {
    actions = (
      <>
        <button type="button" id="provider-stop" disabled={stopAfter} onClick={() => { stopRequested.current = true; setStopAfter(true); }}>{t('Stop after this one')}</button>
        <button type="button" className="primary" disabled>{t('Applying…')}</button>
      </>
    );
  } else if (retry.length > 0) {
    actions = <>{checkButton}<button type="button" className="primary" id="provider-retry" onClick={() => void apply(retry)}>{t('Try again')}</button></>;
  } else if (queued.length > 0) {
    actions = <>{checkButton}<button type="button" className="primary" id="provider-apply" onClick={() => void apply(queued)}>{t('Apply {count} ticked', { count: queued.length })}</button></>;
  } else {
    actions = checkButton;
  }
  const admin = windows && queued.some((item) => item.id === 'node');
  const hint = phase === 'applying'
    ? (stopAfter ? t('Stops after this one.') : '')
    : queued.length
      ? (admin ? t('{count} ticked. Windows will ask for administrator permission.', { count: queued.length }) : t('{count} ticked.', { count: queued.length }))
      : state?.provider === provider || phase === 'checking'
        ? ''
        : t('Nothing is checked until you ask. Checking only reads this computer.');

  const runningLine = phase === 'checking'
    ? t('Checking this computer')
    : phase === 'applying' && running
      ? (steps.find((step) => step.id === running)?.script?.file ?? running)
      : null;

  return (
    <section className="provider-checklist" aria-busy={busy}>
      <div className="provider-checklist-head">
        <h3>{t('{provider} on this computer', { provider: label })}</h3>
        <button type="button" className="setup-more" id="provider-all-clis" onClick={() => void api.shell.openAgentClis()}>
          {t('All agent CLIs')}
        </button>
      </div>
      {error && <p className="error" id="provider-error" role="alert">{t(error)}</p>}
      <ul className="setup-rows" aria-busy={busy}>{rows}</ul>
      <div className="provider-checklist-foot">
        <p className="hint setup-foot-hint">{hint}</p>
        {actions}
      </div>
      <SetupLog runs={log.runs} open={log.open} running={runningLine} elapsed={elapsed} onToggle={log.toggle} onHover={log.hover} />
    </section>
  );
}
