import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  assert.equal(f.detect('pull_request'), 'code=true', 'a root README.md is still code');
});

test('root agent instruction files count as documentation only while they exist at HEAD', t => {
  const f = fixture(t);
  f.write('AGENTS.md');
  f.write('CLAUDE.md');
  f.write('sub/AGENTS.md');
  let previous = f.commit();
  const push = (change: () => void) => {
    change();
    const head = f.commit();
    const result = f.detect('push', previous);
    previous = head;
    return result;
  };
  assert.equal(push(() => f.write('AGENTS.md', 'edited\n')), 'code=false', 'a root AGENTS.md-only edit is documentation');
  assert.equal(push(() => { f.write('CODEX.md'); f.write('GEMINI.md'); }), 'code=false', 'adding root agent files is documentation');
  assert.equal(push(() => { f.write('CLAUDE.md', 'edited\n'); f.write('docs/guide.md'); }), 'code=false');
  assert.equal(push(() => f.git('rm', '--quiet', 'CLAUDE.md')), 'code=true', 'a deleted root CLAUDE.md is code');
  assert.equal(push(() => f.write('sub/AGENTS.md', 'edited\n')), 'code=true', 'a nested sub/AGENTS.md is code');
  assert.equal(push(() => f.git('mv', 'GEMINI.md', 'docs/GEMINI.md')), 'code=true', 'moving an agent file into docs/ removes it from the root');
  assert.equal(push(() => f.git('mv', 'CODEX.md', 'CLAUDE.md')), 'code=true', 'a rename still deletes the original agent file');
  assert.equal(push(() => { f.write('AGENTS.md', 'again\n'); f.write('src/code.ts', 'changed\n'); }), 'code=true');

  f.git('switch', '-c', 'agents-change');
  f.write('AGENTS.md', 'pull request\n');
  f.commit();
  f.git('switch', 'main');
  f.write('src/code.ts', 'new base code\n');
  f.commit();
  f.git('merge', '--no-ff', 'agents-change', '-m', 'synthetic agent-file PR merge');
  assert.equal(f.detect('pull_request'), 'code=false', 'a pull request editing only AGENTS.md is documentation');
  assert.equal(f.detect('workflow_dispatch', previous), 'code=true', 'a manual run still runs everything');
});

