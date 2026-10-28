import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

/**
 * ADR-001 §2 and §9, SPEC-001 A6: the bot core and the headless CLI must stay
 * free of Electron, of any cats-platform code and of the sibling checkouts in
 * the developer workspace, so they can run headless and be re-hosted without
 * change. The shell may use the core, but never the runtime HTTP client
 * directly: everything the shell needs goes through `BotHostApi`.
 */

const repoRoot = resolve(import.meta.dirname, '..');
const srcRoot = join(repoRoot, 'src');

function listTypeScriptFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listTypeScriptFiles(full));
    } else if (/\.(?:ts|mts|cts|js|mjs|cjs)$/u.test(entry) && !entry.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files.sort();
}

const IMPORT_PATTERN =
  /(?:\bimport\s+(?:[^'"]*?\s+from\s+)?|\bexport\s+[^'"]*?\s+from\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/gu;

function importSpecifiers(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    specifiers.push(match[1]!);
  }
  return specifiers;
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

function resolvesInside(file: string, specifier: string, root: string): boolean {
  const target = resolve(dirname(file), specifier);
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !rel.includes(`..${sep}`);
}

function filesUnder(area: string): string[] {
  return listTypeScriptFiles(join(srcRoot, area));
}

test('src/index.ts exists and loads under Node type stripping', async () => {
  const entry = join(srcRoot, 'index.ts');
  assert.ok(existsSync(entry), 'src/index.ts is the package entry point');
  const loaded = await import(pathToFileURL(entry).href);
  assert.equal(typeof loaded, 'object');
});

test('core and cli never import electron, cats-platform or sibling checkouts', () => {
  const offenders: string[] = [];
  for (const file of [...filesUnder('core'), ...filesUnder('cli')]) {
    for (const specifier of importSpecifiers(file)) {
      const lowered = specifier.toLowerCase();
      if (lowered === 'electron' || lowered.startsWith('electron/')) {
        offenders.push(`${relative(repoRoot, file)} imports ${specifier}`);
      } else if (lowered.includes('cats-platform')) {
        offenders.push(`${relative(repoRoot, file)} imports ${specifier}`);
      } else if (isRelative(specifier) && !resolvesInside(file, specifier, srcRoot)) {
        offenders.push(`${relative(repoRoot, file)} reaches outside src/ via ${specifier}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('no source file imports from outside the repository', () => {
  const offenders: string[] = [];
  for (const file of listTypeScriptFiles(srcRoot)) {
    for (const specifier of importSpecifiers(file)) {
      if (isRelative(specifier) && !resolvesInside(file, specifier, repoRoot)) {
        offenders.push(`${relative(repoRoot, file)} reaches outside the repository via ${specifier}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('the shell never holds the runtime client directly', () => {
  const offenders: string[] = [];
  const runtimeClientDir = join(srcRoot, 'core', 'runtime');
  for (const file of filesUnder('shell')) {
    for (const specifier of importSpecifiers(file)) {
      if (!isRelative(specifier)) continue;
      const target = resolve(dirname(file), specifier);
      const rel = relative(runtimeClientDir, target);
      if (rel === '' || (!rel.startsWith('..') && !rel.includes(`..${sep}`))) {
        offenders.push(`${relative(repoRoot, file)} imports ${specifier}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('the renderer takes only types from the core, and nothing from Node or Electron (ADR-003)', () => {
  const rendererRoot = join(srcRoot, 'renderer');
  const typesFile = join(srcRoot, 'core', 'types.ts');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(?:ts|tsx|js)$/u.test(entry)) files.push(full);
    }
  };
  walk(rendererRoot);
  assert.ok(files.length > 0, 'src/renderer has sources');
  const offenders: string[] = [];
  const statement = /\b(?:import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gu;
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(statement)) {
      const typeOnly = Boolean(match[1]);
      const specifier = match[2]!;
      const where = `${relative(repoRoot, file)} imports ${specifier}`;
      if (specifier === 'electron' || specifier.startsWith('electron/') || specifier.startsWith('node:')) {
        offenders.push(where);
      } else if (isRelative(specifier) && !resolvesInside(file, specifier, rendererRoot)) {
        // Outside the renderer only the core's type contract, and only as types (erased from the bundle).
        const allowed = [typesFile, join(srcRoot, 'shared', 'shellUpdate.ts')];
        if (!typeOnly || !allowed.includes(resolve(dirname(file), specifier))) offenders.push(`${where} (only browser-safe type contracts)`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
