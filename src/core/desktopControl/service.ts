import { randomBytes, timingSafeEqual } from 'node:crypto';
import { basename } from 'node:path';

import type { RuntimeMcpServer } from '../runtime/client.ts';
import { BotToolServer, type ToolCallResult } from '../tools/server.ts';
import type {
  DesktopAppTier,
  DesktopControlCapability,
  DesktopControlHolding,
  DesktopControlState,
  DesktopGrantDecision,
  DesktopGrantedApp,
  DesktopGrantRequest,
  SessionCapabilitiesSnapshot,
} from '../types.ts';
import { DesktopControlHelperError, type DesktopControlHelperClient } from './helper.ts';
import type { DesktopLease } from './lease.ts';
import { evaluateDesktopControlPolicy } from './policy.ts';
import type { DesktopControlSwitches } from './switches.ts';
import {
  DESKTOP_CONTROL_ERROR_CODES,
  DESKTOP_CONTROL_INSTRUCTIONS,
  DESKTOP_CONTROL_SERVER_NAME,
  DESKTOP_CONTROL_TOOLS,
  DesktopControlToolError,
  parseClick,
  parseClipboardWrite,
  parseInvokeElement,
  parseKey,
  parseNoArgs,
  parseOpenApp,
  parseReadUi,
  parseRequestAppAccess,
  parseScreenshot,
  parseScroll,
  parseTypeText,
  type DesktopControlErrorCode,
} from './tools.ts';

/**
 * SPEC-006: the Bot's `cats-desktop` session MCP, beside `cats-bot` (BDC-06). The core asks
 * `refresh` before every send of a conversation; a conversation that qualifies (BDC-01 to
 * BDC-04) gets a stable descriptor with a token of its own, and the tools serve only while the
 * core runs an owner message the owner sent locally in that conversation's session (BDC-05).
 * Apps are granted only by the owner through `decide` (BDC-07), kept in memory only. The first
 * input action of a turn holds control until the core reports the turn's end (SPEC-133 DC-11).
 * Screenshots, UI values, window titles, typed text and clipboard content are never logged or
 * stored (BDC-12).
 *
 * The tool names, schemas, results, error codes and the grant, turn, hold and stop rules follow
 * Platform SPEC-133's cross-implementation contract, including its "Phase B server rules";
 * nothing here is imported from Platform.
 */

const GRANT_WAIT_MS = 60_000;
const REQUEST_TTL_MS = 10 * 60_000;
const MAX_PENDING_PER_CONVERSATION = 5;
const SNAPSHOT_TTL_MS = 60_000;
const MAX_SNAPSHOTS = 20;
/** The helper keeps its last 8 UI reads, so older element ids cannot be resolved anyway. */
const MAX_READS = 8;
const OPERATOR_QUIET_MS = 3_000;
/** Helper call timeouts: typing sends 2000 characters in chunks, so it may take a while. */
const TYPE_TIMEOUT_MS = 180_000;
const INPUT_TIMEOUT_MS = 30_000;
const CLIPBOARD_TIMEOUT_MS = 10_000;
/** BDC-08: Cats Desktop and the Bot itself, refused by file name wherever they are installed. */
const NEVER_GRANTABLE_NAMES = ['cats.exe', 'cats bot.exe'];

/** The running work item of a conversation, as the core sees it at tool-call time. */
export interface DesktopControlTurn {
  sessionId: string | null;
  /** The running work item; control held in it ends with it (SPEC-133 DC-11). */
  workItemId: string;
  /** BDC-05: `kind: 'owner_message'` with `source: 'owner'`, still running. */
  ownerPresent: boolean;
}

export interface DesktopControlChange {
  conversationId: string | null;
  pendingRequests: number;
  /** Whether the conversation (or, without one, any conversation) holds control (SPEC-133 DC-11). */
  holding: boolean;
  /** A new grant request is waiting for the owner. */
  notify?: boolean;
}

export interface DesktopControlServiceOptions {
  /** null when this host cannot run the helper (BDC-01). */
  helper: DesktopControlHelperClient | null;
  /** SPEC-008 FR-26: the account's desktop lease, taken before control and clipboard calls. */
  lease?: DesktopLease;
  unavailableReason: string | null;
  switches: DesktopControlSwitches;
  /** The profile switch (BDC-02). */
  profileEnabled(): boolean;
  /** Runtime's capability snapshot for a session; null when it cannot be read. */
  capabilities(sessionId: string): Promise<SessionCapabilitiesSnapshot | null>;
  /** The conversation's running turn; null when none runs. */
  turn(conversationId: string): DesktopControlTurn | null;
  changed(change: DesktopControlChange): void;
  log(line: string): void;
  serverVersion: string;
  /** BDC-08: executables this Bot never grants (its own; Cats Desktop's install paths). */
  selfExecutables?: string[];
  now?(): number;
  /** How long `request_app_access` waits for the owner; tests shorten it. */
  grantWaitMs?: number;
  /** How long an unanswered grant request stays open; tests shorten it. */
  requestTtlMs?: number;
}

interface GrantedApp extends DesktopGrantedApp {
  appId: string;
  aumid: string | null;
}

