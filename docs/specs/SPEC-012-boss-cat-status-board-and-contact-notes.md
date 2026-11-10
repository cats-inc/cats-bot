# SPEC-012: Boss Cat Status Board and Contact Notes

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Approved by the owner on 2026-11-11, with the proposed answers to its open questions (D1, D2); not implemented. Implementation waits for the independent security review |
| **Owner** | Product owner |
| **Reviewer** | Owner, and an independent security review before implementation (as for SPEC-009) |
| **Updates** | SPEC-009's Non-Goal "sharing transcripts, memory or secrets between bots" and FR-6 "reading another bot's transcripts or conversations", narrowed as FR-3 and FR-6 below; SPEC-009 FR-4 (two new tools), FR-9 (their audit) and FR-10 (contact notes); PLAN-009 D29 (the sender conversation becomes a read-only contact note); SPEC-011 FR-13 and FR-14 (the Boss Cat's `assist` heartbeat) |
| **Keeps** | No bot reads another bot's transcripts, conversations or memory. What leaves a bot is a board its core builds without message text, and a summary the bot writes itself |

## Summary

The Boss Cat helps the owner across bots, so it needs to know which bots have work that is
stuck, failed or waiting for the owner. It does not get there by reading their conversations.
It gets a **status board** that each bot's core builds without the model and without any
message text. When it needs detail, it asks the bot. The bot answers in a **contact note**
(zh-TW 聯絡簿) from a review of its own notes (never its direct message), and decides what to
share under fixed rules. The answer is stored for the Boss Cat rather than starting a turn.
The owner can read every contact note but cannot write in one, so no side channel carries the
owner's words to another bot.

## Goals

- The Boss Cat can tell which bots need attention, at no model cost.
- Details come from the bot that holds the context, which decides what to share.
- The owner can see everything that passed between bots. No side channel carries the owner's
  words to another bot: requests the Boss Cat hands on with `hub_message_bot` are its own
  words, and the owner cannot write into a contact note.
- Text from one bot's conversations (Telegram groups, web pages, files, tool output) does not
  reach the Boss Cat, the most capable bot, as it is. At most a summary written by the bot
  that read it does. That summary is still model text, so the Boss Cat treats it as another
  bot's words.

## Non-Goals

- Reading another bot's transcripts, conversations or memory (SPEC-009 FR-6 stays).
- The Boss Cat answering, approving or deciding anything for the owner or for another bot.
- A per-bot opt-in that lets the Boss Cat read a bot's notes. This is a possible later step if
  the board and status answers prove too thin. A direct message would never be included.
- Cats Desktop. Its Boss Cat should follow the same principles in a cats-platform spec once
  this one is approved.

## Definitions

- **Status board**: what `hub_bot_status` returns for a bot: states, counts, times and note
  titles. It contains no message text.
- **Contact note** (聯絡簿): the conversation a bot keeps for one other bot's messages
  (`bot-<sender id>`, PLAN-009 D29), in both the Boss Cat and the bot it talks to.
- **Status answer**: a bot's reply to `hub_ask_status`, written by that bot.

## Requirements

### Functional Requirements

#### Status board

1. FR-1: The Boss Cat gets `hub_bot_status`, with an optional `bot`. Without one, it covers
   every bot that is not archived. The hub asks each running bot's core for its board through
   a new host-API command, `workStatus()`. For a stopped bot the hub answers from its registry
   (id, name, `stopped`).
2. FR-2: A board holds:
   - id, name, the hub state, the runtime state, and whether the direct message is awake or
     asleep (SPEC-011 FR-16);
   - own initiative: on or off, the effective mode, the rhythm phase, the unanswered count,
     whether it waits for the owner, and the next time;
   - the queue: the running item's kind, conversation and start time, and how many items are
     queued;
   - attention:
     - turns that failed or were interrupted in the last 7 days and were not followed by a
       completed turn in the same conversation;
     - how many owner decisions wait (`ask_owner`, approvals, provider interactions), as
       counts only;
     - each with its conversation id;
   - schedules: how many, and the next due time;
   - notes: the 20 most recently active notes, each with its id, its title cut to 80
     characters, the owner's and the bot's last message times, and whether its last turn
     failed, is running or waits for the owner;
   - the direct message: only the owner's and the bot's last message times. Never its text,
     and never a title.
   Contact notes are listed by the other bot's name only.
