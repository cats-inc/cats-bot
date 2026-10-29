/**
 * Contract types of the bot core, named after SPEC-001. Everything persisted
 * under the bot data root carries a `schemaVersion`; the shapes here are the
 * in-memory view of those files plus the `BotHostApi` the shell speaks.
 */

/** SPEC-001 FR-1: the one global provider/model of a bot. */
export interface ExecutionTarget {
  provider: string;
  model: string | null;
  /** Runtime's structured selection, including model-specific controls. */
  modelSelection?: ModelSelection;
  /** Claude Code only: launch with `--chrome` so Claude in Chrome tools are available. */
  claudeInChrome?: boolean;
}

export type WorkspaceAccess = 'read_write' | 'read_only';
export type PermissionMode = 'skip' | 'whitelist' | 'default';

/** SPEC-001 FR-1 / FR-30: the same permissions for background and interactive turns. */
export interface BotPermissions {
  workspaceAccess: WorkspaceAccess;
  permissionMode: PermissionMode;
  allowedTools?: string[];
  cwd: string;
}

/** SPEC-001 FR-1 / FR-25. Minutes are inclusive bounds of a uniform random draw. */
export interface HeartbeatPolicy {
  enabled: boolean;
  wakeMinMinutes: number;
  wakeMaxMinutes: number;
  regularMinMinutes: number;
  regularMaxMinutes: number;
}

/** SPEC-001 FR-26: the optional Telegram binding; the token lives in the secret store. */
export interface TelegramPolicy {
  enabled: boolean;
  ownerChatId: number | null;
}

/** SPEC-006 BDC-02: the owner's switch for desktop control; off by default. */
export interface DesktopControlPolicy {
  enabled: boolean;
}

/** SPEC-001 FR-1. */
/** SPEC-008 FR-24 and ADR-010: where a bot runs. This version runs bots natively only. */
export interface BotEnvironment {
  kind: 'native';
}

export interface BotProfile {
  schemaVersion: 2;
  id: string;
  name: string;
  instructions: string;
  environment: BotEnvironment;
  executionTarget: ExecutionTarget;
  configRevision: number;
  permissions: BotPermissions;
  /** Null retains the original permissionMode behavior; never inferred from skip. */
  providerPolicy: SessionExecutionPolicy | null;
  heartbeat: HeartbeatPolicy;
  idleSleepMinutes: number;
  telegram: TelegramPolicy;
  /** SPEC-006 BDC-02: absent or invalid reads as off, so an older writer that drops it fails closed. */
  desktopControl: DesktopControlPolicy;
  updatedAt: string;
}

/** SPEC-001 Definitions: attachment states between a conversation and a runtime session. */
export type AttachmentState =
  | 'none'
  | 'initializing'
  | 'ready'
  | 'sleeping'
  | 'closed'
  | 'stale'
  | 'failed';

export interface SessionAttachment {
  state: AttachmentState;
  sessionId: string | null;
  providerSessionId: string | null;
  /** The execution target the session was created under (FR-27 staleness). */
  provider: string | null;
  model: string | null;
  configRevision: number | null;
  updatedAt: string;
  lastError?: string;
}

export type ConversationRole = 'home' | 'note';

/** SPEC-001 FR-12: what a replacement session received as handoff context. */
export interface HandoffCheckpoint {
  /** The handoff text that was sent; lossy for long conversations. */
  digest: string;
  /** Transcript sequence number the digest covers, inclusive. */
  throughSeq: number;
  updatedAt: string;
}

/** SPEC-001 FR-9. */
export interface ConversationRecord {
  schemaVersion: 1;
  id: string;
  role: ConversationRole;
  title: string;
  createdAt: string;
  updatedAt: string;
  attachment: SessionAttachment;
  unreadCount: number;
  lastOwnerMessageAt: string | null;
  lastBotMessageAt: string | null;
  checkpoint: HandoffCheckpoint | null;
}

export type TranscriptEntryKind =
  | 'owner'
  | 'bot'
  | 'tool_use'
  | 'tool_result'
  | 'progress'
  | 'error'
  | 'system';

