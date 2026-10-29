import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { writeHandoff } from '../../src/core/store/lock.ts';
import { resolveBotRoot } from '../../src/core/store/paths.ts';

import { FileSecretStore, SECRET_TELEGRAM_TOKEN, secretsPath, type AsyncSecretCipher, type SecretCipher } from '../../src/core/secrets.ts';
import { makeTempHome, openTestBot, type TempHome } from '../support/harness.ts';

let home: TempHome;
before(() => {
  home = makeTempHome('cats-bot-secrets-');
});
after(() => home.cleanup());

const flipCipher: SecretCipher = {
  label: 'test-flip',
  encrypt: (plain) => Buffer.from(Buffer.from(plain, 'utf8').map((byte) => byte ^ 0x5a)),
  decrypt: (cipher) => Buffer.from(cipher.map((byte) => byte ^ 0x5a)).toString('utf8'),
};

test('a plain file store round-trips a secret without writing it in clear text as a plain key', () => {
  const store = new FileSecretStore(home.botsHome);
  assert.equal(store.protection(), 'file');
  assert.equal(store.has(SECRET_TELEGRAM_TOKEN), false);
  store.set(SECRET_TELEGRAM_TOKEN, '123456:ABC-DEF');
  assert.equal(store.get(SECRET_TELEGRAM_TOKEN), '123456:ABC-DEF');
  const raw = readFileSync(secretsPath(home.botsHome), 'utf8');
  assert.doesNotMatch(raw, /123456:ABC-DEF/u, 'the file holds the base64 form, not the raw token');
  store.delete(SECRET_TELEGRAM_TOKEN);
  assert.equal(store.get(SECRET_TELEGRAM_TOKEN), null);
});

test('a cipher-backed store encrypts, and a host without that cipher cannot read the value', () => {
  const warnings: string[] = [];
  const protectedStore = new FileSecretStore(home.botsHome, { cipher: flipCipher });
  assert.equal(protectedStore.protection(), 'os');
  protectedStore.set('apiKey', 'secret-value');
  assert.equal(protectedStore.get('apiKey'), 'secret-value');
  const raw = readFileSync(secretsPath(home.botsHome), 'utf8');
  assert.match(raw, /"cipher": "test-flip"/u);
  assert.doesNotMatch(raw, /secret-value/u);
  const plain = new FileSecretStore(home.botsHome, { warn: (line) => warnings.push(line) });
  assert.equal(plain.get('apiKey'), null);
  assert.equal(plain.has('apiKey'), true);
  assert.match(warnings[0] ?? '', /protected with test-flip/u);
});

test('a host with a cipher re-stores plain entries encrypted and reports what is actually stored', () => {
  const root = join(home.botsHome, 'upgrade');
  mkdirSync(root, { recursive: true });
  const cli = new FileSecretStore(root);
  cli.set(SECRET_TELEGRAM_TOKEN, '777:plain-token');
  assert.equal(cli.protectionOf(SECRET_TELEGRAM_TOKEN), 'file');
  assert.equal(cli.protectionOf('missing'), null);
  assert.equal(cli.protectAtRest(), 0, 'without a cipher nothing can be upgraded');

  const shell = new FileSecretStore(root, { cipher: flipCipher });
  assert.equal(shell.protectionOf(SECRET_TELEGRAM_TOKEN), 'file', 'capability is not protection');
  assert.equal(shell.protectAtRest(), 1);
  assert.equal(shell.protectAtRest(), 0, 'an encrypted entry is left alone');
  const raw = readFileSync(secretsPath(root), 'utf8');
  assert.doesNotMatch(raw, /"cipher": "none"/u);
  assert.match(raw, /"cipher": "test-flip"/u);
  assert.equal(shell.get(SECRET_TELEGRAM_TOKEN), '777:plain-token');
  assert.equal(shell.protectionOf(SECRET_TELEGRAM_TOKEN), 'os');
  assert.equal(cli.protectionOf(SECRET_TELEGRAM_TOKEN), 'os', 'a host without the cipher still reports the stored protection');
});