3. FR-3: Nothing else leaves the core through the board: no message text, prompt, tool
   argument, schedule prompt, decision content, memory, file path or secret. Note titles are
   its only free text.
4. FR-4: A board call runs no model turn and is not a hop (SPEC-009 FR-8). The hub limits it
   to 30 calls an hour per holder, and journals it like every Boss Cat call (SPEC-009 FR-9).

#### Asking a bot

5. FR-5: The Boss Cat gets `hub_ask_status`, with `bot` and an optional `focus` of at most 200
   characters (for example "the parser refactor"). The hub delivers it like `hub_message_bot`:
   - in the same contact note and chain rules;
   - the question and the answer each count as one hop toward the per-chain and hourly limits.
   The call returns at once. The answer does not run a turn in the Boss Cat:
   - it is stored, at most 1,000 characters, with its time;
   - it is shown in the Boss Cat's contact note with that bot;
   - it is returned with that bot's board by `hub_bot_status` and in the Boss Cat's next
     `assist` heartbeat (FR-12), marked as that bot's words.
   So an answer never wakes the Boss Cat's direct message, is never mirrored to Telegram, and
   never bypasses the rhythm or the back-off. The holder still cannot read the bot's
   conversations; it only receives the bot's answer.
6. FR-6: The answering bot's core builds the turn's prompt, not the Boss Cat. The prompt holds:
   - a fixed status request;
   - the bot's own review of its notes (SPEC-011 FR-13's limits). By construction it leaves out
     the direct message's text and every contact note; the direct message appears only as its
     last owner and bot message times;
   - the sharing rules of FR-7;
   - the `focus`, quoted and marked as the Boss Cat's words. It carries no authority.
   The turn runs in a one-off session that is closed after the answer, not in the contact
   note's session, so the review never stays in a context that later delegated work runs in.
   The question and the answer are still written to the contact note's transcript. An ordinary
   `hub_message_bot` turn does not carry the review.
7. FR-7: The sharing rules:
   - Report the state of work: what is unfinished and in which note, what it waits for, and
     the next step the bot suggests.
   - Say nothing about the direct message; the bot does not see it in this turn, and the board
     already carries its times.
   - Do not quote the owner. Never pass on secrets, credentials, file contents or personal
     details.
   - Answer briefly, and decline when the question asks for more than this.

#### Contact notes

8. FR-8: A contact note is shown as 「與 {name} 的聯絡簿」 (en "Contact with {name}"). The name
   comes from the conversation id, so existing notes need no migration.
9. FR-9: The owner can open, read, scroll and delete a contact note, but cannot write in it.
   - The composer is replaced by: 「這是 {holder} 和 {bot} 的聯絡簿，你可以看，但不能在這裡輸入。要跟 {bot} 說話，請到它的私訊。」
   - A button opens that bot's direct message.
   - The core refuses an owner message to a contact note from every surface (note window,
     CLI, Telegram, handoff), with that reason.
   - The owner's decisions stay answerable there: approvals, `ask_owner` questions and provider
     interactions are written as events, not owner messages. A recovery rerun of an
     interrupted delivery (SPEC-001 FR-27) reruns as that delivery, with the sending bot's
     attribution. It writes no owner entry and does not count as the owner writing.
10. FR-10: A contact note that already holds owner-written entries from before this spec starts
    a fresh session at its next delivery. Those words then stay out of the context a reply is
    written from.
11. FR-11: A contact note shows every status request and answer, so the owner can see exactly
    what was shared.

#### The Boss Cat's own initiative

12. FR-12: In `assist` mode, the Boss Cat's heartbeat (SPEC-011 FR-13) appends a compact board
    of the other bots after its own review: names, attention items, waiting decisions and the
    oldest unfinished note per bot, followed by the stored status answers (FR-5) that arrived
    since its last heartbeat. The prompt asks it to:
    - find a bot whose work needs the owner;
    - when the board is not enough, ask at most two bots with `hub_ask_status` and stay quiet
      this time (the answers come to the next heartbeat);
    - otherwise, suggest one next step in its own direct message, naming the bot and the note;
    - not repeat a suggestion it already made.
13. FR-13: The `assist` skip (SPEC-011 FR-14) also fingerprints the board's attention items, its
    waiting counts and the stored answers. A quiet review with no change in any bot's attention
    and no new answer therefore runs no turn.