export type MessageOrigin = 'owner' | 'heartbeat' | 'schedule' | 'event' | 'system' | 'bot';

/** One line of `transcripts/<conversationId>.jsonl`. */
export interface TranscriptEntry {
  seq: number;
  at: string;
  kind: TranscriptEntryKind;
  text: string;
  origin: MessageOrigin;
  /** SPEC-009 FR-10: the name of the bot that sent a message with origin `bot`. */
  from?: string;
  workItemId?: string;
  toolName?: string;
  toolId?: string;
  isError?: boolean;
  /** Versioned, sanitized display projection. Legacy JSONL records remain unchanged. */
  presentation?: import('@cats-inc/platform-ui-web/contracts').ConversationPresentation;
  presentationRevision?: number;
  presentationSeqs?: number[];
  presentationTerminalSeq?: number;
}

export type WorkItemKind = 'owner_message' | 'heartbeat' | 'schedule' | 'event';

/** SPEC-001 FR-15 / ADR-001 §6: the seven states of a work item. */
export type WorkItemState =
  | 'queued'
  | 'running'
  | 'awaiting_owner'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface WorkItemResult {
  text: string;
  completedAt: string;
}

/** SPEC-001 FR-29. */
export interface NotificationState {
  deliveredAt: string | null;
  seenAt: string | null;
}

/**
 * SPEC-009 FR-8 and FR-12: a message the coordinator sent another bot through
 * the hub, or that bot's reply. Each delivery is one hop of its chain.
 */
export interface BotChain {
  id: string;
  hop: number;
  deliveryId: string;
  kind: 'message' | 'reply';
  /** The bot that sent it, and its name when sent. */
  from: string;
  fromName: string;
}

/** SPEC-001 FR-15. */
export interface WorkItem {
  id: string;
  kind: WorkItemKind;
  source: string;
  conversationId: string;
  prompt: string;
  createdAt: string;
  admittedAt: string | null;
  configRevision: number | null;
  state: WorkItemState;
  attempts: number;
  coalesceKey?: string;
  /** Where an inbound message came from (for example `telegram:<chat>:<message>`), to accept it once. */
  sourceRef?: string;
  /** SPEC-009 FR-8 and FR-12: a coordinator delivery this work item carries. */
  chain?: BotChain;
  result?: WorkItemResult;
  notification?: NotificationState;
  /** The provider/model/session the run actually used (ADR-001 §3 evidence). */
  run?: WorkRun;
  error?: string;
  updatedAt: string;
}

/**
 * SPEC-001 FR-28: journaled before the prompt is sent, so recovery can tell
 * this turn's messages in the runtime transcript from earlier ones.
 */
export interface WorkRun {
  provider: string;
  model: string | null;
  sessionId: string;
  /** When the prompt was about to be sent. */
  startedAt?: string;
  /** How many history messages the session had before the prompt; null when it could not be read. */
  historyBaseline?: number | null;
}

export type MissedPolicy = 'skip' | 'coalesce' | 'run_once';

/** SPEC-001 FR-21. `at` for `once`, `cron` plus `timezone` for `cron`. */
export interface ScheduleRecord {
  id: string;
  conversationId: string;
  kind: 'once' | 'cron';
  at?: string;
  cron?: string;
  timezone: string;
  prompt: string;
  missedPolicy: MissedPolicy;
  graceMinutes: number;
  createdBy: 'owner' | 'agent';
  receipt: string;
  state: 'active' | 'completed' | 'cancelled';
  createdAt: string;
  lastFiredAt: string | null;
  nextAt: string | null;
}

export type PresenceState = 'awake' | 'sleeping' | 'failed';

export type PresenceReason =
  | 'keep_alive'
  | 'startup'
  | 'resumed'
  | 'rebuilt'
  | 'runtime_restart'
  | 'no_capacity'
  | 'wake_failed'
  | 'runtime_unavailable'
  | 'idle'
  | 'owner';

export type HeartbeatKind = 'wake' | 'regular';
export type HeartbeatResult = 'spoke' | 'quiet' | 'busy' | 'failed';

