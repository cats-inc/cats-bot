import { useEffect, useRef } from 'react';
import { useI18n } from '../../i18n.ts';
import { clockOf, logText, runFacts, runFailed, type LogRun } from './setupLogic.ts';

const KIND_LABEL: Readonly<Record<LogRun['kind'], string>> = { check: 'Check', change: 'Change', terminal: 'Terminal' };

/**
 * ADR-030: on a settings page the log (SPEC-010 FR-14) is opened when wanted, beside the rows,
 * instead of lying across the window's foot. Its runs and Copy all are the wizard's.
 */
export function LogSheet({ runs, onClose }: { runs: readonly LogRun[]; onClose(): void }) {
  const { t } = useI18n();
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="log-sheet" role="dialog" aria-label={t('Log')}>
      <div className="log-sheet-head">
        <h3>{t('Log')}</h3>
        {runs.length > 0 && (
          <button type="button" onClick={() => void navigator.clipboard.writeText(logText(runs)).catch(() => {})}>{t('Copy all')}</button>
        )}
        <button type="button" className="quiet" ref={close} onClick={onClose}>{t('Close')}</button>
      </div>
      <div className="log-sheet-body" role="log">
        {runs.length === 0 && <p className="hint">{t('Nothing has run yet.')}</p>}
        {runs.map((run) => (
          <div className="log-run" key={run.run}>
            <div className="log-run-head">
              <span>{clockOf(run.at)}</span>
              <span className={runFailed(run) ? 'log-kind is-fail' : 'log-kind'}>{t(KIND_LABEL[run.kind])}</span>
              <span>{run.file}</span>
            </div>
            <pre className={runFailed(run) ? 'setup-run-output is-fail' : 'setup-run-output'}>
              {[`> ${run.command}`, ...(run.ended ? runFacts(run) : [t('Running…')])].join('\n')}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The button that opens it, with how many runs this window heard. */
export function LogButton({ runs, onOpen }: { runs: readonly LogRun[]; onOpen(): void }) {
  const { t } = useI18n();
  return <button type="button" className="setup-more" onClick={onOpen}>{t('Log ({count})', { count: runs.length })}</button>;
}
