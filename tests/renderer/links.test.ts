import assert from 'node:assert/strict';
import { test } from 'node:test';

import { imageTarget, linkTarget } from '../../src/renderer/markdown/links.ts';
import { externalUrl } from '../../src/shell/electron/navigationPolicy.ts';

/** SPEC-003 FR-3: only http(s) leaves a note, and only for the system browser. */

test('a reply link opens outside only for http(s); everything else is inert with its target as the title', () => {
  assert.deepEqual(linkTarget('https://example.com/a?b=1'), { kind: 'external', href: 'https://example.com/a?b=1' });
  assert.deepEqual(linkTarget('HTTP://example.com'), { kind: 'external', href: 'HTTP://example.com' });
  for (const href of ['./src/core/bot.ts', 'C:\Users\me\notes.md', 'file:///C:/x', '#section', 'mailto:a@b.c', 'javascript:alert(1)', '']) {
    assert.deepEqual(linkTarget(href), { kind: 'inert', title: href }, href);
  }
  assert.deepEqual(linkTarget(undefined), { kind: 'inert', title: '' });
});

test('images are never loaded: a remote one becomes a link, a local one its label', () => {
  assert.deepEqual(imageTarget('https://example.com/cat.png', 'a cat'), { kind: 'external', href: 'https://example.com/cat.png', label: 'a cat' });
  assert.deepEqual(imageTarget('https://example.com/cat.png', ''), { kind: 'external', href: 'https://example.com/cat.png', label: 'https://example.com/cat.png' });
  assert.deepEqual(imageTarget('./cat.png', 'a cat'), { kind: 'inert', label: 'a cat' });
  assert.deepEqual(imageTarget(undefined, undefined), { kind: 'inert', label: '' });
});

test('the shell hands only http(s) to the system browser', () => {
  assert.equal(externalUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(externalUrl('http://localhost:3000/'), 'http://localhost:3000/');
  for (const url of ['file:///C:/Windows/notepad.exe', 'javascript:alert(1)', 'mailto:a@b.c', 'ms-settings:', 'not a url', '']) {
    assert.equal(externalUrl(url), null, url);
  }
});
