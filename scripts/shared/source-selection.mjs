/**
 * How a release selects a source from another repository. Cats Desktop and Cats Bot share this on purpose, so one rule applies:
 * selection checks current main; publication checks the main baseline recorded when the bump was prepared.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const git = (root, ...args) => execute('git', ['--no-replace-objects', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180_000 });
// Spelled in full, because a tag named origin/main would otherwise shadow the branch.
const MAIN = 'refs/remotes/origin/main';
// Outside the package and the installers, so leaving them out changes nothing a user runs.
const UNPACKAGED_PATH = /^(?:docs|\.github)\//u;
const LEFT_OUT = 'Left out of this release:';

/** Commits on `main` that `commit` lacks and that change anything outside docs/ and .github/. Refuses a commit that is not on `main`. */
export async function missingSourceChanges(root, commit, main = MAIN) {
  const label = main.replace(/^refs\/remotes\//u, '');
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error('Expected a full source commit SHA.');
  if ((await git(root, 'rev-parse', '--is-shallow-repository')).stdout.trim() === 'true') throw new Error(`The checkout at ${root} is shallow; comparing a source with ${label} needs its full history.`);
  await git(root, 'rev-parse', '--verify', '--quiet', `${main}^{commit}`).catch(() => { throw new Error(`The checkout at ${root} has no ${label}.`); });
  await git(root, 'merge-base', '--is-ancestor', commit, main).catch(() => { throw new Error(`Source ${commit} is not on ${label}. Select a commit that landed there, not a pull request's branch head.`); });
  // --no-renames lists both sides, so moving a packaged file into docs/ still counts. A merge lists only what it changes itself.
  const { stdout } = await git(root, '-c', 'core.quotepath=off', 'log', '--no-renames', '--diff-merges=dense-combined', '--name-only', '--format=%x00%H%x00%s', `${commit}..${main}`);
  const [, ...fields] = stdout.split('\0');
  const changes = [];
  for (let index = 0; index < fields.length; index += 2) {
    const [subject, ...paths] = fields[index + 1].split('\n');
    if (paths.filter(Boolean).every(path => UNPACKAGED_PATH.test(path))) continue;
    changes.push({ sha: fields[index], subject, pull: /\(#(\d+)\)$/u.exec(subject)?.[1] ?? null });
  }
  return changes;
}

/** The text of each left-out statement: its line, then what follows until a blank line, a heading or a list item at its own level. */
export function leftOutStatements(notes) {
  const statements = [];
  let indent = null;
  for (const line of notes.split(/\r?\n/u)) {
    const current = /^\s*/u.exec(line)[0].length;
    if (line.includes(LEFT_OUT)) indent = current;
    else if (indent !== null && (!line.trim() || (/^\s*(?:[-*+]|\d+\.|#{1,6})\s/u.test(line) && current <= indent))) indent = null;
    if (indent !== null) statements.push(line);
  }
  return statements.join('\n');
}

/**
 * Refuses a selected source that is off `main`, or that lacks changes on `main` the release notes do not list as left out.
 * Only a `Left out of this release:` statement counts, naming each change as `<repository>#<pull>` or by its first 8 SHA characters.
 * Any other mention does not, because notes also cite commits they include, and a bare #N does not, because pull request numbers
 * collide between repositories. A false match would hide exactly what this check is for. The reason for leaving a change out is for reviewers to judge.
 */
export async function assertSelectedSource({ root, commit, notes, repository, main = MAIN }) {
  const missing = await missingSourceChanges(root, commit, main);
  const statements = leftOutStatements(notes);
  const listed = ({ sha, pull }) => new RegExp(`(?<![0-9a-f])${sha.slice(0, 8)}`, 'u').test(statements)
    || (pull !== null && new RegExp(`(?<![\\w-])${repository}#${pull}(?!\\d)`, 'u').test(statements));
  const unlisted = missing.filter(change => !listed(change));
  if (unlisted.length) {
    throw new Error([`${repository} ${commit.slice(0, 8)} lacks changes on ${main.replace(/^refs\/remotes\//u, '')} that the release notes do not list as left out:`,
      ...unlisted.map(({ sha, subject, pull }) => `  ${pull === null ? sha.slice(0, 8) : `${repository}#${pull}`} ${subject}`),
      `Select a newer ${repository} commit, or list each of these on a "${LEFT_OUT}" line, with the reason.`].join('\n'));
  }
  return missing;
}

/** One machine-readable selection in the current version's notes, committed with the bump. */
export function frozenSourceSelection(notes, repository) {
  const lines = notes.split(/\r?\n/u).filter(line => line.includes('**Source selection:**') && line.includes(`${repository}@`));
  const match = lines.length === 1
    ? /^- \*\*Source selection:\*\* ([\w-]+)@([a-f0-9]{40}); main@([a-f0-9]{40})\.$/u.exec(lines[0])
    : null;
  if (!match || match[1] !== repository) {
    throw new Error(`Record exactly one "- **Source selection:** ${repository}@FULL_COMMIT_SHA; main@FULL_BASELINE_SHA." line in this version's notes before freezing the bump.`);
  }
  return { commit: match[2], baseline: match[3] };
}

/** Later main commits do not change a frozen release's inputs or omission list. */
export async function assertFrozenSource({ root, commit, notes, repository }) {
  const selection = frozenSourceSelection(notes, repository);
  if (commit !== selection.commit) throw new Error(`Selected ${repository} ${commit} differs from the frozen source ${selection.commit}.`);
  // The baseline must have landed, even when a caller supplies an invented or PR-only baseline.
  if ((await git(root, 'rev-parse', '--is-shallow-repository')).stdout.trim() === 'true') {
    throw new Error(`The checkout at ${root} is shallow; validating the frozen baseline needs its full history.`);
  }
  await git(root, 'merge-base', '--is-ancestor', selection.baseline, MAIN).catch(() => {
    throw new Error(`Frozen ${repository} baseline ${selection.baseline} is not on origin/main.`);
  });
  return assertSelectedSource({ root, commit, notes, repository, main: selection.baseline });
}

/** Release CI belongs to the exact source, not whichever commit main names later. */
export async function requireTestedReleaseSource({ github, owner, repo, sourceCommit, sourceRef, tag }) {
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit) || !/^v\d+\.\d+\.\d+$/u.test(tag)) throw new Error('Invalid release source identity.');
  const releaseBranch = `release/${tag}`;
  if (!['refs/heads/main', `refs/heads/${releaseBranch}`, `refs/tags/${tag}`].includes(sourceRef)) {
    throw new Error(`Publish from main or the frozen ${releaseBranch} branch; ordinary feature branches are not release sources.`);
  }
  const candidates = [{ event: 'push', branch: 'main' }, { event: 'workflow_dispatch', branch: releaseBranch }];
  for (const candidate of candidates) {
    const { data } = await github.rest.actions.listWorkflowRuns({ owner, repo, workflow_id: 'ci.yaml', head_sha: sourceCommit,
      ...candidate, status: 'completed', per_page: 100 });
    if (data.workflow_runs.some(run => run.head_sha === sourceCommit && run.head_branch === candidate.branch
      && run.event === candidate.event && run.status === 'completed' && run.conclusion === 'success'
      && run.head_repository?.full_name === `${owner}/${repo}`)) return;
  }
  throw new Error(`CI has not passed on frozen source ${sourceCommit}; run ci.yaml manually on ${releaseBranch}, or wait for this exact main push's CI. Do not advance the release source.`);
}
