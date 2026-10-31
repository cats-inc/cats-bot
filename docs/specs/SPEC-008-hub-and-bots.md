# SPEC-008: Hub and Bots

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Implemented on 2026-10-30 (PLAN-009); the release is 0.3.0 |
| **Owner** | Product owner |
| **Reviewer** | Independent agent before implementation |

## Summary

Implement [ADR-008](../decisions/008-run-every-bot-as-a-headless-core-under-one-hub.md):
one Electron hub presents and manages several bots, each running as a headless
core child process with its own Runtime and CLI. This applies at any product
cap; this version ships a cap of three bots.

The bots under one hub have no collective name: shared things are "hub" files,
settings and tools. In this repository "fleet" means desktop-work-fleet
(ADR-001), so it is not used for bots.

## Goals

- Every bot is an independent process; a UI failure never stops a bot.
- One tray, one settings surface, one updater and one login item for
  all bots.
- Bot creation and management in the product UI, up to the bot cap.

## Non-Goals

- Sharing a Runtime between bots (ADR-001 Alternative 7).
- WSL or docker execution (ADR-010: native only in this version).
- The Boss Cat role's tools (SPEC-009); this spec stores only its holder.

## Requirements

### Hub

1. FR-1: One hub runs per OS account and installation, behind one Electron
   single-instance lock on the hub's user data (`%APPDATA%\Cats Bot` on
   Windows). A second launch hands its arguments to the running hub and exits.
   The hub also takes a root lock in `<CATS_BOT_HOME>`, so two installations
   pointed at one root never manage the same bots: the later hub shows which
   installation holds the lock and exits. Each installation keeps a random
   installation id in its user data (FR-12).
2. FR-2: The bot registry is `<CATS_BOT_HOME>/bots.json`, schema version 1:
   bots (id, order, start automatically, created at, archived at),
   `environmentProfile` (ADR-010) and the Boss Cat (SPEC-009). Only
   the hub writes it, under a lock file, through temp file plus rename. Missing
   fields get defaults; a corrupt file is reported and never overwritten
   (SPEC-001 FR-4 rules).
3. FR-3: At start the hub reconciles the registry with `<root>/bots/` and
   `<root>/archive/`. The directory's location decides whether a bot is
   archived: an entry whose directory is in the other folder gets `archivedAt`
   set or cleared to match. A directory without an entry is shown as
   unregistered for the owner to add (as archived when it is under `archive/`);
   an entry without a directory is shown as failed. Neither is deleted
   automatically. Only `<root>/trash/` holds deletions the owner has already
   confirmed: the hub finishes them and removes any remaining entry (FR-5).
4. FR-4: First run starts when no registry exists. The owner picks the
   environment profile (only native in this version), then creates the first bot
   with SPEC-002 FR-1's provider-first flow. The registry is then written, with
   the first bot as the Boss Cat.
5. FR-5: Bot management, the Bots tab of Cats Bot Settings (the hub's own
   settings window, beside its General tab: display language, start at login,
   version, updates and the data folder; PLAN-010), lists every bot that is not archived, with
   its state (starting, running, stopped, failed, externally hosted), and offers
   create, start, stop, start automatically and order. Archived bots are listed
   separately. Removing a bot takes two separate steps, each with its own
   confirmation, and nothing skips the first:
   - **Archive** a bot that is not archived: the hub stops its core (FR-10),
     takes the bot root's instance lock (SPEC-001 FR-3) so no other host can
     start it meanwhile, renames `<root>/bots/<id>/` to `<root>/archive/<id>/`,
     records `archivedAt` and releases the lock. The rename is the commit
     point; if the registry write fails after it, FR-3 repairs `archivedAt` at
     the next start. An archived bot never runs and has no windows, tray items
     or automatic start. It does not count toward the cap, and its id stays
     reserved: `cats-bot run` refuses an id that has a directory under
     `archive/` instead of creating a new bot root for it. Archiving the
     Boss Cat clears the role (SPEC-009). If the lock or the rename
     fails, the bot stays registered and stopped and the error is shown. An
     externally hosted bot (FR-11) cannot be archived while it runs.
   - **Restore** an archived bot, subject to the cap: the same steps back to
     `<root>/bots/<id>/`, clearing `archivedAt`. It comes back stopped.
   - **Delete** an archived bot, and only an archived bot: after a confirmation
     that names the bot, the hub renames `<root>/archive/<id>/` into
     `<root>/trash/`, removes its registry entry and then removes the directory,
     including its encrypted secrets. This cannot be undone. A delete that stops
     partway finishes at the next start (FR-3), so a partly removed bot never
     reappears as archived. The provider CLIs' own folders (`~/.codex`,
     `~/.claude`, …) are not touched.
