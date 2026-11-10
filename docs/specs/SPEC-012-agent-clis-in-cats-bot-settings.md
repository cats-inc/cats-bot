# SPEC-012: Agent CLIs in Cats Bot Settings

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Implemented on 2026-11-11 (PLAN-012); real installs and updates on clean machines not yet accepted |
| **Owner** | Product owner |
| **Reviewer** | Independent agent before merge |
| **Related decision** | [ADR-019](../decisions/019-manage-agent-clis-from-cats-bot-settings-with-the-wizard-rows.md) |
| **Related plan** | [PLAN-012](../plans/PLAN-012-agent-clis-in-cats-bot-settings.md) |
| **Updates** | SPEC-010 FR-21; SPEC-008 FR-5 |

## Summary

Cats Bot Settings gets an Agent CLIs tab. It lists every agent CLI the cat bots can use and
what those CLIs need, in the setup wizard's rows (SPEC-010). It can install, update and sign
in, under the wizard's rules: nothing runs until the owner asks, and only ticked rows change
anything. Each cat bot's Cat bot tab shows its own CLI in the same rows.

## Goals

- Opening Settings starts no process.
- The owner can see which CLIs the cat bots share, which bot needs which, and what each script
  would do before it runs.
- Updating a CLI or Node.js is as visible and as deliberate as installing it.
- One wording for a row, wherever it appears.

## Non-Goals

- Changing vendored helpers or their JSON contract.
- Saying whether an update is available before it runs (ADR-019 Alternative 2).
- Repair or uninstall.
- Checking on a schedule or at launch beyond what ADR-006 already does.

## Requirements

### Functional Requirements

**The tab**

1. FR-1: Cats Bot Settings (scope `hub`) has a third tab, Agent CLIs (「Agent CLI」), after
   General and Cat bots. A cat bot's Cat bot tab opens it through "All agent CLIs".
2. FR-2: Rows are grouped as the wizard groups them.
   - "Installed through Node.js": Node.js and npm, the npm folder, then Codex. They are drawn as a
     stem from Node.js, solid once Node.js is ready.
   - "With their own installer": Claude, Antigravity, Grok, Muse.
   - "Optional, and fine to leave for later": PowerShell scripts, on Windows only.
3. FR-3: Opening the tab runs nothing.
   - Before the first check in this hub session, every row reads "Not checked yet".
   - The lead says nothing is checked until the owner asks.
   - The hub keeps the last results in memory for its session. The tab shows them with the time
     of the check, and keeps its ticks and log while another tab is shown.
4. FR-4: Check this computer is the consent for read-only checks. Its hint says how many run: one
   per row, plus Codex first-time setup on Windows.
   - Node.js is read first. While it is not ready, the npm folder and Codex wait unread.
   - The rest are read at most three at a time.
5. FR-5: A row whose check cannot run says so, with "Cannot check" and its reason in its details.
   Nothing changed, and the other rows are not affected.
6. FR-6: A CLI's row names the cat bots that use it ("Used by Mochi, Tora"), from Settings → Cat
   bots; archived cat bots do not count.
   - Rows the cat bots need, and Node.js and the npm folder when one uses Codex, count as
     required.
   - The lead says how many required rows are not ready. Other rows can be ticked but are not
     counted.

**Changes**

7. FR-7: Every change is ticked by the owner, unticked by default.
   - A row that needs work has a tick box at its left, with its summary, tags and details: what
     the helper reports it would do, the command that really runs, the script's SHA-256 and
     source, and a command for doing it by hand.
   - "Apply N ticked" runs ticked rows top down, one at a time, each read again after it runs.
     "Stop after this one" keeps the rest ticked.
   - A failure stops the queue and keeps the ticks after it. A row the owner ran offers Try
     again without a new tick.
   - "Tick all N required" appears from two required rows.
   - Codex waits for Node.js and the npm folder; setting up Node.js also reads what waited on it.
