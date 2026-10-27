# AGENTS.md

> Shared coding-agent instructions. Customize project facts, not protocol claims.

## Reading Order and Scope

1. Read this file and confirm understanding, then read only your own agent file
   (`CLAUDE.md`, `GEMINI.md`, or `CODEX.md`).
2. Consult `docs/AGENT-GUIDE.md` and any relevant skill before task work.
3. Never edit another agent's specific instruction file.
4. These local conventions do not override host safety rules or higher-priority
   instructions. MUST means required; SHOULD means recommended. Explicit user
   workflow choices can override defaults such as branch and PR policy.

## Project Metadata

- Type: single-project
- Purpose: standalone, always-alive desktop bots for the Cats ecosystem. One
  process per bot wraps an agent CLI through `@cats-inc/cats-runtime` (app-managed
  child process, loopback HTTP), with a tray icon, sticky-note conversations and one
  global provider/model per bot. Read `docs/decisions/001-build-a-resident-bot-core-on-cats-runtime-with-disposable-presentation.md`
  (accepted), `docs/specs/SPEC-001-resident-bot-core-and-global-execution.md` and `docs/plans/PLAN-001-resident-bot-core-foundation.md` before any
  implementation; the two notes under `docs/research/` are their evidence. Does not
  import `@cats-inc/cats-platform`.
- Entry points: none runnable yet. ADR-001 defines a headless `cats-bot` CLI over the
  bot core and an Electron shell as the first presentation host; after PLAN-001 Phase 0,
  `src/` holds `index.ts` and the `src/core/types.ts` contract until Phase 1 lands.
- Stack and versions: Node.js 24 (`.nvmrc`), TypeScript 5, ESM (`NodeNext`), erasable
  TypeScript syntax only (Node runs `.ts` tests by type stripping: no `enum`, `namespace`
  or parameter properties; relative imports end in `.ts`), `@cats-inc/cats-runtime` pinned
  to the exact version in `package.json` and consumed over its process + HTTP contract.
  Electron is the first shell; desktop-layer hosts need a later ADR.
- Test command: `npm ci && npm run typecheck && npm test && npm run build`. `npm test`
  runs `node --test` over `tests/**/*.test.ts`; tests only write under temporary
  directories and never touch the real `~/.cats` (`docs/testing.md`).
- Subprojects: none declared; nested AGENTS.md files provide scoped instructions
  and do not by themselves prove a monorepo architecture.

## Task Routing

| Need | Reference |
|------|-----------|
| Setup and commands | `docs/setup-guide.md`, `docs/testing.md` |
| Architecture and decisions | `docs/architecture.md`, `docs/decisions/` |
| Feature planning | `docs/specs/`, `docs/plans/` |
| Document inventory | `docs/README.md` |
| Script help and naming | `docs/SCRIPT-STANDARDS.md` |
| Services / ports | `docs/services.md` |
| Security | `docs/security-guidelines.md` |
| Optional reusable workflows | `skills/README.md` |
| Optional A2A / MCP integration | `docs/a2a/README.md`, `docs/mcp-config.md` |

## Change and Safety Rules

- Preserve user edits. Do not discard, delete, publish, or stage unrelated work
  without authorization. Never commit credentials or modify out-of-scope files.
- Update related tests and docs in the same session/commit. Keep examples consistent
  with actual behavior; placeholders are not completed implementation.
- Read relevant ADRs before architecture decisions and record new decisions using
  `docs/decisions/000-template.md`. Use SPEC/PLAN templates for approved complex work.
- Resolve destructive targets exactly and preview operations. On a violated
  requirement, stop the affected operation, disclose it and propose correction;
  obtain approval before corrective destructive work.
- Check `docs/services.md` before adding listeners and update it when ports change.
  If available, consult the bootstrap's cross-project port registry. Warn about
  conflicts and make ports configurable; do not modify an external registry
  without permission.

## Release completion

- Prepare version fields, release notes, exact source/artifact pins, compatibility
  and migration notes, and the applicable signing profile in the original bump
  commit/PR before publication. Do not claim future verification has passed.
