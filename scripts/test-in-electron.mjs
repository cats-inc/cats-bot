#!/usr/bin/env node
/**
 * Runs test files inside the Electron this package ships, in its Node.js mode, which is
 * where the bot core runs. Its Node.js and SQLite are not the ones `npm test` uses.
 * Usage: node scripts/test-in-electron.mjs <test file>...
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The arguments that are not existing files. A pattern or a renamed file would otherwise run nothing, quietly. */
export function missingFiles(files) {
  return files.filter((file) => {
    try {
      return !statSync(file).isFile();
    } catch {
      return true;
    }
  });
}

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
 * The files that defined no test. The runner reports such a file as one passing test whose
 * name is the file's path, so the counts alone cannot show it.
 */
export function filesWithoutTests(output, files) {
  const reported = [...output.matchAll(/^(?:not )?ok \d+ - (.+)$/gmu)]
    // TAP escapes a backslash and a `#` in a name with a backslash.
    .map((match) => resolve(match[1].replace(/\\(.)/gu, '$1')));
  return files.filter((file) => reported.includes(resolve(file)));
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

async function output(child) {
  let text = '';
  child.stdout.on('data', (chunk) => {
    text += chunk;
  });
  const [code, signal] = await once(child, 'close');
  return { code, signal, text };
}

async function main(files) {
  if (files.length === 0) {
    console.error('Usage: node scripts/test-in-electron.mjs <test file>...');
    return 2;
  }
  const missing = missingFiles(files);
  if (missing.length > 0) {
    console.error(`Not a test file: ${missing.join(', ')}. Name each file; patterns are not expanded.`);
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

  // The binary itself says what it is, so the tests cannot have run somewhere else.
  const asked = await output(
    spawn(electron, ['-p', 'process.versions.electron'], { env, stdio: ['ignore', 'pipe', 'inherit'] }),
  );
  if (asked.code !== 0 || asked.text.trim() !== version) {
    console.error(
      `${electron} is not Electron ${version} in its Node.js mode: it answered ${JSON.stringify(asked.text.trim())}.`,
    );
    return 1;
  }

  const child = spawn(electron, ['--test', '--test-reporter=tap', ...files], {
    env,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(chunk));
  const { code, signal, text } = await output(child);
  const summary = readTapSummary(text);
  const problem = electronRunProblem({ code, signal, summary, empty: filesWithoutTests(text, files) });
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
