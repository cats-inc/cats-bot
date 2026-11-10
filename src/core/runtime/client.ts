/**
 * The bot's only view of cats-runtime: the HTTP contract documented in the
 * runtime's docs/api.md (sessions, messages, resume, cancel, close, delete,
 * observe, history, health). Nothing here imports runtime source (ADR-001 §1).
 */
import type {
  InteractionHost,
  InteractionSnapshot,
  InteractionResponse,
  ProviderInteraction,
  ModelCatalog,
  ModelSelection,
  SessionCapabilitiesSnapshot,
  SessionExecutionPolicy,
} from '../types.ts';
import { INTERACTION_HOST } from './providerPolicy.ts';

export type RuntimeSessionStatus = 'initializing' | 'ready' | 'busy' | 'closing' | 'closed';

export interface RuntimeSessionView {
  id: string;
  status: RuntimeSessionStatus;
  providerName?: string;
  providerSessionId?: string;
  origin?: 'runtime' | 'discovered';
  model?: string;
  cwd?: string;
  [key: string]: unknown;
}

export interface RuntimeStreamEvent {
  type: string;
  text?: string;
  sessionId?: string;
  toolName?: string;
  toolId?: string;
  isError?: boolean;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RuntimeMcpServer {
  name: string;
  transport: 'http';
  url: string;
  auth: { kind: 'bearer_env'; token: string } | { kind: 'none' };
}

export interface CreateSessionRequest {
  provider: string;
  model?: string;
  modelSelection?: ModelSelection;
  cwd?: string;
  instructions?: string;
  workspaceKind?: 'source' | 'sandbox' | 'worktree';
  workspaceAccess?: 'read_write' | 'read_only';
  permissionMode?: 'skip' | 'whitelist' | 'default';
  allowedTools?: string[];
  mcpServers?: RuntimeMcpServer[];
  interactionHost?: InteractionHost;
  executionPolicy?: SessionExecutionPolicy;
}

export interface SendMessageRequest {
  message: string;
  instructions?: string;
  mcpServers?: RuntimeMcpServer[];
}

export interface RuntimeHealth {
  status: string;
  readiness?: { ready?: boolean; phase?: string };
  startup?: { phase?: string; bootstrapRequired?: boolean; pid?: number; managedBy?: string };
  version?: string;
  [key: string]: unknown;
}

export interface RuntimeModelCatalog {
  provider: string;
  defaultModel?: string | null;
  models?: Array<{ id: string; label?: string; default?: boolean }>;
}

export interface RuntimeHistory {
  messages: Array<{ role: string; text: string }>;
  [key: string]: unknown;
}

export interface RuntimeObserve {
  session?: RuntimeSessionView;
  [key: string]: unknown;
}

export class RuntimeHttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown, code?: string) {
    super(message);
    this.name = 'RuntimeHttpError';
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

export interface StreamOutcome {
  /** True when the stream delivered a `result` event (SPEC-001 FR-18). */
  completed: boolean;
  eventCount: number;
  resultEvent: RuntimeStreamEvent | null;
  errorText: string | null;
}

export interface RuntimeClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  /** Timeout for every non-streaming call. */
  requestTimeoutMs?: number;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, '')}${path}`;
}

export class RuntimeClient {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: RuntimeClientOptions) {
    this.baseUrl = options.baseUrl;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      ...extra,
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await this.fetchImpl(joinUrl(this.baseUrl, path), {
      method,
      headers: this.headers(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: combined,
    });
    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!response.ok) {
      const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
      const message = typeof record.error === 'string' ? record.error : `HTTP ${response.status}`;
      const code = typeof record.code === 'string' ? record.code : undefined;
      throw new RuntimeHttpError(response.status, message, parsed, code);
    }
    return parsed as T;
  }

  health(signal?: AbortSignal): Promise<RuntimeHealth> {
    return this.request<RuntimeHealth>('GET', '/health', undefined, signal);
  }

  createSession(body: CreateSessionRequest): Promise<RuntimeSessionView> {
    return this.request<RuntimeSessionView>('POST', '/sessions', body);
  }

  getSession(id: string): Promise<RuntimeSessionView> {
    return this.request<RuntimeSessionView>('GET', `/sessions/${encodeURIComponent(id)}`);
  }

  resumeSession(id: string, body: Pick<CreateSessionRequest, 'mcpServers' | 'interactionHost' | 'executionPolicy'> = {}): Promise<RuntimeSessionView> {
    return this.request<RuntimeSessionView>('POST', `/sessions/${encodeURIComponent(id)}/resume`, body);
  }

  closeSession(id: string): Promise<RuntimeSessionView> {
    return this.request<RuntimeSessionView>('POST', `/sessions/${encodeURIComponent(id)}/close`, {});
  }

  cancelSession(id: string): Promise<RuntimeSessionView> {
    return this.request<RuntimeSessionView>('POST', `/sessions/${encodeURIComponent(id)}/cancel`, {});
  }

  deleteSession(id: string): Promise<unknown> {
    return this.request<unknown>('DELETE', `/sessions/${encodeURIComponent(id)}`);
  }

  observeSession(id: string): Promise<RuntimeObserve> {
    return this.request<RuntimeObserve>('GET', `/sessions/${encodeURIComponent(id)}/observe`);
  }

  getHistory(id: string): Promise<RuntimeHistory> {
    return this.request<RuntimeHistory>('GET', `/sessions/${encodeURIComponent(id)}/history`);
  }

  async sessionControls(
    provider: string,
    policy: SessionExecutionPolicy | null,
  ): Promise<Pick<CreateSessionRequest, 'interactionHost' | 'executionPolicy'>> {
    let unenforceable = false;
    try {
      const result = await this.request<{ providers: Record<string, { defaultInstance?: string; defaultBackend?: string;
        instances: Array<{ id: string; backend: string; continuity?: {
          interactions?: { version: number; kinds: string[] };
          sessionCapabilities?: { version: number; executionPolicy: boolean;
            admissibleCeilings?: Array<{ access: string; network: boolean }> };
        } }> }> }>('GET', '/providers/config');
      const configured = result.providers?.[provider];
      const target = configured?.instances.find(t => t.id === configured.defaultInstance && t.backend === configured.defaultBackend);
      const c = target?.continuity;
      const ceilings = c?.sessionCapabilities?.admissibleCeilings;
      if (
        policy &&
        ceilings &&
        !ceilings.some(
          (ceiling) =>
            ceiling.access === policyAccess(policy) && ceiling.network === policyNetwork(policy),
        )
      ) {
        unenforceable = true;
      } else if (
        c?.interactions?.version === 1 &&
        (!policy || (c.sessionCapabilities?.version === 1 && c.sessionCapabilities.executionPolicy))
      ) {
        return { interactionHost: { ...INTERACTION_HOST, kinds: INTERACTION_HOST.kinds.filter(k => c.interactions!.kinds.includes(k)) },
          ...(policy ? { executionPolicy: policy } : {}) };
      }
    } catch {
      /* Old Runtime remains usable only with the unchanged legacy policy. */
    }
    if (unenforceable) throw new Error('The selected provider cannot enforce this access or network limit. Choose full access with network, or keep the existing tool settings.');
    if (policy) throw new Error('Selected Runtime/provider does not support provider policy v1. Upgrade Runtime or select legacy settings.');
    return {};
  }

  interactions(id: string): Promise<InteractionSnapshot> {
    return this.request('GET', `/sessions/${encodeURIComponent(id)}/interactions`);
  }

  respondInteraction(id: string, interactionId: string, body: InteractionResponse): Promise<ProviderInteraction> {
    return this.request('POST', `/sessions/${encodeURIComponent(id)}/interactions/${encodeURIComponent(interactionId)}/responses`, body);
  }

  capabilities(id: string, refresh = false): Promise<SessionCapabilitiesSnapshot> {
    return this.request('GET', `/sessions/${encodeURIComponent(id)}/capabilities${refresh ? '?refresh=true' : ''}`);
  }

  /** `GET /providers/{provider}/models`: the catalog of a configured provider (400 otherwise). */
  providerModels(provider: string): Promise<RuntimeModelCatalog> {
    return this.request<RuntimeModelCatalog>('GET', `/providers/${encodeURIComponent(provider)}/models`);
  }

  providerAdvancedModels(
    provider: string,
  ): Promise<Omit<ModelCatalog, 'models' | 'source'> & { entries: ModelCatalog['models'] }> {
    return this.request(
      'GET',
      `/providers/${encodeURIComponent(provider)}/models/advanced?backend=cli&instance=native`,
    );
  }

  async currentModelSelection(provider: string, saved: ModelSelection): Promise<ModelSelection> {
    const catalog = await this.providerAdvancedModels(provider);
    if (!catalog.entries.some((entry) => entry.id === saved.entryId)) {
      throw new Error(`Saved model '${saved.entryId}' is unavailable. Choose a model in Settings.`);
    }
    // Refresh only the optimistic revision. Runtime validates the unchanged
    // entry and every saved control against this revision, with no UI fallback.
    const { catalogRevision: _previous, ...selection } = saved;
    return {
      ...selection,
      ...(catalog.catalogRevision ? { catalogRevision: catalog.catalogRevision } : {}),
    };
  }

  /**
   * `POST /sessions/{id}/messages` with `Accept: application/x-ndjson`; every
   * line is one event. Rejections before the stream starts surface as
   * `RuntimeHttpError` (409 busy, 404 no worker, 410 exited, 403/429 guardrail).
   */
  async streamMessage(
    id: string,
    body: SendMessageRequest,
    onEvent: (event: RuntimeStreamEvent) => void,
    signal?: AbortSignal,
    onAccepted?: () => void,
  ): Promise<StreamOutcome> {
    const response = await this.fetchImpl(
      joinUrl(this.baseUrl, `/sessions/${encodeURIComponent(id)}/messages`),
      {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }),
        body: JSON.stringify(body),
        signal,
      },
    );
    if (!response.ok) {
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // keep the raw text
      }
      const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
      const message = typeof record.error === 'string' ? record.error : `HTTP ${response.status}`;
      const code = typeof record.code === 'string' ? record.code : undefined;
      throw new RuntimeHttpError(response.status, message, parsed, code);
    }
    const outcome: StreamOutcome = { completed: false, eventCount: 0, resultEvent: null, errorText: null };
    if (!response.body) return outcome;
    onAccepted?.();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: RuntimeStreamEvent;
      try {
        event = JSON.parse(trimmed) as RuntimeStreamEvent;
      } catch {
        return;
      }
      if (!event || typeof event.type !== 'string') return;
      outcome.eventCount += 1;
      if (event.type === 'result') {
        outcome.completed = true;
        outcome.resultEvent = event;
      } else if (event.type === 'error') {
        outcome.errorText = typeof event.text === 'string' ? event.text : 'runtime error';
      }
      onEvent(event);
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        let newline = buffered.indexOf('\n');
        while (newline !== -1) {
          handleLine(buffered.slice(0, newline));
          buffered = buffered.slice(newline + 1);
          newline = buffered.indexOf('\n');
        }
      }
      buffered += decoder.decode();
      if (buffered) handleLine(buffered);
    } finally {
      reader.releaseLock();
    }
    return outcome;
  }
}

function policyAccess(policy: SessionExecutionPolicy): string {
  return policy.mode === 'explicit' ? policy.access : policy.constraints.maxAccess;
}

function policyNetwork(policy: SessionExecutionPolicy): boolean {
  return policy.mode === 'explicit' ? policy.network : policy.constraints.network;
}
