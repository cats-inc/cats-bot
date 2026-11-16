import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SETUP_PROVIDER_IDS,
  type ComputerSetupState,
  type SetupChange,
  type SetupHelperId,
} from '../../shared/providerSetup.ts';
import { errorText } from '../errors.ts';
import { useI18n } from '../i18n.ts';
import { ActionRow, changeVerb } from './setup/ActionRow.tsx';
import { LogButton, LogSheet } from './setup/LogSheet.tsx';
import {
  computerGroups,
  liveRow,
  logTotals,
  neededHelpers,
  neededPending,
  neededTickable,
  retryChange,
  rowKind,
  shortClock,
  stemClass,
  updatableSteps,
  usersByProvider,
  type ComputerStep,
  type LogRun,
} from './setup/setupLogic.ts';
import { CheckIcon, CodexSetupRow, PlainRow, SignInRow, WaitIcon } from './setup/StepRow.tsx';
import { useElapsed, useSetupLog } from './setup/useSetupLog.ts';

/**
 * SPEC-013: Cats Bot Settings' Agent CLIs tab. Every agent CLI the cat bots can use, and what
 * those CLIs need, in the setup wizard's rows (SPEC-010). Opening it runs nothing; Check this
 * computer only reads; only what the owner confirms in a row's box changes anything, one at a
 * time (ADR-030). The log opens beside the rows when asked.
 */

const api = window.catsBot;

type Phase = 'idle' | 'checking' | 'applying';
type Item = { id: SetupHelperId; change: SetupChange };

