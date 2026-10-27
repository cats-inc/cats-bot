/**
 * Contract types of the bot core, named after SPEC-001. Everything persisted
 * under the bot data root carries a `schemaVersion`; the shapes here are the
 * in-memory view of those files plus the `BotHostApi` the shell speaks.
 */

/** SPEC-001 FR-1: the one global provider/model of a bot. */
export interface ExecutionTarget {
  provider: string;
  model: string | null;
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

/** SPEC-001 FR-1. */
export interface BotProfile {
  schemaVersion: 1;
  id: string;
  name: string;
  instructions: string;
  executionTarget: ExecutionTarget;
  configRevision: number;
  permissions: BotPermissions;
  heartbeat: HeartbeatPolicy;
  idleSleepMinutes: number;
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

export type MessageOrigin = 'owner' | 'heartbeat' | 'schedule' | 'event' | 'system';

/** One line of `transcripts/<conversationId>.jsonl`. */
export interface TranscriptEntry {
  seq: number;
  at: string;
  kind: TranscriptEntryKind;
  text: string;
  origin: MessageOrigin;
  workItemId?: string;
  toolName?: string;
  toolId?: string;
  isError?: boolean;
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
  result?: WorkItemResult;
  notification?: NotificationState;
  /** The provider/model/session the run actually used (ADR-001 §3 evidence). */
  run?: { provider: string; model: string | null; sessionId: string };
  error?: string;
  updatedAt: string;
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
  | { type: 'config'; at: string; configRevision: number; executionTarget: ExecutionTarget };

export type RuntimeState = 'stopped' | 'starting' | 'ready' | 'failed';

/** SPEC-001 FR-3: what a second instance of the same bot hands to the running one. */
export interface HandoffMessage {
  id: string;
  at: string;
  kind: 'open' | 'say' | 'args';
  conversationId?: string;
  text?: string;
  args?: string[];
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
  sendOwnerMessage(conversationId: string, text: string): Promise<WorkItem>;
  cancelTurn(conversationId: string): Promise<void>;
  markSeen(conversationId: string): Promise<void>;
  listSchedules(): Promise<ScheduleRecord[]>;
  cancelSchedule(scheduleId: string): Promise<void>;
  resolveApproval(workItemId: string, decision: 'approve' | 'deny'): Promise<void>;
  quit(): Promise<void>;
}

export interface BotProfilePatch {
  name?: string;
  instructions?: string;
  executionTarget?: ExecutionTarget;
  heartbeat?: Partial<HeartbeatPolicy>;
  idleSleepMinutes?: number;
  permissions?: Partial<BotPermissions>;
}

/** SPEC-001 FR-32 events. The renderer never receives runtime URLs or keys. */
export type BotHostEvent =
  | { type: 'conversation.updated'; conversation: ConversationRecord }
  | { type: 'turn.delta'; conversationId: string; workItemId: string; entry: TranscriptEntry }
  | { type: 'turn.completed'; conversationId: string; workItem: WorkItem }
  | { type: 'work.updated'; workItem: WorkItem }
  | { type: 'work.awaitingOwner'; workItem: WorkItem }
  | { type: 'presence.changed'; conversationId: string; presence: PresenceState; reason: PresenceReason }
  | { type: 'runtime.status'; state: RuntimeState; detail?: string }
  | { type: 'host.handoff'; message: HandoffMessage };
