/**
 * SPEC-010: what setup tells a page. Rows come in the order the owner reads them;
 * `planned` and `applied` are the helper's own words, shown as they are.
 */
export type SetupStepId = 'node' | 'npm' | 'provider' | 'shell';

export interface SetupScript {
  file: string;
  /** From `assets/setup/provenance.json`; null when the file is not recorded there. */
  sha256: string | null;
  /** The repository and commit it was copied from, as one short label. */
  source: string | null;
}

export interface SetupStep {
  id: SetupStepId;
  label: string;
  status: string;
  installed: boolean;
  version: string | null;
  manualSteps: string[];
  warnings: string[];
  /** A restart needed now, not one a read-only plan anticipates after applying. */
  restartRequired: boolean;
  /** FR-12: never blocks another step or finishing. */
  optional: boolean;
  /** What the helper reports it would do. */
  planned: string[];
  /** What the helper reports it just did. */
  applied: string[];
  script: SetupScript | null;
  /** FR-10: the command applying this step really runs. */
  applyCommand: string | null;
}

/** FR-15: only what a CLI itself reports. Most give no signal, and that is said rather than guessed. */
export type SetupSignIn = 'signed_in' | 'required' | 'unknown';

export interface ProviderSetupState {
  provider: string;
  steps: SetupStep[];
  canFinish: boolean;
  signIn: SetupSignIn;
  /** FR-15: the fixed command that signs in to this provider. */
  signInCommand: string | null;
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
