# ADR-015: Make creating a cat bot a wizard whose scripts the owner ticks

## Status

Accepted — 2026-11-04, by the owner after reviewing an interactive mock. Specified by
[SPEC-010](../specs/SPEC-010-setup-wizard.md) and carried out by
[PLAN-011](../plans/PLAN-011-setup-wizard.md). This updates the onboarding part of
[ADR-006](006-share-runtime-catalogs-and-package-provider-setup-helpers.md); its catalog,
vendoring and provenance rules stay.

## Context

The page that creates a bot opens with Codex selected and immediately runs its packaged
helpers, so choosing nothing still starts up to four PowerShell processes. Changing the
provider starts another check and locks the provider field until it ends.

The owner also could not see what setup does to their environment:

- Each install is one button. Nothing says that it asks for UAC, runs a remote install
  script, changes the user PATH or the npm prefix, edits `~/.zshrc`, removes an old npm
  package or accepts winget's agreements.
- Helper output is parsed and thrown away.
- Finishing the first run turns on start at login and makes the first bot the Boss Cat
  without saying so.
- The name and persona have no shared rules. The first-run page and the Boss Cat tool each
  check different things, and the Bot tab and `cats-bot init` check nothing beyond a field
  limit.

## Decision

1. **One wizard with three pages** for the first run, for New cat bot and for a Boss Cat's
   request: who it is, this computer, sign-in and start. Each page touches more than the
   last, and nothing runs until the owner asks.
2. **Page 1 runs nothing.** No process and no PATH scan. No provider is preselected. Its
   button says what it does: "Check this computer".
3. **The check is read-only and needs no ticks.** Pressing that button is the consent. It
   still runs scripts and CLIs, so the log opens while it runs.
4. **Every script that changes anything is ticked by the owner**, unticked by default. A row
   shows what the helper itself reports it would do, the exact command, the script's
   SHA-256 and a command for doing it by hand.
5. **The log is our own read-only text area, not a terminal.** It shows each command and the
   helper's structured result.
6. **Sign-in opens a real external terminal** with a fixed command per provider. Cats Bot
   still only asks the CLI whether it is signed in, and reads no credential files.
7. **The Codex chain stops being strictly ordered.** Once Node.js is ready, everything else
   is read at once. The PowerShell policy is optional, listed last, has no prerequisite and
   blocks nothing: helpers run with `-ExecutionPolicy Bypass` and Runtime resolves `.cmd`,
   so only the owner's own PowerShell sessions need it.
8. **Start at login and the Boss Cat role are stated.** Start at login becomes a visible
   checkbox, still ticked by default on a first run where it is offered.
9. **The model field follows Cats Chat's `ProviderModelFields`**: all catalog entries, each
   entry's own controls, `(default)` labels, the first value when a catalog names no
   default, and catalog text left untranslated. Nothing is chosen out of sight.
10. **One rule for a name and a persona**, in a browser-safe shared module, enforced by the
    page, the shell and the core, and applied only to new or changed values.

The setup window takes Settings' size, 860×640, stays resizable, and gets a minimum of
800×600.

## Consequences

### Positive

- Opening the window starts no process, and a read-only check is visible while it runs.
- Nothing changes the owner's environment without a tick, and each change names itself.
- A clean machine needs at most two rounds of ticking instead of four.
- Hidden characters cannot reach a session through a pasted persona, and a name cannot
  forge a line in a dialog, a log or a heartbeat prompt.

### Negative

- More clicks than one install button, by design. "Tick all required" keeps it short.
- The log has no live output: helpers report once, at the end, and winget, npm and msiexec
  output is discarded inside them. An elevated child can never stream back.
- `cats-bot init` and `updateProfile` now refuse text they used to take, so the release
  carrying this moves to the next minor under the version policy.
- Three small color tokens change for contrast, across all of Settings.

### Neutral

- Stored profiles are untouched. A saved name or persona outside the new rule keeps working
  until the owner changes it.
- The check on each launch stays: a GUI launch has no login-shell PATH.
- Settings' Bot tab checks only when asked, with its own install buttons.

## Alternatives Considered

### Alternative 1: An embedded terminal (node-pty and xterm)

- **Pros**: real output, and sign-in could stay inside the window.
- **Cons**: a native dependency on three OSes for a page seen once. It would still show
  little, because helpers discard their children's output, and an elevated child cannot
  attach to it.
- **Why rejected**: the owner accepted our own text area, and sign-in works in an external
  terminal.

### Alternative 2: Tick the read-only checks too

- **Pros**: literally every script is ticked.
- **Cons**: a checklist before the checklist, for scripts that change nothing.
- **Why rejected**: the button and the visible log carry the same consent.

### Alternative 3: Tick the required items by default

- **Pros**: fewer clicks.
- **Cons**: an unread tick is not consent, which is what the owner asked for.
- **Why rejected**: a shortcut after the rows gives the same speed after reading them.

### Alternative 4: A fixed-size window

- **Pros**: one layout to test.
- **Cons**: on a small work area the footer can end up off screen, with no way forward.
- **Why rejected**: the layout already flexes, and a minimum size covers the rest.

## References

- [SPEC-010](../specs/SPEC-010-setup-wizard.md), [PLAN-011](../plans/PLAN-011-setup-wizard.md)
- [ADR-006](006-share-runtime-catalogs-and-package-provider-setup-helpers.md)
- [SPEC-008](../specs/SPEC-008-hub-and-bots.md) FR-4, FR-5, FR-19, FR-23
- [SPEC-009](../specs/SPEC-009-boss-cat-role.md) FR-4

---

*Decision made: 2026-11-04*
*Decision makers: Product owner, Claude*
