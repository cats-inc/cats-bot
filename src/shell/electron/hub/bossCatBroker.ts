import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RemoteBotCore } from '../../../core/host-api/remote.ts';
import { CLI_PROVIDERS } from '../../../core/providers/catalog.ts';
import { writeFileAtomic } from '../../../core/store/atomicFile.ts';
import { isValidBotId } from '../../../core/store/paths.ts';
import { isHubRecordId, isPlainLine, oneLine } from '../../../core/tools/hubTools.ts';
import type { BotDeliveryState, WorkItem, WorkItemState } from '../../../core/types.ts';
import type { BossCatLimits } from './registry.ts';

/**
 * SPEC-009: the hub's side of the Boss Cat role. Every `cats-hub` call
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

export interface BossCatBot {
  id: string;
  name: string;
  state: string;
}

export interface BossCatDeps {
  home: string;
  holder(): string | null;
  limits(): BossCatLimits;
  /** The bots that are not archived. */
  bots(): BossCatBot[];
  /** The running core of a bot this hub manages, or null (SPEC-008 FR-10). */
  core(id: string): RemoteBotCore | null;
  /** Whether the bot cap leaves no room for a new bot (SPEC-008 FR-4). */
  atBotCap(): boolean;
  /**
   * Whether creating a bot with this provider needs the owner's setup first (`window`), cannot
   * ask now because the owner has a New bot window open (`busy`), or neither (`none`).
   */
  setupNeeded(provider: string): 'none' | 'window' | 'busy';
  /**
   * Creates and starts the bot, or, when this computer does not have its provider yet,
   * opens the owner's New bot window filled in with the request (`busy`: one is open already).
   */
  createBot(input: { name: string; persona: string; provider: string }): Promise<{ id: string } | { setup: 'opened' | 'busy' }>;
  /** Why the holder cannot start this bot now, or null: one that failed is the runner's or the owner's to start. */
  startBlocked(id: string): string | null;
  /** Starts a bot the owner allowed to start; it rejects with the reason when the bot did not start. */
  startBot(id: string): Promise<void>;
  stopBot(id: string): Promise<void>;
  setHolder(id: string | null): Promise<void>;
  /** FR-5: the owner's answer; false when declined, expired, the role moved or the hub stopped. */
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
  /** Kept while the delivery may be sent again; a settled one keeps none (compaction). */
  text: string;
  state: 'accepted' | 'sent' | 'answered' | 'failed';
  at: string;
  workItemId?: string;
  reason?: string;
}

const MAX_TEXT = 64 * 1024;
/** Names in dialogs, records and prompts: one line, short. */
const NAME_LENGTH = 40;
const RECORD_NAME_LENGTH = 80;
const PERSONA_PREVIEW = 300;
const BUSY_WINDOW = 'The owner already has a New bot window open. Ask again after it closes.';
/** FR-5: a declined or expired request is not asked again for this long. */
export const CONSENT_COOLDOWN_MS = 60_000;
/** FR-12: settled deliveries stay in the log this long, for the hourly limit and the chains they belong to. */
const RETENTION_MS = 30 * 24 * 3_600_000;
const SETTLED: readonly WorkItemState[] = ['completed', 'failed', 'cancelled', 'interrupted'];

export class BossCatBroker {
  private readonly deps: BossCatDeps;
  private readonly deliveries = new Map<string, DeliveryRecord>();
  private readonly logFile: string;
  private readonly auditFile: string;
  /** Deliveries are sent one at a time per target, so a target that hangs holds up only its own. */
  private readonly queues = new Map<string, Promise<unknown>>();
  /** FR-5: the holders with a request before the owner, and when the owner last declined one. */
  private readonly asking = new Set<string>();
  private readonly declinedAt = new Map<string, number>();

  constructor(deps: BossCatDeps) {
    this.deps = deps;
    const dir = join(deps.home, 'boss-cat');
    this.logFile = join(dir, 'deliveries.jsonl');
    this.auditFile = join(deps.home, 'logs', 'hub-audit.jsonl');
    this.load();
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private load(): void {
    if (!existsSync(this.logFile)) return;
    const content = readFileSync(this.logFile, 'utf8');
    let lines = 0;
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      lines += 1;
      try {
        const record = JSON.parse(line) as DeliveryRecord;
        if (typeof record.id === 'string') this.deliveries.set(record.id, record);
      } catch {
        this.deps.log('Boss Cat: an unreadable delivery log line was skipped');
      }
    }
    // A last line a crash cut short stays on its own, so the next record is not lost with it.
    if (content.length > 0 && !content.endsWith('\n')) appendFileSync(this.logFile, '\n', 'utf8');
    const cutoff = this.now().getTime() - RETENTION_MS;
    const settledToTrim = (record: DeliveryRecord) => !this.open(record) && (record.text !== '' || !(Date.parse(record.at) >= cutoff));
    if (lines > this.deliveries.size || [...this.deliveries.values()].some(settledToTrim)) {
      try {
        this.compact();
      } catch (error) {
        this.deps.log(`Boss Cat: the delivery log was not compacted: ${error instanceof Error ? error.message : 'error'}`);
      }
    }
  }

