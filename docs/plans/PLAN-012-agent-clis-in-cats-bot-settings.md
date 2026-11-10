# PLAN-012: Agent CLIs in Cats Bot Settings

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Implemented; real installs and updates on clean machines pending |
| **Owner** | Product owner |
| **Assigned To** | Claude |
| **Reviewer** | Independent agent before merge |

## Related Spec

[SPEC-012: Agent CLIs in Cats Bot Settings](../specs/SPEC-012-agent-clis-in-cats-bot-settings.md),
under [ADR-019](../decisions/019-manage-agent-clis-from-cats-bot-settings-with-the-wizard-rows.md).

## Overview

One PR: the shell contract, the two pages and their documents change together, because the old
installation component goes away with them.

## Implementation Phases

### Phase 1: The shell

- [x] `-Upgrade` in `helperInvocation` and `Invoke-SetupHelper.ps1`, only for Node.js and the
      provider CLIs.
- [x] `ProviderSetup.computer()`, `checkComputer()` and `changeComputer()`: reading order, bounded
      checks, check failures per row, prerequisites, a fresh read after each change, and what
      waited on Node.js.
- [x] Before-and-after update results, kept while the version is the same.
- [x] `install()` takes a change, and a cat bot's check updates the computer's rows.
- [x] `computer:*` channels for Cats Bot Settings only; `shell:openAgentClis`; `setup:environment`
      for a cat bot's settings window.

### Phase 2: The pages

- [x] `StepRow` takes the Update tick, the not-checked and cannot-check states, the stem and the
      users line. Running, queued, sign-in and Codex rows are shared with the wizard.
- [x] `useSetupLog` holds the log's behavior for the wizard and both tabs.
- [x] `AgentClisTab` and `ProviderChecklist`; `ProviderInstallation` removed.
- [x] Copy in English and Traditional Chinese, and the styles in `settings.css`.

### Phase 3: Checks

- [x] Unit tests: `tests/shell/computerSetup.test.ts` and `tests/renderer/agentClis.test.ts`.
- [x] `scripts/test-agent-clis-renderer.mjs`: the hub tab and a cat bot's tab, hidden and isolated,
      with fake helpers, in both languages at 860×640.
- [x] `scripts/test-setup-wizard-renderer.mjs` passes unchanged after the shared rows moved.
- [ ] A real update and install on clean Windows, macOS and Linux machines. Not run by an agent:
      it would change the computer's CLIs.

## Related

- [PLAN-011](PLAN-011-setup-wizard.md)
