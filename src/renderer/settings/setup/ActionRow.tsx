import { useEffect, useRef } from 'react';
import type { SetupChange, SetupStep } from '../../../shared/providerSetup.ts';
import { useI18n } from '../../i18n.ts';
import { stepFacts, updateFacts } from './setupFacts.ts';
import { canUpdate, runFacts, rowKind, updateNote, type LogRun } from './setupLogic.ts';
import { CheckIcon, CrossIcon, Details, PlainRow, QueuedRow, RunningRow, StepTitle, WaitIcon } from './StepRow.tsx';

/**
 * ADR-030: a wizard row as a settings page shows it. Settings is not a process the window walks
 * through, so a row has one action instead of a tick: it asks in a box under the row, naming
 * what will run, and runs at once. What the run reported stays on the row; the whole log
 * opens only when asked (`LogSheet`). The wizard keeps its ticks and its log (SPEC-010).
 */

/** Node.js and the CLIs are installed; the npm folder and PowerShell scripts are set up. */
const INSTALLS = new Set(['node', 'codex', 'claude', 'antigravity', 'grok', 'muse', 'kimi', 'provider']);

export function changeVerb(step: SetupStep<string>, change: SetupChange, t: (text: string, values?: Record<string, unknown>) => string): string {
  if (change === 'upgrade') return t('Update');
  return INSTALLS.has(step.id) ? t('Install') : t('Set up');
}

