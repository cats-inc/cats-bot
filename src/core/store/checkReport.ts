import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BotPaths } from './paths.ts';

/**
 * SPEC-014 FR-13: where the report of a check of the state database that failed is written,
 * and how a host finds it. Files only: the hub asks this of a core that stopped, and never
 * opens the database itself.
 */

const CHECK_REPORT = /^state-check-(\d{8}T\d{6}\d{3}Z)\.txt$/u;

/**
 * A file named after a time more than this after now was written by a clock set forward; it
 * is never taken for the newest, which would keep it so until the clock caught up.
 */
export const CLOCK_SLACK_MS = 24 * 3_600_000;

/** The report of a check that failed at `at`, in the bot's folder. */
export function checkReportFile(paths: BotPaths, at: Date): string {
  return join(paths.root, `state-check-${timeStamp(at)}.txt`);
}

/**
 * The newest report of a check that failed, written at `since` or later, or null. The hub
 * asks this of a core that stopped, so as not to start it again on a damaged database. A
 * report named after a time to come is not one of this start's.
 */
export function checkReportSince(paths: BotPaths, since: Date, now = new Date()): string | null {
  if (!existsSync(paths.root)) return null;
  const latest = now.getTime() + CLOCK_SLACK_MS;
  const found = readdirSync(paths.root)
    .map((name) => ({ name, at: parseTimeStamp(CHECK_REPORT.exec(name)?.[1] ?? '') }))
    .filter(
      (report) =>
        report.at !== null &&
        report.at.getTime() >= since.getTime() &&
        report.at.getTime() <= latest,
    )
    .sort((a, b) => b.at!.getTime() - a.at!.getTime());
  return found[0] ? join(paths.root, found[0].name) : null;
}

/** A time as the state's file names carry it: `20261112T080000000Z`. */
export function timeStamp(at: Date): string {
  return at.toISOString().replace(/[-:.]/gu, '');
}

export function parseTimeStamp(text: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/u.exec(text);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, millisecond] = match;
  const at = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}.${millisecond}Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}
