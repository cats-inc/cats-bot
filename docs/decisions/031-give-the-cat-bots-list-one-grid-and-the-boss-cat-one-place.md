# ADR-031: Give the Cat Bots List One Grid and the Boss Cat One Place

## Status

Accepted — 2026-11-16, at the owner's request. The owner asked for a review of Cats Bot Settings after the cat bot's
own settings (ADR-030), was shown a proposal and a mock, and chose its recommendations: no Settings for a cat bot
that is not running, order in its own mode, nothing about limits or visibility while no Boss Cat is assigned, and
the hub's own dialogs for archive and delete. Amends [SPEC-008](../specs/SPEC-008-hub-and-bots.md) FR-5,
[SPEC-009](../specs/SPEC-009-boss-cat-role.md) FR-8, [SPEC-012](../specs/SPEC-012-boss-cat-status-board-and-contact-notes.md)
FR-12 and [SPEC-002](../specs/SPEC-002-desktop-presence-settings-and-first-run.md) FR-4. The Agent CLIs tab is as
ADR-030 left it.

## Context

- The Cat bots list had the conversation list's old problems (ADR-026).
  - Each row was a wrapping flex row. The Boss Cat's row had no "Boss Cat sees status" switch, so its controls fit
    on the first line. Every other row's controls moved to a second line.
  - At 860 px, Stop sat 382 px from the row's start on the Boss Cat's row and 454 px on the others; rows were 60 px
    and 103 px tall.
  - At the window's 600 px minimum, the order arrows and Archive were outside the window, and the page scrolled
    sideways.
- What the Boss Cat may see was a switch on every row, explained only in a tooltip. The rest of the role (holder and
  limits) was in its own group below.
- The list had no way to open a cat bot's settings.
- Order was two arrow buttons on every row. It sets which cat bot starts first, where its floating Cat first sits and
  its place in the tray.
- The Boss Cat limits were uncontrolled fields saved on blur. A value out of range was dropped silently and stayed on
  screen.
- Some words were the system's: "Hops per chain", "Found in the bots folder", "Hub settings".
- The data folder was on General, while Data held only the reset.

## Decision

1. **One grid, the same columns in every row.**
   - The columns are: the face and its state dot; the name with its provider and state; Auto-start; Start or Stop;
     Settings; Archive.
   - Auto-start is named once, above the column.
   - A control that cannot apply leaves its cell empty:
     - A cat bot another program runs has no Auto-start, Start or Archive.
     - A missing one has no Start.
     - Only a running or starting cat bot has Settings.
   - A failed cat bot's error takes a line of its own under the row.
   - A list narrower than 420 px keeps Settings and Archive as glyphs.
   - Archived cat bots use the same grid, with Restore and Delete.
2. **Settings opens the cat bot's own settings window** (`openSettings`, a new hub action).
   - A cat bot that is not running has no settings window, so it has no Settings.
   - Settings does not start it.
3. **Order has its own mode.**
   - "Change order" replaces each row's controls with up and down, and says what the order is for. "Done" brings
     them back.
   - New cat bot is hidden meanwhile.
4. **The Boss Cat has one place.**
   - The group holds the holder, with its tools hint, and the two limits:
     - "Hand-offs for one request, at most … times";
     - "Messages from the Boss Cat per hour, at most … messages".
   - A limit is saved when its field is left. A whole number out of range becomes the nearest one the hub accepts,
     and an emptied field keeps its value.
   - "What the Boss Cat can see" lists every other cat bot with its switch (SPEC-012 FR-12). Its explanation is on
     the page.
   - With no Boss Cat assigned, only the holder field shows. The limits and switches keep their values, and the
     switches stay on by default.
5. **Archive and delete keep the hub's own dialogs.** The main process asks, so the page cannot skip a step
   (SPEC-008 FR-5).
6. **General and Data.**
   - General has three groups: Language; Start-up and floating Cats; Updates.
   - Data has the data folder and the reset. The reset says what it erases and what it keeps as two short lists, and
     calls the window Cats Bot Settings.
7. **Colour.** Download update and Restart and install run something on the computer, so they use the ink button
   of ADR-030. New cat bot keeps amber as the page's main action.
8. **Words.** "In the folder but not added yet" replaces "Found in the bots folder".

## Consequences

### Positive

- Rows line up and never wrap or scroll sideways, at 860 px and at 600 px.
- Everything about the Boss Cat is in one place, with its explanation in view.
- A cat bot's settings are one click from the list.

### Negative

- A stopped cat bot's settings still need it started first.
- Changing the order takes one more press.

### Neutral

- No stored data changes. The listing gains `limitRanges`, and `BotAction` gains `openSettings`.

## Alternatives Considered

### Alternative 1: Start a stopped cat bot when its Settings is pressed

- **Pros**: every row has Settings.
- **Cons**: starting a cat bot also starts its Runtime and its own initiative.
- **Why rejected**: the owner chose an empty cell instead.

### Alternative 2: Keep the arrows on every row

- **Pros**: one press per move.
- **Cons**: two more buttons per row, which crowd a narrow window.
- **Why rejected**: order changes rarely.

### Alternative 3: Confirm archive and delete in a box under the row, as the conversation list does

- **Pros**: the same look as the conversation list.
- **Cons**: the main process would still have to ask, or a page could skip the step.
- **Why rejected**: the hub's dialog already is that guard.
