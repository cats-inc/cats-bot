import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * PLAN-014 task 1.7: the measurement of SPEC-014's targets runs, on a small database here;
 * the manual workflow runs it on a million entries on every platform.
 */

const { measure, parseArguments } = (await import(
  new URL('../../scripts/testing/measure-store-performance.mjs', import.meta.url).href
)) as {
  measure(options: { entries: number; json: boolean }): Promise<{
    entries: number;
    appendP95Ms: number;
    newest50Ms: number;
    searchesMs: Record<string, number>;
    runtime: { platform: string };
  }>;
  parseArguments(argv: string[]): { entries: number; json: boolean };
};

test('the store measurement reads its arguments and measures every target', async () => {
  assert.deepEqual(parseArguments([]), { entries: 1_000_000, json: false });
  assert.deepEqual(parseArguments(['--entries', '2000', '--json']), { entries: 2000, json: true });
  assert.throws(() => parseArguments(['--entries', '10']), /at least 100/u);
  assert.throws(() => parseArguments(['--size']), /Unknown argument/u);

  const result = await measure({ entries: 2000, json: true });
  assert.equal(result.entries, 2000);
  assert.ok(result.appendP95Ms >= 0 && result.newest50Ms >= 0);
  assert.deepEqual(Object.keys(result.searchesMs).length, 15);
  assert.equal(result.runtime.platform, process.platform);
});

test('the manual workflow measures on every platform, under Node.js and inside Electron', () => {
  const workflow = readFileSync(
    new URL('../../.github/workflows/store-performance.yaml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /^on:\n {2}workflow_dispatch:/mu);
  for (const os of ['ubuntu-latest', 'windows-latest', 'macos-latest'])
    assert.ok(workflow.includes(os), os);
  assert.match(workflow, /node scripts\/testing\/measure-store-performance\.mjs/u);
  assert.match(workflow, /ELECTRON_RUN_AS_NODE: '1'/u);
  // The input is passed as a variable, never written into the script.
  assert.doesNotMatch(workflow, /run:[^\n]*\$\{\{/u);
  assert.doesNotMatch(workflow, /--entries "\$\{\{/u);
  assert.equal(workflow.match(/ENTRIES: \$\{\{ inputs\.entries \}\}/gu)?.length, 2);
});