export function ActionRow({
  step,
  provider,
  platform,
  depClass,
  extra,
  running,
  queued,
  elapsed,
  justApplied,
  retry,
  lastRun,
  disabled,
  confirming,
  notice,
  onAsk,
  onCancel,
  onRun,
  onCheckAgain,
}: {
  step: SetupStep<string>;
  provider: string;
  platform: string;
  /** SPEC-013 FR-2: where the row hangs from Node.js. */
  depClass?: string;
  /** SPEC-013 FR-6: the cat bots that use this CLI. */
  extra?: string | null;
  running: boolean;
  queued: boolean;
  elapsed: string | null;
  justApplied: boolean;
  /** The change the owner ran here that did not finish: Try again runs it without asking again. */
  retry: SetupChange | null;
  /** What the last run of this row reported, from this window's log. */
  lastRun: LogRun | null;
  /** Something else runs in this window. */
  disabled: boolean;
  /** The change whose box is open under the row. */
  confirming: SetupChange | null;
  /** Why the last press did nothing, such as another window running a step. */
  notice?: string | null;
  onAsk(change: SetupChange): void;
  onCancel(): void;
  onRun(change: SetupChange): void;
  onCheckAgain?: () => void;
}) {
  const { t } = useI18n();
  const boxRef = useRef<HTMLDivElement>(null);
  // The box takes the keyboard, on its action, as the conversation list's confirmations do (ADR-026).
  useEffect(() => {
    if (confirming) boxRef.current?.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
  }, [confirming]);
  const windows = platform === 'win32';
  if (running) return <RunningRow step={step} windows={windows} elapsed={elapsed} depClass={depClass} extra={extra} />;
  if (queued) return <QueuedRow step={step} depClass={depClass} extra={extra} />;
  const kind = rowKind(step);
  if (kind === 'unchecked') {
    return <PlainRow id={step.id} label={step.label} optional={step.optional} depClass={depClass} extra={extra} glyph={<WaitIcon />} state={t('Not checked yet')} />;
  }
  const rowClass = (base: string) => (depClass ? `${base} ${depClass}` : base);
  const users = extra ? <p className="setup-row-users">{extra}</p> : null;
  const noticeLine = notice ? <p className="setup-row-notice" role="alert">{notice}</p> : null;
  const box = (change: SetupChange) => {
    const facts = change === 'upgrade' ? updateFacts(step, provider, platform) : stepFacts(step, provider, platform);
    const verb = changeVerb(step, change, t);
    return (
      <div className="setup-confirm" role="group" aria-label={verb} ref={boxRef}
        onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onCancel(); } }}>
        <strong>{change === 'upgrade' ? t('Update {label}?', { label: t(step.label) }) : INSTALLS.has(step.id) ? t('Install {label}?', { label: t(step.label) }) : t('Set up {label}?', { label: t(step.label) })}</strong>
        {facts.tags.length > 0 && (
          <div className="setup-tags">
            {facts.tags.map((tag) => <span key={tag.text} className={tag.danger ? 'setup-tag is-danger' : 'setup-tag'}>{t(tag.text, tag.values)}</span>)}
          </div>
        )}
        <Details step={step} facts={facts} update={change === 'upgrade'} />
        <div className="setup-confirm-actions">
          <button type="button" className="quiet" onClick={onCancel}>{t('Cancel')}</button>
          <button type="button" className="run" data-initial-focus onClick={() => onRun(change)}>{verb}</button>
        </div>
      </div>
    );
  };
  const output = lastRun?.ended ? <pre className="setup-run-output">{[`> ${lastRun.command}`, ...runFacts(lastRun)].join('\n')}</pre> : null;
  const action = (change: SetupChange, label?: string) => (
    <button type="button" className="setup-act" id={`setup-act-${step.id}`} disabled={disabled} aria-expanded={confirming === change}
      onClick={() => (confirming === change ? onCancel() : onAsk(change))}>
      {label ?? changeVerb(step, change, t)}
    </button>
  );

  if (kind === 'ready') {
    const note = updateNote(step);
    const update = canUpdate(step);
    return (
      <li className={rowClass('setup-row is-ready')} data-row={step.id}>
        <div className="setup-row-top">
          <span className="setup-glyph"><CheckIcon /></span>
          <div className="setup-row-text">
            <StepTitle label={step.label} optional={step.optional} />
            {step.systemRestartRequired && <p className="setup-system-restart">{t('Restart Windows to finish installation.')}</p>}
            {note && <p className={note.tone === 'danger' ? 'setup-update-note is-danger' : 'setup-update-note'}>
              {note.tone === 'danger' && note.text.endsWith('The log below says why.') ? t('The update did not finish, and the version you had still works.') : t(note.text, note.values)}
            </p>}
            {users}
            {noticeLine}
          </div>
          <span className="setup-row-state">
            {justApplied ? t('Just finished') : t('Ready')}{step.version && <code className="setup-version">{step.version}</code>}
          </span>
          <span className="setup-row-act">{update && action('upgrade')}</span>
        </div>
        {note?.tone === 'danger' && output}
        {confirming === 'upgrade' && box('upgrade')}
      </li>
    );
  }
  if (kind === 'waiting') {
    return (
      <li className={rowClass('setup-row is-waiting')} data-row={step.id}>
        <div className="setup-row-top">
          <span className="setup-glyph"><WaitIcon /></span>
          <div className="setup-row-text">
            <StepTitle label={step.label} optional={step.optional} />
            <p>{t('Waits for Node.js. Once it works, this can be set up here.')}</p>
            {users}
          </div>
          <span className="setup-row-act" />
        </div>
      </li>
    );
  }
  if (kind === 'checkFailed') {
    return (
      <li className={rowClass('setup-row is-failed')} data-row={step.id}>
        <div className="setup-row-top">
          <span className="setup-glyph"><CrossIcon /></span>
          <div className="setup-row-text">
            <StepTitle label={step.label} optional={step.optional} />
            <p>{t('Its check could not run, so nothing is known about it. Nothing changed. Other rows are not affected.')}</p>
            {users}
          </div>
          <span className="setup-row-state is-danger">{t('Cannot check')}</span>
          <span className="setup-row-act">
            {onCheckAgain && <button type="button" className="setup-act" id={`setup-recheck-${step.id}`} disabled={disabled} onClick={onCheckAgain}>{t('Check again')}</button>}
          </span>
        </div>
        {step.checkError && <pre className="setup-run-output">{step.checkError}</pre>}
      </li>
    );
  }
  if (kind === 'restart') {
    return (
      <li className={rowClass('setup-row is-failed')} data-row={step.id}>
        <div className="setup-row-top">
          <span className="setup-glyph"><WaitIcon /></span>
          <div className="setup-row-text">
            <StepTitle label={step.label} optional={step.optional} />
            <p className={step.systemRestartRequired ? 'setup-system-restart' : undefined}>{step.systemRestartRequired
              ? t('Restart Windows to finish installation.')
              : t('Installed, but Cats Bot cannot find it yet. Check again first. If that does not help, restart Cats Bot.')}</p>
            {users}
          </div>
          <span className="setup-row-state is-attention">{t('Not found yet')}</span>
          <span className="setup-row-act" />
        </div>
      </li>
    );
  }
  if (kind === 'failed' || kind === 'declined') {
    return (
      <li className={rowClass('setup-row is-failed')} data-row={step.id}>
        <div className="setup-row-top">
          <span className="setup-glyph"><CrossIcon /></span>
          <div className="setup-row-text">
            <StepTitle label={step.label} optional={step.optional} />
            <p>{kind === 'declined' ? t('You chose No in the Windows prompt, so nothing changed.') : t('It did not finish.')}</p>
            {step.systemRestartRequired && <p className="setup-system-restart">{t('Restart Windows to finish installation.')}</p>}
            {users}
            {noticeLine}
          </div>
          <span className="setup-row-state is-danger">{t('Not installed')}</span>
          <span className="setup-row-act">
            {retry
              ? <button type="button" className="setup-act" id={`setup-retry-${step.id}`} disabled={disabled} onClick={() => onRun(retry)}>{t('Try again')}</button>
              : action('apply')}
          </span>
        </div>
        {output}
        {confirming === 'apply' && box('apply')}
      </li>
    );
  }
  const facts = stepFacts(step, provider, platform);
  return (
    <li className={rowClass('setup-row is-needs')} data-row={step.id}>
      <div className="setup-row-top">
        <span className="setup-glyph"><WaitIcon /></span>
        <div className="setup-row-text">
          <StepTitle label={step.label} optional={step.optional} />
          <p>{t(facts.summary, facts.summaryValues)}</p>
          {users}
          {noticeLine}
        </div>
        <span className="setup-row-act">{action('apply')}</span>
      </div>
      {confirming === 'apply' && box('apply')}
    </li>
  );
}