test('telegramStatus reports the stored token protection, and a reloadToken handoff encrypts a token the CLI wrote', async () => {
  const id = 'sealed';
  const root = resolveBotRoot(id, { CATS_BOT_HOME: home.root });
  const { core } = openTestBot({
    botsHome: home.botsHome,
    id,
    core: { secrets: new FileSecretStore(root, { cipher: flipCipher }) },
  });
  new FileSecretStore(root).set(SECRET_TELEGRAM_TOKEN, '888:from-the-cli');
  assert.equal(core.telegramStatus().protection, 'file', 'the CLI stored it without encryption');
  await core.start();
  try {
    writeHandoff(core.paths, { kind: 'telegram', payload: { reloadToken: true } });
    const deadline = Date.now() + 10_000;
    while (core.telegramStatus().protection !== 'os') {
      if (Date.now() > deadline) throw new Error('the handoff did not re-store the token encrypted');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.doesNotMatch(readFileSync(secretsPath(root), 'utf8'), /"cipher": "none"/u);
  } finally {
    await core.stop();
  }
});

// The review of PLAN-009 1.2: a host's cipher answers later, so nothing may write an old copy.
function gatedCipher() {
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => { open = resolve; });
  const cipher: AsyncSecretCipher = {
    label: 'host',
    encrypt: async (plain) => {
      await gate;
      return Buffer.from(`enc:${plain}`);
    },
    decrypt: async (data) => data.toString('utf8').slice(4),
  };
  return { cipher, open: () => open() };
}

test('an upgrade that waits for the host cipher keeps a secret deleted or set meanwhile', async () => {
  const root = join(home.root, 'race-upgrade');
  mkdirSync(root, { recursive: true });
  const plain = new FileSecretStore(root);
  plain.set('cleared', 'T1-old');
  plain.set('replaced', 'B-old');
  plain.set('kept', 'K-old');
  const { cipher, open } = gatedCipher();
  const store = new FileSecretStore(root, { asyncCipher: cipher });
  const upgrading = store.protectAtRestAsync();
  store.delete('cleared');
  const setting = store.setAsync('replaced', 'B-new');
  open();
  await Promise.all([upgrading, setting]);
  assert.equal(await store.getAsync('cleared'), null, 'a deleted secret stays deleted');
  assert.equal(await store.getAsync('replaced'), 'B-new');
  assert.equal(await store.getAsync('kept'), 'K-old');
  assert.equal(store.protectionOf('kept'), 'os', 'an untouched secret is still upgraded');
});

test('the last set of a secret wins, even when an earlier one is still being encrypted', async () => {
  const root = join(home.root, 'race-set');
  mkdirSync(root, { recursive: true });
  let release: () => void = () => {};
  const slow = new Promise<void>((resolve) => { release = resolve; });
  const store = new FileSecretStore(root, {
    asyncCipher: {
      label: 'host',
      encrypt: async (plain) => {
        if (plain === 'first') await slow;
        return Buffer.from(`enc:${plain}`);
      },
      decrypt: async (data) => data.toString('utf8').slice(4),
    },
  });
  const first = store.setAsync('token', 'first');
  await store.setAsync('token', 'second');
  release();
  await first;
  assert.equal(await store.getAsync('token'), 'second');
  const third = store.setAsync('token', 'first');
  store.delete('token');
  release();
  await third;
  assert.equal(store.has('token'), false, 'a delete after a set still in flight wins');
});

test('a token handed off while no host serves the cipher still starts Telegram (review of 1.2)', async () => {
  // A Telegram API that holds every long poll until it is aborted.
  const fakeFetch = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  })) as unknown as typeof fetch;
  const logs: string[] = [];
  const { core } = openTestBot({
    botsHome: home.botsHome, id: 'reload-no-host',
    core: {
      telegram: { fetch: fakeFetch, apiBaseUrl: 'http://127.0.0.1:9' },
      hostCipher: 'host-label', channel: { hostRequestTimeoutMs: 300 },
      handoffPollMs: 50,
      log: (line: string) => logs.push(line),
    },
  });
  await core.updateProfile({ telegram: { enabled: true } });
  await core.start();
  try {
    new FileSecretStore(core.paths.root).set(SECRET_TELEGRAM_TOKEN, '123:from-cli');
    writeHandoff(core.paths, { kind: 'telegram', payload: { reloadToken: true } });
    const deadline = Date.now() + 5_000;
    while (!core.status().telegram.polling && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(core.status().telegram.polling, true, logs.join('\n'));
    assert.ok(logs.some((line) => line.includes('secret re-store deferred')), logs.join('\n'));
  } finally { await core.stop(); }
});
