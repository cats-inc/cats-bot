import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RemoteBotCore } from '../../../core/host-api/remote.ts';
import { CLI_PROVIDERS } from '../../../core/providers/catalog.ts';
import { isValidBotId } from '../../../core/store/paths.ts';
import type { BotDeliveryState, WorkItem, WorkItemState } from '../../../core/types.ts';
import type { CoordinatorLimits } from './registry.ts';

/**
 * SPEC-009: the hub's side of the coordinator role. Every `cats-hub` call
 * arrives here from the channel of the bot that made it; the hub checks that
 * this bot holds the role now (FR-3), offers only the tools of FR-4 (FR-6),
 * asks the owner where FR-5 says so, keeps the limits of FR-8, and records
 * each call (FR-9). Deliveries go to a log under `<CATS_BOT_HOME>` before
 * they are sent, are sent again until the target admits them, and their
 * replies are collected from the target's journal, so a crash on either side
 * neither loses nor repeats one (FR-12).
 */

export interface ToolAnswer {
  text: string;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

export interface CoordinatorBot {
  id: string;
  name: string;
  state: string;
}

export interface CoordinatorDeps {
  home: string;
  holder(): string | null;
  limits(): CoordinatorLimits;
  /** The bots that are not archived. */
  bots(): CoordinatorBot[];
  /** The running core of a bot this hub manages, or null (SPEC-008 FR-10). */
  core(id: string): RemoteBotCore | null;
  createBot(input: { name: string; persona: string; provider: string }): Promise<string>;
  startBot(id: string): Promise<void>;
  stopBot(id: string): Promise<void>;
  /** Whether the owner stopped this bot (FR-5). */
  stoppedByOwner(id: string): boolean;
  setHolder(id: string | null): Promise<void>;
  /** FR-5: the owner's answer; false when declined, expired or the hub stopped. */
  confirm(holder: string, question: string, detail: string): Promise<boolean>;
  log(line: string): void;
  now?(): Date;
}

interface DeliveryRecord {
  id: string;
  kind: 'message' | 'reply';
  chainId: string;
  hop: number;
  from: string;
  fromName: string;
  to: string;
  /** For a message, the holder's conversation its reply returns to; for a reply, that conversation. */
  conversationId: string;
  text: string;
  state: 'accepted' | 'sent' | 'answered' | 'failed';
  at: string;
  workItemId?: string;
  reason?: string;
}

const MAX_TEXT = 64 * 1024;
const TERMINAL: readonly WorkItemState[] = ['completed', 'failed', 'cancelled', 'interrupted'];

export class Coordinator {
  private readonly deps: CoordinatorDeps;
  private readonly deliveries = new Map<string, DeliveryRecord>();
  private readonly logFile: string;
  private readonly auditFile: string;
  private sending: Promise<unknown> = Promise.resolve();

