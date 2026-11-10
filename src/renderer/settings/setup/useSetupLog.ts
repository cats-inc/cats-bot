import { useCallback, useEffect, useRef, useState } from 'react';
import { addLogEntry, elapsedLabel, type LogRun } from './setupLogic.ts';

/** SPEC-010 FR-14: how long a finished run's log stays open before it gives the room back. */
export const LOG_SETTLE_MS = 1400;

/** A run's timer, as `mm:ss`, while `since` is set. */
export function useElapsed(since: number | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [since]);
  return since === null ? null : elapsedLabel(now - since);
}

/**
 * SPEC-010 FR-14, for every page with a log (the wizard, the Agent CLIs tab and a bot's own
 * tab, SPEC-013 FR-14): the runs this window heard, and when the log opens and closes. Any run
 * opens it. It closes about 1.4 s after success, stays open after a failure, and waits while
 * the pointer is on it. Once the owner toggles it, it stays as they set it, except that a
 * failure opens it.
 */
export function useSetupLog() {
  const [runs, setRuns] = useState<LogRun[]>([]);
  const runsRef = useRef<LogRun[]>([]);
  const [open, setOpen] = useState(false);
  const choice = useRef<'open' | 'closed' | null>(null);
  const hovering = useRef(false);
  const closeOnLeave = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => window.catsBot.setup.onLog((entry) => {
    runsRef.current = addLogEntry(runsRef.current, entry);
    setRuns(runsRef.current);
  }), []);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const cancelSettle = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    closeOnLeave.current = false;
  }, []);
  const openForRun = useCallback(() => {
    cancelSettle();
    setOpen(choice.current !== 'closed');
  }, [cancelSettle]);
  const openForFailure = useCallback(() => {
    cancelSettle();
    setOpen(true);
  }, [cancelSettle]);
  const settle = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      if (choice.current) return;
      if (hovering.current) {
        closeOnLeave.current = true;
        return;
      }
      setOpen(false);
    }, LOG_SETTLE_MS);
  }, []);
  const toggle = useCallback(() => {
    cancelSettle();
    setOpen((current) => {
      choice.current = current ? 'closed' : 'open';
      return !current;
    });
  }, [cancelSettle]);
  const hover = useCallback((value: boolean) => {
    hovering.current = value;
    if (!value && closeOnLeave.current) {
      closeOnLeave.current = false;
      settle();
    }
  }, [settle]);

  return { runs, runsRef, open, openForRun, openForFailure, settle, toggle, hover };
}
