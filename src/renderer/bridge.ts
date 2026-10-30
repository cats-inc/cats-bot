import type {
  ApprovalDecision,
  BotHostEvent,
  BotProfile,
  BotProfilePatch,
  BotStatus,
  ConversationRecord,
  ModelCatalog,
  ProviderInfo,
  ScheduleRecord,
  TelegramSettingsStatus,
  TranscriptEntry,
  WorkItem,
  BotInteractionSnapshot,
  BotInteractionResponse,
  SessionCapabilitiesSnapshot,
  DesktopControlState,
  DesktopGrantDecision,
} from '../core/types.ts';
import type { BotUpdateAction, BotUpdateState } from '../shared/shellUpdate.ts';

/**
 * ADR-003: the type of `window.catsBot`, which `assets/preload.cjs` exposes.
 * The renderer takes only types from the core (`core/types.ts`); everything
 * at run time goes through this bridge. `tests/shell/bridge.test.ts` checks
 * the command list and the layers against the shell, so a command added on
 * one side and not the other fails a test instead of a click.
 */

/** Each `bot:invoke` command with its arguments and result (src/shell/electron/ipc.ts). */
export interface HostCommands {
  providerInteractions: { args: [conversationId: string]; result: BotInteractionSnapshot };
  respondProviderInteraction: { args: [conversationId: string, interactionId: string, response: BotInteractionResponse]; result: null };
  sessionCapabilities: { args: [conversationId: string, refresh?: boolean]; result: SessionCapabilitiesSnapshot };
  openProviderInteractionUrl: { args: [conversationId: string, interactionId: string]; result: null };
  getProfile: { args: []; result: BotProfile };
  updateProfile: { args: [patch: BotProfilePatch]; result: BotProfile };
  listConversations: { args: []; result: ConversationRecord[] };
  createConversation: { args: [title?: string]; result: ConversationRecord };
  deleteConversation: { args: [conversationId: string]; result: null };
  transcript: { args: [conversationId: string]; result: TranscriptEntry[] };
  conversationTranscript: { args: [conversationId: string]; result: TranscriptEntry[] };
  sendOwnerMessage: { args: [conversationId: string, text: string]; result: WorkItem };
  cancelTurn: { args: [conversationId: string]; result: null };
  markSeen: { args: [conversationId: string]; result: null };
  listSchedules: { args: []; result: ScheduleRecord[] };
  cancelSchedule: { args: [scheduleId: string]; result: null };
  /** One conversation's work items: the unfinished ones and the newest finished ones. */
  listWorkItems: { args: [conversationId?: string]; result: WorkItem[] };
  resolveApproval: { args: [workItemId: string, decision: ApprovalDecision]; result: null };
  status: { args: []; result: BotStatus };
  listProviders: { args: []; result: ProviderInfo[] };
  listModels: { args: [provider: string]; result: ModelCatalog };
  renameConversation: { args: [conversationId: string, title: string]; result: ConversationRecord };
  telegramStatus: { args: []; result: TelegramSettingsStatus };
  setTelegramToken: { args: [token: string | null]; result: TelegramSettingsStatus };
  /** SPEC-006: without a conversation (Settings), only the profile-level state. */
  desktopControlState: { args: [conversationId?: string]; result: DesktopControlState };
  setConversationDesktopControl: { args: [conversationId: string, enabled: boolean]; result: DesktopControlState };
  respondDesktopGrant: { args: [conversationId: string, requestId: string, decision: DesktopGrantDecision]; result: DesktopControlState };
  stopDesktopControl: { args: [conversationId: string]; result: DesktopControlState };
}

export type HostCommandName = keyof HostCommands;

/** The same list as the shell's `HOST_COMMANDS`, at run time, for the contract test. */
export const BRIDGE_COMMANDS = [
  'providerInteractions', 'respondProviderInteraction', 'sessionCapabilities', 'openProviderInteractionUrl',
  'getProfile',
  'updateProfile',
  'listConversations',
  'createConversation',
  'deleteConversation',
  'transcript',
  'conversationTranscript',
  'sendOwnerMessage',
  'cancelTurn',
  'markSeen',
  'listSchedules',
  'cancelSchedule',
  'listWorkItems',
  'resolveApproval',
  'status',
  'listProviders',
  'listModels',
  'renameConversation',
  'telegramStatus',
  'setTelegramToken',
  'desktopControlState', 'setConversationDesktopControl', 'respondDesktopGrant', 'stopDesktopControl',
] as const satisfies readonly HostCommandName[];

/** Where a note lives (SPEC-002 FR-8); the shell's `NOTE_LAYERS`. */
export const BRIDGE_NOTE_LAYERS = ['normal', 'top', 'desktop', 'wallpaper'] as const;
export type NoteLayer = (typeof BRIDGE_NOTE_LAYERS)[number];

export interface NoteWindowState {
  layer: NoteLayer;
  layers: NoteLayer[];
  botName: string;
}

export interface NoteLayersView {
  layers: NoteLayer[];
  labels: Record<NoteLayer, string>;
  /** The layer of every note the shell has seen, by conversation id. */
  views: Record<string, NoteLayer>;
}

