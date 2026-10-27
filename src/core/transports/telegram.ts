/**
 * SPEC-001 FR-19 / FR-26: optional Telegram long polling. One consumer per
 * bot token, inbound private messages from the owner's chat become owner
 * messages in the home conversation, replies are mirrored back in order and
 * split at 4,000 characters. Webhooks are out of scope (ADR-001 §10).
 *
 * Loop shape (offset, backoff, conflict handling) adapted from cats-platform
 * `src/platform/transports/telegram/polling.ts` at revision 595e9ca (MIT),
 * per ADR-001 §1.
 */

export const TELEGRAM_CHUNK_LIMIT = 4_000;
const DEFAULT_API_BASE_URL = 'https://api.telegram.org';
const DEFAULT_POLL_TIMEOUT_SECONDS = 25;

export type TelegramHealth = 'healthy' | 'degraded' | 'failed';

export interface TelegramInbound {
  chatId: number;
  messageId: number;
  from: string;
  text: string;
}

export interface TelegramTransportOptions {
  token: string;
  botName: string;
  ownerChatId: number | null;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  pollTimeoutSeconds?: number;
  now(): Date;
  log(line: string): void;
  /** The first private chat that writes becomes the owner; the core persists it. */
  onOwnerBound(chatId: number, name: string): void;
  onOwnerMessage(message: TelegramInbound): Promise<void>;
}

export interface TelegramStatus {
  polling: boolean;
  health: TelegramHealth;
  ownerChatId: number | null;
  lastPollAt: string | null;
  lastError: string | null;
  processedUpdates: number;
  consecutiveFailures: number;
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number; type: string; first_name?: string; username?: string };
    from?: { id: number; first_name?: string; username?: string };
  };
}

function maskToken(token: string): string {
  return token.length <= 4 ? 'bot:***' : `bot:***${token.slice(-4)}`;
}

function backoffMs(failures: number): number {
  return Math.min(1_000 * 2 ** Math.min(failures, 15), 30_000);
}

function healthFor(failures: number): TelegramHealth {
  if (failures < 3) return 'healthy';
  if (failures < 10) return 'degraded';
  return 'failed';
}

/** FR-19: chunks of at most `limit` characters, cut at a newline when one is near. */
export function chunkTelegramText(text: string, limit: number = TELEGRAM_CHUNK_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/u, '');
  }
  if (rest.length > 0 || chunks.length === 0) chunks.push(rest);
  return chunks;
}

export class TelegramTransport {
  private readonly options: TelegramTransportOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private controller: AbortController | null = null;
  private loop: Promise<void> | null = null;
  private offset: number | null = null;
  private ownerChatId: number | null;
  private lastPollAt: string | null = null;
  private lastError: string | null = null;
  private processedUpdates = 0;
  private consecutiveFailures = 0;
  private outbound: Promise<void> = Promise.resolve();

  constructor(options: TelegramTransportOptions) {
    this.options = options;
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = (options.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/u, '');
    this.ownerChatId = options.ownerChatId;
  }

  private url(method: string): string {
    return `${this.baseUrl}/bot${this.options.token}/${method}`;
  }