  /** Whether the hub still sends this delivery, or waits for its answer. */
  private open(record: DeliveryRecord): boolean {
    return record.state === 'accepted' || (record.kind === 'message' && record.state === 'sent');
  }

  /**
   * FR-12: the log keeps each delivery's last state. Settled deliveries lose
   * their text, which the bots' transcripts hold, and leave after 30 days.
   */
  private compact(): void {
    const cutoff = this.now().getTime() - RETENTION_MS;
    const kept: DeliveryRecord[] = [];
    for (const record of this.deliveries.values()) {
      const open = this.open(record);
      if (!open && !(Date.parse(record.at) >= cutoff)) {
        this.deliveries.delete(record.id);
        continue;
      }
      const compacted = open || !record.text ? record : { ...record, text: '' };
      this.deliveries.set(record.id, compacted);
      kept.push(compacted);
    }
    writeFileAtomic(this.logFile, kept.map((record) => `${JSON.stringify(record)}\n`).join(''), { mode: 0o600 });
  }

  /** FR-12: each change of a delivery is appended before anything depends on it. */
  private save(record: DeliveryRecord): void {
    mkdirSync(join(this.logFile, '..'), { recursive: true });
    appendFileSync(this.logFile, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    this.deliveries.set(record.id, record);
  }

  /** FR-9: the hub's record of every call, with ids and outcomes only. */
  private audit(entry: { tool: string; holder: string; target?: string; chain?: string; outcome: string }): void {
    try {
      mkdirSync(join(this.auditFile, '..'), { recursive: true });
      appendFileSync(this.auditFile, `${JSON.stringify({ at: this.now().toISOString(), ...entry })}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch { /* The audit never stops a call. */ }
    this.deps.log(`Boss Cat ${entry.tool} by ${entry.holder}${entry.target ? ` for ${entry.target}` : ''}: ${entry.outcome}`);
  }

  /** A bot's name as the owner sees it in a dialog or a record: one line, short. */
  private name(id: string, length = NAME_LENGTH): string {
    return oneLine(this.deps.bots().find((bot) => bot.id === id)?.name ?? id, length) || id;
  }

  /** A bot as the owner's dialog names it: its name and its id, which no other bot's name can imitate. */
  private label(id: string): string {
    const name = this.name(id);
    return name === id ? id : `${name} (${id})`;
  }

  /** A `cats-hub` call from the bot whose channel carried it. */
  async handle(caller: string, raw: unknown): Promise<ToolAnswer> {
    const call = parseCall(raw);
    if (!call) return refuse('The hub could not read the call.');
    // Only ids reach the audit and the log; the model's other arguments are not kept (FR-9).
    const target = typeof call.args.bot === 'string' && isValidBotId(call.args.bot) ? call.args.bot : undefined;
    const finish = (answer: ToolAnswer): ToolAnswer => {
      const chain = answer.structuredContent?.chain ?? call.args.chain;
      this.audit({
        tool: call.tool, holder: caller,
        ...(target ? { target } : {}),
        ...(isHubRecordId(chain) ? { chain } : {}),
        outcome: answer.isError
          ? `refused: ${oneLine(answer.text, 200)}`
          : answer.structuredContent?.setup === 'owner' ? 'sent to the owner\'s setup' : 'done',
      });
      return answer;
    };
    // FR-3: the holder now, whatever the session still carries.
    if (this.deps.holder() !== caller) return finish(refuse('This bot does not hold the Boss Cat role.'));
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

  /**
   * FR-5: the owner's answer to one request of the holder; null when the
   * owner allowed it and the caller still holds the role, otherwise why not.
   * Each holder has one request before the owner at a time, and one the owner
   * declined is not asked again at once.
   */
  private async ownerAllows(caller: string, question: string, detail: string): Promise<ToolAnswer | null> {
    if (this.asking.has(caller)) return refuse('The owner has not answered your last request yet. Wait for that answer first.');
    const declined = this.declinedAt.get(caller);
    if (declined !== undefined && this.now().getTime() - declined < CONSENT_COOLDOWN_MS) {
      return refuse('The owner declined a request a moment ago. Wait a minute before asking again.');
    }
    this.asking.add(caller);
    let allowed: boolean;
    try {
      allowed = await this.deps.confirm(caller, question, detail);
    } finally {
      this.asking.delete(caller);
    }
    if (!allowed) {
      this.declinedAt.set(caller, this.now().getTime());
      return refuse('The owner declined, or did not answer in time.');
    }
    // FR-3: an answer counts only while the bot that asked still holds the role.
    if (this.deps.holder() !== caller) return refuse('This bot no longer holds the Boss Cat role; nothing was done.');
    return null;
  }

  /** Another bot of this hub, not the caller. */
  private other(caller: string, args: Record<string, unknown>): string {
    const id = args.bot;
    if (typeof id !== 'string' || !isValidBotId(id)) throw new Error('Name another bot by the id hub_list_bots returns.');
    if (id === caller) throw new Error('These tools act on other bots, not on the Boss Cat itself.');
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
    let messages: number;
    if (typeof args.chain === 'string' && args.chain) {
      const chain = [...this.deliveries.values()].filter((record) => record.chainId === args.chain);
      // FR-8: only the holder starts chains, and continues its own.
      if (chain.length === 0 || chain.find((record) => record.hop === 1)?.from !== caller) return refuse('That chain is unknown.');
      chainId = args.chain;
      messages = chain.filter((record) => record.kind === 'message').length;
    } else {
      chainId = `chain-${randomUUID().slice(0, 12)}`;
      messages = 0;
    }
    // FR-8: each delivery is a hop, and every message brings one reply, also one still on its way;
    // a message is taken only with room for its reply.
    const hop = messages * 2 + 1;
    if (hop + 1 > limits.hopsPerChain) {
      return refuse(`This chain reached its limit of ${limits.hopsPerChain} hops. Start a new one, or ask the owner to raise the limit.`);
    }
    const hourAgo = this.now().getTime() - 3_600_000;
    const recent = [...this.deliveries.values()]
      .filter((record) => record.kind === 'message' && record.from === caller && Date.parse(record.at) > hourAgo).length;
    if (recent >= limits.messagesPerHour) {
      return refuse(`The Boss Cat sent ${recent} messages in the last hour, its limit. Try again later, or ask the owner to raise the limit.`);
    }
    const record: DeliveryRecord = {
      id: `delivery-${randomUUID().slice(0, 12)}`, kind: 'message', chainId, hop,
      from: caller, fromName: this.name(caller, RECORD_NAME_LENGTH), to: target, conversationId, text, state: 'accepted', at: this.now().toISOString(),
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
    const previous = this.queues.get(record.to) ?? Promise.resolve();
    const task = previous.then(async () => {
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
        this.deps.log(`Boss Cat: delivery ${current.id} to ${current.to} waits: ${error instanceof Error ? oneLine(error.message, 200) : 'error'}`);
        return false;
      }
    });
    const settled = task.catch(() => undefined);
    this.queues.set(record.to, settled);
    void settled.then(() => {
      if (this.queues.get(record.to) === settled) this.queues.delete(record.to);
    });
    return task;
  }

  /** FR-8: a message's answer, or why there is none, returns to the bot that sent it. */
  private async answer(message: DeliveryRecord, state: WorkItemState, reply: string | null, error: string | null): Promise<void> {
    if (message.kind !== 'message' || (message.state !== 'sent' && message.state !== 'accepted')) return;
    const settled = state === 'completed' ? 'answered' : 'failed';
    // A sender archived since has nothing waiting for the reply, and its id may be given to a new bot.
    if (!this.deps.bots().some((bot) => bot.id === message.from)) {
      this.save({ ...message, state: settled, reason: 'its sender is no longer active' });
      return;
    }
    // FR-12: the reply is recorded, under an id of its message's, before the message counts as answered,
    // so a hub that stops in between finds the message open again and the reply already there.
    const replyId = `reply-${message.id}`;
    let replyRecord = this.deliveries.get(replyId);
    if (!replyRecord) {
      const text = state === 'completed'
        ? (reply?.trim() || '(no answer)')
        : `${this.name(message.to)} did not answer: its work on your message ended ${state}${error ? ` (${oneLine(error, 300)})` : ''}.`;
      replyRecord = {
        id: replyId, kind: 'reply', chainId: message.chainId, hop: message.hop + 1,
        from: message.to, fromName: this.name(message.to, RECORD_NAME_LENGTH), to: message.from, conversationId: message.conversationId,
        text: text.slice(0, MAX_TEXT), state: 'accepted', at: this.now().toISOString(),
      };
      this.save(replyRecord);
    }
    this.save({ ...message, state: settled });
    await this.send(replyRecord);
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
      this.deps.log(`Boss Cat: replies of ${botId} not read: ${error instanceof Error ? oneLine(error.message, 200) : 'error'}`);
      return;
    }
    for (const state of states) {
      const message = this.deliveries.get(state.deliveryId);
      // A core answers only for what was sent to it.
      if (message?.kind === 'message' && message.to === botId && SETTLED.includes(state.state)) {
        await this.answer(message, state.state, state.reply, state.error);
      }
    }
  }

  /**
   * FR-12: a bot that was archived, or that the hub gave up restarting. What
   * still waits for it fails back to its sender. An archived bot's id may
   * later be given to a new bot, so its deliveries end there too: replies on
   * their way to it are dropped, and its own messages bring no reply. A bot
   * the hub gave up on keeps its replies for when the owner starts it again.
   */
  async targetGone(botId: string, reason: string, { archived }: { archived: boolean }): Promise<void> {
    for (const record of [...this.deliveries.values()]) {
      const open = record.state === 'accepted' || (record.kind === 'message' && record.state === 'sent');
      if (!open) continue;
      if (record.kind === 'message' && record.to === botId) {
        await this.answer(record, 'failed', null, reason);
      } else if (archived && record.kind === 'reply' && record.to === botId) {
        this.save({ ...record, state: 'failed', reason });
      } else if (archived && record.kind === 'message' && record.from === botId) {
        this.save({ ...record, state: 'failed', reason: 'its sender was archived' });
      }
    }
  }

  private async create(caller: string, args: Record<string, unknown>): Promise<ToolAnswer> {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    const persona = typeof args.persona === 'string' ? args.persona.trim() : '';
    const provider = typeof args.provider === 'string' ? args.provider : '';
    // The New bot window and the Bot tab take 40 characters, as the first run does.
    if (!name || name.length > NAME_LENGTH || !isPlainLine(name)) {
      return refuse('The new bot needs a name of one line, at most 40 characters, whose every character shows.');
    }
    if (persona.length > 4_000) return refuse('The persona is too long.');
    if (!CLI_PROVIDERS.some((entry) => entry.id === provider)) {
      return refuse(`Choose one of these providers: ${CLI_PROVIDERS.map((entry) => entry.id).join(', ')}.`);
    }
    if (this.deps.atBotCap()) return refuse('The owner\'s bots are at the bot cap; the owner can archive one first.');
    // FR-4: a New bot window the owner has open is not replaced, so the owner is not asked for nothing.
    const setup = this.deps.setupNeeded(provider);
    if (setup === 'busy') return refuse(BUSY_WINDOW);
    // FR-5: the owner decides. What the holder wrote stays in the detail, quoted and marked as the holder's.
    const holder = this.label(caller);
    const refusal = await this.ownerAllows(caller, `${holder} asks to create a new bot.`, [
      `Name: ${oneLine(name, NAME_LENGTH)}`,
      `Provider: ${provider}`,
      ...(setup === 'window' ? [`This computer does not have ${provider} yet; the New bot window opens to set it up.`] : []),
      ...(persona ? [`Persona, as ${holder} wrote it: "${oneLine(persona, PERSONA_PREVIEW)}"`] : []),
    ].join('\n'));
    if (refusal) return refusal;
    // The hub decides again: PATH or the owner's windows can change while the dialog is open.
    const created = await this.deps.createBot({ name, persona, provider });
    if ('setup' in created) {
      return created.setup === 'opened'
        ? ok(`${provider} is not set up on this computer yet. The owner now has the New bot window, filled in for ${oneLine(name, NAME_LENGTH)}; the bot is created when the owner finishes its setup there.`, { setup: 'owner' })
        : refuse(BUSY_WINDOW);
    }
    return ok(`Created ${oneLine(name, NAME_LENGTH)} (${created.id}). It runs with desktop control and Telegram off.`, { bot: created.id });
  }

  private async start(caller: string, args: Record<string, unknown>): Promise<ToolAnswer> {
    const target = this.other(caller, args);
    if (this.deps.core(target)) return ok(`${this.name(target)} is already running.`);
    const blocked = this.deps.startBlocked(target);
    if (blocked) return refuse(`${this.name(target)} cannot be started now. ${blocked}`);
    // FR-5 and D26: a stopped bot starts only with the owner's consent.
    const refusal = await this.ownerAllows(caller, `${this.label(caller)} asks to start ${this.label(target)}.`, '');
    if (refusal) return refusal;
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
      ? `${this.label(caller)} proposes that ${this.label(proposed)} take over the Boss Cat role.`
      : `${this.label(caller)} proposes that no bot hold the Boss Cat role.`;
    const refusal = await this.ownerAllows(caller, question, '');
    if (refusal) return refusal;
    await this.deps.setHolder(proposed);
    return ok(proposed ? `${this.name(proposed)} now holds the Boss Cat role.` : 'No bot holds the Boss Cat role now.');
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
  if (typeof value.tool !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/u.test(value.tool)) return null;
  if (typeof value.conversationId !== 'string' || !value.conversationId || value.conversationId.length > 200) return null;
  const args = value.args && typeof value.args === 'object' && !Array.isArray(value.args) ? value.args as Record<string, unknown> : {};
  return { tool: value.tool, args, conversationId: value.conversationId };
}
