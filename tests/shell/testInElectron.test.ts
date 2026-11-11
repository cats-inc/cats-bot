import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

interface TapSummary {
  tests: number;
  pass: number;
  fail: number;
  cancelled: number;
  skipped: number;
}

// The script is plain JavaScript, like the other CI scripts.
const { electronRunProblem, filesWithoutTests, readTapSummary } = (await import(
  new URL('../../scripts/test-in-electron.mjs', import.meta.url).href
)) as {
  readTapSummary(output: string): TapSummary | null;
  filesWithoutTests(output: string, files: string[]): string[];
  electronRunProblem(run: {
    code: number | null;
    signal: string | null;
    summary: TapSummary | null;
    empty?: string[];
  }): string | null;
};

/**
 * `scripts/test-in-electron.mjs` decides whether the store tests passed inside Electron. These
 * cover its reading of the report; CI's `npm run test:electron` is the run itself.
 */

const report = (lines: string[]): string => `${['TAP version 13', ...lines].join('\n')}\n`;
const counts = (tests: number, pass: number, fail = 0, cancelled = 0, skipped = 0): string[] => [
  `1..${tests}`,
  `# tests ${tests}`,
  '# suites 0',
  `# pass ${pass}`,
  `# fail ${fail}`,
  `# cancelled ${cancelled}`,
  `# skipped ${skipped}`,
  '# todo 0',
  '# duration_ms 12.5',
];

test('the summary is read from the end of a TAP report', () => {
  assert.deepEqual(
    readTapSummary(report(['ok 1 - first', 'ok 2 - second # SKIP', ...counts(2, 1, 0, 0, 1)])),
    {
      tests: 2,
      pass: 1,
      fail: 0,
      cancelled: 0,
      skipped: 1,
    },
  );
  assert.equal(readTapSummary(report(['ok 1 - first'])), null);
  assert.equal(readTapSummary(''), null);
  // A line a test printed is not the summary.
  assert.equal(readTapSummary(report(['# pass 3 of them', 'ok 1 - first'])), null);
});

test('a file that defined no test is named, although the runner counts it as a pass', () => {
  const files = ['tests/core/sqliteDriver.test.ts', 'tests/core/stateDatabase.test.ts'];
  const empty = report([
    'ok 1 - the driver loads',
    '# Subtest: C:\\\\repo\\\\tests\\\\core\\\\stateDatabase.test.ts',
    'ok 2 - C:\\\\repo\\\\tests\\\\core\\\\stateDatabase.test.ts',
    ...counts(2, 2),
  ]);
  assert.deepEqual(filesWithoutTests(empty, files), ['tests/core/stateDatabase.test.ts']);
  assert.deepEqual(
    filesWithoutTests(
      report(['ok 1 - /repo/tests/core/sqliteDriver.test.ts', ...counts(1, 1)]),
      files,
    ),
    ['tests/core/sqliteDriver.test.ts'],
  );
  assert.deepEqual(
    filesWithoutTests(
      report(['ok 1 - the driver loads', 'ok 2 - a writer creates', ...counts(2, 2)]),
      files,
    ),
    [],
  );
});

test('only a clean run with tests in every file counts as a pass', () => {
  const summary = { tests: 22, pass: 21, fail: 0, cancelled: 0, skipped: 1 };
  assert.equal(electronRunProblem({ code: 0, signal: null, summary }), null);
  assert.match(electronRunProblem({ code: 1, signal: null, summary }) ?? '', /exited with code 1/u);
  assert.match(
    electronRunProblem({ code: null, signal: 'SIGKILL', summary }) ?? '',
    /stopped by SIGKILL/u,
  );
  assert.match(electronRunProblem({ code: 0, signal: null, summary: null }) ?? '', /no summary/u);
  assert.match(
    electronRunProblem({ code: 0, signal: null, summary: { ...summary, tests: 0, pass: 0 } }) ?? '',
    /no test ran/u,
  );
  assert.match(
    electronRunProblem({
      code: 0,
      signal: null,
      summary,
      empty: ['tests/core/stateDatabase.test.ts'],
    }) ?? '',
    /no test ran in tests\/core\/stateDatabase\.test\.ts/u,
  );
  assert.match(
    electronRunProblem({ code: 0, signal: null, summary: { ...summary, fail: 2 } }) ?? '',
    /2 failed/u,
  );
  assert.match(
    electronRunProblem({ code: 0, signal: null, summary: { ...summary, cancelled: 1 } }) ?? '',
    /1 were cancelled/u,
  );
});

test('CI and the package script run the store tests inside Electron on every platform', () => {
  const root = new URL('../../', import.meta.url);
  const script =
    (
      JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts['test:electron'] ?? '';
  const [node, runner, ...listed] = script.split(' ');
  assert.deepEqual([node, runner], ['node', 'scripts/test-in-electron.mjs']);
  // Every test that loads the driver, the adapter or a store module built on them runs there.
  const core = new URL('tests/core/', root);
  const storeTests = readdirSync(core)
    .filter((name) => name.endsWith('.test.ts'))
    .filter((name) =>
      /\/src\/core\/store\/(?:sqliteDriver|state[A-Za-z]+|searchText)\.ts'/u.test(
        readFileSync(new URL(name, core), 'utf8'),
      ),
    )
    .map((name) => `tests/core/${name}`);
  assert.ok(storeTests.length >= 2, storeTests.join(' '));
  assert.deepEqual([...listed].sort(), storeTests.sort());
  const workflow = readFileSync(new URL('.github/workflows/ci.yaml', root), 'utf8');
  const step =
    /- name: Test the store inside the shipped Electron\n(?<body>(?: {8}.*\n)+)/u.exec(workflow)
      ?.groups?.body ?? '';
  assert.match(step, /^ {8}if: env\.SKIP == ''$/mu);
  assert.match(step, /^ {8}run: npm run test:electron$/mu);
  assert.doesNotMatch(step, /matrix\.os/u);
});
