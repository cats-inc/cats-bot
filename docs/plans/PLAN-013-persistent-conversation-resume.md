# PLAN-013: Resume Persistent Conversations across Bot Restarts

## Metadata

| Field | Value |
| --- | --- |
| Status | Implemented and locally validated; exact Runtime pin refreshed; unpublished |
| Owner | Bot core conversation lifecycle |
| Reviewer | Independent read-only review completed; findings fixed and regression-tested |
| Date | 2026-11-11 |
| Baseline | eb16f2db99f76f82c216b5026c0009e616d45f02 |

## Related Spec

[SPEC-001](../specs/SPEC-001-resident-bot-core-and-global-execution.md),
[ADR-001](../decisions/001-build-a-resident-bot-core-on-cats-runtime-with-disposable-presentation.md)
and [PLAN-001](PLAN-001-resident-bot-core-foundation.md).
Runtime's SPEC-041 / PLAN-052 define persistence and native loss; Bot
owns conversation identity, rebind decisions, transcript handoff and notices.

## Overview

Before this change, startup and Runtime exit marked live attachments closed. The binder created a new
session for closed attachments even though Bot keeps a stable Runtime data
directory, and Runtime reloads the old record with its native provider ID intact.
Resume that saved record first. A new Bot process must not imply a new Codex
conversation; different home/note conversations must still keep separate threads.

Work is isolated in `.claude/worktrees/codex-session-retention` on
`fix/codex-session-retention`. Existing version-1 records remain readable
without a bulk rewrite. No release or version bump is included.

## Implementation Phases

### P1. Admit saved attachments after restart

- [x] Trace startup, Runtime exit, binder and life reconcile together. Interpret
      compatible closed/failed saved attachments as candidates for inspection,
      unless explicit terminal/reset/retarget evidence forbids it.
- [x] Inspect the saved Runtime session; resume its ID when the worker is gone.
      Never globally discover native sessions or import raw native IDs for the
      normal restart case.
- [x] Re-supply current policy and host/MCP descriptors on resume. Preserve
      provider/model/configRevision checks and one in-flight bind per conversation.
- [x] Preserve interruption of unfinished runs without replay. Startup/reconcile
      performs no inference; heartbeat follows the existing scheduling policy.
- [x] Cover legacy attachment states and home plus multiple note conversations.

### P2. Make replacement depend on evidence

- [x] Preserve typed provider_session_unavailable across HTTP and stream errors.
      Runtime #214 is terminal; the original native ID is never respawned.
- [x] Keep attachments on timeout, unreachable Runtime, authorization/policy error
      and ambiguous failure. A failed resume must not turn the next tick into create.
- [x] For confirmed native loss or authoritative missing Runtime record, apply one
      bounded replacement with correct workspace, transcript handoff and a visible
      notice. Fence further automatic replacements until a successful turn.
- [x] Preserve deliberate reset and incompatible configuration behavior. Do not
      repurpose a closed record belonging to another conversation or revision.

### P3. Recognizable persistent names

- [x] Supply a bounded label such as Cats Bot, bot name and conversation title
      through Runtime's optional sessionLabel contract.
- [x] Keep label failure nonfatal and prevent repeated name writes during ticks.
      Native protocol and stable instruction routing remain Runtime-owned.

### P4. Verification, dependency and governing documents

- [x] Add fake-runtime tests asserting create/resume counts and both IDs after
      Bot restart, Runtime crash, idle sleep and temporary failures.
- [x] Cover concurrent tick/send, multiple notes, terminal loss delivered through
      both transports, replacement failure and explicit reset/retarget.
- [x] Extend real-Runtime integration to stop/restart the host over the same
      isolated data directory. Existing cancel/resume coverage alone is insufficient.
- [x] Replace the old vendored Runtime candidate for integrated validation; record
      exact source and artifact digest and verify the installed package matches.
- [x] Run focused core/integration tests and type checks, then isolated native
      Codex acceptance. Model turns belong only in test profiles; installed user
      activity is observed read-only.
- [x] Amend ADR-001/SPEC-001's closed-versus-sleeping rule and PLAN-001 references
      when implementation is accepted. Record migration evidence if the chosen
      implementation requires any new mandatory persisted state.

## Files to Create/Modify

| File/area | Planned change |
| --- | --- |
| src/core/bot.ts | Startup/runtime-exit attachment classification and terminal evidence. |
| src/core/conversations/binder.ts | Inspect/resume saved identity, preserve coalescing and temporary failures. |
| src/core/life/loop.ts | Reconcile restart candidates without creating unnecessary sessions. |
| src/core/queue/turnRunner.ts | Typed failure recovery and one-replacement fence. |
| src/core/runtime/ | Transport typed errors, support/label fields and fresh resume admission. |
| tests/core/bot.test.ts; tests/core/life.test.ts; tests/core/runtimeStop.test.ts | Restart, concurrency, transient failure and no-inference fixtures. |
| tests/integration/runtime.test.ts; tests/integration/multinote.test.ts | Persisted registry restart and isolated conversation identities. |
| package.json; package-lock.json; vendor/ | Exact Runtime candidate once built and validated. |