  constructor(deps: CoordinatorDeps) {
    this.deps = deps;
    const dir = join(deps.home, 'coordinator');
    this.logFile = join(dir, 'deliveries.jsonl');
    this.auditFile = join(deps.home, 'logs', 'hub-audit.jsonl');
    this.load();
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private load(): void {
    if (!existsSync(this.logFile)) return;
    for (const line of readFileSync(this.logFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as DeliveryRecord;
        if (typeof record.id === 'string') this.deliveries.set(record.id, record);
      } catch {
        this.deps.log('coordinator: an unreadable delivery log line was skipped');
      }
    }
  }

  /** FR-12: each change of a delivery is appended before anything depends on it. */
  private save(record: DeliveryRecord): void {
    mkdirSync(join(this.logFile, '..'), { recursive: true });
    appendFileSync(this.logFile, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    this.deliveries.set(record.id, record);
  }

  /** FR-9: the hub's record of every call, without message text. */
  private audit(entry: { tool: string; holder: string; target?: string; chain?: string; outcome: string }): void {
    try {
      mkdirSync(join(this.auditFile, '..'), { recursive: true });
      appendFileSync(this.auditFile, `${JSON.stringify({ at: this.now().toISOString(), ...entry })}\n`, 'utf8');
    } catch { /* The audit never stops a call. */ }
    this.deps.log(`coordinator ${entry.tool} by ${entry.holder}${entry.target ? ` for ${entry.target}` : ''}: ${entry.outcome}`);
  }

  private name(id: string): string {
    return this.deps.bots().find((bot) => bot.id === id)?.name ?? id;
  }

  /** A `cats-hub` call from the bot whose channel carried it. */
  async handle(caller: string, raw: unknown): Promise<ToolAnswer> {
    const call = parseCall(raw);
    if (!call) return refuse('The hub could not read the call.');
    const target = typeof call.args.bot === 'string' ? call.args.bot : undefined;
    const finish = (answer: ToolAnswer): ToolAnswer => {
      const chain = answer.structuredContent?.chain ?? call.args.chain;
      this.audit({
        tool: call.tool, holder: caller,
        ...(target ? { target } : {}),
        ...(typeof chain === 'string' ? { chain } : {}),
        outcome: answer.isError ? `refused: ${answer.text}` : 'done',
      });
      return answer;
    };
    // FR-3: the holder now, whatever the session still carries.
    if (this.deps.holder() !== caller) return finish(refuse('This bot does not hold the coordinator role.'));
    try {
      switch (call.tool) {
        case 'hub_list_bots':
          return finish(ok(JSON.stringify(this.deps.bots(), null, 2), { bots: this.deps.bots() }));
        case 'hub_message_bot':
          return finish(await this.message(caller, call.args, call.conversationId));
        case 'hub_create_bot':
          return finish(await this.create(caller, call.args));
        case 'hub_start_bot':
          return finish(await this.start(caller, call.args));
        case 'hub_stop_bot':
          return finish(await this.stop(caller, call.args));
        case 'hub_set_heartbeat':
          return finish(await this.heartbeat(caller, call.args));
        case 'hub_propose_transfer':
          return finish(await this.transfer(caller, call.args));
        default:
          // FR-6: nothing else exists, whatever the arguments.
          return finish(refuse('The hub offers no such tool.'));
      }
    } catch (error) {
      return finish(refuse(error instanceof Error ? error.message : 'The hub could not carry out the call.'));
    }
  }

  /** Another bot of this hub, not the caller. */
  private other(caller: string, args: Record<string, unknown>): string {
    const id = args.bot;
    if (typeof id !== 'string' || !isValidBotId(id)) throw new Error('Name another bot by the id hub_list_bots returns.');
    if (id === caller) throw new Error('These tools act on other bots, not on the coordinator itself.');
    if (!this.deps.bots().some((bot) => bot.id === id)) {
      throw new Error(this.deps.bots().length <= 1 ? 'There is no other bot.' : `There is no bot ${id}.`);
    }
    return id;
  }

  private async message(caller: string, args: Record<string, unknown>, conversationId: string): Promise<ToolAnswer> {
    const target = this.other(caller, args);
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!text) return refuse('The message needs text.');
    if (text.length > MAX_TEXT) return refuse('The message is too long.');
    const core = this.deps.core(target);
    if (!core) return refuse(`${this.name(target)} is not running under this hub; start it first.`);
    const limits = this.deps.limits();
    let chainId: string;
    let hop: number;
    if (typeof args.chain === 'string' && args.chain) {
      const chain = [...this.deliveries.values()].filter((record) => record.chainId === args.chain);
      // FR-8: only the holder starts chains, and continues its own.
      if (chain.length === 0 || chain.find((record) => record.hop === 1)?.from !== caller) return refuse('That chain is unknown.');
      chainId = args.chain;
      hop = Math.max(...chain.map((record) => record.hop)) + 1;
    } else {
      chainId = `chain-${randomUUID().slice(0, 12)}`;
      hop = 1;
    }
    // FR-8: room for this message and its reply.
    if (hop + 1 > limits.hopsPerChain) {
      return refuse(`This chain reached its limit of ${limits.hopsPerChain} hops. Start a new one, or ask the owner to raise the limit.`);
    }
    const hourAgo = this.now().getTime() - 3_600_000;
    const recent = [...this.deliveries.values()]
      .filter((record) => record.kind === 'message' && record.from === caller && Date.parse(record.at) > hourAgo).length;
    if (recent >= limits.messagesPerHour) {
      return refuse(`The coordinator sent ${recent} messages in the last hour, its limit. Try again later, or ask the owner to raise the limit.`);
    }
    const record: DeliveryRecord = {
      id: `delivery-${randomUUID().slice(0, 12)}`, kind: 'message', chainId, hop,
      from: caller, fromName: this.name(caller), to: target, conversationId, text, state: 'accepted', at: this.now().toISOString(),
    };
    this.save(record);
    const delivered = await this.send(record);
    return ok(
      delivered
        ? `Delivered to ${this.name(target)}. Its reply comes back to this conversation. Chain ${chainId}, hop ${hop}.`
        : `Recorded for ${this.name(target)}, which receives it once its core answers again. Chain ${chainId}, hop ${hop}.`,
      { delivery: record.id, chain: chainId, hop },
    );
  }

  /** Sends a recorded delivery; one that the target has admitted is marked sent (FR-12). */
  private send(record: DeliveryRecord): Promise<boolean> {
    const task = this.sending.then(async () => {
      const current = this.deliveries.get(record.id);
      if (!current || current.state !== 'accepted') return current?.state === 'sent';
      const core = this.deps.core(current.to);
      if (!core) return false;
      try {
        const item = await core.admitBotMessage({
          deliveryId: current.id, chainId: current.chainId, hop: current.hop, kind: current.kind,
          from: current.from, fromName: current.fromName, text: current.text,
          ...(current.kind === 'reply' ? { conversationId: current.conversationId } : {}),
        });
        this.save({ ...current, state: 'sent', workItemId: item.id });
        return true;
      } catch (error) {
        this.deps.log(`coordinator: delivery ${current.id} to ${current.to} waits: ${error instanceof Error ? error.message : 'error'}`);
        return false;
      }
    });
    this.sending = task.catch(() => undefined);
    return task;
  }

  /** FR-8: a message's answer, or why there is none, returns to the bot that sent it. */
  private async answer(message: DeliveryRecord, state: WorkItemState, reply: string | null, error: string | null): Promise<void> {
    if (message.kind !== 'message' || (message.state !== 'sent' && message.state !== 'accepted')) return;
    const text = state === 'completed'
      ? (reply?.trim() || '(no answer)')
      : `${this.name(message.to)} did not answer: its work on your message ended ${state}${error ? ` (${error})` : ''}.`;
    this.save({ ...message, state: state === 'completed' ? 'answered' : 'failed' });
    const reply_: DeliveryRecord = {
      id: `delivery-${randomUUID().slice(0, 12)}`, kind: 'reply', chainId: message.chainId, hop: message.hop + 1,
      from: message.to, fromName: this.name(message.to), to: message.from, conversationId: message.conversationId,
      text: text.slice(0, MAX_TEXT), state: 'accepted', at: this.now().toISOString(),
    };
    this.save(reply_);
    await this.send(reply_);
  }

  /** A bot finished a work item: a message it was handed is answered. */
  async turnCompleted(botId: string, item: WorkItem): Promise<void> {
    const chain = item.chain;
    if (item.source !== 'bot' || chain?.kind !== 'message') return;
    const message = this.deliveries.get(chain.deliveryId);
    if (!message || message.to !== botId) return;
    await this.answer(message, item.state, item.result?.text ?? null, item.error ?? null);
  }

  /**
   * FR-12: a bot's core is attached again. What it has not admitted is sent
   * again, and messages it finished while the hub was away are answered.
   */
  async attached(botId: string): Promise<void> {
    for (const record of [...this.deliveries.values()]) {
      if (record.to === botId && record.state === 'accepted') await this.send(record);
    }
    const open = [...this.deliveries.values()].filter((record) => record.kind === 'message' && record.to === botId && record.state === 'sent');
    if (open.length === 0) return;
    const core = this.deps.core(botId);
    if (!core) return;
    let states: BotDeliveryState[];
    try {
      states = await core.botDeliveries(open.map((record) => record.id));
    } catch (error) {
      this.deps.log(`coordinator: replies of ${botId} not read: ${error instanceof Error ? error.message : 'error'}`);
      return;
    }
    for (const state of states) {
      const message = this.deliveries.get(state.deliveryId);
      if (message && TERMINAL.includes(state.state)) await this.answer(message, state.state, state.reply, state.error);
    }
  }

  /** FR-12: a target that was archived or can no longer run fails what still waits for it. */
  async targetGone(botId: string, reason: string): Promise<void> {
    for (const record of [...this.deliveries.values()]) {
      if (record.kind === 'message' && record.to === botId && (record.state === 'accepted' || record.state === 'sent')) {
        await this.answer(record, 'failed', null, reason);
      }
    }
  }

  private async create(caller: string, args: Record<string, unknown>): Promise<ToolAnswer> {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    const persona = typeof args.persona === 'string' ? args.persona.trim() : '';
    const provider = typeof args.provider === 'string' ? args.provider : '';
    if (!name || name.length > 80) return refuse('The new bot needs a name of at most 80 characters.');
    if (persona.length > 4_000) return refuse('The persona is too long.');
    if (!CLI_PROVIDERS.some((entry) => entry.id === provider)) {
      return refuse(`Choose one of these providers: ${CLI_PROVIDERS.map((entry) => entry.id).join(', ')}.`);
    }
    // FR-5: the owner decides.
    if (!await this.deps.confirm(caller, `${this.name(caller)} asks to create a bot named "${name}" on ${provider}.`, persona)) {
      return refuse('The owner declined, or did not answer in time.');
    }
    const id = await this.deps.createBot({ name, persona, provider });
    return ok(`Created ${name} (${id}). It runs with desktop control and Telegram off.`, { bot: id });
  }

  private async start(caller: string, args: Record<string, unknown>): Promise<ToolAnswer> {
    const target = this.other(caller, args);
    if (this.deps.core(target)) return ok(`${this.name(target)} is already running.`);
    // FR-5: a bot the owner stopped starts only with the owner's consent.
    if (this.deps.stoppedByOwner(target)
      && !await this.deps.confirm(caller, `${this.name(caller)} asks to start ${this.name(target)}, which you stopped.`, '')) {
      return refuse('The owner declined, or did not answer in time.');
    }
    await this.deps.startBot(target);
    return ok(`Started ${this.name(target)}.`);
  }

  private async stop(caller: string, args: Record<string, unknown>): Promise<ToolAnswer> {
    const target = this.other(caller, args);
    if (!this.deps.core(target)) return ok(`${this.name(target)} is not running.`);
    await this.deps.stopBot(target);
    return ok(`Stopped ${this.name(target)}.`);
  }

  private async heartbeat(caller: string, args: Record<string, unknown>): Promise<ToolAnswer> {
    const target = this.other(caller, args);
    if (typeof args.enabled !== 'boolean') return refuse('Say whether the heartbeat runs (enabled true or false).');
    const core = this.deps.core(target);
    if (!core) return refuse(`${this.name(target)} is not running.`);
    await core.updateProfile({ heartbeat: { enabled: args.enabled } });
    return ok(`${this.name(target)}'s heartbeat is ${args.enabled ? 'running' : 'paused'}.`);
  }

  private async transfer(caller: string, args: Record<string, unknown>): Promise<ToolAnswer> {
    const proposed = args.bot === null ? null : this.other(caller, args);
    const question = proposed
      ? `${this.name(caller)} proposes that ${this.name(proposed)} take over the coordinator role.`
      : `${this.name(caller)} proposes that no bot hold the coordinator role.`;
    if (!await this.deps.confirm(caller, question, '')) return refuse('The owner declined, or did not answer in time.');
    await this.deps.setHolder(proposed);
    return ok(proposed ? `${this.name(proposed)} now holds the coordinator role.` : 'No bot holds the coordinator role now.');
  }
}

function ok(text: string, structuredContent?: Record<string, unknown>): ToolAnswer {
  return { text, ...(structuredContent ? { structuredContent } : {}) };
}

function refuse(text: string): ToolAnswer {
  return { text, isError: true };
}

function parseCall(raw: unknown): { tool: string; args: Record<string, unknown>; conversationId: string } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.tool !== 'string' || value.tool.length > 64) return null;
  if (typeof value.conversationId !== 'string' || !value.conversationId || value.conversationId.length > 200) return null;
  const args = value.args && typeof value.args === 'object' && !Array.isArray(value.args) ? value.args as Record<string, unknown> : {};
  return { tool: value.tool, args, conversationId: value.conversationId };
}