6. FR-6: The bot cap is the hub setting `maxBots`, 3 in this version and not
   offered in the UI. Archived bots do not count. Creating or restoring beyond
   it is refused in the UI and in the hub's own API. Tests cover at least two
   bots and the cap.

### Cores

7. FR-7: The hub starts a core by running its own executable with
   `ELECTRON_RUN_AS_NODE=1` and the headless host entry for one bot (today's
   `cats-bot run`, given the bot id and `CATS_BOT_HOME`), with the same
   environment hygiene the core applies to Runtime (SPEC-001 FR-5). The hub also
   passes the packaged Runtime entry and desktop-control helper path, which
   today only the shell supplies to an in-process core, and names its
   installation as the core's manager (FR-12). The core takes the bot root's
   instance lock (SPEC-001 FR-3).
8. FR-8: Cores never talk to each other directly. Anything crossing bots goes
   through the hub (SPEC-009).
9. FR-9: If a core exits without being asked, the hub marks it failed and
   restarts it with backoff, a bounded number of times per window. After that the
   bot stays failed with its error and log location. Other bots and the hub are
   unaffected.
10. FR-10: Quit gracefully stops every core this hub manages, through the
    channel: the core stops its Runtime, CLI, helper and tool servers. The hub
    manages a core whose descriptor names this installation as its manager
    (FR-12), including one started before the hub's own restart. The hub kills a
    core's process tree only after a timeout. Externally hosted cores are left
    running.
11. FR-11: A core started by another host (for example a developer's
    `cats-bot run`) also publishes its channel descriptor, without this
    installation as its manager. The hub lists it in Settings → Bots as
    externally hosted, with its state, and gives it no notes, floating Cat or
    tray items. The hub attaches to its channel only to read its state and to
    serve the hub identity (FR-21). It never starts a second copy, never stops it
    on Quit and never restarts it.

### Host channel

12. FR-12: Each core publishes a channel descriptor in its bot root: protocol
    version, socket path, a per-start random token, PID and manager (the
    installation id of the hub that started it, or none), readable by the
    current account only. The transport is a named pipe on Windows and a 0600
    Unix socket elsewhere, as for today's owner control. Existing CLI control
    operations (`interactions`, `respond`, `capabilities`, `desktop`) keep
    working.
13. FR-13: The channel works in both directions:
    - from hub to core, every `BotHostApi` call as request/response;
    - from core to hub, its event stream with sequence numbers, and requests for
      host services: the secret cipher (FR-20), the current hub identity
      (FR-21), and Boss Cat brokering (SPEC-009).

    Requests are authenticated and size-bounded, and their bodies are never
    logged. A protocol version mismatch is refused and shown, not worked around.

    A host attaches without a gap. It subscribes first and buffers events, then
    reads the snapshots (transcript, work items, interactions, desktop control
    state). Each snapshot carries the last sequence number it includes, and the
    host applies only buffered events above it. A later gap in sequence numbers
    makes the host read the snapshots again.
14. FR-14: The channel adds no new way to create an owner-sourced work item. A
    message typed in a hub note is an owner message exactly as it is today, and
    SPEC-006's local-owner-turn rule gives the same result as now. The only new
    work-item source is `bot`, for Boss Cat work (SPEC-009).
15. FR-15: When the hub reattaches after its own restart, it verifies each
    descriptor's PID and token, then attaches as in FR-13 and rebuilds view
    state from the snapshots. Events are not persisted for replay.