#### The owner's control

14. FR-14: Settings → Bots has a per-bot switch, 「讓主控貓看到這隻貓的狀態」, on by default.
    When it is off:
    - `hub_bot_status` returns only that bot's id, name and hub state;
    - `hub_ask_status` to it is refused;
    - the Boss Cat's heartbeat leaves it out.

### Non-Functional Requirements

- **Cost**: the board is free. A status question is one hop under SPEC-009's limits (4 per
  chain, 10 messages an hour), and its review stays within 6,000 characters.
- **Security**: the only free text that reaches the Boss Cat from another bot is note titles
  and that bot's own answer, both marked as another bot's (SPEC-009 FR-9). The question it
  answers was built by its own core, and the Boss Cat's `focus` is short and quoted. The answer
  is model text that may echo untrusted content from the bot's notes, so the Boss Cat's
  prompt treats it as data, and the hub's refusals (SPEC-009 FR-6) still bound what the Boss
  Cat can do with it.
- **Privacy**: a direct message never leaves its bot beyond its message times. Notes leave
  only as titles and as the bot's own summary. Note titles are set by the owner or by the bot
  when it creates a note, never derived from a message. The per-bot switch removes even
  that.

## Design Overview

- **Core.**
  - `src/core/hub/status.ts` (new) builds the board from the conversation store, work items,
    schedules and the life loop's status.
  - `BotCore.workStatus()` exposes it through `src/core/host-api/commands.ts` and `remote.ts`.
  - `admitBotMessage` gains the delivery kind `status`. It builds FR-6's prompt with
    `buildWorkReview` over the bot's own notes and runs it in a one-off session.
  - A delivery of kind `status-answer` is stored and shown without a turn (FR-5).
- **Hub.** `hub_bot_status` and `hub_ask_status` live in `src/core/tools/hubTools.ts` and
  `src/shell/electron/hub/bossCatBroker.ts`. The broker calls `workStatus()` and delivers
  status questions as recorded deliveries (SPEC-009 FR-12).
- **Renderer.** The note window drops the composer for `bot-*` conversations. Settings → Bots
  gains the switch.
- **Boss Cat heartbeat.** A core cannot reach other bots itself, so each minute the hub pushes
  the other bots' boards (FR-14 applied) to the holder's core through a new host-API command,
  `setPeerBoards`. `src/core/life/review.ts` gains a compact board section built from the latest
  copy, which only the holder's `assist` heartbeat receives. A copy older than five minutes is
  left out.

## Test Plan

- The board has every FR-2 field and no message text. A fixture whose messages hold a marker
  string never shows the marker in the board.
- A stopped bot, an archived bot and a bot with the switch off each return only the fields
  FR-1 and FR-14 allow.
- The answering turn's prompt holds the fixed request, the review and the rules. The `focus`
  appears quoted, and a `focus` over 200 characters is refused.
- An ordinary `hub_message_bot` turn carries no review, and a status turn's session is closed
  afterwards; the contact note's own session never holds the review.
- A status review fixture whose direct message holds a marker string never shows the marker.
- A status answer runs no turn in the Boss Cat. It is not mirrored to Telegram, does not wake
  the direct message in rest hours, and appears in the board and the next `assist` heartbeat.
- Approvals and `ask_owner` answers still work in a contact note. A recovery rerun there writes
  no owner entry.
- The owner cannot send to a contact note from the note window, CLI, Telegram or handoff, and
  gets the reason.
- A contact note with old owner entries starts a fresh session at its next delivery.
- The Boss Cat's `assist` heartbeat includes the board of the other bots and skips when nothing
  changed.
- Board calls beyond 30 an hour are refused, and status questions count toward the hop limits.

## Decisions

- D1 (2026-11-11, the owner): note titles reach the Boss Cat by default, although they can
  reveal a topic. The FR-14 switch turns the whole board off for a bot.
- D2 (2026-11-11, the owner): the Boss Cat writes its suggestion in its own direct message, not
  in the other bot's, so the owner hears it from the bot that holds the role (FR-12).

## References

- SPEC-009 (Boss Cat role), PLAN-009 D29 (a conversation per sender).
- SPEC-011 FR-13 and FR-14 (`assist` review and skip).
