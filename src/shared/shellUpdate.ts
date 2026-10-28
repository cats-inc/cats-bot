/** Browser-safe desktop update contract. No updater or Node objects cross IPC. */
export type UpdatePhase = 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error' | 'unavailable';
export interface BotUpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  version: string | null;
  distribution: 'development' | 'unofficial' | 'standard-preview';
  canCheck: boolean;
  canInstall: boolean;
  reason: string | null;
  error: string | null;
  percent: number | null;
}
export type BotUpdateAction = 'check' | 'download' | 'install' | 'release';
