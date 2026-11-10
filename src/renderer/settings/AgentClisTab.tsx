import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SETUP_PROVIDER_IDS,
  type ComputerSetupState,
  type SetupChange,
  type SetupHelperId,
} from '../../shared/providerSetup.ts';
import { errorText } from '../errors.ts';
import { useI18n } from '../i18n.ts';
import { SetupLog } from './setup/SetupLog.tsx';
import {
  changeFor,
  computerChecks,
  computerGroups,
  liveRow,
  logTotals,
  neededHelpers,
  neededPending,
  neededTickable,
  rowKind,
  shortClock,
  stemClass,
  updatableSteps,
  usersByProvider,
  type ComputerStep,
} from './setup/setupLogic.ts';
import { CheckIcon, CodexSetupRow, PlainRow, QueuedRow, RunningRow, SignInRow, StepRow, WaitIcon } from './setup/StepRow.tsx';
import { useElapsed, useSetupLog } from './setup/useSetupLog.ts';

/**
 * SPEC-012: Cats Bot Settings' Agent CLIs tab. Every agent CLI the cat bots can use, and what
 * those CLIs need, in the setup wizard's rows (SPEC-010). Opening it runs nothing; Check this
 * computer only reads; only what the owner ticks changes anything, top down, one at a time.
 */

const api = window.catsBot;

type Phase = 'idle' | 'checking' | 'applying';
type Item = { id: SetupHelperId; change: SetupChange };

const without = <T,>(set: ReadonlySet<T>, value: T): Set<T> => {
  const next = new Set(set);
  next.delete(value);
  return next;
};

