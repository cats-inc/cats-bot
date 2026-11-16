import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import test from 'node:test';

// CI skips application checks when a change touches only root docs/ or the root
// agent instructions (AGENTS.md, CLAUDE.md, CODEX.md, GEMINI.md), so no test,
// script or source file may read repository documentation or those files. Keep
// executable inputs in fixtures; quoted docs paths need a documented
// temporary-workspace use.
const sourceFile = /\.(?:[cm]?js|[cm]?ts|tsx)$/u;
// A quoted path that starts at docs/, or a 'docs' segment passed to join/resolve.
const docsPath = /['"\x60](?:\.{1,2}\/)*docs\/|['"\x60]docs['"\x60]\s*[,)]/u;
// A quoted root agent instruction file. Nested copies such as sub/AGENTS.md
// are ordinary files that CI tests.
const agentFile = /['"\x60](?:\.{1,2}\/)*(?:AGENTS|CLAUDE|CODEX|GEMINI)\.md['"\x60]/u;
// Checking that a root agent file exists does not read it; the skill sync
// script requires the root AGENTS.md this way.
const existenceCheck = /\b(?:exists|l?stat|access)(?:Sync)?\(/u;
const readsFile = /read/iu;
// A single line that names docs/ or a root agent file without reading it
// carries a trailing `docs-boundary-ignore: <reason>` comment.
const ignoreMarker = /docs-boundary-ignore: \S/u;
const generatedWorkspacePaths = new Set([
  'tests/shell/ci.test.ts', // creates Git fixture docs and agent files under a temporary directory
  'tests/shell/releasePipeline.test.ts', // writes release docs under a temporary fixture
]);
function listSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listSources(path);
    return sourceFile.test(entry.name) ? [path] : [];
  });
}

function readsDocumentation(line: string): boolean {
  if (ignoreMarker.test(line)) return false;
  if (docsPath.test(line)) return true;
  return agentFile.test(line) && !(existenceCheck.test(line) && !readsFile.test(line));
}

test('the guard covers root agent instructions but allows existence checks', () => {
  assert.ok(readsDocumentation("readFileSync('AGENTS.md', 'utf8');"));
  assert.ok(readsDocumentation("await readFile(path.join(root, 'CLAUDE.md'));"));
  assert.ok(readsDocumentation('readFileSync(\x60../GEMINI.md\x60);'));
  assert.ok(readsDocumentation("if (existsSync('CODEX.md')) readFileSync('CODEX.md');"));
  assert.ok(!readsDocumentation("if (!(await exists(path.join(root, 'AGENTS.md')))?.isFile()) throw error;"));
  assert.ok(!readsDocumentation("readFileSync(join(root, 'sub/AGENTS.md'));"));
  assert.ok(!readsDocumentation("seed(root, 'AGENTS.md'); // docs-boundary-ignore: temporary project"));
});

test('application checks stay independent of repository docs and agent instructions', () => {
  const root = process.cwd();
  const violations = ['tests', 'scripts', 'src'].flatMap(dir => listSources(join(root, dir)))
    .map(path => relative(root, path).split(sep).join('/'))
    .filter(path => path !== 'tests/shell/docsBoundary.test.ts' && !generatedWorkspacePaths.has(path))
    .flatMap(path => readFileSync(join(root, path), 'utf8').split(/\r?\n/u)
      .map((line, index) => ({ line, at: path + ':' + (index + 1) }))
      .filter(({ line }) => readsDocumentation(line))
      .map(({ at, line }) => at + ': ' + line.trim()));
  assert.deepEqual(violations, [],
    'Move executable inputs into tests/fixtures/ instead of reading repository docs/ or the root agent instructions.');
});
