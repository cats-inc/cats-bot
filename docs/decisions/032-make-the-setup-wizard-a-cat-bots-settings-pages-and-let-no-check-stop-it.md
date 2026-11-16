# ADR-032: Make the Setup Wizard a Cat Bot's Settings Pages, and Let No Check Stop It

## Status

Accepted — 2026-11-16, at the owner's request. The owner asked for a review of the setup wizard after a cat bot's
settings (ADR-030) and Cats Bot Settings (ADR-031), was shown a proposal and a mock, and chose its recommendations.
Amends [ADR-015](015-make-creating-a-cat-bot-a-wizard-whose-scripts-the-owner-ticks.md): a row's own action, confirmed
in a box, replaces the tick, and nothing a check finds stops the wizard. Amends ADR-030 §5, which kept the wizard's
ticks, and [SPEC-010](../specs/SPEC-010-setup-wizard.md) FR-1 to FR-3, FR-6, FR-8, FR-9, FR-11, FR-13, FR-15 and FR-18.

## Context

- **The wizard's pages did not match a cat bot's settings.**
  - The wizard had Name and look (name, look, provider, personality), Check and install, and Sign in and start
    (sign-in, start at login, model, summary).
  - Settings has Name and look, Provider and model (agent CLI, its setup rows, sign-in, model), and Permissions.
  - The provider was chosen on page 1, installed on page 2, and signed in to with its model chosen on page 3.
- **The same work had two controls.** The wizard ticked rows and pressed "Apply N ticked". Settings gives each row
  one action, confirmed in a box under it, and "Set up all N".
- **A check stopped the wizard.**
  - Next stayed disabled while a required row was not ready.
  - When a check script could not run ("Cannot check"), Next stayed disabled even when the CLI worked.
  - When an install could not be found yet, the page offered only "Restart Cats Bot" and "Check again".
  - Both creation entry points ran the check again and refused to create.
- **Stopping did not protect anything.** A CLI removed after setup leaves a cat bot that starts and cannot answer.
  - In a temporary home with no CLI on PATH, Claude, Codex and Grok cat bots all started.
  - Their first message failed with "resume failed: No provider session ID to resume" (Claude, Codex) or
    "Error: spawn grok ENOENT" (Grok). The note said only "Response failed".
- **Many lines only reassured.** "Changes nothing on your computer", "Runs only what you tick", "Nothing is created
  until you confirm", "(nothing checks whether it is installed yet)", and a closing "So far this setup has changed
  nothing on your computer".
- The wizard never said what the new cat bot may do. The owner first saw that in its settings.

## Decision

1. **The wizard's pages are a cat bot's settings pages, under the same names.**
   - Name and look: name, look and personality. Display language is offered on the first run, as before.
   - Provider and model: the agent CLI, its rows on this computer, sign-in, and the model.
   - Permissions: what the new cat bot may do, then start at login and what Create does.
   - Every page stays mounted. A check or a step on page 2 goes on while another page shows, as on a cat bot's
     Provider and model page, and page 2 shows its result when the owner comes back.
2. **Page 2 is the settings page's own rows (`ProviderOps`).**
   - Each row has one action (Install, Set up, Update). It asks in a box under the row, naming what will run, and
     runs once the box's button is pressed. "Set up all N" does the required rows, top down.
   - "Check this computer" is still the consent for the read-only check. Nothing runs on choosing a provider.
   - The log stays across the window's foot, as SPEC-010 FR-14 has it. It is told when a check or a step starts
     and ends, so it opens for a run, closes after success, and stays open after a failure.
   - A row Cats Bot cannot find yet offers "Restart Cats Bot", keeping what the wizard holds (SPEC-010 FR-13).
   - A ready row offers no Update, because the wizard's windows only install (SPEC-013 FR-13).
   - On Windows, while PowerShell scripts is not set up, the sign-in row says it opens in Command Prompt
     (SPEC-010 FR-12), on a cat bot's own page too.
   - Page 2 has no link to Cats Bot Settings and no log sheet.
   - The six agent CLIs sit three to a row, as in settings.
3. **No check stops the wizard.**
   - Next needs only a valid name and persona on page 1 and a chosen provider on page 2.
   - Create needs a model and waits only while a check or a step is running.
   - Neither creation entry point refuses (`checkForCreation` is removed). Each waits for a step that is still
     running, then looks, read-only, where the chosen CLI is (`prepareEnvironment`). That puts its folder on the PATH
     the new core inherits, as a check on page 2 would have, because the Runtime can find a CLI outside PATH where
     its installer puts it.
4. **A missing CLI is said where it matters, when the owner sends a message.**
   - When an owner's message fails, the core looks for the provider's command on the PATH it gives the Runtime, as
     `listProviders` does. If the command is not there, the conversation gets one error saying so, with
     `fix: { kind: 'install_cli' }`.
   - The note shows it as "{provider} is not on this computer, so this message got no reply." with "Open Provider
     and model", which opens the cat bot's own settings on that page.
   - Neither the Runtime's resume error nor the CLI's own error from before any output, such as a failed spawn, is
     added beside it. The work item keeps the raw reason for the log.
   - A host that names the command itself (development, tests) is trusted. Heartbeats and schedules stay quiet.
5. **Page 3 says what the cat bot may do.** It shows the sentence the cat bot's Permissions page starts with, for
   the provider's default, which is not changed (ADR-030). Creation takes no permission input.
6. **The reassuring lines are gone.**
   - The rail shows only page names. The provider field, page 1's hint and the checking page's lead lose theirs.
   - Page 3 no longer counts changes or says nothing changed. The log keeps that count.
   - What says what will run stays: tags, details, the confirmation box, "When you press create", and what a
     failure did.

## Consequences

### Positive

- The wizard and a cat bot's settings have one layout and one way to set up a CLI.
- Nothing the wizard reads can trap the owner on a page.
- A missing CLI is named, with the place to install it, whenever it is missing, not only during setup.
- The owner sees what the new cat bot may do before creating it.

### Negative

- Page 2 holds more than the old page 2, so it scrolls in more states at 860×640, more at 800×600, and more with the
  log open. The button bar stays in place, as on the settings page.
- A cat bot can be created whose CLI is missing. Its first message then says so instead of answering.
- Each row is pressed and confirmed, where several ticks used to run with one Apply. "Set up all N" covers the
  required rows.

### Neutral

- A transcript entry may carry `fix`. Older versions ignore the field and show the entry's English text.
- `canCreateFromSetup`, the tick helpers and the ticking row are removed.

## Alternatives Considered

### Alternative 1: Keep the ticks in the wizard

- **Pros**: one Apply runs several rows.
- **Cons**: the wizard and settings keep two controls for one job.
- **Why rejected**: the owner chose one control for both.

### Alternative 2: Show the whole Permissions page on page 3

- **Pros**: the owner could change permissions before the cat bot exists.
- **Cons**: page 3 would scroll by about 220 px at 860×640, and creation would have to take permission input.
- **Why rejected**: the owner chose the sentence. The defaults stay as they are, and the cat bot's Permissions page
  changes them.

### Alternative 3: Keep stopping at the check, and add a way around it

- **Pros**: fewer cat bots created without a working CLI.
- **Cons**: a check that cannot run still traps the owner. A CLI removed later still goes unnoticed.
- **Why rejected**: the owner asked that no detection hold the UI.