/** One line of `journal.jsonl`. */
export type JournalEntry =
  | { type: 'work'; at: string; item: WorkItem }
  | { type: 'schedule'; at: string; schedule: ScheduleRecord }
  | { type: 'presence'; at: string; conversationId: string; presence: PresenceState; reason: PresenceReason }
  | { type: 'runtime'; at: string; event: 'started' | 'ready' | 'exited' | 'restart_scheduled'; detail?: string }
  | { type: 'heartbeat'; at: string; kind: HeartbeatKind; result: HeartbeatResult }
  | { type: 'config'; at: string; configRevision: number; executionTarget: ExecutionTarget }
  /** SPEC-009 FR-9: a coordinator tool call this bot made, without its text. */
  | { type: 'coordinator'; at: string; tool: string; target?: string; chain?: string; outcome: string };

/** SPEC-009 FR-12: what the hub hands a bot for one delivery. */
export interface BotDelivery {
  deliveryId: string;
  chainId: string;
  hop: number;
  kind: 'message' | 'reply';
  from: string;
  fromName: string;
  /** The conversation a reply returns to; a message goes to the direct message. */
  conversationId?: string;
  text: string;
}

/** SPEC-009 FR-12: how a delivery stands in the bot that received it. */
export interface BotDeliveryState {
  deliveryId: string;
  workItemId: string;
  state: WorkItemState;
  /** The reply, once the work item completed. */
  reply: string | null;
  error: string | null;
}

export type RuntimeState = 'stopped' | 'starting' | 'ready' | 'failed';

/** SPEC-001 FR-3: what a second instance of the same bot hands to the running one. */
export interface HandoffMessage {
  id: string;
  at: string;
  kind: 'open' | 'say' | 'args' | 'schedule_create' | 'schedule_cancel' | 'approve' | 'heartbeat' | 'quit' | 'telegram';
  conversationId?: string;
  text?: string;
  args?: string[];
  payload?: Record<string, unknown>;
}

/** SPEC-001 FR-32 commands, as plain serializable calls. */
export interface BotHostApi {
  getProfile(): Promise<BotProfile>;
  updateProfile(patch: BotProfilePatch): Promise<BotProfile>;
  listConversations(): Promise<ConversationRecord[]>;
  createConversation(title?: string): Promise<ConversationRecord>;
  deleteConversation(conversationId: string): Promise<void>;
  openView(conversationId: string): Promise<void>;
  closeView(conversationId: string): Promise<void>;
  /** An open view in the background does not read replies; only a focused one does. */
  setViewFocused(conversationId: string, focused: boolean): Promise<void>;
  sendOwnerMessage(conversationId: string, text: string): Promise<WorkItem>;
  cancelTurn(conversationId: string): Promise<void>;
  markSeen(conversationId: string): Promise<void>;
  listSchedules(): Promise<ScheduleRecord[]>;
  cancelSchedule(scheduleId: string): Promise<void>;
  resolveApproval(workItemId: string, decision: 'approve' | 'deny'): Promise<void>;
  providerInteractions(conversationId: string): Promise<BotInteractionSnapshot>;
  respondProviderInteraction(conversationId: string, interactionId: string, response: BotInteractionResponse): Promise<void>;
  sessionCapabilities(conversationId: string, refresh?: boolean): Promise<SessionCapabilitiesSnapshot>;
  /** SPEC-006 BDC-07: desktop control state; with a conversation, its switch, grants and waiting grant requests. */
  desktopControlState(conversationId?: string): Promise<DesktopControlState>;
  /** SPEC-006 BDC-03: the per-conversation switch; turning it off revokes that conversation's grants. */
  setConversationDesktopControl(conversationId: string, enabled: boolean): Promise<DesktopControlState>;
  /** SPEC-006 BDC-07: only the owner answers a grant request, never a provider approval or Telegram. */
  respondDesktopGrant(conversationId: string, requestId: string, decision: DesktopGrantDecision): Promise<void>;
  /** SPEC-006 BDC-10 / SPEC-133 DC-12: without a conversation, stops every conversation. */
  stopDesktopControl(conversationId?: string): Promise<void>;
  quit(): Promise<void>;
}

export type ApprovalDecision = 'approve' | 'deny';

