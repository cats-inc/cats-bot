import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertNewerRelease, repository, validateInputs } from './release-contract.mjs';

/** Octokit is supplied by actions/github-script; all external values stay data. */
export async function guardRelease({ github, root, tag, sourceCommit }) {
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) throw new Error('Invalid source commit.');
  const input = await validateInputs(root, tag, true);
  const [owner, repo] = repository.split('/');
  const releases = await github.paginate(github.rest.repos.listReleases, { owner, repo, per_page: 100 });
  assertNewerRelease(tag, releases);
  const notes = await readFile(join(root, 'docs', 'releases', `${tag}.md`), 'utf8'); // docs-boundary-ignore: manual publication reads notes; CI tests supply a temporary root.
  if (notes.trim().length < 80) throw new Error('Prepare release notes, compatibility, source pins and signing policy before dispatch.');
  const existing = releases.find(item => item.tag_name === tag);
  const identity = `Source commit: \`${sourceCommit}\``;
  if (existing && (!existing.draft || existing.target_commitish !== sourceCommit || !existing.body?.includes(identity))) throw new Error('Refusing to reuse a release from another source or a published release.');
  try {
    await github.rest.git.getRef({ owner, repo, ref: `tags/${tag}` });
    // Drafts do not create a Git tag. A pre-existing tag is never reused.
    throw new Error('Release tag already exists; select an unused version.');
  } catch (error) { if (error.status !== 404) throw error; }
  return { ...input, notes, existing, identity, owner, repo };
}

/** The preview build does not rerun the tests, so main's CI must have passed on this exact commit. */
export async function requireTestedSource({ github, owner, repo, sourceCommit }) {
  const { data } = await github.rest.actions.listWorkflowRuns({ owner, repo, workflow_id: 'ci.yaml', head_sha: sourceCommit,
    event: 'push', branch: 'main', status: 'completed', per_page: 20 });
  if (!data.workflow_runs.some(run => run.head_sha === sourceCommit && run.conclusion === 'success')) {
    throw new Error(`CI has not passed on ${sourceCommit} on main; wait for that run to pass, then dispatch again.`);
  }
}
