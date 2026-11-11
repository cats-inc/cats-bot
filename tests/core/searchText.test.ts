import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildSearchQuery, containsPattern, indexText } from '../../src/core/store/searchText.ts';

/** SPEC-014 FR-8: how an entry's text and a person's query are rewritten for the index. */

test('a CJK run becomes overlapping two-character tokens, set apart from its neighbours', () => {
  assert.equal(indexText('明天去公園散步'), ' 明天 天去 去公 公園 園散 散步 ');
  assert.equal(indexText('plain english kettle'), 'plain english kettle');
  // A Latin word written against a run is a word of its own afterwards.
  assert.equal(indexText('用iPhone拍照'), ' 用 iPhone 拍照 ');
  assert.equal(indexText('版本v1.2.3更新'), ' 版本 v1.2.3 更新 ');
  // Punctuation of those scripts ends a run instead of joining two words.
  assert.equal(indexText('牙醫，公園。'), ' 牙醫 ， 公園 。');
  assert.equal(indexText('「你好」'), '「 你好 」');
  assert.equal(indexText(''), '');
});

test('Japanese and Korean runs are split the same way', () => {
  // The long-vowel mark belongs to the word.
  assert.equal(indexText('コーヒーを飲む'), ' コー ーヒ ヒー ーを を飲 飲む ');
  assert.equal(indexText('한국어 공부'), ' 한국 국어   공부 ');
});

test('a character outside the Basic Multilingual Plane counts as one character', () => {
  const rare = String.fromCodePoint(0x20000);
  assert.equal(indexText(`${rare}字典`), ` ${rare}字 字典 `);
  assert.equal(indexText(rare), ` ${rare} `);
  assert.deepEqual(buildSearchQuery(rare), { match: null, contains: [rare] });
  assert.deepEqual(buildSearchQuery(`${rare}字`), { match: `"${rare}字"`, contains: [] });
});

test('a query asks for every word, with CJK words as phrases of their tokens', () => {
  assert.deepEqual(buildSearchQuery('公園'), { match: '"公園"', contains: [] });
  assert.deepEqual(buildSearchQuery('去公園'), { match: '"去公 公園"', contains: [] });
  assert.deepEqual(buildSearchQuery('牙醫 公園'), { match: '"牙醫" AND "公園"', contains: [] });
  assert.deepEqual(buildSearchQuery('kettle'), { match: '"kettle"', contains: [] });
  assert.deepEqual(buildSearchQuery('  Pro   MacBook '), {
    match: '"Pro" AND "MacBook"',
    contains: [],
  });
  assert.deepEqual(buildSearchQuery('iPhone拍照'), { match: '"拍照" AND "iPhone"', contains: [] });
  // The tokenizer reads the inside of a quoted word as it read the entry.
  assert.deepEqual(buildSearchQuery('v1.2.3'), { match: '"v1.2.3"', contains: [] });
});

test('nothing a person types is read as query syntax', () => {
  assert.deepEqual(buildSearchQuery('say "hello" OR NOT'), {
    match: '"say" AND """hello""" AND "OR" AND "NOT"',
    contains: [],
  });
  assert.deepEqual(buildSearchQuery('terms:kettle*'), { match: '"terms:kettle*"', contains: [] });
  assert.deepEqual(buildSearchQuery('(a) -b ^c'), {
    match: '"(a)" AND "-b" AND "^c"',
    contains: [],
  });
});

test('a single CJK character is looked for as a substring, once', () => {
  assert.deepEqual(buildSearchQuery('園'), { match: null, contains: ['園'] });
  assert.deepEqual(buildSearchQuery('園 園 步'), { match: null, contains: ['園', '步'] });
  assert.deepEqual(buildSearchQuery('園 kettle'), { match: '"kettle"', contains: ['園'] });
  assert.deepEqual(buildSearchQuery('用iPhone'), { match: '"iPhone"', contains: ['用'] });
});

test('input with nothing to look for gives no query', () => {
  assert.equal(buildSearchQuery(''), null);
  assert.equal(buildSearchQuery('   \n\t'), null);
  assert.equal(buildSearchQuery('，。!? ... --'), null);
});

test('a substring pattern treats the wildcard characters as themselves', () => {
  assert.equal(containsPattern('園'), '%園%');
  assert.equal(containsPattern('100%_\\'), '%100\\%\\_\\\\%');
});
