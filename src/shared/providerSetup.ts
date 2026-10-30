export type SetupStepId = 'node' | 'npm' | 'shell' | 'provider';
export interface SetupStep {
  id: SetupStepId;
  label: string;
  status: string;
  installed: boolean;
  version: string | null;
  manualSteps: string[];
  warnings: string[];
  restartRequired: boolean;
}
export interface ProviderSetupState {
  provider: string;
  steps: SetupStep[];
  canFinish: boolean;
}
