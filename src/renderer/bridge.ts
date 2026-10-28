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
  sendOwnerMessage: { args: [conversationId: string, text: string]; result: WorkItem };
  cancelTurn: { args: [conversationId: string]; result: null };
  markSeen: { args: [conversationId: string]; result: null };
  listSchedules: { args: []; result: ScheduleRecord[] };
  cancelSchedule: { args: [scheduleId: string]; result: null };
  listWorkItems: { args: []; result: WorkItem[] };
  resolveApproval: { args: [workItemId: string, decision: ApprovalDecision]; result: null };
  status: { args: []; result: BotStatus };
  listProviders: { args: []; result: ProviderInfo[] };
  listModels: { args: [provider: string]; result: ModelCatalog };
  renameConversation: { args: [conversationId: string, title: string]; result: ConversationRecord };
  telegramStatus: { args: []; result: TelegramSettingsStatus };
  setTelegramToken: { args: [token: string | null]; result: TelegramSettingsStatus };
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
  botId: string;
  openAtLogin: boolean;
  openAtLoginAvailable: boolean;
  floatingVisible: boolean;
  version: string;
}

export interface FloatingBubbleMessage {
  conversationId: string;
  from: string;
  text: string;
}

export interface SetupInput {
  name: string;
  provider: string;
  model: string | null;
  instructions: string;
}

type Unsubscribe = () => void;

export interface CatsBotBridge {
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
  /** First-run page only. */
  setup: {
    providers(): Promise<ProviderInfo[]>;
    models(provider: string): Promise<ModelCatalog>;
    finish(input: SetupInput): Promise<null>;
  };
}

declare global {
  interface Window {
    catsBot: CatsBotBridge;
  }
}