export interface BotProfilePatch {
  name?: string;
  instructions?: string;
  executionTarget?: ExecutionTarget;
  heartbeat?: Partial<HeartbeatPolicy>;
  idleSleepMinutes?: number;
  permissions?: Partial<BotPermissions>;
  providerPolicy?: SessionExecutionPolicy | null;
  telegram?: Partial<TelegramPolicy>;
  desktopControl?: Partial<DesktopControlPolicy>;
}

/** SPEC-001 FR-32 events. The renderer never receives runtime URLs or keys. */
export type BotHostEvent =
  | { type: 'provider.interactions'; conversationId: string; pending: number; notify?: boolean }
  | { type: 'conversation.updated'; conversation: ConversationRecord }
  | { type: 'turn.delta'; conversationId: string; workItemId: string; entry: TranscriptEntry }
  | { type: 'turn.presentation'; conversationId: string; workItemId: string; entry: TranscriptEntry }
  | { type: 'turn.completed'; conversationId: string; workItem: WorkItem }
  | { type: 'work.updated'; workItem: WorkItem }
  | { type: 'work.awaitingOwner'; workItem: WorkItem }
  | { type: 'presence.changed'; conversationId: string; presence: PresenceState; reason: PresenceReason }
  | { type: 'runtime.status'; state: RuntimeState; detail?: string }
  | { type: 'host.handoff'; message: HandoffMessage }
  /**
   * SPEC-006: desktop control changed; `pendingRequests` counts grant requests waiting in the conversation,
   * and `holding` says whether it (or, without a conversation, any conversation) holds control.
   */
  | { type: 'desktop.control'; conversationId: string | null; pendingRequests: number; holding: boolean; notify?: boolean };

// ---- Command results the presentation reads (SPEC-001 FR-32, SPEC-002) ----------
// Kept here, free of imports, so the renderer can type the bridge from this file
// alone (ADR-003); the modules that produce them re-export them.

/** The process that holds a bot's instance lock. */
export interface InstanceLock {
  pid: number;
  host: string;
  startedAt: string;
}

/** `status`. */
export interface BotStatus {
  id: string;
  name: string;
  root: string;
  runtime: { state: RuntimeState; pid: number | null };
  queue: { queued: number; running: WorkItem | null };
  pendingInteractions: number;
  /** Work items waiting for the owner's answer, such as `ask_owner` questions. */
  awaitingOwner: number;
  conversations: number;
  schedules: number;
  heartbeat: { enabled: boolean; nextAt: string | null; };
  lastTickAt: string | null;
  lock: InstanceLock | null;
  telegram: { enabled: boolean; polling: boolean; ownerChatId: number | null; };
}

export interface ProviderDefinition {
  id: string;
  label: string;
  /** The command the runtime launches unless an override is configured. */
  command: string;
}

/** `listProviders`. */
export interface ProviderInfo extends ProviderDefinition {
  /** Whether the command was found on PATH; null when the host cannot tell. */
  installed: boolean | null;
}

export interface ModelOption {
  id: string;
  label: string;
  default: boolean;
  controls?: ModelControl[];
  controlDefaults?: Record<string, ModelControlValue>;
}

export type ModelControlValue = string | number | boolean;
export interface ModelSelection {
  catalogRevision?: string;
  entryMode: 'explicit';
  entryId: string;
  controls?: Record<string, ModelControlValue>;
}
export interface ModelControl {
  key: string;
  label: string;
  kind: 'enum' | 'boolean' | 'number' | 'string';
  scope?: 'session_default' | 'request' | 'both';
  values?: Array<{ value: ModelControlValue; label: string; } | ModelControlValue>;
  default?: ModelControlValue;
  minimum?: number;
  maximum?: number;
  step?: number;
  applicableEntryIds?: string[];
}

/** `listModels`. */
export interface ModelCatalog {
  provider: string;
  defaultModel: string | null;
  models: ModelOption[];
  catalogRevision?: string;
  controls?: ModelControl[];
  defaultSelection?: ModelSelection | null;
  /** `runtime` when the running runtime answered, `packaged` for the shipped catalog. */
  source: 'runtime' | 'packaged' | 'none';
}

