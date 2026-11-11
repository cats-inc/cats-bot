#!/usr/bin/env node
/**
 * Runs test files inside the Electron this package ships, in its Node.js mode, which is
 * where the bot core runs. Its Node.js and SQLite are not the ones `npm test` uses.
 * Usage: node scripts/test-in-electron.mjs <test file>...
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The counts that end a TAP report, or null when one of them is missing. */
export function readTapSummary(output) {
  const counts = {};
  for (const match of output.matchAll(/^# (tests|pass|fail|cancelled|skipped) (\d+)$/gmu)) {
    counts[match[1]] = Number(match[2]);
  }
  const names = ['tests', 'pass', 'fail', 'cancelled', 'skipped'];
  return names.every((name) => Number.isSafeInteger(counts[name])) ? counts : null;
}

/**
 * The files that defined no test. The runner reports such a file as one passing test named
 * after the file, so the counts alone cannot show it.
 */
export function filesWithoutTests(output, files) {
  const reported = [...output.matchAll(/^(?:not )?ok \d+ - (.+)$/gmu)].map((match) => match[1]);
  return files.filter((file) => reported.some((name) => name.endsWith(basename(file))));
}

/** Why a run does not count as a pass, or null when it does. */
export function electronRunProblem({ code, signal, summary, empty = [] }) {
  if (signal) return `Electron was stopped by ${signal}`;
  if (code !== 0) return `Electron exited with code ${code}`;
  if (!summary) return 'the report has no summary, so nothing shows that a test ran';
  if (summary.tests === 0 || summary.pass === 0) return 'no test ran';
  if (empty.length > 0) return `no test ran in ${empty.join(', ')}`;
  if (summary.fail > 0 || summary.cancelled > 0) {
    return `${summary.fail} failed and ${summary.cancelled} were cancelled`;
  }
  return null;
}

async function main(files) {
  if (files.length === 0) {
    console.error('Usage: node scripts/test-in-electron.mjs <test file>...');
    return 2;
  }
  const require = createRequire(import.meta.url);
  // Throws when the Electron binary was never installed: a missing Electron is a failure here,
  // never a skip.
  const electron = require('electron');
  const { version } = require('electron/package.json');
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  // Set by `node --test` for its children; with it the report would be in the runner's binary format.
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(electron, ['--test', '--test-reporter=tap', ...files], {
    env,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
    process.stdout.write(chunk);
  });
  const [code, signal] = await once(child, 'close');
  const summary = readTapSummary(output);
  const problem = electronRunProblem({ code, signal, summary, empty: filesWithoutTests(output, files) });
  if (problem) {
    console.error(`Tests inside Electron ${version} did not pass: ${problem}.`);
    return 1;
  }
  console.log(`Inside Electron ${version}: ${summary.pass} passed, ${summary.skipped} skipped.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
