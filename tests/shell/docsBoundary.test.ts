import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import test from 'node:test';

// Application checks may skip root docs/. Keep executable test/build inputs in
// fixtures instead; quoted docs paths need a documented temporary-workspace use.
const sourceFile = /\.(?:[cm]?js|[cm]?ts|tsx)$/u;
const docsPath = /['"\x60](?:\.{1,2}\/)*docs\/|['"\x60]docs['"\x60]\s*[,)]/u;
const ignoreMarker = /docs-boundary-ignore: \S/u;
const generatedWorkspacePaths = new Set([
  'tests/shell/ci.test.ts', // creates Git fixture docs under a temporary directory
  'tests/shell/releasePipeline.test.ts', // writes release docs under a temporary fixture
]);
function listSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listSources(path);
    return sourceFile.test(entry.name) ? [path] : [];
  });
}

test('application checks stay independent of repository docs', () => {
  const root = process.cwd();
  const violations = ['tests', 'scripts', 'src'].flatMap(dir => listSources(join(root, dir)))
    .map(path => relative(root, path).split(sep).join('/'))
    .filter(path => path !== 'tests/shell/docsBoundary.test.ts' && !generatedWorkspacePaths.has(path))
    .flatMap(path => readFileSync(join(root, path), 'utf8').split(/\r?\n/u)
      .map((line, index) => ({ line, at: path + ':' + (index + 1) }))
      .filter(({ line }) => docsPath.test(line) && !ignoreMarker.test(line))
      .map(({ at, line }) => at + ': ' + line.trim()));
  assert.deepEqual(violations, [], 'Move executable inputs into tests/fixtures/ instead of reading repository docs/.');
});
