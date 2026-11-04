import type { ProviderSetupState, SetupLogEntry, SetupStep, SetupStepId } from '../../../shared/providerSetup.ts';

/**
 * SPEC-010: what the wizard decides, apart from React, so it is tested with node:test.
 */

/** FR-5: English text is also the translation key. The first preset's text is the placeholder too. */
export const PERSONA_PRESETS: ReadonlyArray<{ label: string; text: string }> = [
  { label: 'Curious', text: 'You are a curious cat who keeps me company while I work. Ask about what catches your eye, and share what you find.' },
  { label: 'Steady', text: 'You are a calm, dependable cat. Keep answers short and lead with the conclusion. When you are unsure, say so instead of guessing.' },
  { label: 'Playful', text: 'You are a playful cat who keeps things light and loves a joke, but you always get the work right.' },
  { label: 'Gentle', text: 'You are a gentle cat who notices how I am doing. When I am tired or stuck, stay with me first, then help me find the next step.' },
  { label: 'Blunt', text: 'You are a blunt cat who says what you see. Point out where I am wrong, then tell me how to fix it.' },
];

export type RowKind = 'ready' | 'needs' | 'waiting' | 'failed' | 'declined' | 'restart';

/** FR-8: the one state a step's row is in. */
export function rowKind(step: SetupStep): RowKind {
  if (step.status === 'prerequisite_required') return 'waiting';
  if (step.status === 'elevation_required') return 'declined';
  if (step.status === 'failed') return 'failed';
  if (step.systemRestartRequired && !step.installed) return 'restart';
  if (step.status === 'restart_required' || step.status === 'relaunch_required' || step.restartRequired) return 'restart';
  if (step.status === 'ready') return 'ready';
  if (step.status === 'auth_required' && step.installed && step.id === 'provider') return 'ready';
  return 'needs';
}

export const needsAction = (step: SetupStep): boolean => rowKind(step) !== 'ready';

/** What a tick box can be offered for. */
export const tickableSteps = (state: ProviderSetupState | null): SetupStep[] =>
  (state?.steps ?? []).filter((step) => rowKind(step) === 'needs');

/** FR-9: the shortcut's rows: required ones, and it appears from two of them. */
export const requiredTickable = (state: ProviderSetupState | null): SetupStep[] =>
  tickableSteps(state).filter((step) => !step.optional);

/** Required rows that are not done, which is how far from ready the page says this computer is. */
export const requiredPending = (state: ProviderSetupState | null): SetupStep[] =>
  (state?.steps ?? []).filter((step) => !step.optional && rowKind(step) !== 'ready');

/** FR-11: ticked rows in the order they run, top down. */
export function queueOf(state: ProviderSetupState | null, ticked: ReadonlySet<SetupStepId>): SetupStepId[] {
  return (state?.steps ?? [])
    .filter((step) => ticked.has(step.id) && rowKind(step) === 'needs')
    .map((step) => step.id);
}

/** A row that stopped the queue, which the page's title and footer speak to. */
export function stoppedStep(state: ProviderSetupState | null): SetupStep | null {
  return (state?.steps ?? []).find((step) => ['failed', 'declined', 'restart'].includes(rowKind(step))) ?? null;
}

/**
 * FR-9: what "Try again" runs: the stopped row, then whatever is still ticked. Only a row the owner
 * already ran can be retried. One that failed a read-only check was never ticked, so nothing runs it.
 */
export function retryQueue(
  stopped: SetupStep | null,
  attempted: ReadonlySet<SetupStepId>,
  queued: readonly SetupStepId[],
): SetupStepId[] {
  if (!stopped || rowKind(stopped) === 'restart' || !attempted.has(stopped.id)) return [];
  return [stopped.id, ...queued.filter((id) => id !== stopped.id)];
}

export interface PendingStep {
  id: SetupStepId;
  helper: string;
  label: string;
  optional: boolean;
}