### Presentation

16. FR-16: One tray icon. With one bot, the menu has today's items (SPEC-002).
    With more, each bot's conversation, heartbeat, floating Cat, request and Stop
    items move into a submenu per bot. Hub items are shared in both shapes:
    Settings… (Cats Bot Settings), Start at login, Check for Updates…, Quit; a
    bot's own settings are "Bot settings…" (PLAN-010). Pending owner requests and unread
    counts are aggregated on the icon.
17. FR-17: Notes, floating Cats and per-bot settings are hub windows bound to one
    bot id. A window receives only its own bot's events and can only reach its
    own bot's channel; bot management is reached only from Cats Bot Settings
    (PLAN-010). Titles carry the bot name. On Windows each window uses
    the AUMID `io.catsinc.catsbot.<botId>`. If renderers keep storage, it is
    partitioned per bot.
18. FR-18: Per-bot view state (note bounds and layers, floating Cat position)
    stays in each bot root's `shell-state.json`. Hub preferences (display
    language, start at login) live in a hub state file under `<CATS_BOT_HOME>`.
    Display language becomes a hub setting (updates ADR-006).
19. FR-19: Packaged provider setup helpers (ADR-006) run in the hub. CLIs
    installed for the account serve every native bot, and only one setup
    operation runs at a time across all bots. After an install the fresh check
    decides the step: a restart or relaunch the helper asks for stands only
    while that check cannot confirm the step, because the hub hands a found
    CLI's folder to Runtime and every core; a failure or a refused elevation
    always stands, a declined UAC prompt included. An install's diagnostics
    show only for a step that is not done, and a help line the check and the
    install both give shows once. On Windows, Codex has a PowerShell scripts
    step after the npm folder. PowerShell runs npm's `codex.ps1` only under a
    permissive execution policy, and a clean Windows has Restricted. The step
    sets the user's own policy to RemoteSigned, so `codex login` works in a
    PowerShell terminal; Cats Bot itself runs `codex.cmd`.

### Host services

20. FR-20: The hub serves the OS secret cipher to its cores over the channel.
    `SecretCipher` and `SecretStore` (`src/core/secrets.ts`) are synchronous
    today, so they gain an asynchronous path. A core under a host without a
    cipher behaves as today's headless host. Protection status stays truthful
    (`os` or `file`).
21. FR-21: The desktop-control helper's self-exclusion always includes the PIDs
    and executable paths of both the core and the current hub. This holds for
    externally hosted cores too, whose executable is not the hub's. When the hub
    PID changes, the core updates the helper before it serves another
    desktop-control call (SPEC-006 BDC-08).
22. FR-22: Updates are hub-owned. Installing stops every core the hub manages,
    refuses while an externally hosted core runs from this installation (and
    says which), installs, relaunches the hub and restarts the cores. This
    replaces the cross-shell exclusion of ADR-004 for hub-hosted bots.
23. FR-23: One login item starts the hub; there are no per-bot login entries.
24. FR-24: Each bot profile records `environment: { kind: 'native' }`. In this
    version the registry's `environmentProfile` and every binding must be
    native, and anything else is refused (ADR-010).
25. FR-25: The hub publishes its own control descriptor under `<CATS_BOT_HOME>`,
    with the same transport, token and account rules as FR-12. Owner CLI
    commands that act on the hub (the registry, the Boss Cat) go
    through it while the hub runs. Without a running hub they refuse instead of
    writing the registry themselves.

### Desktop control across bots

26. FR-26: At most one bot controls the desktop at a time. A core takes the
    desktop lease before a turn takes control (SPEC-006) and before a clipboard
    call. The lease is a lock scoped to the OS account's desktop session, not to
    `CATS_BOT_HOME`, and the OS releases it when the process holding it exits.
    Cores take it themselves, so externally hosted cores obey it without the hub
    and FR-11 is unchanged. A turn keeps the lease until its control ends: the
    end of the turn (SPEC-133 DC-11), Stop (DC-12) or the core stopping. A call
    that cannot take the lease returns `unavailable` with the reason that
    another bot is using the desktop; SPEC-133's shared error codes are
    unchanged.

