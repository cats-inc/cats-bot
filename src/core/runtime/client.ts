/**
 * The bot's only view of cats-runtime: the HTTP contract documented in the
 * runtime's docs/api.md (sessions, messages, resume, cancel, close, delete,
 * observe, history, health). Nothing here imports runtime source (ADR-001 §1).
 */

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
  cwd?: string;
  instructions?: string;
  workspaceKind?: 'source' | 'sandbox' | 'worktree';
  workspaceAccess?: 'read_write' | 'read_only';
  permissionMode?: 'skip' | 'whitelist' | 'default';
  allowedTools?: string[];
  mcpServers?: RuntimeMcpServer[];
}

export interface SendMessageRequest {
  message: string;
  instructions?: string;
  mcpServers?: RuntimeMcpServer[];
}

export interface RuntimeHealth {
  status: string;
  readiness?: { ready?: boolean; phase?: string };
  startup?: { phase?: string; bootstrapRequired?: boolean; pid?: number };
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

  resumeSession(id: string, body: { mcpServers?: RuntimeMcpServer[] } = {}): Promise<RuntimeSessionView> {
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

  /** `GET /providers/{provider}/models`: the catalog of a configured provider (400 otherwise). */
  providerModels(provider: string): Promise<RuntimeModelCatalog> {
    return this.request<RuntimeModelCatalog>('GET', `/providers/${encodeURIComponent(provider)}/models`);
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