/** The rows a check is about to fill in, in the shell's order (`ProviderSetup.chain`). */
export function pendingSteps(provider: string, label: string, platform: string): PendingStep[] {
  if (provider !== 'codex') return [{ id: 'provider', helper: provider, label, optional: false }];
  return [
    { id: 'node', helper: 'node', label: 'Node.js and npm', optional: false },
    { id: 'npm', helper: 'npm', label: 'npm installation folder', optional: false },
    { id: 'provider', helper: provider, label: 'Codex', optional: false },
    ...(platform === 'win32' ? [{ id: 'shell' as const, helper: 'shell', label: 'PowerShell scripts', optional: true }] : []),
  ];
}

/** FR-3: the hint beside "Check this computer". */
export function checksToRun(provider: string, platform: string): number {
  return pendingSteps(provider, provider, platform).length + (provider === 'codex' && platform === 'win32' ? 1 : 0);
}

/** FR-14: a helper run in the log: its start and end entries as one. */
export interface LogRun {
  run: number;
  kind: SetupLogEntry['kind'];
  helper: string;
  file: string;
  command: string;
  at: string;
  ended: boolean;
  status?: string;
  version?: string;
  planned?: string[];
  applied?: string[];
  warnings?: string[];
  manualSteps?: string[];
  error?: string;
  durationMs?: number;
}

export function addLogEntry(runs: readonly LogRun[], entry: SetupLogEntry): LogRun[] {
  const { phase, ...fields } = entry;
  const index = runs.findIndex((run) => run.run === entry.run);
  if (index < 0) return [...runs, { ...fields, ended: phase === 'end' }];
  const next = [...runs];
  // A run keeps the time it started.
  next[index] = { ...next[index]!, ...fields, at: next[index]!.at, ended: phase === 'end' };
  return next;
}

/**
 * A change that ended without reporting one changed nothing. A declined UAC prompt looks like that:
 * Install-Node answers `changes_required`, as its check did.
 */
const changedNothing = (run: LogRun): boolean =>
  run.kind === 'change' && run.ended && !run.applied?.length
  && !['ready', 'auth_required', 'restart_required', 'relaunch_required'].includes(run.status ?? '');

export const runFailed = (run: LogRun): boolean =>
  Boolean(run.error) || run.status === 'failed' || run.status === 'elevation_required' || run.status === 'not_found' || changedNothing(run);

export function logTotals(runs: readonly LogRun[]): { checks: number; changes: number } {
  return {
    checks: runs.filter((run) => run.kind === 'check' && run.ended).length,
    changes: runs.filter((run) => run.kind === 'change' && run.ended && !runFailed(run)).length,
  };
}

/** What a finished run reported, one fact a line, in the helper's words. */
export function runFacts(run: LogRun): string[] {
  const lines: string[] = [];
  if (run.status) lines.push(`status: ${run.status}${run.version ? `, version: ${run.version}` : ''}`);
  if (run.planned?.length) lines.push(`planned: ${run.planned.join(', ')}`);
  if (run.applied?.length) lines.push(`applied: ${run.applied.join(', ')}`);
  for (const line of run.warnings ?? []) lines.push(`warning: ${line}`);
  for (const line of run.manualSteps ?? []) lines.push(`next: ${line}`);
  if (run.error) lines.push(`error: ${run.error}`);
  if (run.ended && run.durationMs !== undefined) lines.push(`took ${(run.durationMs / 1000).toFixed(1)} s`);
  return lines;
}

export const clockOf = (iso: string): string => {
  const date = new Date(iso);
  const two = (value: number) => String(value).padStart(2, '0');
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
};

/** FR-14: "Copy all". */
export function logText(runs: readonly LogRun[]): string {
  return runs
    .map((run) => [`${clockOf(run.at)} ${run.kind} ${run.file}`, `> ${run.command}`, ...runFacts(run)].join('\n'))
    .join('\n\n');
}

/** A check's rows while it runs, from what the log has heard so far. */
export type LiveRow = 'pending' | 'checking' | 'ready' | 'needs';

export function liveRow(runs: readonly LogRun[], since: number, helper: string): LiveRow {
  const run = runs.slice(since).findLast((item) => item.helper === helper && item.kind === 'check');
  if (!run) return 'pending';
  if (!run.ended) return 'checking';
  return run.status === 'ready' || run.status === 'auth_required' ? 'ready' : 'needs';
}

export const elapsedLabel = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};