### Bot ids

27. FR-27: A bot id is one path segment of 1 to 64 characters matching
    `[a-z0-9]+(-[a-z0-9]+)*`, and never a Windows device name (`con`, `prn`,
    `aux`, `nul`, `com0`–`com9`, `lpt0`–`lpt9`). It is checked wherever it
    enters, before any path is resolved: `--id` and `CATS_BOT_ID` in the CLI,
    the core and the shell; Settings → Bots create (FR-5); and the registry and
    directory reconcile (FR-3), which reports and skips a directory whose name
    is not a valid id. An invalid id is refused with a message that states the
    rule. `cats-bot init`, first run and a new bot derive an id of this form
    from the bot's name: its words, then `-catsbot`, and `-2`, `-3` and so on
    for a later bot of the same name, within 64 characters (PLAN-010). An id
    given with `--id` is taken as given.
    No id can then name a path outside its own bot root, such as the hub's part
    of `<CATS_BOT_HOME>` (SPEC-007 FR-3).

### Non-Functional Requirements

- **Performance**: record working set and time to first usable note for the hub
  alone, the hub with one bot and the hub with two bots, compared with the 0.2.x
  baseline of about 560 MB for one bot (ADR-008).
- **Security**: channel tokens are 32 random bytes and current account only; the
  hub never holds Runtime credentials; renderers stay sandboxed and bot-scoped.
  A token authenticates the OS account, not the owner. Any process of that
  account that can read a descriptor can use it, including a native provider
  CLI with file access, as with today's owner control. The hub's refusals
  (SPEC-009 FR-6) therefore limit its API, not such processes. This is not a
  security boundary; only a non-native environment such as docker isolates a
  bot (ADR-010), and this version offers none.
- **Reliability**: a hub crash leaves cores running and a restarted hub recovers
  them; one core's failure affects no other bot.

## Design Overview

```
Cats Bot.exe (hub, Electron)            ~/.catsbot/
  tray, windows, updates, setup         bots.json, hub state
        │ host channel (pipe/socket + token, per core)
        ├── core: bots/mochi-catsbot (ELECTRON_RUN_AS_NODE) ── Runtime ── CLI
        └── core: bots/<id>          (ELECTRON_RUN_AS_NODE) ── Runtime ── CLI
```

## Dependencies

- ADR-007/SPEC-007 paths and identity.
- The existing headless host (`src/cli/main.ts run`) and owner control
  (`src/core/host-api/control.ts`).

## Open Questions

- [x] Bot cap (2026-10-29): three bots in this version (FR-6).
- [x] Removing a bot (2026-10-29): archive first; only an archived bot can be
      deleted (FR-5).
- [x] Externally hosted cores (2026-10-29): listed with their state, not
      presented (FR-11).
- [x] Desktop control across bots (2026-10-29, after review): one lease scoped
      to the OS account that every core takes itself, so FR-11 is unchanged
      (FR-26).
- [x] Strength of the hub's limits (2026-10-29, after review): API refusals,
      stated as not a security boundary (Security).

## References

- [ADR-001](../decisions/001-build-a-resident-bot-core-on-cats-runtime-with-disposable-presentation.md),
  [ADR-008](../decisions/008-run-every-bot-as-a-headless-core-under-one-hub.md),
  [ADR-010](../decisions/010-bind-each-bot-to-an-execution-environment.md)
- [SPEC-001](SPEC-001-resident-bot-core-and-global-execution.md),
  [SPEC-002](SPEC-002-desktop-presence-settings-and-first-run.md),
  [SPEC-006](SPEC-006-desktop-control-session-mcp.md),
  [SPEC-009](SPEC-009-boss-cat-role.md)

---

*Created: 2026-10-29*
*Author: Claude, from the owner's decisions*
*Related Plan: [PLAN-009](../plans/PLAN-009-hub-headless-cores-and-coordinator.md)*
