import {
  isUpdatableHelper,
  SETUP_PROVIDER_IDS,
  type ComputerSetupState,
  type ProviderSetupState,
  type SetupChange,
  type SetupHelperId,
  type SetupLogEntry,
  type SetupStep,
  type SetupStepId,
} from '../../../shared/providerSetup.ts';

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

export type RowKind = 'ready' | 'needs' | 'waiting' | 'failed' | 'declined' | 'restart' | 'unchecked' | 'checkFailed';

const isProviderRow = (id: string): boolean => id === 'provider' || (SETUP_PROVIDER_IDS as readonly string[]).includes(id);

/** FR-8: the one state a step's row is in. SPEC-012 adds a row not checked yet and one whose check could not run. */
export function rowKind(step: SetupStep<string>): RowKind {
  if (step.status === 'not_checked') return 'unchecked';
  if (step.status === 'check_failed') return 'checkFailed';
  if (step.status === 'prerequisite_required') return 'waiting';
  if (step.status === 'elevation_required') return 'declined';
  if (step.status === 'failed') return 'failed';
  if (step.systemRestartRequired && !step.installed) return 'restart';
  if (step.status === 'restart_required' || step.status === 'relaunch_required' || step.restartRequired) return 'restart';
  if (step.status === 'ready') return 'ready';
  if (step.status === 'auth_required' && step.installed && isProviderRow(step.id)) return 'ready';
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

/* ---- SPEC-012: Cats Bot Settings' Agent CLIs tab, and a bot's own tab ---- */

export type ComputerStep = SetupStep<SetupHelperId>;

/** FR-8: a working row whose helper can update it. The shell gives only those an update command. */
export const canUpdate = (step: SetupStep<string>): boolean =>
  rowKind(step) === 'ready' && step.updateCommand !== null && isUpdatableHelper(step.id === 'provider' ? 'codex' : step.id);

/** FR-7: what Apply does for a ticked row: set up what is missing, or update what works. */
export function changeFor(step: SetupStep<string>): SetupChange | null {
  const kind = rowKind(step);
  if (kind === 'needs') return 'apply';
  return canUpdate(step) ? 'upgrade' : null;
}

/** FR-7: ticked rows in the order they run, top down, whether they install or update. */
export function changeQueue<Id extends string>(steps: ReadonlyArray<SetupStep<Id>>, ticked: ReadonlySet<string>): Id[] {
  return steps.filter((step) => ticked.has(step.id) && changeFor(step) !== null).map((step) => step.id);
}

/** FR-8: the rows "Tick all N updates" ticks, which it offers from two of them. */
export const updatableSteps = <Id extends string>(steps: ReadonlyArray<SetupStep<Id>>): Array<SetupStep<Id>> => steps.filter(canUpdate);

export interface ComputerGroup {
  key: 'node' | 'native' | 'optional';
  title: string;
  rows: ComputerStep[];
  /** FR-2: its rows hang from Node.js, as the wizard draws them. */
  stem: boolean;
}

/** FR-2: the wizard's groups. Inside a group, the order every list uses. */
export function computerGroups(state: ComputerSetupState): ComputerGroup[] {
  const of = (ids: readonly SetupHelperId[]) =>
    ids.map((id) => state.steps.find((step) => step.id === id)).filter((step): step is ComputerStep => step !== undefined);
  const groups: ComputerGroup[] = [
    { key: 'node', title: 'Installed through Node.js', rows: of(['node', 'npm', 'codex']), stem: true },
    { key: 'native', title: 'With their own installer', rows: of(['claude', 'antigravity', 'grok', 'muse']), stem: false },
    { key: 'optional', title: 'Optional, and fine to leave for later', rows: of(['shell']), stem: false },
  ];
  return groups.filter((group) => group.rows.length > 0);
}

/** FR-2: where a row sits on its group's stem. */
export function stemClass(group: ComputerGroup, index: number): string | undefined {
  if (!group.stem) return undefined;
  if (index === 0) return 'is-dep-root';
  return index === group.rows.length - 1 ? 'is-dep is-dep-last' : 'is-dep';
}

/** FR-6: the cat bots using each provider, from Settings → Cat bots. Archived ones do not count. */
export function usersByProvider(bots: ReadonlyArray<{ name: string; provider: string | null; state: string }>): Map<string, string[]> {
  const users = new Map<string, string[]>();
  for (const bot of bots) {
    if (!bot.provider || bot.state === 'archived') continue;
    users.set(bot.provider, [...(users.get(bot.provider) ?? []), bot.name]);
  }
  return users;
}

/** FR-6: what the cat bots need: the CLIs they use, and Node.js and its npm folder for Codex. */
export function neededHelpers(users: ReadonlyMap<string, readonly string[]>): Set<SetupHelperId> {
  const needed = new Set<SetupHelperId>();
  for (const id of SETUP_PROVIDER_IDS) if (users.get(id)?.length) needed.add(id);
  if (needed.has('codex')) {
    needed.add('node');
    needed.add('npm');
  }
  return needed;
}

/** FR-6: rows the cat bots need that are not ready, which is how far from ready the tab says they are. */
export const neededPending = (steps: readonly ComputerStep[], needed: ReadonlySet<SetupHelperId>): ComputerStep[] =>
  steps.filter((step) => needed.has(step.id) && !step.optional && rowKind(step) !== 'ready');

/** FR-7: the rows "Tick all N required" ticks: ones the cat bots need, and it appears from two. */
export const neededTickable = (steps: readonly ComputerStep[], needed: ReadonlySet<SetupHelperId>): ComputerStep[] =>
  steps.filter((step) => needed.has(step.id) && rowKind(step) === 'needs');

/** FR-4: the hint beside Check this computer: every row, and Codex's first-time setup on Windows. */
export const computerChecks = (state: ComputerSetupState): number =>
  state.steps.length + (state.platform === 'win32' ? 1 : 0);

/**
 * What Try again runs. An update starts from something that works, so a row its update left
 * broken is installed again instead; the shell would refuse to update it.
 */
export function retryChange(step: SetupStep<string>, attempted: SetupChange): SetupChange {
  return attempted === 'upgrade' && !step.installed ? 'apply' : attempted;
}

/** FR-9: what the last update found, in a few words. */
export function updateNote(step: SetupStep<string>): { text: string; values?: Record<string, string>; tone: 'ok' | 'danger' } | null {
  const update = step.lastUpdate;
  if (!update) return null;
  switch (update.outcome) {
    case 'updated':
      return update.from && update.to
        ? { text: 'Updated {from} → {to}', values: { from: update.from, to: update.to }, tone: 'ok' }
        : { text: 'Updated to {to}', values: { to: update.to ?? '' }, tone: 'ok' };
    case 'current':
      return { text: 'Already the newest', tone: 'ok' };
    case 'restart':
      return { text: 'Installed. It finishes after a restart; the version you had works until then.', tone: 'ok' };
    case 'declined':
      return { text: 'You chose No in the Windows prompt, so nothing changed.', tone: 'danger' };
    default:
      return { text: 'The update did not finish, and the version you had still works. The log below says why.', tone: 'danger' };
  }
}

/** FR-3: when the results the tab shows were read. */
export const shortClock = (iso: string): string => clockOf(iso).slice(0, 5);