export type TelegramHealth = 'healthy' | 'degraded' | 'failed';

export interface TelegramStatus {
  polling: boolean;
  health: TelegramHealth;
  ownerChatId: number | null;
  lastPollAt: string | null;
  lastError: string | null;
  processedUpdates: number;
  consecutiveFailures: number;
}

/** `telegramStatus`: never carries the token itself. */
export interface TelegramSettingsStatus {
  enabled: boolean;
  tokenStored: boolean;
  protection: 'os' | 'file';
  transport: TelegramStatus | null;
}

// SPEC-039 wire contract, owned by Runtime; no provider protocol details.
/** Host-facing interaction contract. Native provider request IDs stay in the adapter. */
export const INTERACTION_KINDS = [
  'command_approval', 'file_approval', 'tool_approval', 'permission_grant', 'user_input', 'mcp_form', 'mcp_url',
] as const;
export type InteractionKind = (typeof INTERACTION_KINDS)[number];
export type InteractionStatus = 'pending' | 'responding' | 'resolved' | 'expired'
  | 'cancelled' | 'interrupted' | 'unsupported';

export interface InteractionHost {
  version: 1;
  kinds: InteractionKind[];
  timeoutMs: number;
}

export interface InteractionOption {
  id: string;
  label: string;
  description?: string;
}

export interface InteractionField {
  id: string;
  label: string;
  description?: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'strings';
  required: boolean;
  secret?: boolean;
  options?: InteractionOption[];
  allowOther?: boolean;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
}

export interface InteractionPrompt {
  kind: InteractionKind;
  title: string;
  message?: string;
  command?: string;
  cwd?: string;
  server?: string;
  url?: string;
  choices?: InteractionOption[];
  fields?: InteractionField[];
  /** Provider-normalized permission units. Granting one never grants another unit. */
  permissions?: InteractionOption[];
  scopes?: ('turn' | 'session')[];
}

export interface ProviderInteraction {
  interactionId: string;
  sessionId: string;
  workerGeneration: string;
  executionId: string;
  revision: number;
  createdAt: string;
  expiresAt: string;
  status: InteractionStatus;
  prompt?: InteractionPrompt;
  /** Terminal receipts retain the kind, but discard prompt and answer contents. */
  kind: InteractionKind;
  reason?: string;
  decision?: InteractionAnswer['action'];
  providerConfirmed?: boolean;
}

export interface InteractionAnswer {
  action: 'accept' | 'decline' | 'cancel';
  choice?: string;
  values?: Record<string, string | number | boolean | string[]>;
  grants?: string[];
  scope?: 'turn' | 'session';
}

export interface InteractionResponse {
  expectedRevision: number;
  idempotencyKey: string;
  answer: InteractionAnswer;
}

export interface InteractionSnapshot {
  version: 1;
  sessionId: string;
  workerGeneration: string | null;
  revision: number;
  interactions: ProviderInteraction[];
}

export type ExecutionAccess = 'read-only' | 'workspace-write' | 'full-access';
export type ExecutionApproval = 'never' | 'untrusted' | 'on-request';
export type SessionExecutionPolicy = { version: 1; mode: 'provider';
  constraints: { maxAccess: ExecutionAccess; network: boolean } }
  | { version: 1; mode: 'explicit'; access: ExecutionAccess; network: boolean; approval: ExecutionApproval };

export interface EffectiveExecutionPolicy {
  requested?: SessionExecutionPolicy;
  source: 'legacy' | 'provider' | 'explicit';
  status: 'not_observed' | 'verified' | 'mismatch' | 'unsupported';
  observed?: { access: ExecutionAccess; network: boolean; approval: string; reviewer: string };
  coverage: 'local-process-only';
  reason?: string;
  configurationSources: string[];
}

export interface SessionToolServer {
  name: string;
  source: 'provider-configured' | 'session-injected';
  connection: 'notStarted' | 'starting' | 'connected' | 'authenticationRequired' | 'failed' | 'cancelled' | 'disabled' | 'unknown';
  /** An unsupported auth mechanism does not imply unsupported tools. */
  auth: 'unknown' | 'unsupported' | 'notLoggedIn' | 'bearerToken' | 'oAuth';
  tools: Array<{ name: string; qualifiedName: string }>;
  discovery: 'advertised' | 'failed' | 'truncated';
  invocation: 'not_verified';
}

