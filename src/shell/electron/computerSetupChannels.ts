/** SPEC-013: the IPC channels behind Cats Bot Settings' Agent CLIs tab, apart from Electron for the contract test. */
export const COMPUTER_SETUP_CHANNELS = [
  'computer:state',
  'computer:check',
  'computer:change',
  'computer:openTerminal',
  'computer:openCodexInitialization',
] as const;
