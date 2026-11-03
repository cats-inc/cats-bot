# SPEC-010: Setup Wizard

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Implemented on 2026-11-04 (PLAN-011), approved by the owner after an interactive mock. Installs on clean machines are not yet accepted: see PLAN-011 Phase 4 |
| **Owner** | Product owner |
| **Reviewer** | Independent agent before each merge |
| **Related decision** | [ADR-015](../decisions/015-make-creating-a-cat-bot-a-wizard-whose-scripts-the-owner-ticks.md) |
| **Related plan** | [PLAN-011](../plans/PLAN-011-setup-wizard.md) |
| **Updates** | SPEC-002 FR-1 and FR-3; SPEC-008 FR-4, FR-5, FR-19 and FR-23; SPEC-009 FR-4 |

## Summary

Creating a cat bot becomes a three-page wizard. Nothing runs until the owner asks, every
script that changes the computer is ticked by the owner, and a log shows what ran. The same
wizard serves the first run, Settings' New cat bot and a Boss Cat's request. A name and a
persona get one rule wherever they enter.

## Goals

- Choosing or looking at a provider starts no process.
- The owner can see, before and after, each change setup makes to their environment.
- A clean machine reaches a working cat bot without a relaunch.
- A name or persona cannot break the program, and the usual ways of hiding text in one are
  refused before it reaches a session.

## Non-Goals

- An embedded terminal or live helper output (ADR-015 Alternative 1).
- Changing the vendored helpers. Their contract and provenance stay as they are.
- Removing the read-only check on each launch.
- Validating what a persona asks for. It is the owner's own instruction to their cat bot.

## User Stories

- As an owner on a clean computer, I want to read what each script does before it runs, so
  I can decide or do it myself.
- As an owner, I want to change my mind about the provider without something having run.
- As an owner, I want to paste a persona without hidden characters coming along unseen.

## Requirements

### Functional Requirements

**The window**

1. FR-1: One page serves the first run (`purpose=first-run`), New cat bot and a Boss Cat's
   request, which opens it filled in (`purpose=create`). Its three steps are shown in a
   side rail with the Cat and a note holding the name and provider, in Settings' layout.
   Finished steps can be revisited until a run or the creation starts.
2. FR-2: The window opens at 860×640 and is resizable, with a minimum of 800×600. Page 1
   fits the minimum without scrolling. A larger window gives the log more height, up to
   320 px; forms keep a readable width.

**Page 1: who it is**

3. FR-3: Page 1 starts no process and scans no PATH: `setup:providers` returns the fixed
   list. No provider is preselected and none is focused; the name field has focus. Fields
   in order: name, look, provider, optional personality. Display language is offered on the
   first run only. The button reads "Check this computer", is disabled until the name is
   valid and a provider chosen, and the hint beside it says how many read-only checks run.
4. FR-4: A Boss Cat's request fills in name, persona and provider, and still waits for the
   button.
5. FR-5: Five preset buttons sit above the personality box on the five-column grid: Curious,
   Steady, Playful, Gentle and Blunt.
   - A press replaces the box's content, and Ctrl+Z restores it.
   - The first preset's text is also the placeholder, which stays when the box is cleared.
   - A button shows pressed while the box holds exactly its text.
   - Presets are translated. A box still holding a preset follows a language change.

**Page 2: this computer**

6. FR-6: The check runs the selected provider's helpers, read-only, only after the button or
   "Check again". Back cancels a running check.
7. FR-7: Reading order for Codex: Node.js first. While Node.js is not ready, the npm folder
   and Codex wait unread, because their plans cannot be known. PowerShell scripts (Windows)
   is read regardless. Once Node.js is ready, everything is read in one pass.
8. FR-8: Rows appear in this order: Node.js, the npm folder, the provider CLI, then
   PowerShell scripts. Each has one state:
   - ready, with version and no tick box;
   - needs work, with a tick box;
   - waiting on Node.js, grey, with no tick box;
   - queued or running, with a timer;
   - failed, including a declined UAC prompt;
   - installed but not found, the fallback in FR-13.
9. FR-9: Every script that changes anything runs only if ticked, and all are unticked by
   default. "Tick all required" closes the list after the last tickable row, ticks required
   rows only, and turns into its undo when all are ticked. It appears from two required
   tickable rows. A declined UAC prompt's "Try again" needs no new tick. "Try again" appears
   only for a row the owner already ran. A row that failed its read-only check was never
   ticked, so it offers "Check again" and the command for doing it by hand, and leaves other
   ticked rows free to apply.
10. FR-10: A row shows a plain summary, tags for its consequences, and details that are
    collapsed by default; only a failed row's details open by themselves. The details hold:
    - what the helper reports it would do (`plannedActions`, `plannedChanges`), verbatim;
    - the command that really runs;
    - the script's SHA-256 and source commit, from `assets/setup/provenance.json`;
    - a command for doing it by hand, with a copy button.

    Tags follow the operating system and the helper's plan: administrator rights, a download,
    a remote install script, winget's agreements, the user PATH, npm settings, the PowerShell
    policy, a shell profile on macOS and Linux, and removal of an old npm package. Every
    command in the wizard uses one snippet style.
11. FR-11: "Apply" runs ticked rows one at a time from the top, with a fresh check after each.
    "Stop after this one" leaves the rest ticked. The window cannot close during an install.
12. FR-12: PowerShell scripts is optional: "（選用）" in its title, no prerequisite, and it
    never blocks Codex or finishing. Declining it opens sign-in in Command Prompt.
13. FR-13: A failure stops the queue and states what happened: a declined UAC prompt says
    nothing changed. When a helper asks for a restart and the fresh check still cannot
    confirm the step, the row says the item is installed but not found yet, offering "Check
    again" first and then restarting Cats Bot, keeping the page's input (a draft file read
    once and removed on the next start).