export function AgentClisTab() {
  const { t } = useI18n();
  const [state, setState] = useState<ComputerSetupState | null>(null);
  const [users, setUsers] = useState<Map<string, string[]>>(new Map());
  const [phase, setPhase] = useState<Phase>('idle');
  // ADR-030: each row has one action, which asks in a box under it; two or more rows can go at once.
  const [confirming, setConfirming] = useState<{ id: string; change: SetupChange } | null>(null);
  const [batch, setBatch] = useState<'required' | 'updates' | null>(null);
  const [applied, setApplied] = useState<ReadonlySet<string>>(new Set());
  const [attempted, setAttempted] = useState<ReadonlyMap<string, SetupChange>>(new Map());
  const [notices, setNotices] = useState<ReadonlyMap<string, string>>(new Map());
  const [queue, setQueue] = useState<string[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [runStart, setRunStart] = useState<number | null>(null);
  const [stopAfter, setStopAfter] = useState(false);
  const stopRequested = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [checkFrom, setCheckFrom] = useState(0);
  const [terminals, setTerminals] = useState<Record<string, 'opened' | 'missing'>>({});
  const [opening, setOpening] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const log = useSetupLog();
  const elapsed = useElapsed(runStart);

  // FR-3: what the hub kept from this session, and who uses which CLI. Neither starts a process.
  // FR-13: a cat bot's page can read its CLI meanwhile, so coming back to this window reads again,
  // unless a check or a change runs here.
  const idle = useRef(true);
  idle.current = phase === 'idle';
  useEffect(() => {
    let live = true;
    const readState = () => {
      if (!idle.current) return;
      void api.computer.state()
        .then((next) => { if (live && idle.current) setState(next); })
        .catch((failure: unknown) => { if (live) setError(errorText(failure)); });
    };
    readState();
    window.addEventListener('focus', readState);
    const readBots = () => {
      void api.hub.bots().then((listing) => { if (live) setUsers(usersByProvider(listing.bots)); }).catch(() => {});
    };
    readBots();
    const off = api.hub.onChange(readBots);
    return () => {
      live = false;
      off();
      window.removeEventListener('focus', readState);
    };
  }, []);

  const steps = state?.steps ?? [];
  const checked = Boolean(state?.checkedAt);
  const busy = phase !== 'idle';
  const windows = state?.platform === 'win32';
  const needed = neededHelpers(users);
  const pending = checked ? neededPending(steps, needed) : [];
  const required = neededTickable(steps, needed);
  const updates = updatableSteps(steps);
  const batchItems: Item[] = batch === 'required'
    ? required.map((step) => ({ id: step.id, change: 'apply' as const }))
    : batch === 'updates' ? updates.map((step) => ({ id: step.id, change: 'upgrade' as const })) : [];

  const fail = (failure: unknown, id?: string) => {
    const text = errorText(failure);
    if (/Wait for the current setup operation to finish/u.test(text)) {
      const notice = t('Another Cats Bot window is running a setup step. Try again when it finishes.');
      if (id) setNotices((current) => new Map(current).set(id, notice));
      else setError(notice);
    } else setError(text);
  };

  /** FR-4: the owner's press is the consent. It only reads. */
  const check = useCallback(async () => {
    setPhase('checking');
    setError(null);
    setConfirming(null);
    setBatch(null);
    setNotices(new Map());
    setCheckFrom(log.runsRef.current.length);
    setRunStart(Date.now());
    setApplied(new Set());
    setAttempted(new Map());
    setTerminals({});
    try {
      setState(await api.computer.check());
    } catch (failure) {
      fail(failure);
    }
    setPhase('idle');
    setRunStart(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [log]);

  /** FR-7, ADR-030: what the owner confirmed, top down, one at a time, each read again after it runs. */
  const apply = async (items: readonly Item[]) => {
    if (items.length === 0 || busy) return;
    stopRequested.current = false;
    setStopAfter(false);
    setConfirming(null);
    setBatch(null);
    setPhase('applying');
    setError(null);
    setQueue(items.map((item) => item.id));
    let current: Item | null = null;
    try {
      for (const item of items) {
        if (stopRequested.current) break;
        current = item;
        setRunning(item.id);
        setRunStart(Date.now());
        setNotices((rest) => { const next = new Map(rest); next.delete(item.id); return next; });
        setAttempted((rest) => new Map(rest).set(item.id, item.change));
        const next = await api.computer.change(item.id, item.change);
        setState(next);
        setQueue((rest) => rest.filter((id) => id !== item.id));
        const done = next.steps.find((step) => step.id === item.id);
        const kind = done ? rowKind(done) : 'failed';
        const updateFailed = item.change === 'upgrade' && ['failed', 'declined'].includes(done?.lastUpdate?.outcome ?? '');
        if (kind === 'ready' && !updateFailed) {
          setApplied((rest) => new Set(rest).add(item.id));
          setAttempted((rest) => { const next2 = new Map(rest); next2.delete(item.id); return next2; });
          continue;
        }
        // A failure stops the queue (FR-7). The version that was there still works after a failed update.
        if (updateFailed) setAttempted((rest) => { const next2 = new Map(rest); next2.delete(item.id); return next2; });
        if (done && kind === 'needs') setError(t('{label} ran, but it is not done yet. Its row has the result.', { label: t(done.label) }));
        break;
      }
    } catch (failure) {
      fail(failure, current?.id);
    }
    setRunning(null);
    setRunStart(null);
    setQueue([]);
    setPhase('idle');
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
    setOpening(false);
  };

  const usedBy = (id: SetupHelperId): string | null => {
    if (!(SETUP_PROVIDER_IDS as readonly string[]).includes(id)) return null;
    const names = users.get(id) ?? [];
    return names.length ? t('Used by {names}', { names: names.join(t(', ')) }) : t('No cat bot uses it yet');
  };
  // FR-7: the row the owner ran that stopped, which offers Try again without asking again.
  const stopped = steps.find((step) => attempted.has(step.id) && ['failed', 'declined', 'restart'].includes(rowKind(step))) ?? null;
  const lastRun = (id: string): LogRun | null => log.runs.findLast((run) => run.helper === id && run.kind === 'change') ?? null;

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
    const attemptedChange = attempted.get(step.id);
    return (
      <ActionRow
        key={step.id}
        step={step}
        provider={step.id}
        platform={state?.platform ?? ''}
        depClass={depClass}
        extra={extra}
        running={step.id === running}
        queued={queue.includes(step.id) && step.id !== running}
        elapsed={elapsed}
        justApplied={applied.has(step.id)}
        retry={stopped?.id === step.id && attemptedChange && rowKind(step) !== 'restart' ? retryChange(step, attemptedChange) : null}
        lastRun={lastRun(step.id)}
        disabled={busy}
        confirming={confirming?.id === step.id ? confirming.change : null}
        notice={notices.get(step.id) ?? null}
        onAsk={(change) => { setBatch(null); setConfirming({ id: step.id, change }); }}
        onCancel={() => setConfirming(null)}
        onRun={(change) => void apply([{ id: step.id, change }])}
        onCheckAgain={() => void check()}
      />
    );
  };

  let lead: string;
  if (phase === 'checking') lead = t('Checking this computer. This only reads what is there and changes nothing.');
  else if (phase === 'applying') lead = t('One at a time, with a fresh check after each.');
  else if (!checked) lead = t('Every cat bot on this computer shares these. Nothing is checked until you ask, and nothing changes until you confirm it.');
  else if (pending.length) lead = t('Results from your check at {time}. {count} item(s) your cat bots need are not ready.', { time: shortClock(state!.checkedAt!), count: pending.length });
  else lead = t('Results from your check at {time}. Everything your cat bots use is ready.', { time: shortClock(state!.checkedAt!) });

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

  const admin = windows && batchItems.some((item) => item.id === 'node');
  return (
    <section className="panel clis-panel" data-panel="clis" aria-busy={busy}>
      <div className="clis-pane">
        <div className="panel-head clis-head">
          <h2>{t('Agent CLIs')}</h2>
          <div className="clis-tools">
            {phase === 'applying' && queue.length > 1
              ? <button type="button" id="clis-stop" disabled={stopAfter} onClick={() => { stopRequested.current = true; setStopAfter(true); }}>{stopAfter ? t('Stops after this one.') : t('Stop after this one')}</button>
              : <>
                  {checked && required.length >= 2 && (
                    <button type="button" id="clis-setup-required" disabled={busy} aria-expanded={batch === 'required'}
                      onClick={() => { setConfirming(null); setBatch(batch === 'required' ? null : 'required'); }}>{t('Set up all {count}', { count: required.length })}</button>
                  )}
                  {checked && updates.length >= 2 && (
                    <button type="button" id="clis-update-all" disabled={busy} aria-expanded={batch === 'updates'}
                      onClick={() => { setConfirming(null); setBatch(batch === 'updates' ? null : 'updates'); }}>{t('Update all {count}', { count: updates.length })}</button>
                  )}
                  <button type="button" id={checked ? 'clis-recheck' : 'clis-check'} disabled={busy || !state} onClick={() => void check()}>
                    {phase === 'checking' ? t('Checking…') : checked ? t('Check again') : t('Check this computer')}
                  </button>
                </>}
            <LogButton runs={log.runs} onOpen={() => setLogOpen(true)} />
          </div>
        </div>
        <p className="lead" id="clis-lead">{lead}</p>
        {error && <p className="error" id="clis-error" role="alert">{t(error)}</p>}
        {batch && batchItems.length > 0 && (
          <div className="setup-confirm" role="group" aria-label={batch === 'updates' ? t('Update all {count}', { count: batchItems.length }) : t('Set up all {count}', { count: batchItems.length })}
            onKeyDown={(event) => { if (event.key === 'Escape') setBatch(null); }}>
            <strong>{batch === 'updates' ? t('Update all {count}?', { count: batchItems.length }) : t('Set up all {count}?', { count: batchItems.length })}</strong>
            <p className="hint">{t('One at a time, top down. Each one is read again after it runs.')}{admin ? ` ${t('Windows will ask for administrator permission.')}` : ''}</p>
            <ul className="setup-confirm-list">
              {batchItems.map((item) => {
                const step = steps.find((entry) => entry.id === item.id)!;
                const command = item.change === 'upgrade' ? step.updateCommand : step.applyCommand;
                return <li key={item.id}>{changeVerb(step, item.change, t)} {t(step.label)}{command && <code className="setup-command">{command}</code>}</li>;
              })}
            </ul>
            <div className="setup-confirm-actions">
              <button type="button" className="quiet" onClick={() => setBatch(null)}>{t('Cancel')}</button>
              <button type="button" className="run" autoFocus onClick={() => void apply(batchItems)}>
                {batch === 'updates' ? t('Update all {count}', { count: batchItems.length }) : t('Set up all {count}', { count: batchItems.length })}
              </button>
            </div>
          </div>
        )}
        {state && computerGroups(state).map((group) => {
          const nodeReady = rowKind(group.rows[0]!) === 'ready';
          return (
            <div className="setup-block" key={group.key}>
              <p className="setup-group-label">{t(group.title)}</p>
              <ul className={group.stem && nodeReady ? 'setup-rows is-unlocked' : 'setup-rows'} aria-busy={busy}>
                {group.rows.map((step) => row(step, stemClass(group, group.rows.indexOf(step))))}
              </ul>
            </div>
          );
        })}
        {signInGroup}
      </div>
      {logOpen && <LogSheet runs={log.runs} onClose={() => setLogOpen(false)} />}
    </section>
  );
}
