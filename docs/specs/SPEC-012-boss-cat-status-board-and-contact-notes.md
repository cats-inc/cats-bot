# SPEC-012: Boss Cat Status Board and Contact Notes

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Approved by the owner on 2026-11-11 (D1, D2) and split into two phases the same day after the independent security review (D3). Phase 1 may be implemented. Phase 2 waits for FR-13's Runtime capabilities. Neither is implemented |
| **Owner** | Product owner |
| **Reviewer** | Owner; independent security review on 2026-11-11 (see Security Review) |
| **Updates** | SPEC-009 FR-4 (`hub_bot_status`), FR-9 (its audit) and FR-10 (contact notes); PLAN-009 D29 (the sender conversation becomes a read-only contact note); SPEC-011 FR-13 and FR-14 (the Boss Cat's `assist` heartbeat) |
| **Keeps** | SPEC-009's Non-Goal and FR-6: no bot reads another bot's transcripts, conversations or memory. Phase 1 shares only a board the core builds without message text. These are limits on the hub's API and the cores' commands, not a security boundary: the holder's CLI runs under the owner's OS account and can read control descriptors and bot roots (SPEC-008 Security, SPEC-009 FR-6) |

## Summary

The Boss Cat helps the owner across bots, so it needs to know which bots have work that is
stuck, failed or waiting for the owner. It never reads their conversations.

**Phase 1** gives it a **status board**. Each bot's core builds the board without the model, and
the board holds states, counts, times and note titles, never message text. The Boss Cat's
`assist` heartbeat reads the boards and suggests a next step to the owner in its own direct
message. Phase 1 also turns the conversation a bot keeps for the Boss Cat's messages into a
**contact note** (zh-TW 聯絡簿). The owner can read a contact note but cannot write in it, and
its sessions never carry the owner's words.

**Phase 2**, later, lets the Boss Cat ask a bot for a short status answer. It is built only
once Runtime can run that answer in a session with no tools, no handoff and no provider-side
memory (FR-13). The security review showed that without those capabilities, prompt rules
alone would protect the direct message and the Boss Cat's tools.

## Goals

- The Boss Cat can tell which bots need attention, at no model cost, from facts the cores
  compute.
- In Phase 1 no text from another bot's conversations reaches the Boss Cat except note titles.
  Titles are bounded, cleaned and fenced as data.
- No side channel carries the owner's words to another bot through a contact note: the owner
  cannot write there, and contact-note sessions never carry owner-written entries. Note titles
  are the exception (D1), and the per-bot switch (FR-12) removes them.
- The owner can see every exchange between bots.

## Non-Goals

- Reading another bot's transcripts, conversations or memory.
- The Boss Cat answering, approving or deciding anything for the owner or for another bot.
- A per-bot opt-in that lets the Boss Cat read a bot's notes. A direct message would never be
  included.
- Cats Desktop. Its Boss Cat works through group conversations the owner takes part in, so
  it gets its own cats-platform spec.
- Phase 2 before FR-13 holds.

## Definitions

- **Status board**: what `hub_bot_status` returns for a bot (FR-2).
- **Contact note** (聯絡簿): the conversation a bot keeps for one other bot's messages
  (PLAN-009 D29), marked by `contactOf` (FR-5).
- **Peer section**: the part of the Boss Cat's `assist` heartbeat built from the other bots'
  boards (FR-10).

## Requirements

### Phase 1

#### Status board

1. FR-1: The Boss Cat gets `hub_bot_status`, with an optional `bot`. Without one, it covers
   every bot that is not archived.
   - The hub asks each running bot's core for its board through a new command,
     `workStatus()`. The command is in `HOST_ONLY_COMMANDS` and never callable by a renderer.
   - For a stopped bot, the hub answers from its registry: id, name, `stopped`.
   - For a bot whose switch is off (FR-12): id, name and hub state only.
2. FR-2: A board holds:
   - id, name, the hub state, the runtime state, and whether the direct message is awake or
     asleep (SPEC-011 FR-16);
   - own initiative: on or off, the effective mode, the rhythm phase, the unanswered count,
     whether it waits for the owner, and the next time;
   - the queue: the running item's kind, its conversation and start time, and how many items
     are queued;
   - attention:
     - turns that failed or were interrupted in the last 7 days, not followed by a completed
       turn in the same conversation;
     - how many owner decisions wait (`ask_owner`, approvals, provider interactions), as counts
       only;
     - each with its conversation id;
     - turns with source `bot` and contact notes are left out, so the Boss Cat's own traffic
       never creates attention;
   - schedules: how many, and the next due time;
   - notes: the 20 most recently active notes, contact notes excluded. Each has its id, its
     title, the owner's and the bot's last message times, and whether its last turn failed,
     is running or waits for the owner;
   - the direct message: only the owner's and the bot's last message times. Never its text or
     a title.
3. FR-3: Note titles are the board's only free text.
   - Each is cut to 80 characters, with control and bidirectional-override characters
     removed.
   - Every consumer shows titles fenced as data.
   - Titles are set by the owner, or by the bot when it creates a note. They are never derived
     from a message.
   - Nothing else leaves the core through the board: no message text, prompt, tool argument,
     schedule prompt, decision content, error text, memory, file path or secret.
4. FR-4: A board call runs no model turn and is not a hop (SPEC-009 FR-8). The hub limits it
   to 30 calls an hour per holder, and journals it with ids only (SPEC-009 FR-9).

#### Contact notes

5. FR-5: A contact note carries `contactOf`, the other bot's id. That field, not the `bot-`
   prefix of its id, makes it a contact note.
   - The field is set at creation, and once on existing `bot-<id>` conversations whose id names
     a valid bot. The upgrade is additive, validated, backed up and atomic, per the version
     policy. An older version ignores the field.
   - The note is shown as 「與 {name} 的聯絡簿」 (en "Contact with {name}").
6. FR-6: The owner can open, read, scroll and delete a contact note, but cannot write in it.
   - The composer is replaced by: 「這是 {holder} 和 {bot} 的聯絡簿，你可以看，但不能在這裡輸入。要跟 {bot} 說話，請到它的私訊。」
   - A button opens that bot's direct message.
   - The core refuses, with that reason, every owner-written path into a conversation with
     `contactOf`: `sendOwnerMessage` from the note window, the CLI and the handoff directory;
     `retryOwnerMessage`; and `setConversationDesktopControl`.
   - Telegram reaches only the direct message, so it never writes into a contact note.
7. FR-7: The owner's decisions stay answerable in a contact note: approvals, `ask_owner`
   questions and provider interactions.
   - There, a decision's follow-up turn is a `kind: event` work item, not an owner message. It
     is not owner-present, so it has no desktop control (SPEC-006). It writes no owner entry and
     does not set `lastOwnerMessageAt`, so it never counts as the owner writing (SPEC-011 FR-9).
   - An interrupted delivery ends failed and is never rerun (PLAN-009 D28, SPEC-001 FR-28).
8. FR-8: Every session of a contact note is created from a handoff that leaves out owner-written
   entries (and Phase 2's status entries): new, stale and rebuilt sessions alike. That includes
   SPEC-001 FR-27's rebuild after a configuration change, FR-28's recovery, and the rebuild when
   the provider session is gone. Earlier owner words in such a note therefore never reach a
   reply.
9. FR-9: A contact note shows every message between the two bots, so the owner sees exactly
   what passed.

#### The Boss Cat's own initiative

10. FR-10: In `assist` mode the Boss Cat's heartbeat (SPEC-011 FR-13) appends a peer section
    after its own review.
    - Sources: the hub pushes the other bots' boards, with FR-12 applied, to the holder's core
      every minute through a new host-only command, `setPeerBoards`. A copy older than five
      minutes is left out, and `setBossCat(false)` clears the copies.
    - Content, per bot: its name, its attention items (counts with fenced note titles), its
      waiting decisions, and its oldest unfinished note (fenced title and age). It holds no
      text any bot or model wrote.
    - The prompt asks the Boss Cat to find a bot whose work needs the owner, suggest one next
      step in its own direct message naming the bot and the note (D2), and not repeat a
      suggestion it already made.
    - While the holder runs a heartbeat, its core refuses every `cats-hub` call from that
      turn. A heartbeat can therefore only suggest. Handing work on with `hub_message_bot`
      stays an owner-present turn, after the owner agrees.
11. FR-11: The `assist` skip (SPEC-011 FR-14) also fingerprints the peer section's attention
    items and waiting counts. A quiet review with no change in any bot's attention runs no
    turn. A heartbeat that speaks counts toward the back-off as before (SPEC-011 FR-10).

#### The owner's control

12. FR-12: Settings → Bots has a per-bot switch, 「讓主控貓看到這隻貓的狀態」, on by default.
    - When it is off, `hub_bot_status` returns only that bot's id, name and hub state, and the
      peer section leaves it out.
    - The hub applies it, and pushes fresh peer boards as soon as it changes.
    - The switch does not affect `hub_message_bot`, and the setting's hint says so.

### Phase 2 (deferred): status questions

13. FR-13: Prerequisite. Phase 2 is built only when cats-runtime offers, and tests per
    provider a bot can run on, a session that:
    - has no MCP servers and no file or command tools, or the most restrictive policy that
      blocks them;
    - receives no handoff pack;
    - loads no provider-native project memory (such as `CLAUDE.md` or auto-memory in the
      workspace);
    - can be deleted together with its history.
14. FR-14: When it is built, a status question follows these rules:
    - **Who is asked.** The holder's core decides whom to ask, from attention items whose
      fingerprint changed since that bot's last answer. The model does not decide. The hub
      refuses a question for an unchanged fingerprint.
    - **Focus.** It names a note id from the board, not free text.
    - **What the answering bot sees.** Its review holds its own lines, states and times. The
      owner's lines become "owner wrote at <time>". The direct message and contact notes are
      never in it.
    - **The answering turn.**
      - It runs in FR-13's session.
      - Any approval it raises is declined, not shown.
      - Its work item journals the request kind and the note id, not the built prompt.
      - The session is deleted once the answer is recorded or recovery settles.
      - The answering core also refuses `status` deliveries while its switch is off.
    - **The answer.**
      - The hub cuts it to 1,000 characters, removes control and bidirectional-override
        characters, and deduplicates it by delivery id.
      - Only the latest answer per bot is kept, shown with its age.
      - It is dropped after 24 hours, when the switch turns off, when the bot is archived, or
        when the holder changes.
      - The Boss Cat reads answers in a one-off session without `cats-hub` and without the
        home handoff. Only its final text is written to its direct message.
    - **Limits.** Questions share `messagesPerHour` with `hub_message_bot`. A heartbeat that
      asked counts toward the back-off.
    - **Changes mid-flight.** When the switch turns off or the role moves, pending status
      deliveries fail, late answers are dropped and stored answers are cleared.
    - **Delivery kinds.** `asDelivery` and the broker's counting, open, answer and attach paths
      learn the new kinds explicitly. Both the hub and the core check every limit.

### Non-Functional Requirements

- **Cost**: Phase 1 runs no extra model turn. The board is free, and the Boss Cat's heartbeat
  is skipped when no bot's attention changed.
- **Security**: in Phase 1 the only text that reaches the Boss Cat from another bot is note
  titles: at most 80 characters, cleaned and fenced. Fencing is a prompt-level control. The
  hard controls are that a heartbeat cannot use `cats-hub` (FR-10) and that the hub refuses
  what SPEC-009 FR-6 lists. An injected Boss Cat can still message, start or stop other bots
  and use its native tools in an owner-present turn, as under SPEC-009.
- **Privacy**: a direct message leaves its bot only as message times. Notes leave only as
  titles, and the per-bot switch removes even those.

## Design Overview (Phase 1)

- **Core.**
  - `src/core/hub/status.ts` (new) builds the board from the conversation store, work items,
    schedules and the life loop's status.
  - `workStatus()` and `setPeerBoards()` join `HOST_ONLY_COMMANDS` in
    `src/core/host-api/commands.ts`.
  - The conversation record gains `contactOf`, normalized field by field, and an upgrade marks
    existing contact notes.
  - `sendOwnerMessage`, `retryOwnerMessage` and `setConversationDesktopControl` refuse
    contact notes.
  - Decision follow-ups in a contact note become event items.
  - `binder.ts` filters the handoff of contact notes.
  - `src/core/life/review.ts` gains the peer section.
  - The core's `cats-hub` server refuses calls while the running item is a heartbeat.
- **Hub.**
  - `hub_bot_status` joins `src/core/tools/hubTools.ts` and
    `src/shell/electron/hub/bossCatBroker.ts`.
  - The hub pushes peer boards each minute.
  - The registry keeps the per-bot switch.
- **Renderer.** The note window drops the composer for contact notes. Settings → Bots gains
  the switch.

## Test Plan (Phase 1)

- The board has every FR-2 field and no message text. A fixture whose messages, schedules,
  decisions and errors hold a marker string never shows the marker.
- Titles over 80 characters, or holding control or bidirectional-override characters, come out
  cut and cleaned.
- A stopped bot, an archived bot and a bot with the switch off each return only what FR-1 and
  FR-12 allow.
- `workStatus` and `setPeerBoards` are refused from a renderer channel.
- Owner messages, retries and desktop-control changes in a contact note are refused, from the
  note window, the CLI and the handoff directory. An `ask_owner` answer there runs as an event:
  it is not owner-present and does not set `lastOwnerMessageAt`.
- A contact note with old owner entries gets a handoff without them, for a new, a stale and a
  rebuilt session.
- The Boss Cat's `assist` heartbeat includes the peer section, skips when no attention changed,
  and is refused when it calls a `cats-hub` tool.
- Board calls beyond 30 an hour are refused, and turning the switch off removes the bot from
  the next peer section.
- The upgrade marks existing `bot-<id>` conversations, keeps a backup and survives a failed
  write.

## Decisions

- D1 (2026-11-11, the owner): note titles reach the Boss Cat by default, although they can
  reveal a topic. The FR-12 switch turns the whole board off for a bot.
- D2 (2026-11-11, the owner): the Boss Cat writes its suggestion in its own direct message, not
  in the other bot's (FR-10).
- D3 (2026-11-11, the owner): after the security review, the spec splits into Phase 1 (board,
  contact notes, a board-only Boss Cat heartbeat) and Phase 2 (status questions, after FR-13).

## Security Review

An independent review on 2026-11-11 found the following, now addressed:

- **High.**
  - H1: peer text reached the holder's direct-message session, which has `cats-hub`. Now
    FR-10 makes the peer section board-only, and its heartbeat cannot use `cats-hub`. Phase 2's
    answers are read in a one-off session (FR-14).
  - H2: the "one-off session" did not exist, and the review quoted the owner. Now FR-13 is a
    prerequisite, and FR-14 replaces owner lines with times and `focus` with a note id.
  - H3: a rebuilt session's handoff carried old owner words. Now FR-8.
- **Medium.**
  - M1: decisions ran as owner messages, and the recovery wording was wrong. Now FR-6 and
    FR-7.
  - M2: delivery kinds and limits were unclear. Now FR-14.
  - M3: asking could loop and spend. Now FR-14; Phase 1 does not ask.
  - M4: switch and role changes mid-flight were undefined. Now FR-12 and FR-14.
- **Low.**
  - Answer storage. Now FR-14.
  - Host-only commands. Now FR-1 and FR-10.
  - "API limits, not a boundary" was not restated. Now Keeps.
  - Goals contradicted D1, and named Telegram groups as a source; a bot receives Telegram only
    in its direct message. Now Goals and FR-6.

## References

- SPEC-009 (Boss Cat role), PLAN-009 D28 to D30.
- SPEC-011 FR-9, FR-10, FR-13, FR-14 and FR-16.
- SPEC-001 FR-12, FR-27 and FR-28; SPEC-006 (desktop control and owner presence); SPEC-008
  Security.
