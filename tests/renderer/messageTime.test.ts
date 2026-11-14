import assert from 'node:assert/strict';
import { test } from 'node:test';

import { acceptLanguage } from '../../src/renderer/localeStore.ts';
import { currentDayKey, dayKey, dayLabel, dayStartKeys, messageTime, messageTimestamp, msUntilNextDay, readTime, subscribeDay } from '../../src/renderer/note/messageTime.ts';

/** SPEC-003 FR-13: a message's time to the minute, a divider for each new day, the full time in the tooltip. */

const now = new Date(2026, 10, 14, 9, 30);

function inLocale<T>(locale: 'en' | 'zh-TW', run: () => T): T {
  acceptLanguage({ preference: locale, locale });
  try {
    return run();
  } finally {
    acceptLanguage({ preference: 'en', locale: 'en' });
  }
}

test('a bubble shows hours and minutes, without seconds', () => {
  const at = new Date(2026, 10, 14, 7, 0, 13);
  assert.match(inLocale('en', () => messageTime(at)), /^7:00\sAM$/u);
  assert.equal(inLocale('zh-TW', () => messageTime(at)), '上午7:00');
});

test('the tooltip gives the whole date and time, to the second', () => {
  const at = new Date(2026, 10, 12, 7, 0, 13);
  // "上午" like the bubble, not the "清晨" of Chinese timeStyle.
  assert.equal(inLocale('zh-TW', () => messageTimestamp(at)), '2026年11月12日 星期四 上午7:00:13');
  assert.match(inLocale('en', () => messageTimestamp(at)), /Thursday, November 12, 2026.*7:00:13/u);
});

test('the same 7 AM on two days is told apart by the day divider', () => {
  const today = new Date(2026, 10, 14, 7, 0);
  const earlier = new Date(2026, 10, 12, 7, 0);
  assert.notEqual(dayKey(today), dayKey(earlier));
  assert.equal(dayKey(today), dayKey(new Date(2026, 10, 14, 23, 59)), 'one day runs to local midnight');
  assert.equal(inLocale('en', () => dayLabel(today, now)), 'Today');
  assert.equal(inLocale('zh-TW', () => dayLabel(new Date(2026, 10, 13, 22, 0), now)), '昨天');
  assert.equal(inLocale('zh-TW', () => dayLabel(earlier, now)), '11月12日 星期四');
  assert.match(inLocale('en', () => dayLabel(earlier, now)), /^Thursday, November 12$/u);
  // Another year names the year too.
  assert.match(inLocale('zh-TW', () => dayLabel(new Date(2025, 10, 12, 7, 0), now)), /^2025年11月12日 星期三$/u);
  // Yesterday across a month boundary.
  assert.equal(inLocale('en', () => dayLabel(new Date(2026, 9, 31, 8, 0), new Date(2026, 10, 1, 8, 0))), 'Yesterday');
  // Across New Year: the last day of the old year is Yesterday, the day before it names its year.
  assert.equal(inLocale('zh-TW', () => dayLabel(new Date(2026, 11, 31, 23, 0), new Date(2027, 0, 1, 8, 0))), '昨天');
  assert.match(inLocale('zh-TW', () => dayLabel(new Date(2026, 11, 30, 23, 0), new Date(2027, 0, 1, 8, 0))), /^2026年12月30日 星期三$/u);
});

test('the day clock wakes once just after local midnight and tells only its listeners', (t) => {
  assert.equal(msUntilNextDay(new Date(2026, 10, 14, 23, 59, 0)), 61_000);
  assert.equal(msUntilNextDay(new Date(2026, 10, 30, 12, 0, 0)), 12 * 3600_000 + 1000, 'across a month end');

  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date(2026, 10, 14, 23, 59, 0).getTime() });
  let heard = 0;
  const unsubscribe = subscribeDay(() => { heard += 1; });
  try {
    const before = currentDayKey();
    assert.equal(before, dayKey(new Date(2026, 10, 14)));
    t.mock.timers.tick(30_000);
    assert.equal(heard, 0, 'not before midnight');
    t.mock.timers.tick(31_000);
    assert.equal(heard, 1, 'once, just after midnight');
    assert.equal(currentDayKey(), dayKey(new Date(2026, 10, 15)));
    assert.equal(inLocale('en', () => dayLabel(new Date(2026, 10, 14, 7, 0))), 'Yesterday', 'the old day now reads Yesterday');
    t.mock.timers.tick(3600_000);
    assert.equal(heard, 1, 'nothing more the same day');
  } finally {
    unsubscribe();
  }
});

test('a divider starts each day among the items shown; an item without a readable time starts none', () => {
  const items = [
    { key: 'a', at: new Date(2026, 10, 12, 7, 0) },
    { key: 'b', at: new Date(2026, 10, 12, 9, 0) },
    { key: 'tool', at: null },
    { key: 'c', at: new Date(2026, 10, 13, 7, 0) },
    { key: 'd', at: new Date(2026, 10, 14, 7, 0) },
  ];
  assert.deepEqual([...dayStartKeys(items, (item) => item.at, (item) => item.key)], ['a', 'c', 'd']);
  // A line hidden by the verbose switch is not passed in, so the next shown item starts the day.
  assert.deepEqual([...dayStartKeys(items.filter((item) => item.key !== 'c'), (item) => item.at, (item) => item.key)], ['a', 'd']);
  // A reply sealed after midnight, then a line written while it ran: the day is not started twice.
  const midnight = [
    { key: 'reply', at: new Date(2026, 10, 14, 0, 1) },
    { key: 'line', at: new Date(2026, 10, 13, 23, 59) },
    { key: 'next', at: new Date(2026, 10, 14, 0, 5) },
  ];
  assert.deepEqual([...dayStartKeys(midnight, (item) => item.at, (item) => item.key)], ['reply']);
  assert.equal(readTime('not a time'), null);
  assert.equal(readTime(undefined), null);
  assert.equal(readTime('2026-11-12T23:00:13.000Z')?.toISOString(), '2026-11-12T23:00:13.000Z');
});