- After publication, verify the required workflow and public assets/registry,
  report the results in the final response, and stop. Actions run results/logs
  and release assets are the hosted evidence; do not create a GitHub Release for
  an npm-only target.
- MUST NOT edit the published GitHub Release (description, title, assets or
  flags), and MUST NOT add a follow-up tracked report, status edit, commit or PR
  to change "prepared" to "published", append validation/checksums, or refresh
  release history in README/PROGRESS/docs. Do not offer any of these as optional
  follow-ups. This rule overrides generic project-memory
  sync requirements for routine publication results. Further repository changes
  need an explicit request or an actual release defect within authorized scope.
- Once the selected release is published and verified, perform its authorized
  cleanup and finish. Do not chase unrelated main commits, rebase, rebuild or
  republish solely to land post-release documentation.
- Follow the [shared release completion policy](https://github.com/cats-inc/cats-one/blob/main/docs/release-guide.md#release-preparation-and-completion).


## Development Workflow

Default: plan → feature/fix branch → implement → test → independent review →
Conventional Commit → PR → merge. Follow an explicitly authorized direct-commit
workflow when requested. Do not interpret a review request as permission to edit.

Use the project's documented test command; confirm the manifest/CI configuration
when this template still contains placeholders. Report missing tests as missing,
not successful. New or changed behavior needs appropriate regression coverage.

## Project Roles

| Role | Assigned Agent | Responsibility |
|------|----------------|----------------|
| Conductor | Unassigned | Planning, assignment, status |
| Architect | Unassigned | Architecture and stack decisions |
| Security Specialist | Unassigned | Security review |
| UX Lead | Unassigned | UX decisions |
| Specialist | All others | Implementation, testing, documentation |

If assigned, the Conductor coordinates architecture and owns README Current Status.
Specialists acknowledge assignments, follow the agreed plan and do not change that
status section without approval. Otherwise work follows the authorized user task.

An agent MUST NOT review code it wrote itself. Author-run tests and mechanical
checks are allowed but are not independent review. Important changes SHOULD be
reviewed by a separate agent or human. Report when independent review is unavailable.
Do not add agent annotations in code or docs. Shared AGENTS changes require a
reason in the commit message. Handoffs state completed work, checks and remaining work.

## Conventions and Skills

Honor `.editorconfig`. Use lowercase kebab-case directories, snake_case Python,
and the project's chosen JavaScript/TypeScript naming. PowerShell scripts use
`Verb-Noun.ps1` with comment-based help; Bash uses kebab-case, header help and
a `usage()` function. See `docs/SCRIPT-STANDARDS.md` for examples.

Canonical skills live in `skills/`; edit them there, not in discovery copies.
Run `scripts/windows/Sync-AgentSkills.ps1` after changes. See `skills/README.md`
for discovery paths and installed workflows. Do not assume optional skills exist.

Branch cleanup is an explicit maintenance task, never an automatic commit step.
Preview `scripts/windows/Remove-MergedBranches.ps1 -WhatIf` or the corresponding
Bash script's `--dry-run`; see `docs/AGENT-GUIDE.md` for details.

When cleaning up after a merge, remove the worktree you created for that work
before sweeping; the helper skips any branch a worktree still holds. Remove only
worktrees you created, since another may hold someone else's live work, and keep
one past its merge only when the user asks. While several agents share a clone,
keep the main checkout on the default branch and work in worktrees under the
repository's Git-ignored `.claude/worktrees/`, not sibling directories that
folder-wide tools such as bulk `git pull` scripts also scan.

## Command Aliases

| Alias | Required behavior |
|-------|-------------------|
| `dyu` | Read this file and own agent file, reply exactly “I am [Agent Name], and I understand.”, then await the next task |
| `cnp` | Check secrets and scope; `git add .`, Conventional Commit and push; resolve unsafe unrelated changes first |
| `umd` | Update documentation affected by recent changes; use `update-docs` if installed |
| `rlc` | Read-only review of the last commit; use an independent reviewer for your own code |

Aliases do not authorize force-pushes, destructive cleanup or additional external
actions. Report completion or a precise blocker.

These are project conventions using the [AGENTS.md](https://agents.md) format,
not AAIF certification or a claim of runtime protocol interoperability.
