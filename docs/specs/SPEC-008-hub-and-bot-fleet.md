# SPEC-008: Hub and Bot Fleet

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Draft |
| **Owner** | Product owner |
| **Reviewer** | Independent agent before implementation |

## Summary

Implement [ADR-008](../decisions/008-run-every-bot-as-a-headless-core-under-one-hub.md):
one Electron hub presents and manages a fleet of bots, each running as a headless
core child process with its own Runtime and CLI. This applies at any product
cap; this version ships a cap of three bots.

## Goals

- Every bot is an independent process; a UI failure never stops a bot.
- One tray, one settings surface, one update coordinator and one login item for
  the whole fleet.
- Bot creation and management in the product UI, up to the fleet cap.

## Non-Goals

- Sharing a Runtime between bots (ADR-001 Alternative 7).
- WSL or docker execution (ADR-010: native only in this version).
- The coordinator role's tools (SPEC-009); this spec stores only its holder.

## Requirements

### Hub

1. FR-1: One hub runs per OS account and installation, behind one Electron
   single-instance lock on the hub's user data (`%APPDATA%\Cats Bot` on
   Windows). A second launch hands its arguments to the running hub and exits.
2. FR-2: The fleet registry is `<CATS_BOT_HOME>/fleet.json`, schema version 1:
   bots (id, order, start automatically, created at, archived at),
   `environmentProfile` (ADR-010) and the coordinator holder (SPEC-009). Only
   the hub writes it, under a lock file, through temp file plus rename. Missing
   fields get defaults; a corrupt file is reported and never overwritten
   (SPEC-001 FR-4 rules).
3. FR-3: At start the hub reconciles the registry with `<root>/bots/` and
   `<root>/archive/`. A directory without an entry is shown as unregistered for
   the owner to add (as archived when it is under `archive/`); an entry without a
   directory is shown as failed. Neither is deleted automatically.
4. FR-4: First run starts when no registry exists. The owner picks the
   environment profile (only native in this version), then creates the first bot
   with SPEC-002 FR-1's provider-first flow. The registry is then written, with
   the first bot as coordinator holder.
5. FR-5: Bot management in Settings lists every bot that is not archived, with
   its state (starting, running, stopped, failed, externally hosted), and offers
   create, start, stop, start automatically and order. Archived bots are listed
   separately. Removing a bot takes two separate steps, each with its own
   confirmation, and nothing skips the first:
   - **Archive** a bot that is not archived: the hub stops its core (FR-10),
     renames `<root>/bots/<id>/` to `<root>/archive/<id>/` and records
     `archivedAt`. An archived bot never runs and has no windows, tray items or
     automatic start. It does not count toward the cap, and its id stays
     reserved. Archiving the coordinator holder clears the role (SPEC-009). If
     the rename fails, the bot stays registered and stopped and the error is
     shown. An externally hosted bot (FR-11) cannot be archived while it runs.
   - **Restore** an archived bot: the hub renames it back to `<root>/bots/<id>/`
     and clears `archivedAt`, subject to the cap. It comes back stopped.
   - **Delete** an archived bot, and only an archived bot: after a confirmation
     that names the bot, the hub permanently removes `<root>/archive/<id>/`,
     including its encrypted secrets, and its registry entry. This cannot be
     undone. The provider CLIs' own folders (`~/.codex`, `~/.claude`, …) are
     not touched.
6. FR-6: The fleet cap is the hub setting `maxBots`, 3 in this version and not
   offered in the UI. Archived bots do not count. Creating or restoring beyond
   it is refused in the UI and in the hub's own API. Tests cover at least two
   bots and the cap.

### Cores

7. FR-7: The hub starts a core by running its own executable with
   `ELECTRON_RUN_AS_NODE=1` and the headless host entry for one bot (today's
   `cats-bot run`, given the bot id and `CATS_BOT_HOME`), with the same
   environment hygiene the core applies to Runtime (SPEC-001 FR-5). The hub also
   passes the packaged Runtime entry and desktop-control helper path, which
   today only the shell supplies to an in-process core. The core takes the bot
   root's instance lock (SPEC-001 FR-3).
8. FR-8: Cores never talk to each other directly. Anything crossing bots goes
   through the hub (SPEC-009).
9. FR-9: If a core exits without being asked, the hub marks it failed and
   restarts it with backoff, a bounded number of times per window. After that the
   bot stays failed with its error and log location. Other bots and the hub are
   unaffected.
10. FR-10: Quit gracefully stops every core this hub started, through the
    channel: the core stops its Runtime, CLI, helper and tool servers. The hub
    kills a core's process tree only after a timeout. Externally hosted cores are
    left running.
11. FR-11: A core started by another host (for example a developer's
    `cats-bot run`) also publishes its channel descriptor. The hub lists it in
    Settings → Bots as externally hosted, with its state, and gives it no notes,
    floating Cat or tray items. The hub attaches to its channel only to read its
    state and to serve the hub identity (FR-21). It never starts a second copy,
    never stops it on Quit and never restarts it.

### Host channel

12. FR-12: Each core publishes a channel descriptor in its bot root: protocol
    version, socket path, a per-start random token and PID, readable by the
    current account only. The transport is a named pipe on Windows and a 0600
    Unix socket elsewhere, as for today's owner control. Existing CLI control
    operations (`interactions`, `respond`, `capabilities`, `desktop`) keep
    working.