interface Candidate {
  path: string;
  publisher: string | null;
  productName: string;
  displayName: string;
  running?: boolean;
  category: string;
  aumid?: string | null;
}

interface HelperWindow {
  hwnd: number;
  pid?: number;
  path: string;
  title: string;
  bounds: unknown;
  minimized: boolean;
  foreground: boolean;
}

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What a `screenshot_window` result fixes for `click` and `scroll` (SPEC-133 "Phase B server rules"). */
interface Snapshot {
  windowId: string;
  hwnd: number;
  /** The window's frame at capture time; the helper refuses a window that moved since. */
  bounds: Bounds;
  scale: number;
  width: number;
  height: number;
  capturedAt: number;
}

/** One conversation's descriptor for one runtime session; grants are scoped to it (SPEC-133 DC-09). */
interface Attachment {
  conversationId: string;
  sessionId: string;
  token: string;
  apps: Map<string, GrantedApp>;
  windows: Map<string, number>;
  windowIdsByHwnd: Map<number, string>;
  reads: number;
  snapshots: Map<string, Snapshot>;
  /** `read_ui` id prefix (`ui<n>`) to the helper read it came from. */
  uiReads: Map<string, { windowId: string; hwnd: number; readId: number }>;
  /** The app the running turn holds control of, and that turn (DC-11). */
  holding: { app: string; workItemId: string; } | null;
  /** Input ops sent to the helper and not answered yet; they may outlive a cancelled turn. */
  inputsInFlight: number;
}

interface GrantRequest {
  requestId: string;
  conversationId: string;
  attachment: Attachment;
  query: string;
  candidate: Candidate;
  tier: DesktopAppTier;
  reason: string;
  createdAt: string;
  expiresAt: string;
  decided: Promise<DesktopGrantDecision>;
  settle(decision: DesktopGrantDecision): void;
}

const opaque = (prefix: string) => `${prefix}_${randomBytes(9).toString('base64url')}`;

function toolError(code: DesktopControlErrorCode, message: string): ToolCallResult {
  return { text: `${code}: ${message}`, isError: true, structuredContent: { error: { code, message } } };
}

function toolResult(value: Record<string, unknown>, summary: string): ToolCallResult {
  return { text: summary, structuredContent: value };
}

/** Helper codes that are also tool codes pass through; the helper-only ones map per SPEC-133. */
function mapHelperError(error: unknown): DesktopControlToolError {
  if (error instanceof DesktopControlToolError) return error;
  if (!(error instanceof DesktopControlHelperError)) return new DesktopControlToolError('unavailable', 'Desktop control failed.');
  const code: DesktopControlErrorCode =
    error.code === 'window_gone'
      ? 'window_changed'
      : error.code === 'not_found'
        ? 'not_granted'
        : (DESKTOP_CONTROL_ERROR_CODES as readonly string[]).includes(error.code)
          ? (error.code as DesktopControlErrorCode)
          : 'unavailable';
  return new DesktopControlToolError(code, error.message);
}

/** Keeps the newest `max` entries of a map. */
function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value as K);
}

const STOPPED_MESSAGE = 'The owner stopped desktop control; ask for access again.';