export interface SessionToolInventory {
  state: 'not_observed' | 'observed' | 'partial' | 'unavailable';
  observedAt: string | null;
  stale: boolean;
  /** Top-level discovery cannot enumerate tools lazily exposed inside code-mode hosts. */
  coverage: 'top-level-mcp';
  pages: number;
  servers: SessionToolServer[];
  dynamicTools: Array<{ name: string; source: 'runtime-dynamic' }>;
  /** Built-in provider tools, once the provider reports them. */
  builtins: 'not_exposed_by_provider' | 'not_observed' | 'observed';
  builtinTools?: string[];
  reason?: string;
}

export interface ProviderSessionCapabilities {
  interactions: { version: 1; supported: InteractionKind[]; host?: InteractionHost };
  policy: EffectiveExecutionPolicy;
  inventory: SessionToolInventory;
  dependencies: Array<{ kind: 'computer_use' | 'browser'; status: 'available' | 'unavailable' | 'unknown';
    evidence: string; remediation: string }>;
}

export interface SessionCapabilitiesSnapshot {
  version: 1;
  sessionId: string;
  workerGeneration: string | null;
  supported: boolean;
  observation?: ProviderSessionCapabilities;
  reason?: string;
  /** SPEC-006 BDC-13: added by the Bot, separate from the provider-native `computer_use` dependency. */
  desktopControl?: DesktopControlCapability;
}

// ---- SPEC-006 / SPEC-133 desktop control (Bot-owned) -----------------------

/** SPEC-133 DC-18 state values; `holding` takes precedence over `active_turn` while an input tool holds control. */
export type DesktopControlStatus = 'unavailable' | 'off' | 'not_injected' | 'injected' | 'active_turn' | 'holding';

export interface DesktopControlCapability {
  name: 'Cats desktop control';
  status: DesktopControlStatus;
  /** Why the status is not `injected`, `active_turn` or `holding`; null otherwise. */
  reason: string | null;
}

/** A conversation whose running turn holds control, and the app it operates (SPEC-133 DC-11). */
export interface DesktopControlHolding {
  conversationId: string;
  app: string;
}

export type DesktopGrantDecision = 'allow' | 'deny';
export type DesktopAppTier = 'full' | 'observe_only';

/** An app the owner granted; matched on executable path plus signing publisher (SPEC-133 DC-09). */
export interface DesktopGrantedApp {
  name: string;
  path: string;
  publisher: string | null;
  tier: DesktopAppTier;
}

/** A grant request waiting for the owner (SPEC-133 DC-08). */
export interface DesktopGrantRequest extends DesktopGrantedApp {
  requestId: string;
  query: string;
  reason: string;
  createdAt: string;
  expiresAt: string;
}

export interface DesktopControlState {
  available: boolean;
  /** Why desktop control is unavailable; null when it is available. */
  reason: string | null;
  /** The profile switch (BDC-02). */
  enabled: boolean;
  /** Conversations whose switch is on (BDC-03). */
  conversations: string[];
  /** Grant requests waiting across every conversation. */
  pendingRequests: number;
  /** Conversations that hold control now (BDC-10: the tray shows them). */
  holding: DesktopControlHolding[];
  conversation?: {
    conversationId: string;
    enabled: boolean;
    capability: DesktopControlCapability;
    stopped: boolean;
    /** The app this conversation's turn holds control of; null when it holds none (BDC-10: the note's banner). */
    holding: string | null;
    grants: DesktopGrantedApp[];
    pendingRequests: DesktopGrantRequest[];
  };
}

export interface BotInteraction extends ProviderInteraction {
  botId: string;
  conversationId: string;
  workItemId: string;
}
export interface BotInteractionSnapshot {
  version: 1;
  supported: boolean;
  reason?: string;
  interactions: BotInteraction[];
}
export interface BotInteractionResponse extends InteractionResponse {
  workerGeneration: string;
  executionId: string;
  workItemId: string;
}
