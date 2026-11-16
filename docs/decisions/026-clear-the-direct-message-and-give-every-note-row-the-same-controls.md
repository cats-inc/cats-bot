# ADR-026: Clear the Direct Message and Give Every Note Row the Same Controls

## Status

Accepted — 2026-11-16, at the owner's request. The owner said the Settings → Conversations list looked wrong:
its buttons did not line up, rows had different numbers of them, and rows sometimes wrapped. The owner asked
for a "Clear" in the direct message's row where notes have Delete, clearing everything in it including the
CLI sessions, and approved the mock (「可以」). The owner also asked that the rail stop cutting off the bot's
provider, model and effort. Amends [SPEC-002](../specs/SPEC-002-desktop-presence-settings-and-first-run.md)
FR-5 (adds FR-5b), [SPEC-001](../specs/SPEC-001-resident-bot-core-and-global-execution.md) FR-14, FR-27 and
FR-32, and [SPEC-009](../specs/SPEC-009-boss-cat-role.md) FR-8.

## Context

- Each row was a wrapping flex row. Its controls were a 150 px layer select, Open, Rename and Delete.
  - The direct message has no Delete, and a contact note has no Rename (SPEC-012 FR-6), so rows had three or
    four controls. The group was pushed to the right, so its columns differed from row to row.
  - Delete armed itself by turning into "Delete for good?" for four seconds. The wider button pushed its row's
    controls onto a second line.
  - At the window's 600 px minimum, every row wrapped, and Delete stuck out of its row.
  - The select cut "On the desktop (below windows, above icons)" short.
- The direct message cannot be deleted. Until now nothing could empty it.
- Deleting a note closed and deleted only its current Runtime session.
  - A session a provider or model change replaced (SPEC-001 FR-27) was only closed and then forgotten, so a
    bot's Runtime collects closed sessions that nothing will delete.
  - The journal keeps every work item whole, prompt and reply included, and never shortens.
- A Boss Cat reply returns to the conversation that asked (SPEC-009 FR-8). A reply to a deleted conversation
  already goes to the contact note. A cleared direct message still exists, so a reply would land in it with
  no question before it.
- The rail showed "provider · model · runtime state" on one line under the name. The effort was missing,
  and the line was always cut.

## Decision

1. **One grid, the same three columns in every row.**
   - The controls are: where the note lives, Open, and Delete. The direct message has Clear in Delete's
     place.
   - Rename becomes a pencil beside the title. A contact note has no pencil, and its columns are unchanged.
   - The layer control is a menu button with a short name ("On top", "Normal", "Desktop", "Wallpaper") and a
     glyph of the layers stacked from the top of the screen down; the note's own layer is drawn long and
     amber.
     - The menu lists the layers this platform offers, in that order, each with a line under it.
     - A list narrower than 460 px shows only the glyph.
   - Delete and Clear ask in a box under the button, which says what goes and what stays. Nothing in a row
     changes size, so no row wraps.
   - While a menu, a confirmation or a name field is open, the list is not redrawn. It is read again when they
     close.
2. **Clearing the direct message** (`clearConversation`, SPEC-002 FR-5b).
   - **Work stops first.** Queued work is cancelled. A running turn is cancelled and waited for (at most 20 s),
     so nothing it still writes lands afterwards. Meanwhile no turn starts, and the owner's message to the
     direct message is refused.
   - **What goes:** the transcript and presentations; the session, unread count, message times and handoff
     checkpoint; the prompts and replies of its earlier work in the journal; and every session it had in
     Runtime.
   - **What stays:** its id, name, layer, desktop control switch and schedules.
   - **The record notes the clear.** It records `cleared` (`at`, and the `throughSeq` its transcript reached).
     Its next entries continue after that `seq`, so nothing that remembered a `seq` meets a reused one.
   - **Earlier work is hidden, not removed.** Work from before `at` is left out of the note window and the
     Boss Cat's status board. It stays in the journal by id, `sourceRef` and state, so a Telegram message or a
     hub delivery is still accepted only once.
   - **Open windows start over.** `conversation.cleared` tells a note window to drop what it shows, since a
     transcript read only adds.
3. **Replaced sessions are remembered.** A conversation keeps the sessions FR-27 replaced
   (`retiredSessionIds`, the last 50).
   - Clearing or deleting deletes them with the current one.
   - A session Runtime reports `retained` (locked or in use), or cannot delete now, stays remembered for the
     next clear. A deleted note cannot remember one.
   - Runtime's delete also removes the provider CLI's own session files where it can.
4. **Deleting a note leaves no words in the journal either.**
   - Its work items and schedules keep their ids and states, but lose their prompts and replies. A heartbeat
     keeps the mark that makes it one.
   - The journal is rewritten line by line and atomically, keeping lines it cannot read. It makes no backup
     copy, which would keep exactly the text being erased.
   - Delete also waits for its cancelled turn now, so that turn cannot write its reply back afterwards.
5. **A Boss Cat reply after a clear goes to the contact note.**
   - The hub's reply carries `askedAt`, its message's time.
   - A reply to a message sent before the clear goes to the holder's contact note for that bot, as a reply to
     a deleted conversation does.
   - A reply without `askedAt`, from an older hub, returns to the conversation that asked, as before.
6. **The rail names the target in full.**
   - Under the name it shows the Runtime state.
   - Under that, on a line of its own that wraps, it shows the provider, model and effort as the note header
     names them (`executionSummary`).

## Consequences

### Positive

- Rows line up, keep their height and never wrap, at 860 px and at the 600 px minimum.
- The owner can start the direct message over without losing its place, name or reminders.
- Clear and Delete remove what the bot said and heard: from its transcript, its journal and Runtime, including
  sessions replaced long ago.

### Negative

- Sessions replaced before this change were never remembered. They stay in the bot's Runtime until a data
  reset (ADR-023).
- Text outside the bot's own files remains:
  - Telegram's copy of the chat;
  - attachments in the working directory's `.cats-attachments/`, which every conversation shares;
  - a provider CLI's own history where Runtime cannot delete it.
- A clear refuses the owner's message for the few seconds it takes. A Telegram message arriving then fails
  like any update that fails, and the transport tries it again on its next poll.
- A cancelled turn that does not end within 20 s may still write into the cleared direct message.
- An older build ignores `cleared` and `retiredSessionIds`. After a downgrade, work from before a clear shows
  again in the note window, and replaced sessions are forgotten. The fields are additive and nothing is lost
  by ignoring them.

## Alternatives Considered

### Alternative 1: Keep the row and fix only its widths

- **Pros**: smallest change.
- **Cons**: rows would still have different controls, and the armed Delete would still widen its row.
- **Why rejected**: neither of the owner's complaints would be fixed.

### Alternative 2: Delete and recreate the direct message

- **Pros**: reuses deletion.
- **Cons**: the direct message's id is `home` everywhere: in Telegram, schedules, the heartbeat, the Boss Cat's
  routing and the shell's layers. Recreating it loses its layer, name and schedules, and reuses `seq` values.
- **Why rejected**: the direct message is never deleted (SPEC-001).

### Alternative 3: Remove the cleared conversation's work items from the journal

- **Pros**: nothing at all remains.
- **Cons**: ids and `sourceRef` are how a Telegram message or a hub delivery is accepted once. Without them, a
  message delivered again after a restart would run twice.
- **Why rejected**: blanking the text keeps that guarantee and removes what was said.
