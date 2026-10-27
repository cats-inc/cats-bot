import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';

import { chunkTelegramText } from '../../src/core/transports/telegram.ts';
import { makeTempHome, openTestBot, waitForEvent, type TempHome } from '../support/harness.ts';

/**
 * SPEC-001 FR-19 / FR-26 / A5 on a fake Telegram Bot API: one long-polling
 * consumer, the first private chat becomes the owner, inbound text becomes
 * an owner message in the home conversation, replies are mirrored in order
 * and split at the limit, other chats are ignored.
 */

interface FakeTelegram {
  url: string;
  sent: Array<{ chat_id: number; text: string }>;
  offsets: number[];
  polls: number;
  push(update: Record<string, unknown>): void;
  close(): Promise<void>;
}

function startFakeTelegram(token: string): Promise<FakeTelegram> {
  const queue: Array<{ update_id: number }> = [];
  const sent: FakeTelegram['sent'] = [];
  const offsets: number[] = [];
  let nextUpdateId = 100;
  let polls = 0;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const prefix = `/bot${token}/`;
    if (!url.pathname.startsWith(prefix)) {
      res.writeHead(401);
      res.end(JSON.stringify({ ok: false, description: 'Unauthorized' }));
      return;
    }
    const method = url.pathname.slice(prefix.length);
    const reply = (body: unknown) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (method === 'deleteWebhook') return reply({ ok: true, result: true });
    if (method === 'getUpdates') {
      polls += 1;
      const offset = Number(url.searchParams.get('offset') ?? '0');
      offsets.push(offset);
      const timeoutMs = Math.min(Number(url.searchParams.get('timeout') ?? '1'), 2) * 1_000;
      const deadline = Date.now() + timeoutMs;
      const attempt = () => {
        const ready = queue.filter((update) => update.update_id >= offset);
        if (ready.length > 0 || Date.now() >= deadline) {
          reply({ ok: true, result: ready });
          return;
        }
        setTimeout(attempt, 25);
      };
      attempt();
      return;
    }
    if (method === 'sendMessage') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk; });
      req.on('end', () => {
        const parsed = JSON.parse(body) as { chat_id: number; text: string };
        sent.push(parsed);
        reply({ ok: true, result: { message_id: sent.length } });
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        sent,
        offsets,
        get polls() { return polls; },
        push(update) {
          nextUpdateId += 1;
          queue.push({ update_id: nextUpdateId, ...update });
        },
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function privateMessage(chatId: number, text: string, name = 'Kenny'): Record<string, unknown> {
  return {
    message: {
      message_id: Math.floor(Math.random() * 100_000),
      text,
      chat: { id: chatId, type: 'private', first_name: name },
      from: { id: chatId, first_name: name },
    },
  };
}

async function until(predicate: () => boolean, timeoutMs = 10_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

let home: TempHome;
let telegram: FakeTelegram;
before(async () => {
  home = makeTempHome('cats-bots-telegram-');
  telegram = await startFakeTelegram('123:abc');
});
after(async () => {
  await telegram.close();
  home.cleanup();
});

test('chunkTelegramText splits at the limit, preferring a newline, and keeps order', () => {
  assert.deepEqual(chunkTelegramText('short'), ['short']);
  assert.deepEqual(chunkTelegramText(''), ['']);
  const lines = Array.from({ length: 120 }, (_, index) => `line ${index} ${'x'.repeat(60)}`).join('\n');
  const chunks = chunkTelegramText(lines);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 4_000));
  assert.equal(chunks.join('\n'), lines);
  const solid = chunkTelegramText('y'.repeat(9_000));
  assert.deepEqual(solid.map((chunk) => chunk.length), [4_000, 4_000, 1_000]);
});

test('the owner chat is bound, inbound text becomes a home turn, replies are mirrored in order, other chats are ignored (FR-26, FR-19)', async () => {
  const { core } = openTestBot({
    botsHome: home.botsHome,
    id: 'tg',
    core: {
      turnRetry: { ownerBusyMs: 200, backgroundBusyMs: 200, runtimeUnavailableMs: 200 },
      telegram: { apiBaseUrl: telegram.url, pollTimeoutSeconds: 1 },
    },
  });
  await core.setTelegramToken('123:abc');
  await core.updateProfile({ telegram: { enabled: true } });
  await core.start();
  try {
    assert.equal(core.status().telegram.polling, true);
    assert.equal(core.telegramStatus().tokenStored, true);
    await until(() => telegram.polls >= 1, 5_000, 'first poll');

    telegram.push(privateMessage(42, '/start'));
    await until(() => telegram.sent.length >= 1, 10_000, 'greeting');
    assert.equal(telegram.sent[0]?.chat_id, 42);
    assert.match(telegram.sent[0]?.text ?? '', /This chat is now where I talk to you/u);
    assert.equal((await core.getProfile()).telegram.ownerChatId, 42, 'the binding is persisted');

    const done = waitForEvent(core, (event) => event.type === 'turn.completed' && event.workItem.kind === 'owner_message');
    telegram.push(privateMessage(42, 'hello there'));
    const finished = await done;
    assert.equal(finished.type === 'turn.completed' && finished.workItem.source, 'telegram');
    assert.equal(finished.type === 'turn.completed' && finished.workItem.result?.text, 'echo: hello there');
    await until(() => telegram.sent.some((message) => message.text === 'echo: hello there'), 10_000, 'mirrored reply');
    assert.equal(core.transcript('home').filter((entry) => entry.kind === 'owner').length, 1, 'the owner message is in the home transcript');

    const before = core.listWorkItems().length;
    telegram.push(privateMessage(99, 'let me in', 'Stranger'));
    await until(() => telegram.offsets.at(-1)! > 0 && telegram.polls > 3, 10_000, 'the update was consumed');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(core.listWorkItems().length, before, 'a chat that is not the owner creates no work');
    assert.ok(!telegram.sent.some((message) => message.chat_id === 99));

    const long = 'z'.repeat(4_500);
    const longDone = waitForEvent(core, (event) => event.type === 'turn.completed' && event.workItem.prompt === long);
    await core.sendOwnerMessage('home', long);
    await longDone;
    await until(() => telegram.sent.filter((message) => message.text.startsWith('echo: z') || /^z+$/u.test(message.text)).length >= 2, 10_000, 'two chunks');
    const chunks = telegram.sent.slice(-2);
    assert.ok(chunks[0]!.text.length <= 4_000 && chunks[1]!.text.length <= 4_000);
    assert.equal(chunks[0]!.text + chunks[1]!.text, `echo: ${long}`, 'chunks arrive in order and complete');

    const offsets = telegram.offsets.filter((offset) => offset > 0);
    assert.deepEqual([...offsets], [...offsets].sort((a, b) => a - b), 'offsets only move forward');
    assert.ok(offsets.at(-1)! > offsets[0]!, 'processed updates are acknowledged');
  } finally {
    await core.stop();
  }
  const pollsAfterStop = telegram.polls;
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal(telegram.polls, pollsAfterStop, 'no consumer survives stop');
  assert.equal(core.status().telegram.polling, false);
});
