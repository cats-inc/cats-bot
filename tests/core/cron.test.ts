import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cronMatches, nextCronOccurrence, parseCron, wallClockToInstant, zonedParts } from '../../src/core/life/cron.ts';

test('parseCron accepts the usual field syntax and rejects garbage', () => {
  const fields = parseCron('*/15 9-17 1,15 * mon-fri');
  assert.deepEqual([...fields.minutes], [0, 15, 30, 45]);
  assert.deepEqual([...fields.hours], [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual([...fields.days], [1, 15]);
  assert.deepEqual([...fields.weekdays], [1, 2, 3, 4, 5]);
  assert.equal(fields.dayRestricted, true);
  assert.equal(fields.weekdayRestricted, true);
  assert.deepEqual([...parseCron('0 0 * * 7').weekdays], [0], 'weekday 7 means Sunday');
  assert.throws(() => parseCron('* * * *'), /five fields/u);
  assert.throws(() => parseCron('60 * * * *'), /out of range/u);
  assert.throws(() => parseCron('* * * * x'), /Invalid cron token/u);
});

test('zonedParts and wallClockToInstant agree across a DST change', () => {
  // 2026-03-08 02:30 does not exist in New York; the instant lands after the jump.
  const instant = wallClockToInstant({ year: 2026, month: 3, day: 8, hour: 3, minute: 30 }, 'America/New_York');
  const parts = zonedParts(instant, 'America/New_York');
  assert.equal(parts.hour, 3);
  assert.equal(parts.minute, 30);
  const taipei = zonedParts(new Date('2026-10-27T16:05:00.000Z'), 'Asia/Taipei');
  assert.deepEqual([taipei.year, taipei.month, taipei.day, taipei.hour, taipei.minute, taipei.weekday], [2026, 10, 28, 0, 5, 3]);
});

test('nextCronOccurrence finds the next wall-clock match in the zone (FR-21)', () => {
  const after = new Date('2026-10-27T01:00:00.000Z'); // 09:00 Taipei, Tuesday
  const daily = nextCronOccurrence(parseCron('30 8 * * *'), after, 'Asia/Taipei');
  assert.equal(daily?.toISOString(), '2026-10-28T00:30:00.000Z', 'tomorrow 08:30 Taipei');
  const weekday = nextCronOccurrence(parseCron('0 9 * * mon'), after, 'Asia/Taipei');
  assert.equal(weekday?.toISOString(), '2026-11-02T01:00:00.000Z', 'next Monday 09:00 Taipei');
  const everyMinute = nextCronOccurrence(parseCron('* * * * *'), after, 'UTC');
  assert.equal(everyMinute?.toISOString(), '2026-10-27T01:01:00.000Z');
  const monthly = nextCronOccurrence(parseCron('0 0 1 1 *'), after, 'UTC');
  assert.equal(monthly?.toISOString(), '2027-01-01T00:00:00.000Z');
  const newYork = nextCronOccurrence(parseCron('0 9 * * *'), new Date('2026-03-07T20:00:00.000Z'), 'America/New_York');
  assert.equal(newYork?.toISOString(), '2026-03-08T13:00:00.000Z', '09:00 EDT the morning after the DST change');
  assert.ok(cronMatches(parseCron('0 9 * * *'), zonedParts(newYork!, 'America/New_York')));
  assert.equal(nextCronOccurrence(parseCron('0 0 31 2 *'), after, 'UTC'), null, 'never matches');
});
