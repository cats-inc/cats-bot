# ADR-019: Manage Agent CLIs from Cats Bot Settings with the Wizard's Rows

## Status

Accepted — 2026-11-11. The owner asked for it: Cats Bot's onboarding and setup are
consistent and complete, but the Settings parts that help install or upgrade a CLI or a
dependency had not been brought up to them, in function or in look. Asked where machine-wide
CLIs belong, the owner chose a new tab in Cats Bot Settings. Specified by
[SPEC-013](../specs/SPEC-013-agent-clis-in-cats-bot-settings.md) and carried out by
[PLAN-012](../plans/PLAN-012-agent-clis-in-cats-bot-settings.md).

This extends [ADR-015](015-make-creating-a-cat-bot-a-wizard-whose-scripts-the-owner-ticks.md)
to Settings and amends SPEC-010 FR-21 and SPEC-008 FR-5. The vendoring and provenance rules of
[ADR-006](006-share-runtime-catalogs-and-package-provider-setup-helpers.md) stand.

## Context

- Each cat bot's Cat bot tab installed its CLI through `ProviderInstallation`:
  - one Install button per step;
  - no tick, no plan, no command, no script hash and no command for doing it by hand;
  - no log, no sign-in and no Codex first-time setup.
- It covered only that bot's provider. CLIs are installed for the account and serve every
  native cat bot (SPEC-008 FR-19), yet Cats Bot Settings had no place for them.
- Nothing in Cats Bot could update a CLI or Node.js, although the vendored helpers all take
  `-Upgrade`.
- In check mode no helper can say whether a newer release exists: `_NpmCliInstaller.ps1`
  forces `$isOutdated` to false unless it is upgrading, and the native helpers compare versions
  only when they mean to install.

## Decision

1. **A new hub tab, Agent CLIs**, after General and Cat bots.
   - It lists every agent CLI Cats Bot supports and what they need, grouped as the wizard groups
     them: Node.js and npm, the npm folder and Codex hang from Node.js; Claude, Antigravity,
     Grok and Muse have their own installer; PowerShell scripts is optional, on Windows.
   - A CLI's row names the cat bots that use it. What they use and depend on is required; the
     rest can be installed but is not counted against the computer.
2. **The wizard's discipline, unchanged.**
   - Opening the tab runs nothing. Rows say they are not checked until the owner presses Check
     this computer, which is the consent for read-only checks.
   - Every change is ticked by the owner, unticked by default, and runs top down, one at a time,
     with a fresh check after each.
   - Rows, tags, details and the log are the wizard's own components, so their wording has one
     source.
3. **Update is offered, not announced.**
   - A working row whose helper has an update (Node.js and the five CLIs) gets an Update tick.
     The npm folder and PowerShell scripts get none.
   - Its details say that it installs the newest release if there is one and changes nothing
     otherwise. No row claims an update is available, because no read-only check can know.
   - The checks before and after an update say what happened: "Updated 2.0.14 → 2.0.20" or
     "Already the newest". An update that does not finish leaves the version that was there,
     and the row says so.
   - The Bot-owned `Invoke-SetupHelper.ps1` gains `-Upgrade`; macOS and Linux pass
     `-Upgrade -Json`. No vendored file changes.
4. **Sign-in and Codex first-time setup** follow on the same tab for each working CLI, in a real
   terminal with the provider's fixed command, as on the wizard's page 3.
5. **Results last for the hub session.** The hub keeps the last check of this computer in memory,
   and a cat bot's own check updates the rows it read.
6. **A cat bot's own tab** shows only its CLI's chain in the same rows, ticks and log, with an
   update too, and links to the new tab. `ProviderInstallation` goes away.
7. **Narrow channels.** The tab's channels answer only Cats Bot Settings' main frame and take a
   fixed helper id and change. One setup operation runs at a time across the hub.

## Consequences

### Positive

- One look and one set of rules for every place that changes the owner's computer.
- The owner can see every CLI the cat bots share, which bots need which, and update them.
- An update can never be mistaken for a check: it is a ticked change with its command shown.

### Negative

- An update tick cannot say whether there is anything to update until it runs.
- Checking this computer starts up to nine processes on Windows, three at a time.
- The tab's results disappear when the hub quits.

### Neutral

- The New cat bot wizard still installs only. A cat bot's own tab may also update.
- Repair and uninstall stay out of Cats Bot; the helpers support them, but no page offers them.

## Alternatives Considered

### Alternative 1: Only redo the Cat bot tab

- **Pros**: smaller; no new tab.
- **Cons**: CLIs are shared, and a CLI no cat bot uses yet had nowhere to be installed or
  updated.
- **Why rejected**: the owner chose the hub tab.

### Alternative 2: Announce updates with a read-only version query

- **Pros**: a badge only where a newer release exists.
- **Cons**: needs a new helper mode on three operating systems, in vendored scripts this
  repository does not change.
- **Why rejected**: out of scope for Cats Bot. A helper change belongs to cats-platform first.

### Alternative 3: Update with one button per row

- **Pros**: one click.
- **Cons**: an update downloads, may ask for administrator rights and accepts winget's
  agreements, like an install.
- **Why rejected**: ADR-015 puts every change behind a tick and shows what it runs.

## References

- [SPEC-013](../specs/SPEC-013-agent-clis-in-cats-bot-settings.md)
- [PLAN-012](../plans/PLAN-012-agent-clis-in-cats-bot-settings.md)
- [ADR-015](015-make-creating-a-cat-bot-a-wizard-whose-scripts-the-owner-ticks.md)
- [SPEC-010](../specs/SPEC-010-setup-wizard.md)
- [SPEC-008](../specs/SPEC-008-hub-and-bots.md)

---

*Decision made: 2026-11-11*
*Decision makers: Owner; drafted by Claude*