function sameToken(expected: string, offered: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(offered);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class DesktopControlService {
  private readonly options: DesktopControlServiceOptions;
  private readonly now: () => number;
  private readonly server: BotToolServer | null;
  private readonly attachments = new Map<string, Attachment>();
  private readonly requests = new Map<string, GrantRequest>();
  private readonly expiries = new Map<string, NodeJS.Timeout>();
  /** SPEC-133 DC-12: stopped conversations refuse every tool but `request_app_access` until a new grant. */
  private readonly stopped = new Set<string>();
  /** Bumped by stop and revocation, so a helper answer that arrives afterwards is discarded. */
  private readonly generations = new Map<string, number>();
  private readonly lastReason = new Map<string, string>();
  private neverGrantablePaths: Set<string>;
  /** The turn that holds the desktop lease; it keeps it until it ends (FR-26). */
  private leased: { conversationId: string; workItemId: string } | null = null;
  private closed = false;

  constructor(options: DesktopControlServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.neverGrantablePaths = new Set((options.selfExecutables ?? []).map((path) => path.toLowerCase()));
    this.server = options.helper === null ? null : new BotToolServer({
      name: DESKTOP_CONTROL_SERVER_NAME,
      serverVersion: options.serverVersion,
      instructions: DESKTOP_CONTROL_INSTRUCTIONS,
      maxBodyBytes: 16 * 1024,
      authorize: (conversationId, token) => {
        const attachment = this.attachments.get(conversationId);
        return !this.closed && attachment !== undefined && sameToken(attachment.token, token);
      },
      handlers: {
        list: () => DESKTOP_CONTROL_TOOLS,
        call: (name, args, context) => this.callTool(name, args, context.conversationId),
      },
    });
  }

  /**
   * SPEC-008 FR-21: the hosts attached to the core are never grantable either,
   * and the helper learns of them before it serves another call.
   */
  setHosts(hosts: ReadonlyArray<{ pid: number; executable: string }>): void {
    const executables = hosts.map((host) => host.executable).filter(Boolean);
    this.neverGrantablePaths = new Set([...(this.options.selfExecutables ?? []), ...executables].map((path) => path.toLowerCase()));
    this.options.helper?.setHosts(hosts.map((host) => host.pid), executables);
  }

  /** Why desktop control cannot be used at all; null while it can (BDC-01). */
  unavailable(): string | null {
    if (this.closed) return 'closed';
    if (!this.options.helper) return this.options.unavailableReason ?? 'unavailable';
    return this.options.helper.unavailableReason();
  }

  // ---- injection (BDC-04) -------------------------------------------------

  /**
   * Re-decides, before a send, whether the conversation's session carries `cats-desktop`.
   * A conversation that stops qualifying, or moves to another session, loses its descriptor,
   * its token and its grants.
   */
  async refresh(conversationId: string, sessionId: string): Promise<void> {
    const reason = await this.ineligible(conversationId, sessionId);
    const current = this.attachments.get(conversationId);
    if (reason) {
      this.lastReason.set(conversationId, reason);
      if (current) this.revoke(conversationId, 'desktop control no longer applies');
      return;
    }
    this.lastReason.delete(conversationId);
    if (current?.sessionId === sessionId) return;
    if (current) this.revoke(conversationId, 'the conversation moved to a new session');
    this.attachments.set(conversationId, {
      conversationId, sessionId, token: randomBytes(24).toString('base64url'), apps: new Map(), windows: new Map(),
      windowIdsByHwnd: new Map(), reads: 0, snapshots: new Map(), uiReads: new Map(), holding: null, inputsInFlight: 0,
    });
    this.options.log(`desktop control injected into conversation ${conversationId}`);
    this.emit(conversationId);
  }

  private async ineligible(conversationId: string, sessionId: string): Promise<string | null> {
    const unavailable = this.unavailable();
    if (unavailable) return unavailable;
    if (!this.options.profileEnabled()) return 'off';
    if (!this.options.switches.isEnabled(conversationId)) return 'conversation_off';
    const verdict = evaluateDesktopControlPolicy(await this.options.capabilities(sessionId).catch(() => null));
    if (!verdict.ok) return verdict.reason;
    try {
      await this.options.helper!.handshake();
    } catch {
      return this.options.helper!.unavailableReason() ?? 'helper_failed';
    }
    // The listener opens with the first qualifying session, so a Bot that never uses the feature has none.
    try {
      await this.server!.start();
    } catch {
      return 'server_failed';
    }
    if (this.closed) return 'closed';
    // The owner may have switched it off while this was being decided.
    if (!this.options.profileEnabled() || !this.options.switches.isEnabled(conversationId)) return 'off';
    return null;
  }

  /** Whether the conversation's session currently carries the descriptor. */
  isAttached(conversationId: string, sessionId: string | null): boolean {
    return sessionId !== null && this.attachments.get(conversationId)?.sessionId === sessionId;
  }

  /** The descriptor for a session that qualifies; stable across turns (BDC-05). */
  descriptorFor(conversationId: string, sessionId: string | null): RuntimeMcpServer[] {
    const attachment = this.attachments.get(conversationId);
    if (!this.server || !attachment || sessionId === null || attachment.sessionId !== sessionId) return [];
    return this.server.descriptorFor(conversationId, attachment.token);
  }

  // ---- global gate (BDC-09) ----------------------------------------------

  pendingRequests(conversationId?: string): number {
    let count = 0;
    for (const request of this.requests.values()) if (!conversationId || request.conversationId === conversationId) count += 1;
    return count;
  }

  // ---- owner actions -------------------------------------------------------

  /** BDC-02: the profile switch changed. Turning it off revokes everything and ends the helper. */
  profileChanged(enabled: boolean): void {
    if (enabled) {
      this.emit(null);
      return;
    }
    for (const conversationId of [...this.attachments.keys()]) this.revoke(conversationId, 'desktop control turned off');
    this.denyPending(() => true);
    this.stopped.clear();
    this.options.helper?.reset();
    this.options.log('desktop control turned off; grants revoked and the helper ended');
    this.emit(null);
  }

  /** BDC-03. */
  setConversation(conversationId: string, enabled: boolean): void {
    this.options.switches.set(conversationId, enabled);
    if (!enabled) {
      this.revoke(conversationId, 'desktop control turned off for the conversation');
      this.stopped.delete(conversationId);
    }
    this.options.log(`desktop control ${enabled ? 'enabled' : 'disabled'} for conversation ${conversationId}`);
    this.emit(conversationId);
  }

  /** The conversation was deleted. */
  forget(conversationId: string): void {
    this.revoke(conversationId, 'conversation deleted');
    this.stopped.delete(conversationId);
    this.lastReason.delete(conversationId);
    if (this.options.switches.isEnabled(conversationId)) this.options.switches.set(conversationId, false);
  }

  /** BDC-07: false when the request is unknown, already answered or belongs to another conversation. */
  decide(conversationId: string, requestId: string, decision: DesktopGrantDecision): boolean {
    const request = this.requests.get(requestId);
    if (!request || request.conversationId !== conversationId) return false;
    request.settle(decision);
    return true;
  }

  /**
   * SPEC-133 DC-12: revoke grants, release control, cancel what is in progress; later calls
   * return `stopped`. The helper's `cancel` is global, so it is sent only when a stopped
   * conversation held control or still has input in progress.
   */
  stop(conversationId?: string): void {
    const conversations = conversationId ? [conversationId]
      : [...new Set([...this.attachments.keys(), ...[...this.requests.values()].map((request) => request.conversationId)])];
    let held = false;
    for (const id of conversations) {
      this.stopped.add(id);
      this.bump(id);
      this.denyPending((request) => request.conversationId === id);
      const attachment = this.attachments.get(id);
      if (attachment) {
        held ||= attachment.holding !== null || attachment.inputsInFlight > 0;
        attachment.holding = null;
        attachment.apps.clear();
        attachment.windows.clear();
        attachment.windowIdsByHwnd.clear();
        attachment.snapshots.clear();
        attachment.uiReads.clear();
      }
      this.options.log(`desktop control stopped in conversation ${id}`);
      this.emit(id);
    }
    if (this.leased && conversations.includes(this.leased.conversationId)) this.releaseLease();
    if (held) this.cancelHelper();
  }

  /**
   * SPEC-133 DC-11: the end of the work item releases the control it held. A turn that ends
   * while its input still runs (the owner cancelled it) cancels that input too: the queue runs
   * one turn at a time, so the global `cancel` reaches only this conversation's op.
   */
  turnEnded(conversationId: string, workItemId: string): void {
    if (this.leased?.workItemId === workItemId) this.releaseLease();
    const attachment = this.attachments.get(conversationId);
    if (!attachment?.holding || attachment.holding.workItemId !== workItemId) return;
    attachment.holding = null;
    if (attachment.inputsInFlight > 0) this.cancelHelper();
    this.options.log(`desktop control released in conversation ${conversationId}: the turn ended`);
    this.emit(conversationId);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.releaseLease();
    for (const conversationId of [...this.attachments.keys()]) this.revoke(conversationId, 'core stopped');
    this.denyPending(() => true);
    this.options.helper?.close();
  }

  async stopServer(): Promise<void> {
    await this.server?.stop();
  }

  // ---- state and capability (BDC-07, BDC-13) ---------------------------------

  /** SPEC-133 DC-18 for one conversation's session; a snapshot refines the not-injected reason. */
  capability(conversationId: string, sessionId: string | null, snapshot?: SessionCapabilitiesSnapshot): DesktopControlCapability {
    const entry = (status: DesktopControlCapability['status'], reason: string | null): DesktopControlCapability =>
      ({ name: 'Cats desktop control', status, reason });
    const unavailable = this.unavailable();
    if (unavailable) return entry('unavailable', unavailable);
    if (!this.options.profileEnabled()) return entry('off', 'off');
    if (!this.options.switches.isEnabled(conversationId)) return entry('off', 'conversation_off');
    const attachment = this.attachments.get(conversationId);
    if (attachment && sessionId !== null && attachment.sessionId === sessionId) {
      if (this.holdingApp(attachment)) return entry('holding', null);
      const turn = this.options.turn(conversationId);
      return turn?.ownerPresent && turn.sessionId === attachment.sessionId ? entry('active_turn', null) : entry('injected', null);
    }
    if (sessionId === null) return entry('not_injected', 'no_live_session');
    if (snapshot) {
      const verdict = evaluateDesktopControlPolicy(snapshot);
      return entry('not_injected', verdict.ok ? 'no_turn_yet' : verdict.reason);
    }
    return entry('not_injected', this.lastReason.get(conversationId) ?? 'no_turn_yet');
  }

  state(conversationId?: string, sessionId: string | null = null): DesktopControlState {
    const reason = this.unavailable();
    const result: DesktopControlState = {
      available: reason === null,
      reason,
      enabled: this.options.profileEnabled(),
      conversations: this.options.switches.list(),
      pendingRequests: this.requests.size,
      holding: this.holding(),
    };
    if (conversationId) {
      const attachment = this.attachments.get(conversationId);
      result.conversation = {
        conversationId,
        enabled: this.options.switches.isEnabled(conversationId),
        capability: this.capability(conversationId, sessionId),
        stopped: this.stopped.has(conversationId),
        holding: attachment ? this.holdingApp(attachment) : null,
        grants: [...(attachment?.apps.values() ?? [])].map(({ name, path, publisher, tier }) => ({ name, path, publisher, tier })),
        pendingRequests: [...this.requests.values()].filter((row) => row.conversationId === conversationId).map((row) => ({
          requestId: row.requestId, query: row.query, name: row.candidate.displayName, path: row.candidate.path,
          publisher: row.candidate.publisher, tier: row.tier, reason: row.reason, createdAt: row.createdAt, expiresAt: row.expiresAt,
        }) satisfies DesktopGrantRequest),
      };
    }
    return result;
  }

  /** Conversations whose running turn holds control, with the app, for the tray (BDC-10). */
  holding(): DesktopControlHolding[] {
    return [...this.attachments.values()].flatMap((attachment) => {
      const app = this.holdingApp(attachment);
      return app ? [{ conversationId: attachment.conversationId, app }] : [];
    });
  }

  // ---- internals -----------------------------------------------------------

  private emit(conversationId: string | null, notify = false): void {
    const attachment = conversationId ? this.attachments.get(conversationId) : undefined;
    this.options.changed({
      conversationId,
      pendingRequests: conversationId ? this.pendingRequests(conversationId) : this.requests.size,
      holding: conversationId ? attachment !== undefined && this.holdingApp(attachment) !== null : this.holding().length > 0,
      ...(notify ? { notify: true } : {}),
    });
  }

  /** The held app while the turn that took control still runs in the attachment's session. */
  private holdingApp(attachment: Attachment): string | null {
    const holding = attachment.holding;
    if (!holding) return null;
    const turn = this.options.turn(attachment.conversationId);
    return turn?.ownerPresent && turn.sessionId === attachment.sessionId && turn.workItemId === holding.workItemId
      ? holding.app : null;
  }

  /** The helper's cancel is global; callers send it only for a conversation that held control. */
  private cancelHelper(): void {
    // Closing ends the helper itself.
    if (this.closed) return;
    this.options.helper?.call('cancel', {}, 5_000).catch(() => undefined);
  }

  private bump(conversationId: string): void {
    this.generations.set(conversationId, (this.generations.get(conversationId) ?? 0) + 1);
  }

  private revoke(conversationId: string, why: string): void {
    const attachment = this.attachments.get(conversationId);
    this.bump(conversationId);
    if (attachment) {
      this.attachments.delete(conversationId);
      this.options.log(`desktop control revoked in conversation ${conversationId}: ${why}`);
      // Revoking a conversation that holds control also ends the input in progress (DC-03, DC-11).
      if (attachment.holding || attachment.inputsInFlight > 0) this.cancelHelper();
    }
    this.denyPending((request) => request.conversationId === conversationId);
    this.emit(conversationId);
  }

  private denyPending(predicate: (request: GrantRequest) => boolean): void {
    for (const request of [...this.requests.values()]) if (predicate(request)) request.settle('deny');
  }

  private neverGrantable(path: string): boolean {
    return (
      NEVER_GRANTABLE_NAMES.includes(basename(path.replaceAll('\\', '/')).toLowerCase()) ||
      this.neverGrantablePaths.has(path.toLowerCase())
    );
  }

  private requireTurn(attachment: Attachment): void {
    if (this.closed) throw new DesktopControlToolError('unavailable', 'Desktop control is closed.');
    const turn = this.options.turn(attachment.conversationId);
    if (!turn?.ownerPresent || turn.sessionId !== attachment.sessionId) {
      throw new DesktopControlToolError(
        'not_owner_present',
        'Desktop tools work only in a turn the owner sent from the Bot conversation or the local command line.',
      );
    }
    const reason = this.unavailable();
    if (reason) throw new DesktopControlToolError('unavailable', `Desktop control is unavailable (${reason}).`);
  }

  /** Read before every call; input tools also use its `operatorIdleMs` (SPEC-133 "Phase B helper rules"). */
  private async requireUnlocked(): Promise<{ locked: boolean; operatorIdleMs?: number }> {
    const state = await this.options.helper!.call<{ locked: boolean; operatorIdleMs?: number }>('state', {}, 5_000);
    if (state.locked) throw new DesktopControlToolError('locked', 'The screen is locked.');
    return state;
  }

  private async listGranted(attachment: Attachment): Promise<Array<HelperWindow & { app: GrantedApp }>> {
    const apps = [...attachment.apps.values()];
    if (!apps.length) return [];
    const { windows } = await this.options.helper!.call<{ windows: HelperWindow[] }>(
      'list_windows', { paths: apps.map((app) => app.path) });
    return windows.flatMap((window) => {
      if (this.neverGrantable(window.path)) return [];
      const app = apps.find((row) => row.path.toLowerCase() === window.path.toLowerCase());
      return app ? [{ ...window, app }] : [];
    });
  }

  private async grantedWindow(attachment: Attachment, windowId: string): Promise<{ hwnd: number; app: GrantedApp }> {
    const hwnd = attachment.windows.get(windowId);
    if (hwnd === undefined) throw new DesktopControlToolError('window_changed', 'Unknown windowId; call list_windows again.');
    const window = (await this.listGranted(attachment)).find((row) => row.hwnd === hwnd);
    if (!window) throw new DesktopControlToolError('window_changed', 'That window is gone or no longer granted; call list_windows again.');
    return { hwnd, app: window.app };
  }

  /**
   * SPEC-133 R5 and "Phase B server rules": after the turn, stop and lock checks, the window
   * must still be granted, its app must have tier `full`, and the owner must have been idle
   * for 3 seconds in the `state` read just before. Only then does the turn hold control.
   */
  private async inputTarget(attachment: Attachment, windowId: string, operatorIdleMs: number | undefined,
    generation: number): Promise<{ hwnd: number; app: GrantedApp }> {
    const target = await this.grantedWindow(attachment, windowId);
    if (target.app.tier === 'observe_only') {
      throw new DesktopControlToolError('observe_only', `${target.app.name} is granted for observing only.`);
    }
    if (typeof operatorIdleMs === 'number' && operatorIdleMs >= 0 && operatorIdleMs < OPERATOR_QUIET_MS) {
      throw new DesktopControlToolError('operator_active', 'The owner is using the computer right now.');
    }
    await this.takeLease(attachment);
    // A stop while the window was being checked sends nothing.
    if (this.generation(attachment.conversationId) !== generation || this.attachments.get(attachment.conversationId) !== attachment) {
      throw new DesktopControlToolError('stopped', STOPPED_MESSAGE);
    }
    this.hold(attachment, target.app.name);
    return target;
  }

  /**
   * SPEC-008 FR-26: before control or a clipboard call the turn takes the
   * account's desktop lease, and keeps it until it ends, is stopped or the
   * core stops. Another bot holding it makes the call unavailable.
   */
  private async takeLease(attachment: Attachment): Promise<void> {
    const lease = this.options.lease;
    const turn = this.options.turn(attachment.conversationId);
    if (!lease || !turn) return;
    if (!(await lease.acquire())) {
      throw new DesktopControlToolError('unavailable', 'Another bot is using the desktop right now.');
    }
    this.leased = { conversationId: attachment.conversationId, workItemId: turn.workItemId };
  }

  private releaseLease(): void {
    if (!this.leased) return;
    this.leased = null;
    this.options.lease?.release();
  }

  private hold(attachment: Attachment, app: string): void {
    const turn = this.options.turn(attachment.conversationId);
    if (!turn) return;
    const previous = attachment.holding;
    attachment.holding = { app, workItemId: turn.workItemId };
    if (previous?.app === app && previous.workItemId === turn.workItemId) return;
    this.options.log(`desktop control held in conversation ${attachment.conversationId}`);
    this.emit(attachment.conversationId);
  }

  /** Screenshot pixels to screen pixels, with the snapshot's own capture-time bounds and scale. */
  private snapshotPoint(attachment: Attachment, snapshotId: string, x: number, y: number): { snapshot: Snapshot; x: number; y: number } {
    const snapshot = attachment.snapshots.get(snapshotId);
    if (!snapshot || this.now() - snapshot.capturedAt > SNAPSHOT_TTL_MS) {
      throw new DesktopControlToolError('stale_snapshot', 'That screenshot is unknown or older than 60 seconds; take a new one.');
    }
    if (x >= snapshot.width || y >= snapshot.height) {
      throw new DesktopControlToolError('stale_snapshot', 'That point is outside the screenshot; take a new one.');
    }
    return { snapshot, x: snapshot.bounds.x + Math.round(x / snapshot.scale), y: snapshot.bounds.y + Math.round(y / snapshot.scale) };
  }

  private generation(conversationId: string): number {
    return this.generations.get(conversationId) ?? 0;
  }

  /** Sends one input op, counting it while the helper works on it. */
  private async sendInput(attachment: Attachment, op: string, params: Record<string, unknown>, timeoutMs: number): Promise<void> {
    attachment.inputsInFlight += 1;
    try {
      await this.options.helper!.call(op, params, timeoutMs);
    } finally {
      attachment.inputsInFlight -= 1;
    }
  }

  /** A grant request only the owner answers; denied when unanswered after the TTL (SPEC-133 DC-08). */
  private openRequest(attachment: Attachment, query: string, candidate: Candidate, reason: string, tier: DesktopAppTier): GrantRequest {
    const requestId = opaque('grant');
    let resolveDecision!: (decision: DesktopGrantDecision) => void;
    const decided = new Promise<DesktopGrantDecision>((resolve) => { resolveDecision = resolve; });
    const ttl = this.options.requestTtlMs ?? REQUEST_TTL_MS;
    const request: GrantRequest = {
      requestId, conversationId: attachment.conversationId, attachment, query, candidate, tier, reason,
      createdAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + ttl).toISOString(), decided,
      settle: (decision) => {
        if (!this.requests.delete(requestId)) return;
        const expiry = this.expiries.get(requestId);
        if (expiry) clearTimeout(expiry);
        this.expiries.delete(requestId);
        if (decision === 'allow' && this.attachments.get(attachment.conversationId) === attachment) {
          const appId = opaque('app');
          attachment.apps.set(appId, { appId, path: candidate.path, publisher: candidate.publisher, aumid: candidate.aumid ?? null,
            name: candidate.displayName, tier });
          this.stopped.delete(attachment.conversationId);
        }
        this.options.log(`desktop control grant request ${requestId} ${decision === 'allow' ? 'allowed' : 'denied'}`);
        resolveDecision(decision);
        this.emit(attachment.conversationId);
      },
    };
    const expiry = setTimeout(() => request.settle('deny'), ttl);
    expiry.unref();
    this.expiries.set(requestId, expiry);
    this.requests.set(requestId, request);
    this.options.log(`desktop control grant request ${requestId} waits for the owner in conversation ${attachment.conversationId}`);
    this.emit(attachment.conversationId, true);
    return request;
  }

  private async requestAccess(attachment: Attachment, args: Record<string, unknown>): Promise<ToolCallResult> {
    const { apps, reason } = parseRequestAppAccess(args);
    const { matches } = await this.options.helper!.call<{ matches: Array<{ query: string; candidates: Candidate[] }> }>(
      'resolve_apps', { queries: apps }, 30_000);
    const results: Array<Record<string, unknown>> = [];
    const waits: Array<Promise<void>> = [];
    for (const query of apps) {
      const candidates = (matches.find((match) => match.query === query)?.candidates ?? [])
        .map((candidate) => this.neverGrantable(candidate.path) ? { ...candidate, category: 'excluded' } : candidate);
      const candidate = candidates.find((row) => row.category !== 'excluded') ?? candidates[0];
      if (!candidate) { results.push({ query, status: 'not_found' }); continue; }
      const tier: DesktopAppTier = candidate.category === 'observe_only' ? 'observe_only' : 'full';
      const describe = (appId?: string) => ({ ...(appId ? { appId } : {}), name: candidate.displayName, path: candidate.path,
        publisher: candidate.publisher, tier });
      if (candidate.category === 'excluded') { results.push({ query, status: 'excluded', app: describe() }); continue; }
      const existing = [...attachment.apps.values()].find((app) => app.path.toLowerCase() === candidate.path.toLowerCase()
        && app.publisher === candidate.publisher);
      if (existing) { results.push({ query, status: 'granted', app: describe(existing.appId) }); continue; }
      // Asking again for an app that already waits for the owner joins that request.
      let request = [...this.requests.values()].find((row) => row.attachment === attachment
        && row.candidate.path.toLowerCase() === candidate.path.toLowerCase() && row.candidate.publisher === candidate.publisher);
      if (!request) {
        if (this.pendingRequests(attachment.conversationId) >= MAX_PENDING_PER_CONVERSATION) {
          results.push({ query, status: 'denied', app: describe() });
          continue;
        }
        request = this.openRequest(attachment, query, candidate, reason, tier);
      }
      const row: Record<string, unknown> = { query, status: 'pending', app: describe() };
      results.push(row);
      waits.push(request.decided.then((decision) => {
        const app = [...attachment.apps.values()].find((granted) => granted.path === candidate.path
          && granted.publisher === candidate.publisher);
        row.status = decision === 'allow' && app ? 'granted' : 'denied';
        if (app) row.app = describe(app.appId);
      }));
    }
    if (waits.length) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.all(waits), new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.options.grantWaitMs ?? GRANT_WAIT_MS);
        timer.unref();
      })]);
      if (timer) clearTimeout(timer);
    }
    const granted = results.filter((row) => row.status === 'granted').length;
    return toolResult({ results: results.map((row) => ({ ...row })) }, `${granted} of ${results.length} app(s) granted.`);
  }

  private async runTool(attachment: Attachment, name: string, args: Record<string, unknown>,
    operatorIdleMs: number | undefined, generation: number): Promise<ToolCallResult> {
    const helper = this.options.helper!;
    switch (name) {
      case 'request_app_access':
        return await this.requestAccess(attachment, args);
      case 'list_windows': {
        parseNoArgs(args);
        const windows = (await this.listGranted(attachment)).slice(0, 50).map((window) => {
          let windowId = attachment.windowIdsByHwnd.get(window.hwnd);
          if (!windowId) {
            windowId = opaque('win');
            attachment.windowIdsByHwnd.set(window.hwnd, windowId);
            attachment.windows.set(windowId, window.hwnd);
          }
          return { windowId, appId: window.app.appId, title: window.title, bounds: window.bounds,
            minimized: window.minimized, foreground: window.foreground };
        });
        return toolResult({ windows }, `${windows.length} window(s).`);
      }
      case 'screenshot_window': {
        const { windowId, maxEdge } = parseScreenshot(args);
        const { hwnd } = await this.grantedWindow(attachment, windowId);
        const shot = await helper.call<{ pngBase64: string; width: number; height: number; scale: number; bounds: Bounds }>(
          'capture_window', { hwnd, maxEdge }, 30_000);
        const capturedAt = this.now();
        const value = { snapshotId: opaque('snap'), windowId, width: shot.width, height: shot.height, scale: shot.scale,
          capturedAt: new Date(capturedAt).toISOString() };
        remember(attachment.snapshots, value.snapshotId, { windowId, hwnd, bounds: shot.bounds, scale: shot.scale,
          width: shot.width, height: shot.height, capturedAt }, MAX_SNAPSHOTS);
        const summary = `Screenshot ${shot.width}x${shot.height}.`;
        return { text: summary, content: [{ type: 'image', data: shot.pngBase64, mimeType: 'image/png' }, { type: 'text', text: summary }],
          structuredContent: value };
      }
      case 'read_ui': {
        const { windowId, maxNodes } = parseReadUi(args);
        const { hwnd } = await this.grantedWindow(attachment, windowId);
        const ui = await helper.call<{ readId: number; nodes: Array<Record<string, unknown>>; truncated: boolean }>(
          'read_ui', { hwnd, maxNodes }, 30_000);
        const prefix = `ui${++attachment.reads}`;
        remember(attachment.uiReads, prefix, { windowId, hwnd, readId: ui.readId }, MAX_READS);
        const nodes = ui.nodes.map((node) => ({ ...node, elementId: `${prefix}.${String(node.elementId)}`,
          parentId: node.parentId === null || node.parentId === undefined ? null : `${prefix}.${String(node.parentId)}` }));
        return toolResult({ windowId, nodes, truncated: ui.truncated }, `${nodes.length} element(s)${ui.truncated ? ', truncated' : ''}.`);
      }
      case 'open_app': {
        const { appId } = parseOpenApp(args);
        const app = attachment.apps.get(appId);
        if (!app) throw new DesktopControlToolError('not_granted', 'That app is not granted; call request_app_access.');
        await helper.call('open_app', { path: app.path, ...(app.aumid ? { aumid: app.aumid } : {}) });
        return toolResult({ opened: true }, `Opened ${app.name}.`);
      }
      // Phase B (SPEC-133 R5). The texts below never carry typed or clipboard text (BDC-12).
      case 'click':
      case 'scroll': {
        const parsed = name === 'click' ? parseClick(args) : parseScroll(args);
        const point = this.snapshotPoint(attachment, parsed.snapshotId, parsed.x, parsed.y);
        const { hwnd, app } = await this.inputTarget(attachment, point.snapshot.windowId, operatorIdleMs, generation);
        // The capture-time bounds make the helper refuse a window that moved since the screenshot.
        const rest = 'button' in parsed ? { button: parsed.button, count: parsed.count }
          : { direction: parsed.direction, amount: parsed.amount };
        await this.sendInput(attachment, name, { hwnd, bounds: point.snapshot.bounds, x: point.x, y: point.y, ...rest }, INPUT_TIMEOUT_MS);
        return toolResult({ done: true }, `${name === 'click' ? 'Clicked' : 'Scrolled'} in ${app.name}.`);
      }
      case 'invoke_element': {
        const { elementId, action } = parseInvokeElement(args);
        const dot = elementId.indexOf('.');
        const read = dot > 0 ? attachment.uiReads.get(elementId.slice(0, dot)) : undefined;
        if (!read) throw new DesktopControlToolError('window_changed', 'Unknown or old elementId; call read_ui again.');
        const { hwnd, app } = await this.inputTarget(attachment, read.windowId, operatorIdleMs, generation);
        await this.sendInput(attachment, 'invoke', { hwnd, readId: read.readId, elementId: elementId.slice(dot + 1), action }, INPUT_TIMEOUT_MS);
        return toolResult({ done: true }, `${action} done in ${app.name}.`);
      }
      case 'type_text': {
        const { windowId, text } = parseTypeText(args);
        const { hwnd, app } = await this.inputTarget(attachment, windowId, operatorIdleMs, generation);
        await this.sendInput(attachment, 'type', { hwnd, text }, TYPE_TIMEOUT_MS);
        return toolResult({ done: true }, `Typed ${text.length} character(s) in ${app.name}.`);
      }
      case 'key': {
        const { windowId, keys } = parseKey(args);
        const { hwnd, app } = await this.inputTarget(attachment, windowId, operatorIdleMs, generation);
        await this.sendInput(attachment, 'key', { hwnd, keys }, INPUT_TIMEOUT_MS);
        return toolResult({ done: true }, `Pressed ${keys} in ${app.name}.`);
      }
      // The clipboard needs no app grant and holds no control.
      case 'clipboard_read': {
        parseNoArgs(args);
        await this.takeLease(attachment);
        const { text } = await helper.call<{ text: string | null }>('clipboard_read', {}, CLIPBOARD_TIMEOUT_MS);
        return toolResult({ text }, text === null ? 'The clipboard holds no text.' : `Read ${text.length} character(s) from the clipboard.`);
      }
      case 'clipboard_write': {
        const { text } = parseClipboardWrite(args);
        await this.takeLease(attachment);
        await helper.call('clipboard_write', { text }, CLIPBOARD_TIMEOUT_MS);
        return toolResult({ done: true }, `Wrote ${text.length} character(s) to the clipboard.`);
      }
      default:
        throw new DesktopControlToolError('unavailable', 'Unknown tool.');
    }
  }

  private async callTool(name: string, args: Record<string, unknown>, conversationId: string): Promise<ToolCallResult> {
    const attachment = this.attachments.get(conversationId);
    if (!attachment) return toolError('unavailable', 'This conversation has no desktop control.');
    const generation = this.generation(conversationId);
    try {
      this.requireTurn(attachment);
      if (name !== 'request_app_access' && this.stopped.has(conversationId)) {
        throw new DesktopControlToolError('stopped', STOPPED_MESSAGE);
      }
      const { operatorIdleMs } = await this.requireUnlocked();
      const result = await this.runTool(attachment, name, args, operatorIdleMs, generation);
      // A stop or revocation while the helper worked cancels the call: its answer is discarded.
      if (this.generation(conversationId) !== generation || this.attachments.get(conversationId) !== attachment) {
        throw new DesktopControlToolError('stopped', STOPPED_MESSAGE);
      }
      return result;
    } catch (error) {
      const mapped = mapHelperError(error);
      return toolError(mapped.code, mapped.message);
    }
  }
}
