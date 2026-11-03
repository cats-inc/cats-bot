import { useEffect, useRef } from 'react';
import { useI18n } from '../../i18n.ts';
import { clockOf, logText, logTotals, runFacts, runFailed, type LogRun } from './setupLogic.ts';

const KIND_LABEL: Readonly<Record<LogRun['kind'], string>> = { check: 'Check', change: 'Change', terminal: 'Terminal' };

/**
 * SPEC-010 FR-14: a read-only text area, not a terminal. Helpers report once, at their
 * end, so a run in progress shows its command and a timer.
 */
export function SetupLog({
  runs,
  open,
  running,
  elapsed,
  onToggle,
  onHover,
}: {
  runs: readonly LogRun[];
  open: boolean;
  /** What is running now, for the closed bar. */
  running: string | null;
  elapsed: string | null;
  onToggle(): void;
  onHover(hovering: boolean): void;
}) {
  const { t } = useI18n();
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const node = scroller.current;
    if (node && pinned.current) node.scrollTop = node.scrollHeight;
  }, [runs, open]);
  const totals = logTotals(runs);
  const last = running ?? (runs.length ? t('Ran {checks} check(s) and changed {changes} item(s).', totals) : t('Nothing has run yet.'));
  return (
    <div className={open ? 'setup-log is-open' : 'setup-log'} onPointerEnter={() => onHover(true)} onPointerLeave={() => onHover(false)}>
      <div className="setup-log-bar">
        <button type="button" className="setup-log-toggle" id="setup-log-toggle" aria-expanded={open} aria-controls="setup-log-panel" onClick={onToggle}>
          <svg className="setup-log-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
          <span className="setup-log-label">{t('Log')}</span>
          <span className="setup-log-last">{last}</span>
          {elapsed && <span className="setup-log-time">{elapsed}</span>}
        </button>
        {open && runs.length > 0 && (
          <button type="button" className="setup-log-copy" id="setup-log-copy" onClick={() => void navigator.clipboard.writeText(logText(runs)).catch(() => {})}>
            {t('Copy all')}
          </button>
        )}
      </div>
      <div className="setup-log-panel" id="setup-log-panel">
        <div
          className="setup-log-scroll"
          ref={scroller}
          role="log"
          aria-live="polite"
          aria-label={t('Log')}
          tabIndex={open ? 0 : -1}
          onScroll={(event) => {
            const node = event.currentTarget;
            pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
          }}
        >
          {runs.length === 0 && <p className="setup-log-empty">{t("After you press Check this computer, each script's full command and result appear here.")}</p>}
          {runs.map((run) => (
            <div className="setup-log-run" key={run.run}>
              <div className="setup-log-head">
                <span className="setup-log-clock">{clockOf(run.at)}</span>
                <span className={runFailed(run) ? 'setup-log-kind is-fail' : `setup-log-kind is-${run.kind}`}>{t(KIND_LABEL[run.kind])}</span>
                <span>{run.file}</span>
              </div>
              <div className="setup-log-command">&gt; {run.command}</div>
              {runFacts(run).map((line, index) => (
                <div className={runFailed(run) && /^(status|warning|error)/u.test(line) ? 'setup-log-fact is-fail' : 'setup-log-fact'} key={index}>{line}</div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