8. FR-8: A working row whose helper has an update gets an Update tick at its right, after its
   version. This covers Node.js and the five CLIs, not the npm folder or PowerShell scripts.
   - Rows without one keep the column, so versions line up.
   - Ticking it shows the row's tags and "What it does": it installs the newest release if there
     is one, and if this is already the newest, nothing changes. It shows the update command,
     the script and a command for doing it by hand.
   - "Tick all N updates" appears from two working rows.
   - An update runs the helper with `-Upgrade`: through `Invoke-SetupHelper.ps1 -Upgrade` on
     Windows, and `-Upgrade -Json` on macOS and Linux.
   - Updating Node.js on Windows needs administrator rights, and the footer says Windows will ask.
9. FR-9: An update is read before and after.
   - The row then says "Updated 2.0.14 → 2.0.20", "Updated to 2.0.20" when the version before was
     unknown, or "Already the newest".
   - An update that fails, or whose permission prompt is declined, leaves the version that was
     there. The row stays ready and says so, and the queue stops.
   - The result stays on the row while that version is the one there.

**Sign-in**

10. FR-10: After a check, a Sign in group lists each working CLI: what it reports (Claude says
    signed in or not; the others cannot tell) and "Open terminal and run" with its fixed command.
    It opens only for a CLI the last check found working, and the log records it.
11. FR-11: On Windows, once Codex works, Codex first-time setup follows. It is advisory, as in
    SPEC-010 FR-15.

**Security and scope**

12. FR-12: The tab's channels (`computer:*`) answer only Cats Bot Settings' main frame.
    - Only a fixed helper id and a change (`apply` or `upgrade`) cross them.
    - One setup operation runs at a time across the hub, whichever window asked.
    - Nothing new starts while the hub is quitting.

**A cat bot's own tab**

13. FR-13: The Cat bot tab shows its provider's chain in the same rows, ticks, details and log.
    This replaces `ProviderInstallation` and amends SPEC-010 FR-21.
    - Looking at a provider starts nothing. Choosing another one drops what was read.
    - It may also update; its `setup:install` takes the change, and only a cat bot's settings
      window may pass `upgrade`.
    - What it reads updates the Agent CLIs tab's rows for the same helpers.

**The log**

14. FR-14: Both tabs end in the wizard's log (SPEC-010 FR-14). Any run opens it. It closes about
    1.4 s after success, stays open after a failure, and waits while the pointer is on it.

### Non-Functional Requirements

- **Security:** as SPEC-010. No path, argument or command crosses IPC, and no credential file is
  read.
- **Compatibility:** no stored data changes. `SetupStep` gains `updateCommand` and optional
  `lastUpdate` and `checkError`.
- **Accessibility:** real buttons, labels and tick boxes, visible focus, and text contrast of at
  least 4.5:1.
- **Localization:** all page text in English and Traditional Chinese. Helper text is shown as
  reported.

## Design Overview

- `src/shared/providerSetup.ts`: helper ids, the update list and `ComputerSetupState`.
- `src/shell/electron/providerSetup.ts`: `computer()`, `checkComputer()`, `changeComputer()`, and
  `install()` with a change.
- `src/shell/electron/computerSetup.ts`: the `computer:*` channels.
- `src/renderer/settings/AgentClisTab.tsx`: the tab.
- `src/renderer/settings/ProviderChecklist.tsx`: a cat bot's own CLI.
- `src/renderer/settings/setup/`: shared rows (`StepRow.tsx`), wording (`setupFacts.ts`), logic
  (`setupLogic.ts`) and the log (`SetupLog.tsx`, `useSetupLog.ts`).

## References

- [ADR-019](../decisions/019-manage-agent-clis-from-cats-bot-settings-with-the-wizard-rows.md)
- [SPEC-010](SPEC-010-setup-wizard.md)
- [SPEC-008](SPEC-008-hub-and-bots.md)
