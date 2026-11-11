# SPEC-011: Heartbeat Modes, Daily Rhythm and Back-off

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Implemented on 2026-11-11; direction set by the owner in conversation. FR-16 to FR-19 (home sleeps in rest hours, as on Desktop) added the same day at the owner's request |
| **Owner** | Product owner |
| **Reviewer** | None before merge: the owner asked to merge it without an independent review |
| **Updates** | SPEC-001 FR-1 and FR-25 (the heartbeat policy, schedule and prompt) and FR-20 (home's keep-alive); SPEC-002 FR-4 (the Life tab) |

## Summary

The heartbeat (shown as Own initiative, zh-TW 自主活動; labelled 心跳 and before that 主動關心) is
no longer only a greeting.
It is a switch of its own, and each cat bot decides what it is for: `companion` keeps the
owner company, and `assist` looks over the bot's own recent conversations for work the
owner left unfinished and suggests how to continue. Both follow the same daily rhythm as
Cats Desktop's companion life, so a bot and a Desktop Cat with the same times wake and go to
bed alike: in rest hours the bot's direct message sleeps and a message wakes it to answer.
A bot that keeps speaking to an owner who does not answer slows down and then stops until
the owner writes. Neither a restart of the app nor a reboot counts as an answer.

## Goals

- An unprompted message is useful: in `assist` it names unfinished work and one next step.
- The owner sets when the bot is awake, with Cats Desktop's settings and defaults, and the
  bot sleeps and wakes on that rhythm as a Desktop Cat does.
- The bot's proactivity decays while the owner does not answer, and that state survives
  restarts and reboots.

## Non-Goals

- The Boss Cat reviewing other bots' conversations. `assist` covers the bot's own
  conversations; the Boss Cat's wider review is a later step.
- The owner putting the bot to sleep or waking it by hand (Desktop's `sleepUntil` and its
  `/sleep` and `/wake` commands, SPEC-124 FR-15, FR-16 and FR-26).
- Starting unfinished work on its own: `assist` only suggests it.

## Requirements

### Functional Requirements

1. FR-1: `heartbeat` adds `mode: auto | assist | companion` (default `auto`),
   `bedtime` (default `23:00`), `wakeWindowStart` (default `07:00`) and `wakeWindowEnd`
   (default `09:00`), local `HH:MM`. `auto` is `assist` while the hub reports this bot as the
   Boss Cat (SPEC-009) and `companion` otherwise; the effective mode is resolved at each
   heartbeat, so passing the role on changes it.
2. FR-2: A profile written before this spec reads as `auto` with the defaults, field by
   field, with no schema bump and no rewrite. A patch is refused when the mode is unknown, a
   time is not `HH:MM`, the wake window ends before it starts, or bedtime falls inside the
   window (Desktop's rule). Only a patch that changes the times is checked against the window.
3. FR-3: Each day's wake time is `wakeWindowStart` plus a stable offset within the window,
   from an FNV-1a hash of the bot id and the local date, so a restart never re-rolls it.
4. FR-4: Awake hours run from that day's wake time to bedtime; a bedtime at or before the
   wake minute means bedtime is after midnight. All clock math is host-local time.
5. FR-5: During rest hours no heartbeat runs except FR-8's. A heartbeat that falls due in
   rest hours is moved to the next wake time plus the wake delay (`wakeMinMinutes` to
   `wakeMaxMinutes`).
6. FR-6: When nothing is scheduled (first start, a changed policy, the owner answering after
   a back-off), the next heartbeat is the wake delay after now if a wake greeting is due,
   the next wake time plus the wake delay during rest hours, and a regular delay otherwise.
7. FR-7: A `wake` heartbeat happens at most once a day: within 3 hours after the day's wake
   time, when no wake heartbeat completed since that wake time, and only while nothing is
   unanswered (FR-9). A wake heartbeat deferred because the owner is talking is not said
   later that day; the next one is regular, as on Desktop.
8. FR-8: In `companion` mode one `bedtime` heartbeat a night may say good night just before
   home goes to sleep (FR-17): within 60 minutes after bedtime, when the bot was awake before
   bedtime, nobody wrote in home since bedtime, and nothing is unanswered. It is tried once a
   night whatever its result. `assist` has no bedtime heartbeat. A good night expects no
   answer, so it is not counted as unanswered (FR-9).
9. FR-9: Only a message from the owner answers: the newest `lastOwnerMessageAt` across all
   of the bot's conversations, including Telegram messages into home. Another bot's message
   (SPEC-009 FR-7), a restart, a reboot or opening a window do not count, and neither does a
   contact note (SPEC-012), where the owner never writes. A heartbeat that spoke is unanswered
   until the owner writes after it; a `[quiet]` reply is not counted.
10. FR-10: The regular delay is multiplied by `2^n`, `n` being the unanswered count (1, 2,
    4, 8, 16). After 5 unanswered heartbeats in a row nothing is scheduled until the owner
    writes; the owner writing sets the count to 0 and draws the next heartbeat afresh.
    Turning the heartbeat back on (pause, then resume) also sets it to 0.
11. FR-11: `life.json` keeps `heartbeat: { nextAt, unanswered, lastSpokeAt, lastWakeAt,
    lastBedtimeAt, reviewedThrough }`, written atomically on every tick and on every
    heartbeat result. The schedule is no longer redrawn after a restart (replacing the
    "timer lives in memory" rule of SPEC-001 FR-25). A heartbeat that fell due while the
    app was closed waits the wake delay after the first plan of the new process, so
    nothing is said the moment the app starts, and then runs under FR-5 and FR-9. A missing
    or damaged record starts afresh field by field; an older version ignores the field.
12. FR-12: `status().heartbeat` adds the effective `mode`, the rhythm `phase`
    (`awake_hours | rest_hours`), `unanswered` and `waitingForOwner`. The Life tab shows the
    switch, the mode, bedtime and the wake window (with Desktop's labels), the wake and
    regular delays, and either the next heartbeat or that it waits for the owner.
13. FR-13: An `assist` heartbeat carries a review the core builds without the model: every
    one of the bot's conversations (home and notes, contact notes excluded; SPEC-012) whose
    owner last wrote within 14 days,
    newest first, each with its last 6 owner, reply and error lines (unprompted replies
    marked), each line at most 240 characters and the whole at most 6,000. When the budget
    runs short a conversation keeps its heading and the owner's last line, and any that
    still do not fit are counted as left out. It also says how many `ask_owner` questions
    wait for the owner. The prompt asks for one short message naming
    the unfinished item, one concrete next step and an offer to continue, written into the
    home conversation (the bot's direct message), and for `[quiet]` when nothing is
    unfinished or the bot would only repeat itself. It does not start the work.
14. FR-14: An `assist` heartbeat with nothing to review, or whose review fingerprint (the
    newest non-heartbeat line of each conversation in it, and the waiting questions) equals
    the one its last quiet review saw, runs no turn and draws the next regular delay.
15. FR-15: Both prompts state how many unprompted messages went unanswered, and the
    `companion` prompt asks not to repeat an earlier unprompted message.

### Sleep and wake (as on Desktop)

16. FR-16: With the heartbeat on, home follows the rhythm as a Desktop Cat does (cats-platform
    SPEC-124 FR-8, FR-12, FR-17): asleep in rest hours, awake in awake hours. With the heartbeat
    off there is no rhythm and home is kept awake around the clock (SPEC-001 FR-20). Nothing
    wakes home in rest hours on its own, a start of the app included; a message from the owner
    (Telegram included), from another bot or from a schedule wakes it through its turn as usual.
17. FR-17: In rest hours a live home session goes to sleep once home has had no message for
    15 minutes and no turn runs or waits for it. The session is closed and the attachment marked
    `sleeping` with its session id kept, so the next wake resumes it. When it was awake before
    bedtime and nobody wrote since (reason `rest`), a `companion` bot first says good night
    (FR-8) and sleeps right after it, its own good night not counting as a message; otherwise
    (woken or talked to after bedtime) it sleeps with reason `idle`. A turn that binds the
    session while it is being closed keeps the session, and the attachment is left as the turn
    set it.
18. FR-18: Asleep, the heartbeat sleeps too: a `nextAt` before the next wake time moves to the
    next wake time plus the wake delay, a later (backed-off) one keeps its time, and one waiting
    for the owner stays unset. At the day's wake time the tick wakes home with reason `rhythm`,
    its awake time starts then, and a `nextAt` that lapsed meanwhile becomes the wake delay
    from now. Woken by a message before the wake time, it simply stays up.
19. FR-19: Going to sleep and waking are journaled and emitted as `presence` changes with the
    reasons `rest`, `idle` and `rhythm`; the floating cat shows its sleeping pose while home
    sleeps and no turn runs. The Life tab's hint says that the bot sleeps in rest hours and that
    a message wakes it.

### Non-Functional Requirements

- **Cost**: `assist` runs no turn when nothing is new, and the back-off caps an unanswered
  bot at five more heartbeats in total, so a bot left alone stops spending turns.
- **Privacy**: the review stays inside the bot: notes reach only the bot's own direct
  message, never another note or another bot. Home replies are mirrored to the owner's own
  Telegram chat as before (SPEC-001 FR-26).

## Design Overview

`src/shared/heartbeatRhythm.ts` is Desktop's rhythm with no Node or renderer imports, used
by the core and the settings page. `src/core/life/review.ts` builds the `assist` review.
`src/core/life/heartbeat.ts` holds the two prompts and the back-off delay.
`src/core/life/loop.ts` gates the heartbeat at the point it would fire, so catch-up, busy
and failure retries and owner deferral all pass through the rhythm and the back-off, and it
persists `HeartbeatState` beside `lastTickAt`. Its rest step (`restHome`) replaces home's
keep-alive in rest hours: it alone decides the good night and the sleep, so a bot whose
heartbeat waits for the owner still sleeps.

## References

- Cats Desktop (cats-platform) SPEC-124 FR-1 to FR-8, FR-10 to FR-13, FR-17 and FR-19 to
  FR-24: the rhythm, its defaults and validation, sleep and wake, and the wake and bedtime
  heartbeats.
- SPEC-001 FR-25, SPEC-009 FR-3 and FR-7.
