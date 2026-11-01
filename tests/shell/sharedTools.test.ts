import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
const cdp = await import(new URL('../../scripts/testing/bot-renderer-cdp.mjs', import.meta.url).href);
const candidate = await import(new URL('../../scripts/bot-candidate.mjs', import.meta.url).href);

test('Bot CDP defaults to 9223 and selects a note file page ahead of settings/avatar', () => {
  assert.equal(cdp.parseArgs(['info'], {}).port, 9223);
  assert.equal(cdp.parseArgs(['info'], { CATS_BOT_CDP_PORT: '9333' }).port, 9333);
  const pages = ['floating.html', 'settings.html', 'note.html?bot=mochi'].map((name, index) => ({
    id: String(index), type: 'page', url: `file:///fixture/${name}`, webSocketDebuggerUrl: `ws://127.0.0.1:9223/${index}`,
  }));
  assert.equal(cdp.selectPageTarget(pages).id, '2');
  assert.equal(cdp.selectPageTarget(pages, 'settings.html').id, '1');
});

test('Bot candidate requires an explicit private root and rejects unrelated/repeated options', () => {
  assert.throws(() => candidate.parseArgs(['start']), /root/u);
  assert.throws(() => candidate.parseArgs(['stop', '--root', 'a', '--workspace', 'b']));
  assert.throws(() => candidate.parseArgs(['start', '--root', 'a', '--root', 'b']));
  assert.equal(candidate.parseArgs(['--help']).command, 'help');
});

test('every vendored tool and producer license matches its source hash and executable mode', async () => {
  const root = new URL('../../', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('scripts/shared-tools.provenance.json', root), 'utf8'));
  for (const source of manifest.sources) {
    assert.match(source.commit, /^[a-f0-9]{40}$/u);
    for (const file of source.files) {
      const url = new URL(file.path, root);
      assert.equal(createHash('sha256').update(await readFile(url)).digest('hex'), file.sha256, file.path);
      if (process.platform !== 'win32') assert.equal(Boolean((await stat(url)).mode & 0o100), file.executable, file.path);
    }
  }
});
