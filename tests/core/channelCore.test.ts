import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { after, before, test } from 'node:test';

import { HostChannelClient } from '../../src/core/host-api/channel.ts';
import { secretsPath } from '../../src/core/secrets.ts';
import type { BotHostEvent, ConversationRecord, TelegramSettingsStatus, TranscriptEntry, WorkItem } from '../../src/core/types.ts';
import { makeTempHome, openTestBot, type TempHome } from '../support/harness.ts';

// SPEC-008 FR-12 to FR-14 and FR-20 with a real core on the fake runtime: a host drives it
// only through the channel.

let home: TempHome;
before(() => {
  home = makeTempHome('cats-bot-channel-core-');
});
after(() => home.cleanup());

const host = { pid: process.pid, executable: process.execPath, installationId: null };
const fakeCipher = {
  label: 'test-cipher',
  encrypt: (plain: string) => Buffer.from(`enc:${plain}`),
  decrypt: (data: Buffer) => data.toString('utf8').slice(4),
};

function turnCompleted(client: HostChannelClient, conversationId: string): Promise<WorkItem> {
  return new Promise((resolve) => {
    const off = client.onEvent((event: BotHostEvent) => {
      if (event.type === 'turn.completed' && event.conversationId === conversationId) { off(); resolve(event.workItem); }
    });
  });
}

test('a host runs a conversation through the channel alone', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'remote' });
  await core.start();
  const client = await HostChannelClient.connect(core.paths.root, { host });
  try {
    const conversation = await client.call('createConversation', 'Chat') as ConversationRecord;
    const done = turnCompleted(client, conversation.id);
    const sent = await client.call('sendOwnerMessage', conversation.id, 'hello over the channel') as WorkItem;
    const completed = await done;
    assert.equal(completed.id, sent.id);
    assert.equal(completed.state, 'completed');
    const transcript = await client.call('transcript', conversation.id) as TranscriptEntry[];
    assert.ok(transcript.some((entry) => entry.kind === 'owner' && entry.text === 'hello over the channel'));
    assert.ok(transcript.some((entry) => entry.kind === 'bot'));
    const status = await client.call('status') as { id: string; queue: { running: unknown } };
    assert.equal(status.id, 'remote');
    assert.equal(status.queue.running, null);
  } finally { client.close(); await core.stop(); }
});

test('secrets are encrypted by the host\'s cipher when the core has none of its own (FR-20)', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'secret', core: { hostCipher: 'test-cipher', channel: { hostRequestTimeoutMs: 5_000 } } });
  await core.start();
  const client = await HostChannelClient.connect(core.paths.root, { host, services: { cipher: fakeCipher } });
  try {
    const status = await client.call('setTelegramToken', '123:abc') as TelegramSettingsStatus;
    assert.equal(status.tokenStored, true);
    assert.equal(status.protection, 'os');
    const stored = JSON.parse(readFileSync(secretsPath(core.paths.root), 'utf8')) as { entries: Record<string, { cipher: string; value: string }> };
    const entry = stored.entries.telegramBotToken!;
    assert.equal(entry.cipher, 'test-cipher');
    assert.equal(Buffer.from(entry.value, 'base64').toString('utf8'), 'enc:123:abc', 'the host encrypted it');
  } finally { client.close(); await core.stop(); }
});

test('two cores in one root each serve only their own host', async () => {
  const one = openTestBot({ botsHome: home.botsHome, id: 'one' }).core;
  const two = openTestBot({ botsHome: home.botsHome, id: 'two' }).core;
  await one.start();
  await two.start();
  const clientOne = await HostChannelClient.connect(one.paths.root, { host });
  const clientTwo = await HostChannelClient.connect(two.paths.root, { host });
  try {
    const seenByTwo: string[] = [];
    clientTwo.onEvent((event) => {
      if (event.type === 'turn.completed') seenByTwo.push(event.workItem.id);
    });
    const done = turnCompleted(clientOne, 'home');
    const sent = await clientOne.call('sendOwnerMessage', 'home', 'only for one') as WorkItem;
    await done;
    assert.equal(seenByTwo.includes(sent.id), false);
    assert.equal(((await clientTwo.call('status')) as { id: string }).id, 'two');
  } finally {
    clientOne.close();
    clientTwo.close();
    await one.stop();
    await two.stop();
  }
});

test('a host hands the core the directory of a provider CLI its setup found (ADR-006)', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'paths' });
  await core.start();
  const client = await HostChannelClient.connect(core.paths.root, { host });
  const before = process.env.PATH;
  try {
    const directory = join(home.root, 'cli-bin');
    assert.equal(await client.call('useCommandDirectory', directory), null);
    assert.equal(process.env.PATH?.split(delimiter)[0], directory, 'later Runtime starts find the CLI first');
    await client.call('useCommandDirectory', directory);
    assert.equal(process.env.PATH?.split(delimiter).filter((entry) => entry === directory).length, 1);
    await assert.rejects(client.call('useCommandDirectory', join('relative', 'bin')), /one absolute path/u);
    await assert.rejects(client.call('useCommandDirectory', `${directory}${delimiter}${directory}`), /one absolute path/u);
  } finally {
    process.env.PATH = before;
    client.close();
    await core.stop();
  }
});

test('a host reports the hub language over the channel, checked like any command (SPEC-008 FR-28)', async () => {
  const { core } = openTestBot({ botsHome: home.botsHome, id: 'hublang' });
  await core.start();
  const client = await HostChannelClient.connect(core.paths.root, { host });
  try {
    assert.equal(await client.call('setHubLanguage', { reply: 'ko', display: 'en' }), null);
    assert.deepEqual((await core.getProfile()).hubLanguage, { reply: 'ko', display: 'en' });
    await assert.rejects(client.call('setHubLanguage', { reply: 'klingon', display: 'en' }), /supported languages/u);
    await assert.rejects(client.call('setHubLanguage', { reply: null, display: 'ja' }), /supported languages/u);
    assert.equal(await client.call('setHubLanguage', { reply: null, display: 'en', extra: 1 }), null);
    assert.deepEqual((await core.getProfile()).hubLanguage, { reply: null, display: 'en' }, 'other keys are not kept');
  } finally {
    client.close();
    await core.stop();
  }
});
