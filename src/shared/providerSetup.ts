/**
 * SPEC-010: what setup tells a page. Rows come in the order the owner reads them;
 * `planned` and `applied` are the helper's own words, shown as they are.
 */
export type SetupStepId = 'node' | 'npm' | 'provider' | 'shell';

/**
 * SPEC-013: every packaged helper the hub can run, which is also a row of Cats Bot
 * Settings' Agent CLIs tab. A provider's row is its own id there, and `provider` in a
 * bot's chain (SPEC-010).
 */
export type SetupHelperId = 'node' | 'npm' | 'shell' | 'codex' | 'claude' | 'antigravity' | 'grok' | 'muse';

/** The five provider CLIs, in the order every list shows them. */
export const SETUP_PROVIDER_IDS = ['codex', 'claude', 'antigravity', 'grok', 'muse'] as const;

/**
 * SPEC-013 FR-8: helpers whose `-Upgrade` installs a newer release. The npm folder only
 * re-applies its settings and PowerShell scripts only sets a policy, so neither has one.
 */
export const UPDATABLE_HELPERS: readonly SetupHelperId[] = ['node', ...SETUP_PROVIDER_IDS];

export const isSetupHelperId = (value: unknown): value is SetupHelperId =>
  typeof value === 'string' && (['node', 'npm', 'shell', ...SETUP_PROVIDER_IDS] as readonly string[]).includes(value);

export const isUpdatableHelper = (value: unknown): boolean =>
  typeof value === 'string' && (UPDATABLE_HELPERS as readonly string[]).includes(value);

/** SPEC-013 FR-7: what a ticked row does. Installing or setting up, or updating something that works. */
export type SetupChange = 'apply' | 'upgrade';

export const isSetupChange = (value: unknown): value is SetupChange => value === 'apply' || value === 'upgrade';

export interface SetupScript {
  file: string;
  /** From `assets/setup/provenance.json`; null when the file is not recorded there. */
  sha256: string | null;
  /** The repository and commit it was copied from, as one short label. */
  source: string | null;
}

/** SPEC-013 FR-9: what the last update found, from the checks before and after it. */
export interface SetupUpdateResult {
  from: string | null;
  to: string | null;
  outcome: 'updated' | 'current' | 'restart' | 'failed' | 'declined';
}

export interface SetupStep<Id extends string = SetupStepId> {
  id: Id;
  label: string;
  status: string;
  installed: boolean;
  version: string | null;
  manualSteps: string[];
  warnings: string[];
  /** A restart needed now, not one a read-only plan anticipates after applying. */
  restartRequired: boolean;
  /** An installer explicitly requested a Windows restart; CLI readiness does not cancel this advice. */
  systemRestartRequired?: boolean;
  /** FR-12: never blocks another step or finishing. */
  optional: boolean;
  /** What the helper reports it would do. */
  planned: string[];
  /** What the helper reports it just did. */
  applied: string[];
  script: SetupScript | null;
  /** FR-10: the command applying this step really runs. */
  applyCommand: string | null;
  /** SPEC-013 FR-8: the command an update really runs; null where the helper has none. */
  updateCommand: string | null;
  /** SPEC-013 FR-9: set once an update of this step has run in this hub session. */
  lastUpdate?: SetupUpdateResult;
  /** SPEC-013 FR-5: the reason a read-only check could not run. */
  checkError?: string;
}

/** FR-15: only what a CLI itself reports. Most give no signal, and that is said rather than guessed. */
export type SetupSignIn = 'signed_in' | 'required' | 'unknown';

export interface CodexInitialization {
  status: 'ready' | 'required' | 'unavailable';
}

export interface ProviderSetupState {
  provider: string;
  steps: SetupStep[];
  canFinish: boolean;
  signIn: SetupSignIn;
  /** FR-15: the fixed command that signs in to this provider. */
  signInCommand: string | null;
  /** Windows Codex first-run setup is separate from installation and sign-in. */
  codexInitialization?: CodexInitialization;
}

/**
 * SPEC-013: this computer as the Agent CLIs tab shows it, kept by the hub for its session.
 * Until the owner first presses Check this computer, every step reads `not_checked` and
 * nothing has run.
 */
export interface ComputerSetupState {
  platform: string;
  checkedAt: string | null;
  steps: Array<SetupStep<SetupHelperId>>;
  /** By provider: what the CLI reports about sign-in, and its fixed sign-in command. */
  signIn: Partial<Record<SetupHelperId, { state: SetupSignIn; command: string | null }>>;
  codexInitialization?: CodexInitialization;
}

export function canCreateFromSetup(state: ProviderSetupState | null): boolean {
  // Sandbox readiness is advice about future turns, not a prerequisite for creating a cat.
  return state?.canFinish === true;
}

/** FR-14: one run of a helper, or one terminal opened, as the page's log shows it. */
export interface SetupLogEntry {
  /** The same for a run's start and end. */
  run: number;
  phase: 'start' | 'end';
  at: string;
  kind: 'check' | 'change' | 'terminal';
  helper: string;
  file: string;
  command: string;
  status?: string;
  version?: string;
  planned?: string[];
  applied?: string[];
  warnings?: string[];
  manualSteps?: string[];
  error?: string;
  durationMs?: number;
}

/** What the page may show about where it runs. */
export interface SetupEnvironment {
  platform: string;
  /** FR-17: a first run on a copy that can start at login. */
  startAtLoginOffered: boolean;
}

/** FR-13: what a restart of Cats Bot keeps. */
export interface SetupDraft {
  name: string;
  instructions: string;
  provider: string;
  avatar?: string;
}
