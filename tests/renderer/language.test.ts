import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';
import {
  LANGUAGE_OPTIONS,
  replyLanguageInstruction,
  resolveBotReplyLanguage,
  resolveHubReplyLanguage,
  resolveLocale,
  translate,
  zhTW,
} from '../../src/shared/language.ts';
import { acceptLanguage, conversationTitle, t } from '../../src/renderer/localeStore.ts';

test('language choices and system locale resolution match Desktop, including Traditional and Simplified Chinese', () => {
  assert.deepEqual(
    LANGUAGE_OPTIONS.map((option) => option.value),
    ['system', 'en', 'zh-TW'],
  );
  for (const locale of ['zh', 'zh-TW', 'zh_HK', 'zh-Hant', 'zh-Hant-MO'])
    assert.equal(resolveLocale('system', locale), 'zh-TW');
  for (const locale of ['en-US', 'ja', 'zh-CN', 'zh-Hans'])
    assert.equal(resolveLocale('system', locale), 'en');
  assert.equal(resolveLocale('en', 'zh-TW'), 'en');
  assert.equal(resolveLocale('zh-TW', 'en-US'), 'zh-TW');
});

test('switching locale updates product copy while retaining owner names and message text', () => {
  acceptLanguage({ preference: 'zh-TW', locale: 'zh-TW' });
  try {
    assert.equal(t('New conversation'), '新增對話');
    assert.equal(conversationTitle({ role: 'home', title: 'Home' }), '私訊');
    assert.equal(conversationTitle({ role: 'home', title: 'My private desk' }), 'My private desk');
    assert.equal(conversationTitle({ role: 'note', title: 'Home' }), 'Home');
    assert.equal(translate('zh-TW', 'Install {name}', { name: 'Claude Code' }), '安裝 Claude Code');
    assert.equal(
      translate('zh-TW', 'A provider returned this message'),
      'A provider returned this message',
    );
  } finally {
    acceptLanguage({ preference: 'en', locale: 'en' });
  }
  assert.equal(t('New conversation'), 'New conversation');
});

test('all literal UI translation keys have a Traditional Chinese entry', () => {
  const root = fileURLToPath(new URL('../../src/', import.meta.url));
  const missing = new Set<string>();
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/u.test(path)) {
        const source = ts.createSourceFile(
          path,
          readFileSync(path, 'utf8'),
          ts.ScriptTarget.Latest,
          true,
        );
        function visit(node: ts.Node) {
          if (ts.isCallExpression(node) && node.expression.getText(source) === 't') {
            const key = node.arguments[0];
            if (key && ts.isStringLiteral(key) && !Object.hasOwn(zhTW, key.text))
              missing.add(key.text);
          }
          ts.forEachChild(node, visit);
        }
        visit(source);
      }
    }
  }
  walk(root);
  assert.deepEqual([...missing], []);
});

test('reply languages resolve like Desktop, and the instruction keeps Desktop wording (SPEC-008 FR-28)', () => {
  assert.equal(resolveHubReplyLanguage('display', 'zh-TW'), 'zh-TW');
  assert.equal(resolveHubReplyLanguage('ja', 'zh-TW'), 'ja');
  assert.equal(resolveHubReplyLanguage('unspecified', 'zh-TW'), null);
  assert.equal(resolveBotReplyLanguage('hub', { reply: 'ko', display: 'en' }), 'ko');
  assert.equal(resolveBotReplyLanguage('display', { reply: 'ko', display: 'zh-TW' }), 'zh-TW');
  assert.equal(resolveBotReplyLanguage('hub', null), null);
  assert.equal(resolveBotReplyLanguage('display', null), null);
  assert.equal(resolveBotReplyLanguage('fr', null), 'fr');
  assert.equal(resolveBotReplyLanguage('unspecified', { reply: 'ko', display: 'en' }), null);
  assert.equal(replyLanguageInstruction(null), null);
  assert.equal(
    replyLanguageInstruction('zh-TW'),
    'Reply to the user in Traditional Chinese unless the user explicitly asks for another language. '
      + 'Keep code, paths, commands, identifiers, logs, and quoted source text unchanged unless translation is explicitly requested.',
  );
});