test('the fingerprint covers code and the agent files\' presence, not docs or agent file content', t => {
  const f = fixture(t);
  const script = workflow.jobs.changes.steps.find((step: { id?: string }) => step.id === 'fingerprint').run;
  // Hosted Ubuntu has sha256sum; a macOS test leg may only have shasum.
  const env: Record<string, string> = {};
  if (spawnSync(bash, ['-c', 'command -v sha256sum'], { stdio: 'ignore' }).status !== 0) {
    const bin = join(f.root, '.git', 'shim');
    mkdirSync(bin);
    writeFileSync(join(bin, 'sha256sum'), '#!/usr/bin/env bash\nexec shasum -a 256 "$@"\n', { mode: 0o755 });
    env.PATH = `${bin}${delimiter}${process.env.PATH}`;
  }
  const fingerprint = (change: () => void) => {
    change();
    f.commit();
    const output = join(f.root, '.git', 'ci-output');
    writeFileSync(output, '');
    const result = spawnSync(bash, ['-e', '-o', 'pipefail', '-c', script], {
      cwd: f.root, encoding: 'utf8', env: { ...process.env, ...env, GITHUB_OUTPUT: output.replaceAll('\\', '/') },
    });
    assert.equal(result.status, 0, result.stderr || String(result.error));
    const match = /^fingerprint=([0-9a-f]{64})$/u.exec(readFileSync(output, 'utf8').trim());
    assert.ok(match, 'the step writes one SHA-256 fingerprint');
    return match[1];
  };
  const base = fingerprint(() => { f.write('AGENTS.md'); f.write('sub/AGENTS.md'); f.write('docs/使用說明.md'); });
  assert.equal(fingerprint(() => { f.write('docs/guide.md'); f.write('docs/使用說明.md', 'edited\n'); }), base, 'docs/ is outside the fingerprint');
  assert.equal(fingerprint(() => f.write('AGENTS.md', 'edited\n')), base, 'an agent file edit keeps the fingerprint');
  const withClaude = fingerprint(() => f.write('CLAUDE.md'));
  assert.notEqual(withClaude, base, 'adding an agent file changes the fingerprint');
  assert.equal(fingerprint(() => f.write('CLAUDE.md', 'edited\n')), withClaude);
  assert.equal(fingerprint(() => f.git('rm', '--quiet', 'CLAUDE.md')), base, 'presence, not history, decides');
  assert.notEqual(fingerprint(() => f.git('rm', '--quiet', 'AGENTS.md')), base, 'removing AGENTS.md changes the fingerprint');
  assert.equal(fingerprint(() => f.write('AGENTS.md', 'restored\n')), base);
  const nested = fingerprint(() => f.write('sub/AGENTS.md', 'edited\n'));
  assert.notEqual(nested, base, 'a nested AGENTS.md is code');
  const readme = fingerprint(() => f.write('README.md', 'edited\n'));
  assert.notEqual(readme, nested, 'a root README.md is code');
  assert.notEqual(fingerprint(() => {
    chmodSync(join(f.root, 'src/code.ts'), 0o755);
    f.git('update-index', '--chmod=+x', 'src/code.ts');
  }), readme, 'file modes count');
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

test('the plan skips docs-only changes first, then code that already passed', () => {
  const plan = workflow.jobs.changes.steps.find((step: { id?: string }) => step.id === 'plan');
  assert.deepEqual(plan.env, {
    CODE: '${{ steps.paths.outputs.code }}',
    GREEN: '${{ steps.green.outputs.cache-hit }}',
    MERGED: '${{ steps.merged.outputs.tested }}',
  });
  const root = mkdtempSync(join(tmpdir(), 'cats-ci-plan-'));
  try {
    const decide = (code: string, green: string, merged: string) => {
      const output = join(root, 'output');
      writeFileSync(output, '');
      const result = spawnSync(bash, ['-e', '-o', 'pipefail', '-c', plan.run], {
        encoding: 'utf8', env: { ...process.env, CODE: code, GREEN: green, MERGED: merged, GITHUB_OUTPUT: output.replaceAll('\\', '/') },
      });
      assert.equal(result.status, 0, result.stderr);
      return readFileSync(output, 'utf8').trim();
    };
    assert.equal(decide('false', '', ''), 'skip=docs');
    assert.equal(decide('false', 'true', 'true'), 'skip=docs');
    assert.equal(decide('true', 'true', ''), 'skip=tested');
    assert.equal(decide('true', '', 'true'), 'skip=tested');
    assert.equal(decide('true', 'false', 'false'), 'skip=');
    assert.equal(decide('true', '', ''), 'skip=', 'skipped lookups run every check');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('only a run that passed every required check records its code, and manual runs never reuse one', t => {
  const changes = workflow.jobs.changes;
  const ids = changes.steps.map((step: { id?: string }) => step.id).filter(Boolean);
  assert.deepEqual(ids, ['paths', 'fingerprint', 'green', 'merged', 'plan']);
  assert.equal(changes.outputs.fingerprint, '${{ steps.fingerprint.outputs.fingerprint }}');
  const green = changes.steps.find((step: { id?: string }) => step.id === 'green');
  assert.equal(green.if, "steps.paths.outputs.code == 'true' && github.event_name != 'workflow_dispatch'");
  assert.equal(green.uses, 'actions/cache/restore@v4');
  assert.deepEqual(green.with, { path: '.ci-green', key: 'ci-green-v1-${{ steps.fingerprint.outputs.fingerprint }}', 'lookup-only': true });

  // The marker is written once, after the validate gate has seen all three
  // node legs and the package contract pass on a full run.
  const validate = workflow.jobs.validate;
  assert.deepEqual(validate.needs, ['changes', 'node', 'preview-contract']);
  const [record, save] = validate.steps.slice(-2);
  const condition = "needs.changes.result == 'success' && needs.changes.outputs.skip == '' && needs.changes.outputs.fingerprint != ''";
  assert.equal(record.if, condition);
  assert.equal(save.if, condition);
  assert.equal(save.uses, 'actions/cache/save@v4');
  assert.deepEqual(save.with, { path: '.ci-green', key: 'ci-green-v1-${{ needs.changes.outputs.fingerprint }}' });
  const savers = Object.entries(workflow.jobs).flatMap(([name, job]) => (job as { steps: { uses?: string }[] }).steps
    .filter(step => step.uses?.startsWith('actions/cache/save')).map(() => name));
  assert.deepEqual(savers, ['validate'], 'no single node leg may record the code as tested');

  const root = mkdtempSync(join(tmpdir(), 'cats-ci-record-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(bash, ['-e', '-o', 'pipefail', '-c', record.run], {
    cwd: root, encoding: 'utf8', env: { ...process.env, FINGERPRINT: 'f'.repeat(64), GITHUB_RUN_ID: '42' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(root, '.ci-green', 'marker'), 'utf8'), `${'f'.repeat(64)} 42\n`);
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