**The log**

14. FR-14: The log is a read-only text area in the product's ink, across the window's foot,
    with a one-line bar when closed.
    - Each run adds its time, kind (check, change or terminal), full command and the
      helper's reported status, version, plan, changes and warnings; a stopped or failed run
      says so in red. A run in progress shows a timer.
    - Any script run opens it. It closes about 1.4 s after success, stays open after a
      failure, including a check that fails or a terminal that cannot open, and waits while the
      pointer is on it.
    - Once the owner toggles it, it stays as they set it, except that a failure opens it.
    - "Copy all" copies it. The log itself lasts as long as the window. The hub's bounded
      diagnostics record each finished run in fixed words only (kind, helper, status, change
      count, duration), because ADR-013 keeps arguments out of those files and a helper's
      own text can hold home paths.

**Page 3: sign-in and start**

15. FR-15: Sign-in is a row like page 2's.
    - Claude reports signed in or not, asked of the CLI; "Check again" asks again.
    - The other four give no signal, and the row says so.
    - "Open terminal and run" starts a new terminal with a fixed command per provider, and
      never reads a credential file. No text from the page or from a model reaches it.
    - Where no terminal is found, the row says so and the command can be copied.
    - After a change, the row says already-open terminals need reopening to see the new PATH.
16. FR-16: The model field follows Cats Chat's `ProviderModelFields`, in the Bot tab too:
    every catalog entry; the selected entry's controls except `request` scope; `(default)`
    on default entries and values; the first listed value when a catalog names no default;
    controls reset when the model changes; catalog text not translated. A preset field
    appears only if a catalog has presets, which no CLI catalog does today.
17. FR-17: On a first run where it is offered (SPEC-008 FR-23), "Start Cats Bot when I sign in"
    is a checkbox, ticked by default. Unticked leaves no login item. An existing entry stays
    as it is.
18. FR-18: Before creating, the page lists what the button does: the folder it creates, the
    Boss Cat role on a first run, and starting the cat bot. It also states how many changes
    the wizard made.

**A name and a persona**

19. FR-19: One browser-safe rule, used by the page, `validateSetupInput`, `createProfile`,
    `applyProfilePatch` and the Boss Cat tool:
    - **Name:** trimmed; 1 to 40 UTF-16 units; well formed; at least one letter, number,
      symbol or punctuation mark; no control or format characters, line breaks, the Braille
      blank or other Default_Ignorable_Code_Point characters. U+FE0E and U+FE0F stay allowed
      right after an emoji or symbol, because emoji need them.
    - **Persona:** trimmed, line endings normalized to LF; at most 4,000 UTF-16 units; well
      formed; line feed and tab allowed; no other control characters, no bidirectional or
      tag characters, line or paragraph separators, other format characters or other
      Default_Ignorable_Code_Point characters, which include the other variation selectors.
      U+FE0E and U+FE0F stay allowed right after an emoji or symbol, and zero-width joiner and
      non-joiner right after a letter, mark, number, punctuation mark or symbol, because emoji
      and some scripts need them. Anywhere else they can spell out hidden text. A joiner after
      each visible character is still possible, and spaces, the Braille blank, private-use and
      unassigned characters are not refused, so the rule narrows hidden text and does not rule
      it out.
    - A value that breaks the rule is refused with a message saying why. It is never
      silently changed, because silently stripped text is how a hidden instruction would go
      unnoticed.
    - The rule applies to new or changed values. A stored value is read as it is, and an
      unchanged value in a patch passes.
20. FR-20: Text that came from a profile is made one line before it enters a heartbeat prompt.

**Settings**

21. FR-21: The Bot tab checks a provider only when asked, and its text fields follow FR-19. The
    check on each launch stays (ADR-006).

**After an install**

22. FR-22: No step needs a relaunch of Cats Bot on the normal path: each helper run re-reads
    PATH, and a reported `commandPath` reaches the hub and every core (SPEC-008 FR-19).

### Non-Functional Requirements

- **Security:**
  - Setup IPC stays limited to the owned window's main frame, with a fixed helper and action.
  - No path, argument or free text crosses it.
  - React renders all owner text, and the only markup inserted is the constant Cat art.
  - A persona reaches a CLI by the same route as any message, so Runtime's Windows quoting
    covers both.
- **Compatibility:** no change to stored data. `SetupInput` gains optional fields. The
  tighter input moves the carrying release to the next minor.
- **Accessibility:** real buttons and labels, visible focus, reduced motion respected, and
  text contrast of at least 4.5:1.
- **Localization:** all page text is in English and Traditional Chinese. Catalog and helper
  text is shown as reported.

## Design Overview

- `src/shared/botText.ts`: the FR-19 rule, free of Node and React.
- `src/shared/providerSetup.ts`: step and log contracts.
- `src/shell/electron/providerSetup.ts`: reading order, optional steps and log events.
- `src/shell/electron/setupTerminal.ts`: the fixed sign-in commands per OS.
- `src/renderer/settings/setup/`: the wizard, replacing `SetupPage.tsx`.

## Dependencies

- Helpers' existing JSON fields; no helper changes.
- Runtime's catalogs through `readPackagedModelCatalog`.

## Open Questions

- None for the owner. macOS and Linux have no clean-machine acceptance on record, so
  PLAN-011 Phase 4 lists it.

## References

- [ADR-015](../decisions/015-make-creating-a-cat-bot-a-wizard-whose-scripts-the-owner-ticks.md)
- [ADR-006](../decisions/006-share-runtime-catalogs-and-package-provider-setup-helpers.md)
- [ADR-013](../decisions/013-keep-bounded-production-host-diagnostics.md)