export function AgentClisTab() {
  const { t } = useI18n();
  const [state, setState] = useState<ComputerSetupState | null>(null);
  const [users, setUsers] = useState<Map<string, string[]>>(new Map());
  const [phase, setPhase] = useState<Phase>('idle');
  // FR-7: each tick is for one change: setting up a row that needs it, or updating one that works.
  const [ticked, setTicked] = useState<ReadonlyMap<string, SetupChange>>(new Map());
  const [details, setDetails] = useState<ReadonlySet<string>>(new Set());
  const [applied, setApplied] = useState<ReadonlySet<string>>(new Set());
  const [attempted, setAttempted] = useState<ReadonlyMap<string, SetupChange>>(new Map());
  const [queue, setQueue] = useState<string[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [runStart, setRunStart] = useState<number | null>(null);
  const [stopAfter, setStopAfter] = useState(false);
  const stopRequested = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [checkFrom, setCheckFrom] = useState(0);
  const [terminals, setTerminals] = useState<Record<string, 'opened' | 'missing'>>({});
  const [opening, setOpening] = useState(false);
  const log = useSetupLog();
  const elapsed = useElapsed(runStart);

  // FR-3: what the hub kept from this session, and who uses which CLI. Neither starts a process.
  useEffect(() => {
    let live = true;
    void api.computer.state()
      .then((next) => { if (live) setState(next); })
      .catch((failure: unknown) => { if (live) setError(errorText(failure)); });
    const readBots = () => {
      void api.hub.bots().then((listing) => { if (live) setUsers(usersByProvider(listing.bots)); }).catch(() => {});
    };
    readBots();
    const off = api.hub.onChange(readBots);
    return () => {
      live = false;
      off();
    };
  }, []);

  const steps = state?.steps ?? [];
  const checked = Boolean(state?.checkedAt);
  const busy = phase !== 'idle';
  const windows = state?.platform === 'win32';
  const needed = neededHelpers(users);
  const isTicked = (step: ComputerStep) => {
    const change = changeFor(step);
    return change !== null && ticked.get(step.id) === change;
  };
  const queued: Item[] = steps.filter(isTicked).map((step) => ({ id: step.id, change: changeFor(step)! }));
  const pending = checked ? neededPending(steps, needed) : [];
  const required = neededTickable(steps, needed);
  const allRequired = required.length > 0 && required.every(isTicked);
  const updates = updatableSteps(steps);
  const allUpdates = updates.length > 0 && updates.every(isTicked);
  // FR-7: a row the owner ran that stopped the queue, which the foot speaks to.
  const stopped = steps.find((step) => attempted.has(step.id) && ['failed', 'declined', 'restart'].includes(rowKind(step))) ?? null;
  const retry: Item[] = stopped && rowKind(stopped) !== 'restart'
    ? [{ id: stopped.id, change: attempted.get(stopped.id)! }, ...queued.filter((item) => item.id !== stopped.id)]
    : [];

  const setTick = (step: ComputerStep, value: boolean) => setTicked((current) => {
    const next = new Map(current);
    const change = changeFor(step);
    if (value && change) next.set(step.id, change);
    else next.delete(step.id);
    return next;
  });
  const tickAll = (rows: readonly ComputerStep[], all: boolean) => setTicked((current) => {
    const next = new Map(current);
    for (const step of rows) {
      const change = changeFor(step);
      if (all || !change) next.delete(step.id);
      else next.set(step.id, change);
    }
    return next;
  });
  const toggleDetails = (id: string, open: boolean) => setDetails((current) => (open ? new Set(current).add(id) : without(current, id)));

  /** FR-4: the owner's press is the consent. It only reads. */
  const check = useCallback(async () => {
    setPhase('checking');
    setError(null);
    setCheckFrom(log.runsRef.current.length);
    setRunStart(Date.now());
    setApplied(new Set());
    setAttempted(new Map());
    setTerminals({});
    log.openForRun();
    let failed = false;
    try {
      const next = await api.computer.check();
      setState(next);
      // What is still the same change keeps its tick; what got done, or became an update, loses it.
      setTicked((current) => new Map([...current].filter(([id, change]) => {
        const step = next.steps.find((item) => item.id === id);
        return step !== undefined && changeFor(step) === change;
      })));
      const broken = next.steps.filter((step) => rowKind(step) === 'checkFailed').map((step) => step.id);
      if (broken.length) {
        failed = true;
        setDetails((current) => new Set([...current, ...broken]));
        log.openForFailure();
      }
    } catch (failure) {
      failed = true;
      setError(errorText(failure));
      log.openForFailure();
    }
    setPhase('idle');
    setRunStart(null);
    if (!failed) log.settle();
  }, [log]);

  /** FR-7: ticked rows, top down, one at a time, each read again after it runs. */
  const apply = async (items: readonly Item[]) => {
    if (items.length === 0 || busy) return;
    stopRequested.current = false;
    setStopAfter(false);
    setPhase('applying');
    setError(null);
    setQueue(items.map((item) => item.id));
    log.openForRun();
    let stoppedShort = false;
    try {
      for (const item of items) {
        if (stopRequested.current) break;
        setRunning(item.id);
        setRunStart(Date.now());
        setAttempted((current) => new Map(current).set(item.id, item.change));
        const next = await api.computer.change(item.id, item.change);
        setState(next);
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
        // A failure stops the queue and keeps the ticks after it (FR-7).
        stoppedShort = true;
        if (updateFailed) {
          // The version that was there still works; the row says so, and the update can be ticked again.
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
    setRunStart(null);
    setQueue([]);
    setPhase('idle');
    if (!stoppedShort) log.settle();
  };

  const openTerminal = async (key: string, open: () => Promise<{ opened: boolean }>) => {
    setOpening(true);
    let opened = false;
    try {
      opened = (await open()).opened;
    } catch {
      opened = false;
    }
    setTerminals((current) => ({ ...current, [key]: opened ? 'opened' : 'missing' }));
    if (!opened) log.openForFailure();
    setOpening(false);
  };

  const usedBy = (id: SetupHelperId): string | null => {
    if (!(SETUP_PROVIDER_IDS as readonly string[]).includes(id)) return null;
    const names = users.get(id) ?? [];
    return names.length ? t('Used by {names}', { names: names.join(t(', ')) }) : t('No cat bot uses it yet');
  };

  const row = (step: ComputerStep, depClass: string | undefined) => {
    const extra = usedBy(step.id);
    if (phase === 'checking') {
      const live = liveRow(log.runs, checkFrom, step.id);
      return (
        <PlainRow
          key={step.id}
          id={step.id}
          label={step.label}
          optional={step.optional}
          depClass={depClass}
          extra={extra}
          glyph={live === 'checking' ? <span className="setup-spinner" /> : live === 'ready' ? <CheckIcon /> : live === 'needs' ? <WaitIcon /> : null}
          state={t(live === 'pending' ? 'Waiting' : live === 'checking' ? 'Checking' : live === 'ready' ? 'Ready' : 'Needs work')}
        />
      );
    }
    if (step.id === running) return <RunningRow key={step.id} step={step} windows={windows} elapsed={elapsed} depClass={depClass} extra={extra} />;
    if (queue.includes(step.id)) return <QueuedRow key={step.id} step={step} depClass={depClass} extra={extra} />;
    return (
      <StepRow
        key={step.id}
        step={step}
        provider={step.id}
        platform={state?.platform ?? ''}
        ticked={isTicked(step)}
        disabled={busy}
        justApplied={applied.has(step.id)}
        detailsOpen={details.has(step.id)}
        onTick={(value) => setTick(step, value)}
        onDetails={(open) => toggleDetails(step.id, open)}
        depClass={depClass}
        extra={extra}
        update
      />
    );
  };

  let lead: string;
  if (phase === 'checking') lead = t('Checking this computer. This only reads what is there and changes nothing.');
  else if (phase === 'applying') lead = t('Applying what you ticked, one at a time, with a fresh check after each.');
  else if (!checked) lead = t('Every cat bot on this computer shares these. Nothing is checked until you ask, and only what you tick changes anything.');
  else if (pending.length) lead = t('Results from your check at {time}. {count} item(s) your cat bots need are not ready. Tick what Cats Bot should do; nothing unticked runs.', { time: shortClock(state!.checkedAt!), count: pending.length });
  else lead = t('Results from your check at {time}. Everything your cat bots use is ready.', { time: shortClock(state!.checkedAt!) });

  const shortcuts = !busy && checked && (required.length >= 2 || updates.length >= 2) && (
    <p className="setup-tick-line">
      {required.length >= 2 && (
        <button type="button" className="setup-more" id="clis-tick-required" onClick={() => tickAll(required, allRequired)}>
          {allRequired ? t('Untick all required') : t('Tick all {count} required', { count: required.length })}
        </button>
      )}
      {updates.length >= 2 && (
        <button type="button" className="setup-more" id="clis-tick-updates" onClick={() => tickAll(updates, allUpdates)}>
          {allUpdates ? t('Untick all updates') : t('Tick all {count} updates', { count: updates.length })}
        </button>
      )}
    </p>
  );

  const signIns = checked ? SETUP_PROVIDER_IDS.filter((id) => state?.signIn[id]) : [];
  const changedPath = logTotals(log.runs).changes > 0;
  const shellLeft = Boolean(steps.find((step) => step.id === 'shell' && rowKind(step) !== 'ready'));
  const signInGroup = signIns.length > 0 && (
    <div className="setup-block">
      <p className="setup-group-label">{t('Sign in')}</p>
      <ul className="setup-rows">
        {signIns.map((id) => {
          const names = users.get(id) ?? [];
          return (
            <SignInRow
              key={id}
              id={id}
              label={steps.find((step) => step.id === id)?.label ?? id}
              signIn={state!.signIn[id]!.state}
              command={state!.signIn[id]!.command}
              who={names.length ? names.join(t(', ')) : t('a cat bot on it')}
              busy={busy || opening}
              terminal={terminals[id] ?? null}
              powerShellLeft={id === 'codex' && windows && shellLeft}
              changedPath={changedPath}
              onOpen={() => void openTerminal(id, () => api.computer.openTerminal(id))}
            />
          );
        })}
        {windows && state?.signIn.codex && (
          <CodexSetupRow
            status={state.codexInitialization?.status}
            who={null}
            busy={busy || opening}
            terminal={terminals['codex-initialization'] ?? null}
            onOpen={() => void openTerminal('codex-initialization', () => api.computer.openCodexInitialization())}
          />
        )}
      </ul>
    </div>
  );

  const checkAgain = (primary = false) => (
    <button type="button" className={primary ? 'primary' : undefined} id="clis-recheck" disabled={busy} onClick={() => void check()}>{t('Check again')}</button>
  );
  let foot;
  if (phase === 'checking') {
    foot = <><p className="hint setup-foot-hint" /><button type="button" className="primary" disabled>{t('Checking…')}</button></>;
  } else if (phase === 'applying') {
    foot = (
      <>
        <p className="hint setup-foot-hint">{stopAfter ? t('Stops after this one.') : ''}</p>
        <button type="button" id="clis-stop" disabled={stopAfter} onClick={() => { stopRequested.current = true; setStopAfter(true); }}>{t('Stop after this one')}</button>
        <button type="button" className="primary" disabled>{t('Applying…')}</button>
      </>
    );
  } else if (!checked) {
    foot = (
      <>
        <p className="hint setup-foot-hint">{state ? t('Runs up to {count} read-only checks. Nothing on this computer changes.', { count: computerChecks(state) }) : ''}</p>
        <button type="button" className="primary" id="clis-check" disabled={!state} onClick={() => void check()}>{t('Check this computer')}</button>
      </>
    );
  } else if (stopped && rowKind(stopped) === 'restart') {
    foot = <><p className="hint setup-foot-hint" />{checkAgain(true)}</>;
  } else if (retry.length > 0) {
    foot = (
      <>
        <p className="hint setup-foot-hint" />
        {checkAgain()}
        {/* FR-7: they ticked it once, so trying again needs no new tick. */}
        <button type="button" className="primary" id="clis-retry" onClick={() => void apply(retry)}>{t('Try again')}</button>
      </>
    );
  } else if (queued.length > 0) {
    const admin = windows && queued.some((item) => item.id === 'node');
    foot = (
      <>
        <p className="hint setup-foot-hint">{admin ? t('{count} ticked. Windows will ask for administrator permission.', { count: queued.length }) : t('{count} ticked.', { count: queued.length })}</p>
        {checkAgain()}
        <button type="button" className="primary" id="clis-apply" onClick={() => void apply(queued)}>{t('Apply {count} ticked', { count: queued.length })}</button>
      </>
    );
  } else {
    foot = (
      <>
        <p className="hint setup-foot-hint">{pending.length ? t('Tick a row to set it up, or set it up yourself and check again.') : ''}</p>
        {checkAgain(true)}
      </>
    );
  }

  const runningLine = phase === 'checking'
    ? t('Checking this computer')
    : phase === 'applying' && running
      ? (steps.find((step) => step.id === running)?.script?.file ?? running)
      : null;

  return (
    <section className="panel clis-panel" data-panel="clis" aria-busy={busy}>
      <div className="setup-pane clis-pane">
        <h2>{t('Agent CLIs')}</h2>
        <p className="lead" id="clis-lead">{lead}</p>
        {error && <p className="error" id="clis-error" role="alert">{t(error)}</p>}
        {shortcuts}
        {state && computerGroups(state).map((group) => {
          const nodeReady = rowKind(group.rows[0]!) === 'ready';
          return (
            <div className="setup-block" key={group.key}>
              <p className="setup-group-label">{t(group.title)}</p>
              <ul className={group.stem && nodeReady ? 'setup-rows is-unlocked' : 'setup-rows'} aria-busy={busy}>
                {group.rows.map((step, index) => row(step, stemClass(group, index)))}
              </ul>
            </div>
          );
        })}
        {signInGroup}
      </div>
      <div className="setup-foot">{foot}</div>
      <SetupLog runs={log.runs} open={log.open} running={runningLine} elapsed={elapsed} onToggle={log.toggle} onHover={log.hover} />
    </section>
  );
}
