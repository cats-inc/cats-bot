import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { parse } from 'yaml';

const workflow = parse(readFileSync('.github/workflows/ci.yaml', 'utf8'));
const detector = workflow.jobs.changes.steps.find((step: { id?: string }) => step.id === 'paths').run;
const bash = process.platform === 'win32'
  ? resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../../bin/bash.exe')
  : 'bash';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'cats-ci-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', [
    '-c', 'user.name=CI Test', '-c', 'user.email=ci@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args,
  ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path: string, content: string = 'fixture\n') => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const commit = () => { git('add', '.'); git('commit', '-m', 'fixture'); return git('rev-parse', 'HEAD'); };
  const detect = (event: string, before: string = '') => {
    const output = join(root, '.git', 'ci-output');
    writeFileSync(output, '');
    const result = spawnSync(bash, ['-e', '-o', 'pipefail', '-c', detector], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, EVENT: event, BEFORE: before, GITHUB_OUTPUT: output.replaceAll('\\', '/') },
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    return readFileSync(output, 'utf8').trim();
  };
  git('init', '--initial-branch=main');
  write('src/code.ts');
  write('README.md');
  const base = commit();
  return { root, git, write, commit, detect, base };
}

test('workflow detects the complete push range and both sides of docs boundary renames', t => {
  const f = fixture(t);
  f.write('docs/guide.md');
  f.write('docs/使用說明.md');
  const docs = f.commit();
  assert.equal(f.detect('push', f.base), 'code=false');

  f.write('src/code.ts', 'changed\n');
  f.write('docs/guide.md', 'changed docs\n');
  const mixed = f.commit();
  assert.equal(f.detect('push', docs), 'code=true');

  f.write('docs/guide.md', 'more docs\n');
  const latest = f.commit();
  assert.equal(f.detect('push', mixed), 'code=false');
  assert.equal(f.detect('push', docs), 'code=true', 'a multi-commit push includes earlier code changes');

  f.git('mv', 'src/code.ts', 'docs/moved.ts');
  const movedIn = f.commit();
  assert.equal(f.detect('push', latest), 'code=true', 'moving code into docs still removes executable input');

  f.git('mv', 'docs/moved.ts', 'src/moved.ts');
  const movedOut = f.commit();
  assert.equal(f.detect('push', movedIn), 'code=true');

  f.git('rm', 'docs/guide.md');
  f.commit();
  assert.equal(f.detect('push', movedOut), 'code=false');

  const previous = f.git('rev-parse', 'HEAD');
  f.write('nested/docs/guide.md');
  f.commit();
  assert.equal(f.detect('push', previous), 'code=true', 'only the root docs directory is excluded');
});

test('workflow compares the PR merge to its current base and defaults to full checks when unknown', t => {
  const f = fixture(t);
  f.git('switch', '-c', 'docs-change');
  f.write('docs/guide.md');
  f.commit();
  f.git('switch', 'main');
  f.write('src/code.ts', 'new base code\n');
  f.commit();
  f.git('merge', '--no-ff', 'docs-change', '-m', 'synthetic PR merge');
  assert.equal(f.detect('pull_request'), 'code=false', 'base branch code changes are already in HEAD^1');
  assert.equal(f.detect('push', ''), 'code=true');
  assert.equal(f.detect('push', '0'.repeat(40)), 'code=true');
  assert.equal(f.detect('push', 'a'.repeat(40)), 'code=true');
  assert.equal(f.detect('push', f.git('rev-parse', 'HEAD')), 'code=true', 'empty diff never skips CI');
  assert.equal(f.detect('workflow_dispatch', f.base), 'code=true');

  f.git('switch', '-c', 'mixed-change');
  f.write('README.md', 'root docs are outside the excluded directory\n');
  f.write('docs/guide.md', 'more docs\n');
  f.commit();
  f.git('switch', 'main');
  f.git('merge', '--no-ff', 'mixed-change', '-m', 'synthetic mixed PR merge');
  assert.equal(f.detect('pull_request'), 'code=true');
});

test('required validate gate rejects missing, failed or cancelled package coverage', () => {
  const gate = workflow.jobs.validate.steps[0].run;
  const check = (changes: string, code: string, node: string, contract: string) => spawnSync(bash, ['-e', '-o', 'pipefail', '-c', gate], {
    env: { ...process.env, CHANGES_RESULT: changes, CODE: code, NODE_RESULT: node, CONTRACT_RESULT: contract },
  }).status;
  assert.equal(check('success', 'false', 'success', 'skipped'), 0);
  assert.equal(check('success', 'true', 'success', 'success'), 0);
  assert.equal(check('failure', '', 'success', 'success'), 0, 'full coverage can recover failed detection');
  for (const result of ['failure', 'cancelled', 'skipped', '']) {
    assert.notEqual(check('success', 'true', result, 'success'), 0);
    assert.notEqual(check('success', 'true', 'success', result), 0);
    assert.notEqual(check('success', 'false', result, 'skipped'), 0);
  }
  assert.notEqual(check('failure', 'false', 'success', 'skipped'), 0, 'failed detection cannot authorize a skip');
  assert.notEqual(check('success', '', 'success', 'skipped'), 0);
});