## Acceptance and Risks

For a compatible conversation with available native history, owner turns,
heartbeat, sleep and ordinary host restart keep both Runtime and provider IDs.
Temporary errors create zero replacements. Confirmed loss creates at most one
replacement before a successful turn. Separate notes never share a thread.

At the planning baseline, the vendored file was cats-runtime-0.6.2-1bbba8d0.tgz, which predates
Runtime #214. Tests using that package cannot establish the new terminal-loss or
persistence contract. Secret-bearing MCP descriptors must be reconstructed, not
read from saved records. Any new required saved format needs validation, backup,
atomic replacement, failure recovery and the required next-minor boundary.

## Validation and rollout

Type checks passed. Initial focused core suites passed 62 tests; the final changed
selection passed 37 tests covering continuity, life-loop races, persisted response
sealing, real-Runtime restart/multiple notes, and the docs boundary. These counts
overlap. The restart fixture uses its own CLI log so earlier tests cannot pollute
create/turn counts. Both IDs survived a complete host/Runtime stop and restart;
the startup tick sent zero model turns, and home/note resumed independently.

The exact local Runtime candidate was installed without saving package or lockfile
changes. Its SHA-256 is
`256fb37a5b218fc9137910969a5d3b4c1e77a138f09273d8caa6018b0d087a76`; all 1,513
installed package files matched the candidate. Runtime's source-manifest digest is
`ad007a2848162ec3fdbcbd1bffdaa6e6ddf94dfe18aec1a654b018cf74ce472d` over baseline
`36a112123b2df3dbbe0f775fe22ab459c206341f` plus the uncommitted implementation.
That initial evidence preceded the `cnr` request. The tracked vendor pin is now
rebuilt from merged Runtime #215, `fb50e59ab2244bd2c45ae93fa11345cb7507011c`,
using the normal clean-GitHub-clone script. Its artifact is
`vendor/cats-runtime-0.6.2-fb50e59a.tgz`; the SHA-256 is identical to the tested
candidate above. Manifest, package dependency, lockfile and vendor description
were refreshed together without a version bump or publication.

Separate isolated Windows Codex acceptance confirmed same-ID persistent resume,
native-name preservation and two-turn ephemeral non-persistence. No installed Bot
profile or real native history was changed. Native failure/cancel, packaged UI and
macOS/Linux acceptance are not claimed. Independent review findings about stale
home probes and unsealed stream errors were fixed and covered by regressions.

Optional version-1 recovery fields load without rewriting legacy records and use
the existing atomic writer on updates. A failed replacement attempt stays fenced
across restart; explicit conversation reset/retarget can create a new binding.
No mandatory migration, version bump or publication is included.

The `cnr` integration also preserves Runtime-loss recovery from Bot #139 and rest
hours from #142. Known native missing-history text and the existing two-distinct-
prompt failure detector share the persisted fence; unknown transport/resume
failures still retain their mapping. The heuristic's optional
`repeated_provider_failure` marker records its decision separately from confirmed
native loss. Rebuild notices are written after successful creation and excluded
from future handoff packs.

After integration, 26 continuity/loss tests and type checks passed; the preceding
56-test selection also passed its heartbeat, life, presentation and handoff tests.
The known-text repair regression in that first selection was fixed and rerun in
the 26-test pass. Independent integration review is complete. A fenced replacement
can retry known-text failures in its same live worker; Runtime's typed terminal
loss remains non-resumable. The persisted fence still forbids another create.

A clean install from the final tracked pin passed both real-Runtime fixture
integration tests and all seven release-contract tests. All 1,513 installed
package files matched the accepted candidate, and the source manifest, tarball
digests, package dependency and lockfile identity passed validation together.

Integration with Bot #146 preserves the one-error-entry rule, including failure
and rebuild-next outcomes. All 52 selected Bot, busy-retry, loss and continuity
tests and type checks passed after that merge; independent review found no code
issues and its closing-versus-closed documentation correction was applied.

## Progress Log

| Date | Update |
| --- | --- |
| 2026-11-11 | Updated main and created worktree. Confirmed existing persisted mapping and restart bypass; implementation and acceptance remain pending. |
| 2026-11-11 | Implemented saved-identity resume, typed bounded recovery, fresh descriptors and labels; regressions, candidate Runtime restart integration and independent review passed. Release pin refresh remains separate. |
| 2026-11-11 | Integrated current main's loss recovery and rest hours; pinned merged Runtime #215 and verified a clean install, registry restart integration and release contracts. No release or version bump. |