export interface ShellStateView {
  /** Null in Cats Bot Settings, which belongs to no bot (D20). */
  botId: string | null;
  openAtLogin: boolean;
  openAtLoginAvailable: boolean;
  floatingVisible: boolean;
  version: string;
  /** The bot's folder, or the Cats Bot root in Cats Bot Settings. */
  root: string;
}

export interface FloatingBubbleMessage {
  conversationId: string;
  from: string;
  text: string;
}

/** SPEC-008 FR-5: one row of Settings → Bots. */
export interface BotRow {
  id: string;
  name: string;
  provider: string | null;
  state: 'starting' | 'running' | 'stopped' | 'failed' | 'external' | 'archived' | 'missing';
  error: string | null;
  pid: number | null;
  startAutomatically: boolean;
  bossCat: boolean;
  /** SPEC-009 FR-11: for the holder, whether its provider gives it the Boss Cat tools. */
  bossCatTools: boolean | null;
}

export interface BotListing {
  bots: BotRow[];
  /** Bot directories without a registry entry, for the owner to add. */
  unregistered: string[];
  maxBots: number;
  active: number;
  /** SPEC-009 FR-8: the owner's limits on Boss Cat messages. */
  limits: { hopsPerChain: number; messagesPerHour: number };
}

export type BotAction = 'start' | 'stop' | 'startAutomatically' | 'moveUp' | 'moveDown' | 'register' | 'archive' | 'restore' | 'delete'
  | 'makeBossCat' | 'clearBossCat';

export interface SetupInput {
  name: string;
  provider: string;
  model: string | null;
  instructions: string;
  modelSelection?: import('../core/types.ts').ModelSelection;
}

type Unsubscribe = () => void;

export interface CatsBotBridge {
  language: {
    get(): Promise<import('../shared/language.ts').LanguageState>;
    set(
      value: import('../shared/language.ts').LanguagePreference,
    ): Promise<import('../shared/language.ts').LanguageState>;
    onChange(listener: (state: import('../shared/language.ts').LanguageState) => void): Unsubscribe;
  };
  /** The note's conversation from `?conversation=`, `home` elsewhere. */
  conversationId: string;
  invoke<C extends HostCommandName>(command: C, ...args: HostCommands[C]['args']): Promise<HostCommands[C]['result']>;
  onEvent(listener: (event: BotHostEvent) => void): Unsubscribe;
  onNavigate(listener: (tab: string) => void): Unsubscribe;
  window: {
    hide(): Promise<null>;
    layerMenu(): Promise<null>;
    onLayer(listener: (layer: NoteLayer) => void): Unsubscribe;
    onLifted(listener: () => void): Unsubscribe;
    state(): Promise<NoteWindowState>;
    openConversation(conversationId: string): Promise<null>;
  };
  /** Settings-window only; the shell answers null to other windows. */
  shell: {
    updateState(): Promise<BotUpdateState>;
    updateAction(action: BotUpdateAction): Promise<BotUpdateState>;
    onUpdate(listener: (state: BotUpdateState) => void): Unsubscribe;
    state(): Promise<ShellStateView | null>;
    setOpenAtLogin(enabled: boolean): Promise<boolean | null>;
    chooseFolder(current: string): Promise<string | null>;
    openDataFolder(): Promise<null>;
    openSettings(tab?: string): Promise<null>;
    setFloatingVisible(visible: boolean): Promise<boolean | null>;
    noteLayers(): Promise<NoteLayersView | null>;
    setNoteLayer(conversationId: string, layer: NoteLayer): Promise<NoteLayer | null>;
  };
  floating: {
    setInteractive(interactive: boolean): void;
    moveTo(x: number, y: number): void;
    dragEnd(): void;
    activate(): Promise<null>;
    menu(): Promise<null>;
    onBubble(listener: (message: FloatingBubbleMessage) => void): Unsubscribe;
  };
  /** Cats Bot Settings only (D17); a bot's settings window is refused. */
  hub: {
    bots(): Promise<BotListing>;
    action(action: BotAction, id: string, value?: boolean): Promise<BotListing>;
    create(): Promise<null>;
    setLimits(limits: { hopsPerChain: number; messagesPerHour: number }): Promise<BotListing>;
    onChange(listener: () => void): Unsubscribe;
  };
  /** First-run page only. */
  setup: {
    check(provider: string): Promise<import('../shared/providerSetup.ts').ProviderSetupState>;
    install(
      provider: string,
      step: import('../shared/providerSetup.ts').SetupStepId,
    ): Promise<import('../shared/providerSetup.ts').ProviderSetupState>;
    providers(): Promise<ProviderInfo[]>;
    models(provider: string): Promise<ModelCatalog>;
    /** New bot window only: a Boss Cat's request waiting for its provider's setup, once. */
    prefill(): Promise<{ name: string; persona: string; provider: string } | null>;
    finish(input: SetupInput): Promise<null>;
  };
}

declare global {
  interface Window {
    catsBot: CatsBotBridge;
  }
}
