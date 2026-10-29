# ADR-008: Run every bot as a headless core under one hub

## Status

Accepted — 2026-10-29, owner decisions recorded from discussion; implementation
pending in [PLAN-009](../plans/PLAN-009-hub-headless-cores-and-coordinator.md).
When implemented this supersedes ADR-001 §2's phase-one mounting and §8's
per-bot single-instance lock and tray, and updates ADR-002 §2–§4, ADR-004's
installation exclusion and ADR-006's language and setup-helper placement. Until
then those records describe the shipped code.

## Context

Today one bot is one Electron application process (`Cats Bot.exe --id <id>`).
The core is mounted in Electron's main process (ADR-001 §2), and each process
has its own tray, settings window, floating Cat, notes, updater, login item,
Electron user data (`%APPDATA%\Cats Bot\bots\<id>`) and single-instance lock.
Several bots are possible only by launching with different `--id` values; no UI
creates or manages a second bot, an update asks the owner to quit the other
shells first (ADR-004), and nothing can show all bots together.

The owner wants multiple bots as a product feature, with every bot in its own
process, and wants the architecture built that way even if the product caps the
fleet at one. ADR-001 §2 already fixed how the core may leave Electron: as "a
change in the packaging layer, not in the core", through `BotHostApi`.

On 2026-10-29 the processes of the installed 0.2.x Mochi on Windows (those
under `Programs\Cats Bot`, read with `Get-Process`) had a working set of about
560 MB:
- two processes without a `--type` flag, 102 and 83 MB;
- GPU, 109 MB;
- renderer, 102 MB;
- utility, 50 MB;
- Runtime, 114 MB.

That is about 450 MB outside Runtime, with the provider CLI not counted. Working
set counts shared pages in each process, so this is an indication, not a
precise total.

## Decision

1. **The hub is the only Electron process.** One hub runs per OS account and
   installation, behind one single-instance lock. It owns every presentation and
   host service: one tray, all windows (each bot's notes, floating Cat and
   settings, plus first run and bot management), native dialogs and
   notifications, update check/download/install, the login item, the fleet
   registry under `~/.catsbot/` (ADR-007), packaged provider setup helpers,
   display language, and the OS secret cipher. It holds no bot state and runs no
   bot timers.
2. **Each bot is a headless core child.** The hub starts one core per bot: the
   packaged executable with `ELECTRON_RUN_AS_NODE`, running the headless host
   (`cats-bot run`) for one bot root. Today that host does not take the packaged
   Runtime entry or helper path, which only the shell passes. It is extended to
   receive them from the hub. The core keeps everything it owns
   today: profile, conversations, work queue, journal, all timers, its own
   Runtime child, tool servers, the desktop-control helper and the Telegram
   transport. SPEC-001 FR-3's instance lock still allows one core per bot root,
   whichever host started it.
3. **One authenticated host channel per core.** The hub reaches a core through a
   local pipe/socket that extends the PLAN-004 owner control (descriptor in the
   bot root, per-start token, current account only). It is versioned and works in
   both directions:
   - from hub to core, the whole `BotHostApi`;
   - from core to hub, the event stream and the host services only the hub can
     provide (secret cipher, hub PID, coordinator brokering for ADR-009).

   The hub still never receives the Runtime URL or key. Calls from the hub's own
   windows keep today's work-item sources. The only new source is `bot`, for work
   that the coordinator hands over (ADR-009). No new path can create an
   owner-sourced work item.
4. **Lifecycle.** At start the hub attaches to cores that are already running and
   starts bots marked to start automatically. Closing windows changes nothing
   (ADR-001's hidden-window guarantee). Quit stops every core the hub started:
   graceful stop first, then the process tree. If the hub crashes, cores keep
   running and a restarted hub reattaches. If a core crashes, the hub restarts it
   with backoff and shows its state. A bot held by another host, such as a
   developer's `cats-bot run`, is listed as externally hosted, without windows,
   and never started twice.
5. **Fleet size.** The architecture supports N bots; the product cap is a hub
   setting, three in this version (SPEC-008). Removing a bot takes two steps:
   archive it, then delete it from the archive.

## Consequences

### Positive

- One Chromium for the whole fleet; an extra bot costs its core, Runtime and CLI.
- Restarting or crashing the UI no longer stops any bot.
- Bot management, one tray, aggregate unread state and one update coordinator
  become possible, and the coordinator role (ADR-009) has a host to ask.

### Negative

- The largest refactor so far: the core leaves Electron's main process, and every
  renderer call and event crosses an IPC channel with reconnection.
- The core cannot use Electron APIs. The secret cipher (today `safeStorage`
  passed in by the shell) is served by the hub over the channel. Because
  `SecretCipher` and `SecretStore` are synchronous today, `src/core/secrets.ts`
  needs an asynchronous path.
- Desktop control's self-exclusion changes. The core passes its own PID and
  executable to the helper (`src/core/bot.ts`), but the bot's notes and tray will
  belong to the hub PID. For a hub-started core, the executable match still
  covers them, because hub and core run the same executable. It does not cover
  an externally hosted core run by `node`. SPEC-008 therefore requires the hub's
  PID and executable path to reach every core's helper, so a bot can never
  operate its own approval UI (SPEC-006 BDC-08).
- Windows taskbar grouping per bot needs per-window AUMIDs instead of one AUMID
  per process.

### Neutral

- The headless CLI host remains for development and service use.
- One Runtime per bot is unchanged; sharing a Runtime (ADR-001 Alternative 7)
  stays deferred.

## Alternatives Considered

### Full Electron process per bot, coordinated by a hub

- **Pros**: reuses most of today's shell code.
- **Cons**: each extra bot pays a whole Electron (about 450 MB measured), and the
  hub must coordinate several UI processes.
- **Why rejected**: owner chose the headless core.

### One process hosting every bot core

- **Pros**: fewest processes, no IPC between UI and core.
- **Cons**: one bot's failure or leak affects all bots.
- **Why rejected**: the owner requires each bot to be its own process.

### Keep per-bot shells and elect a primary for shared UI

- **Pros**: no hub executable mode.
- **Cons**: leader election and handover across N Electron processes.
- **Why rejected**: more moving parts and still N Electrons.

## References

- [ADR-001](001-build-a-resident-bot-core-on-cats-runtime-with-disposable-presentation.md) §2, §8
- [ADR-002](002-give-the-bot-a-desktop-presence-in-the-electron-shell.md),
  [ADR-004](004-publish-standard-previews-with-host-owned-updates.md),
  [ADR-006](006-share-runtime-catalogs-and-package-provider-setup-helpers.md)
- [SPEC-008](../specs/SPEC-008-hub-and-bot-fleet.md),
  [PLAN-009](../plans/PLAN-009-hub-headless-cores-and-coordinator.md)

---

*Decision made: 2026-10-29*
*Decision makers: product owner (sammykenny2), recorded by Claude*