  status(): TelegramStatus {
    return {
      polling: this.controller !== null,
      health: healthFor(this.consecutiveFailures),
      ownerChatId: this.ownerChatId,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      processedUpdates: this.processedUpdates,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  start(): void {
    if (this.controller) return;
    this.controller = new AbortController();
    this.options.log(`telegram polling started (${maskToken(this.options.token)})`);
    this.loop = this.run(this.controller.signal).catch((error: unknown) => {
      if (!(error instanceof Error && error.name === 'AbortError')) {
        this.options.log(`telegram polling stopped: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  async stop(): Promise<void> {
    const controller = this.controller;
    if (!controller) return;
    this.controller = null;
    controller.abort();
    await this.loop;
    this.loop = null;
    await this.outbound.catch(() => undefined);
    this.options.log('telegram polling stopped');
  }

  private async run(signal: AbortSignal): Promise<void> {
    await this.fetchImpl(this.url('deleteWebhook'), { method: 'POST', signal }).catch(() => undefined);
    const timeoutSeconds = this.options.pollTimeoutSeconds ?? DEFAULT_POLL_TIMEOUT_SECONDS;
    while (!signal.aborted) {
      try {
        const params = new URLSearchParams({ timeout: String(timeoutSeconds), allowed_updates: JSON.stringify(['message']) });
        if (this.offset !== null) params.set('offset', String(this.offset));
        const response = await this.fetchImpl(`${this.url('getUpdates')}?${params.toString()}`, {
          method: 'GET',
          signal: AbortSignal.any([signal, AbortSignal.timeout((timeoutSeconds + 10) * 1_000)]),
        });
        this.lastPollAt = this.options.now().toISOString();
        if (response.status === 409) {
          throw new Error('another consumer is polling this bot token (409 Conflict)');
        }
        if (!response.ok) throw new Error(`getUpdates failed with HTTP ${response.status}`);
        const payload = (await response.json()) as { ok?: boolean; result?: TelegramUpdate[]; description?: string };
        if (!payload.ok || !Array.isArray(payload.result)) {
          throw new Error(`getUpdates rejected: ${payload.description ?? 'unknown error'}`);
        }
        this.consecutiveFailures = 0;
        this.lastError = null;
        for (const update of payload.result) {
          this.offset = Math.max(this.offset ?? 0, update.update_id + 1);
          await this.handle(update);
        }
      } catch (error) {
        if (signal.aborted) return;
        this.consecutiveFailures += 1;
        this.lastError = error instanceof Error ? error.message : String(error);
        this.options.log(`telegram poll failed (${this.consecutiveFailures}): ${this.lastError}`);
        const delay = /409 Conflict/u.test(this.lastError) ? 30_000 : backoffMs(this.consecutiveFailures);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
      }
    }
  }

  private async handle(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message || typeof message.text !== 'string') return;
    if (message.chat.type !== 'private') {
      this.options.log(`telegram: ignored a ${message.chat.type} chat message`);
      return;
    }
    const name = message.from?.first_name ?? message.from?.username ?? message.chat.first_name ?? 'owner';
    if (this.ownerChatId === null) {
      // FR-26: the first private chat that speaks is the owner, and the binding is persisted.
      this.ownerChatId = message.chat.id;
      this.options.onOwnerBound(message.chat.id, name);
      this.options.log('telegram: owner chat bound');
      await this.send(`Hi ${name}, I am ${this.options.botName}. This chat is now where I talk to you.`);
      if (message.text.trim() === '/start') return;
    } else if (message.chat.id !== this.ownerChatId) {
      this.options.log('telegram: ignored a message from a chat that is not the owner');
      return;
    }
    if (message.text.trim() === '/start') {
      await this.send(`I am here, ${name}.`);
      return;
    }
    this.processedUpdates += 1;
    await this.options.onOwnerMessage({
      chatId: message.chat.id,
      messageId: message.message_id,
      from: name,
      text: message.text,
    });
  }

  /** FR-19: mirrored replies keep their order; long ones are split in sequence. */
  send(text: string): Promise<void> {
    const chatId = this.ownerChatId;
    if (chatId === null || !text.trim()) return Promise.resolve();
    const queued = this.outbound.then(async () => {
      for (const chunk of chunkTelegramText(text)) {
        await this.sendChunk(chatId, chunk);
      }
    });
    this.outbound = queued.catch((error: unknown) => {
      this.options.log(`telegram send failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return this.outbound;
  }

  private async sendChunk(chatId: number, text: string): Promise<void> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const response = await this.fetchImpl(this.url('sendMessage'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) return;
      if (attempt === 2) throw new Error(`sendMessage failed with HTTP ${response.status}`);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}
