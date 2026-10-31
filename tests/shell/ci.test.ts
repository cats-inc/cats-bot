import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
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
  const check = (changes: string, skip: string, node: string, contract: string) => spawnSync(bash, ['-e', '-o', 'pipefail', '-c', gate], {
    env: { ...process.env, CHANGES_RESULT: changes, SKIP: skip, NODE_RESULT: node, CONTRACT_RESULT: contract },
  }).status;
  assert.equal(check('success', 'docs', 'success', 'skipped'), 0);
  assert.equal(check('success', 'tested', 'success', 'skipped'), 0);
  assert.equal(check('success', '', 'success', 'success'), 0);
  assert.equal(check('failure', '', 'success', 'success'), 0, 'full coverage can recover failed detection');
  for (const result of ['failure', 'cancelled', 'skipped', '']) {
    assert.notEqual(check('success', '', result, 'success'), 0);
    assert.notEqual(check('success', '', 'success', result), 0);
    assert.notEqual(check('success', 'docs', result, 'skipped'), 0);
    assert.notEqual(check('success', 'tested', result, 'skipped'), 0);
  }
  assert.notEqual(check('failure', 'docs', 'success', 'skipped'), 0, 'failed detection cannot authorize a skip');
  assert.notEqual(check('failure', 'tested', 'success', 'skipped'), 0);
  assert.notEqual(check('success', '', 'success', 'skipped'), 0);
  assert.notEqual(check('success', 'other', 'success', 'skipped'), 0, 'only docs or tested may skip the contract');
  assert.notEqual(check('success', 'docs', 'success', 'success'), 0, 'a skip must not also run the contract');
  assert.notEqual(check('success', 'tested', 'success', 'success'), 0);
});

test('the plan skips docs-only changes first, then a merged pull request that already passed', () => {
  const plan = workflow.jobs.changes.steps.find((step: { id?: string }) => step.id === 'plan').run;
  const root = mkdtempSync(join(tmpdir(), 'cats-ci-plan-'));
  try {
    const decide = (code: string, tested: string) => {
      const output = join(root, 'output');
      writeFileSync(output, '');
      const result = spawnSync(bash, ['-e', '-o', 'pipefail', '-c', plan], {
        encoding: 'utf8', env: { ...process.env, CODE: code, TESTED: tested, GITHUB_OUTPUT: output.replaceAll('\\', '/') },
      });
      assert.equal(result.status, 0, result.stderr);
      return readFileSync(output, 'utf8').trim();
    };
    assert.equal(decide('false', ''), 'skip=docs');
    assert.equal(decide('false', 'true'), 'skip=docs');
    assert.equal(decide('true', 'true'), 'skip=tested');
    assert.equal(decide('true', 'false'), 'skip=');
    assert.equal(decide('true', ''), 'skip=', 'a skipped lookup runs every check');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a main push reuses its merged pull request\'s green run only for that exact tree on the previous main', t => {
  const step = workflow.jobs.changes.steps.find((item: { id?: string }) => item.id === 'merged');
  assert.equal(step.if, "github.event_name == 'push' && steps.paths.outputs.code == 'true'");
  assert.deepEqual(workflow.jobs.changes.permissions, { contents: 'read', 'pull-requests': 'read', actions: 'read' });
  const root = mkdtempSync(join(tmpdir(), 'cats-ci-merged-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, 'origin.git'), work = join(root, 'work'), bin = join(root, 'bin');
  const run = (cwd: string, ...args: string[]) => execFileSync('git', [
    '-c', 'user.name=CI Test', '-c', 'user.email=ci@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args,
  ], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path: string, content: string) => { mkdirSync(dirname(join(work, path)), { recursive: true }); writeFileSync(join(work, path), content); };
  const commit = (message: string) => { run(work, 'add', '.'); run(work, 'commit', '-m', message); return run(work, 'rev-parse', 'HEAD'); };
  run(root, 'init', '--bare', '--initial-branch=main', origin);
  mkdirSync(work); run(work, 'init', '--initial-branch=main'); run(work, 'remote', 'add', 'origin', origin);
  write('src/code.ts', 'base\n');
  const base = commit('base');
  // Pull request #7 is up to date with main; its squash lands the same tree.
  run(work, 'switch', '-c', 'pr-7');
  write('src/code.ts', 'pull request seven\n');
  const head7 = commit('pr 7');
  run(work, 'push', '--quiet', 'origin', `${head7}:refs/pull/7/head`);
  run(work, 'switch', 'main');
  run(work, 'merge', '--squash', 'pr-7'); const squash7 = commit('squash #7');
  // Pull request #8 branched from the old main; main moved before its squash.
  run(work, 'switch', '-c', 'pr-8', base);
  write('src/other.ts', 'pull request eight\n');
  const head8 = commit('pr 8');
  run(work, 'push', '--quiet', 'origin', `${head8}:refs/pull/8/head`);
  run(work, 'switch', 'main');
  run(work, 'merge', '--squash', 'pr-8'); const squash8 = commit('squash #8');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), [
    '#!/usr/bin/env bash',
    'case "$2" in',
    '  */pulls) [ -n "${STUB_PULLS:-}" ] || exit 1; printf \'%s\\n\' "$STUB_PULLS" ;;',
    '  */actions/workflows/*) printf \'%s\\n\' "${STUB_PASSED:-0}" ;;',
    '  *) exit 1 ;;',
    'esac',
  ].join('\n') + '\n', { mode: 0o755 });
  const reuse = (head: string, before: string, pulls: string, passed: string) => {
    run(work, 'checkout', '--quiet', head);
    const output = join(root, 'output');
    writeFileSync(output, '');
    const result = spawnSync(bash, ['-e', '-o', 'pipefail', '-c', step.run], {
      cwd: work, encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, REPO: 'cats-inc/cats-bot', BEFORE: before,
        STUB_PULLS: pulls, STUB_PASSED: passed, GITHUB_OUTPUT: output.replaceAll('\\', '/') },
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    return readFileSync(output, 'utf8').trim();
  };
  assert.equal(reuse(squash7, base, `7 ${head7}`, '1'), 'tested=true');
  assert.equal(reuse(squash7, base, `7 ${head7}`, '0'), 'tested=false', 'the pull request must have passed CI');
  assert.equal(reuse(squash7, base, '', '1'), 'tested=false', 'a failed lookup runs every check');
  assert.equal(reuse(squash7, base, `7 ${head8}`, '1'), 'tested=false', 'the reported head must be the pull request ref');
  assert.equal(reuse(squash7, base, `9 ${head7}`, '1'), 'tested=false', 'an unknown pull request ref runs every check');
  assert.equal(reuse(squash7, '', `7 ${head7}`, '1'), 'tested=false');
  assert.equal(reuse(squash8, base, `8 ${head8}`, '1'), 'tested=false', 'a push of several commits runs every check');
  assert.equal(reuse(squash8, squash7, `8 ${head8}`, '1'), 'tested=false', 'a head without the previous main was tested on other code');
});