13. FR-13: The channel works in both directions:
    - from hub to core, every `BotHostApi` call as request/response;
    - from core to hub, its event stream with sequence numbers, and requests for
      host services: the secret cipher (FR-20), the current hub identity
      (FR-21), and coordinator brokering (SPEC-009).

    Requests are authenticated and size-bounded, and their bodies are never
    logged. A protocol version mismatch is refused and shown, not worked around.
14. FR-14: The channel adds no new way to create an owner-sourced work item. A
    message typed in a hub note is an owner message exactly as it is today, and
    SPEC-006's local-owner-turn rule gives the same result as now. The only new
    work-item source is `bot`, for coordinator work (SPEC-009).
15. FR-15: When the hub reattaches after its own restart, it verifies each
    descriptor's PID and token, rebuilds view state from snapshots (transcript,
    work items, interactions, desktop control state) and then resubscribes.
    Events are not persisted for replay.

### Presentation

16. FR-16: One tray icon. With one bot, the menu has today's items (SPEC-002).
    With more, each bot's conversation, heartbeat, floating Cat, request and Stop
    items move into a submenu per bot. Fleet items are shared: Bots…, Settings…,
    Start at login, Check for Updates…, Quit. Pending owner requests and unread
    counts are aggregated on the icon.
17. FR-17: Notes, floating Cats and per-bot settings are hub windows bound to one
    bot id. A window receives only its own bot's events and can only reach its
    own bot's channel. Titles carry the bot name. On Windows each window uses
    the AUMID `io.catsinc.catsbot.<botId>`. If renderers keep storage, it is
    partitioned per bot.
18. FR-18: Per-bot view state (note bounds and layers, floating Cat position)
    stays in each bot root's `shell-state.json`. Fleet preferences (display
    language, start at login) live in a hub state file under `<CATS_BOT_HOME>`.
    Display language becomes fleet-level (updates ADR-006).
19. FR-19: Packaged provider setup helpers (ADR-006) run in the hub. CLIs
    installed for the account serve every native bot, and only one setup
    operation runs at a time across the fleet.

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
22. FR-22: Updates are hub-owned. Installing stops every hub-started core,
    refuses while an externally hosted core runs from this installation (and
    says which), installs, relaunches the hub and restarts the cores. This
    replaces the cross-shell exclusion of ADR-004 for hub-hosted bots.
23. FR-23: One login item starts the hub; there are no per-bot login entries.
24. FR-24: Each bot profile records `environment: { kind: 'native' }`. In this
    version the registry's `environmentProfile` and every binding must be
    native, and anything else is refused (ADR-010).
25. FR-25: The hub publishes its own control descriptor under `<CATS_BOT_HOME>`,
    with the same transport, token and account rules as FR-12. Owner CLI
    commands that act on the fleet (the registry, the coordinator holder) go
    through it while the hub runs. Without a running hub they refuse instead of
    writing the registry themselves.

### Non-Functional Requirements

- **Performance**: record working set and time to first usable note for the hub
  alone, the hub with one bot and the hub with two bots, compared with the 0.2.x
  baseline of about 560 MB for one bot (ADR-008).
- **Security**: channel tokens are 32 random bytes and current account only; the
  hub never holds Runtime credentials; renderers stay sandboxed and bot-scoped.
- **Reliability**: a hub crash leaves cores running and a restarted hub recovers
  them; one core's failure affects no other bot.

## Design Overview

```
Cats Bot.exe (hub, Electron)            ~/.catsbot/
  tray, windows, updates, setup         fleet.json, hub state
        │ host channel (pipe/socket + token, per core)
        ├── core: bots/mochi   (ELECTRON_RUN_AS_NODE) ── Runtime ── CLI
        └── core: bots/<id>    (ELECTRON_RUN_AS_NODE) ── Runtime ── CLI
```

## Dependencies

- ADR-007/SPEC-007 paths and identity.
- The existing headless host (`src/cli/main.ts run`) and owner control
  (`src/core/host-api/control.ts`).

## Open Questions

- [x] Fleet cap (2026-10-29): three bots in this version (FR-6).
- [x] Removing a bot (2026-10-29): archive first; only an archived bot can be
      deleted (FR-5).
- [x] Externally hosted cores (2026-10-29): listed with their state, not
      presented (FR-11).

## References

- [ADR-001](../decisions/001-build-a-resident-bot-core-on-cats-runtime-with-disposable-presentation.md),
  [ADR-008](../decisions/008-run-every-bot-as-a-headless-core-under-one-hub.md),
  [ADR-010](../decisions/010-bind-each-bot-to-an-execution-environment.md)
- [SPEC-001](SPEC-001-resident-bot-core-and-global-execution.md),
  [SPEC-002](SPEC-002-desktop-presence-settings-and-first-run.md),
  [SPEC-006](SPEC-006-desktop-control-session-mcp.md),
  [SPEC-009](SPEC-009-coordinator-role.md)

---

*Created: 2026-10-29*
*Author: Claude, from the owner's decisions*
*Related Plan: [PLAN-009](../plans/PLAN-009-hub-headless-cores-and-coordinator.md)*
