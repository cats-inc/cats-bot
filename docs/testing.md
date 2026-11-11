# Testing Strategy

> How the bot core is tested, and the rules every test follows.

## Overview

The bot core is headless by design (ADR-001 §2), so almost everything is
testable without a window: state machines, the queue, schedules and heartbeats
run against a fake runtime client and a fake clock, and the few things that
need a real process run against the real pinned `cats-runtime` package with a
scripted fixture provider. Manual acceptance with a real provider CLI is the
last step, not the first.

## Test Types

### Architecture boundary test

- **Location**: `tests/architecture-boundaries.test.ts`
- **Scope**: `src/core/**` and `src/cli/**` never import `electron`, any
  `cats-platform` path or a relative path outside `src/`; `src/shell/**` never
  imports `src/core/runtime/`; no file reaches outside the repository
  (SPEC-001 A6).

  The shared conversation exception allows `@cats-inc/platform-ui-web/contracts`
  in core/CLI and public React/CSS entries in the renderer. Private entries and
  the root Platform application remain prohibited. `tests/core/presentation.test.ts`
  checks ordering, sidecar validation/backup/atomic failure, recovery and old-history
  compatibility; `npm test` continues exercising the real pinned Runtime.

### Unit tests

- **Location**: `tests/core/profile.test.ts`, `store.test.ts`, `handoff.test.ts`,
  `queue.test.ts`, `cron.test.ts`, `schedules.test.ts`, `heartbeat.test.ts`
  (also the SPEC-011 rhythm, back-off, prompts and work review),
  `tools.test.ts`, `secrets.test.ts`, `telegram.test.ts` (against an
  in-process fake Telegram Bot API)
- **Scope**: profile defaults and field-by-field normalisation, atomic writes,
  the instance lock and handoff files, journal rebuild, handoff-pack
  truncation, queue ordering and the session gate. Pure functions and the
  file system only.

### SQLite driver acceptance

- **Location**: `tests/core/sqliteDriver.test.ts` with
  `tests/support/sqlite-crash-writer.mjs`
- **Scope**: what the bot state database (SPEC-014, PLAN-014 task 1.1) needs from the
  SQLite built into the runtime, loaded through `src/core/store/sqliteDriver.ts`:
  - no experimental notice on stderr, other warnings still delivered, and a clear error
    when the runtime was started without SQLite;
  - WAL, STRICT tables, upsert and rollback;
  - a record stored as JSON text coming back exactly. Text holding NUL characters or lone
    surrogates survives because JSON escapes them, not because the driver keeps them;
  - contentless FTS5 over two-character tokens that finds Chinese words and the Latin
    words written against them, delete by row id, and a rebuild from the JSON records;
  - a change reported after a delete from the index, which needs the statement to read
    big integers;
  - `VACUUM INTO` not replacing an existing database, and `quick_check`;
  - a reader beside a running writer whose open transaction is already in the
    write-ahead log, in the same process and from another process;
  - a reader that neither creates a database nor leaves files beside a stopped bot;
  - a closed connection releasing its directory, which Windows refuses while it is open;
  - committed rows surviving a killed writer, and its open transaction not.

The `sqlite-driver runtime` line it prints also reports, without asserting, what the
runtime does with a raw NUL in a TEXT value, with the row id after a delete from the index,
and which files a read-only open leaves.

The architecture boundary test keeps `node:sqlite` out of every other module (SPEC-014
FR-2).

### State database adapter

- **Location**: `tests/core/stateDatabase.test.ts`
- **Scope**: `src/core/store/stateDatabase.ts` and `stateSchema.ts` (SPEC-014 FR-1 to FR-4):
  - a writer creating the schema on a new file and recording what wrote it;
  - each table keeping a JSON record with index columns that may be empty, an entry's
    row id never being reused, and the journal keeping the order it was written in;
  - a database from a newer version, and a file that is not a bot state database, refused
    with their bytes and journal mode as they were;
  - a schema that could not be finished leaving nothing behind, and a reader reading no
    database a writer has not finished;
  - a reader that never creates a file, sees the writer's commits, reads one snapshot
    taken before its work starts, and accepts only queries;
  - a change reporting its rows, and an insert its row id, whatever row id the index
    left behind;
  - transactions that are all or nothing, including a nested failure the outer code
    catches, work that returns a promise, and a transaction SQLite ended by itself; and a
    failed read in a snapshot leaving the transaction around it to go on;
  - one statement at a time, transactions opened only through the adapter, and an insert
    that must add exactly one row;
  - closing twice, a closed database saying so, and Windows refusing a rename while a
    connection is open;
  - the URI for an existing database, including UNC roots, and on Windows a read through
    a share of the local drive.

The architecture boundary test keeps the driver and the adapter out of every module
outside `src/core/store/`.

### Store tests inside Electron

`npm test` runs both files above under Node.js. The core runs inside Electron, whose
Node.js and SQLite are different builds, so CI runs them once more there on every
platform:

```bash
npm run test:electron
```

`scripts/test-in-electron.mjs` starts the Electron dependency in its Node.js mode with the
test runner. It first asks that binary for its Electron version and requires the
dependency's. It fails when Electron is not installed, when an argument is not an
existing file, when a test fails or is cancelled, and when a file defined no test, which
the runner would otherwise count as a pass.
`tests/shell/testInElectron.test.ts` covers how it reads the report and that CI runs it
on every platform. It also requires the `test:electron` script to name every test file
under `tests/core/` that loads the driver, the adapter or a store module built on them.

### Core tests on the fake runtime

- **Location**: `tests/core/bot.test.ts` and `tests/core/life.test.ts` with
  `tests/support/fake-runtime.mjs`
- **Scope**: `BotCore` through the real supervisor and client against a small
  HTTP stand-in for cats-runtime whose behaviour the message text scripts
  (`busy-once`, `noworker-once`, `exit-once`, `slow:<ms>`, `interrupt`,
  `error`, `tool`, `instructions?`). Covers streaming, retry on 409, resume on
  404, rebuild on 410, cancel, restart recovery (`interrupted`), stale
  attachments after a target change, the single-instance lock and handoff,
  note deletion and runtime crash restarts with backoff. The life tests drive
  `core.tick()` by hand with an adjustable clock: home session creation and
  revival after a crash, busy protection, quiet and spoken heartbeats, pause,
  due schedules and coalescing, missed policies after downtime, approvals and
  their timeout, idle notes. `tests/core/heartbeatLife.test.ts` covers SPEC-011:
  the back-off and its stop after five unanswered messages across a restart,
  home sleeping in rest hours (the good night, a message at night, dozing off
  again, waking at the wake time, a start at night, the heartbeat off) and the
  morning greeting, and `assist` reviewing notes into the direct message.
  `openTestBot` puts the injected clock (or the wall clock when none is supplied)
  in the bot's awake hours unless a test passes `awake: false`. Wake-greeting
  tests start at a fixed local noon, so their wake time belongs to the same local
  day even when CI runs just after midnight. Other wall-clock tests set the rhythm
  with `awakeNow()`; run the suites with `TZ` set to a
  night, just-after-bedtime and wake-window local time after changing the rhythm.

### Integration tests

- `tests/integration/unstartedSession.test.ts` uses the pinned real Runtime and
  the scripted Codex app-server fixture in a disposable home. It stops a warm
  zero-turn worker, restarts over the saved registry, checks one handoff with the
  prior conversation intact, and completes the first replacement turn. A failed
  initial authentication/bootstrap remains attached after restart. Companion
  continuity tests cover unknown evidence, recorded attempts, history paths,
  current/last runs, home/note isolation, concurrency and the persisted fence.

- `tests/integration/antigravityTimeout.test.ts` starts the real packed Runtime
  with a legacy agy stream-json fixture in a disposable home. It emits init,
  stays silent for 31 seconds, then completes; the previous Runtime fails this
  case at 30 seconds. The fixture uses no real provider or authentication.

  Verified on Linux ARM64 with Node 26.13.0: the previous `fb0f1125` Runtime
  artifact reproduced `Antigravity stopped responding after the initial response
  for 30000ms`; the `f53a2058` replacement completed the
  same 31-second case. The focused Bot run passed 22 tests (architecture, provider
  catalogs, Runtime stop, legacy CLI create/stream/cancel/resume/history, native
  Muse/Grok/Antigravity fixtures and this regression), plus typecheck and build.
  Runtime's focused config/WorkerPool/WorkerProcess run passed 105 tests and its
  build passed. Independent source and artifact review was performed separately.
  These are isolated fixtures, not a live model or installed-profile acceptance;
  no installed Bot/Desktop files or user conversations were changed.

- **Location**: `tests/integration/runtime.test.ts`, `tools.test.ts` and
  `multinote.test.ts` with `tests/support/fixture-cli/`
- **Scope**: the real pinned `cats-runtime` bin from `node_modules`, started
  the way the bot starts it (`--startup-mode app-managed`, a reserved loopback
  port, private `CATS_RUNTIME_DIR`, discovery flags off), with the scripted
  fixture CLI registered as `claude` through `command: node` plus
  `launch.args` (it speaks Claude Code's stream-json, answers the runtime's
  `--version`/`--help` probes, honours `--resume` and calls the bot's MCP
  server from `--mcp-config` like the real CLI would).
  Covers session creation with persona instructions, streaming, tool events,
  cancel, resume with `--resume`, `history`, and that a discovered entry in
  the private registry changes nothing for the bot (SPEC-001 A1). The tools
  test has the fixture call the bot's MCP server through the runtime's
  `--mcp-config` (bearer token from the environment variable the runtime
  sets): a schedule created by the model fires on the tick, `ask_owner` waits
  for the owner, and a quiet heartbeat leaves no message (SPEC-001 A2). The
  multi-note test shows a secret told in one note is not recalled from
  another and that a model change replaces the session instead of resuming
  it (SPEC-001 A4).
- Every test starts its own runtime in a temporary directory and stops it in
  `after`, so no child process outlives the test run.

### Shell tests

`tests/shell/trayMenu.test.ts` checks global-only tray menus with zero, one and
multiple Cats, per-Cat callback isolation, hidden-avatar recovery entry points,
localized labels and unchanged conversation titles. It verifies the emergency
Stop’s priority, app-name deduplication and dispatch to the hub’s global action,
while each avatar’s Stop stays scoped to that Cat. Unreadable Cat state keeps
recovery enabled and Stop first; status read failures do not mean an empty hub. Native menu presentation is a separate
Electron/OS acceptance check; plain-data tests alone do not prove it.

`tests/shell/setup.test.ts` drives the real first-run setup against a controllable
Electron double: closing during a pending check cancels immediately, a late final
recheck cannot create a bot, a delayed page load cannot show a closed window, and
installation and bot creation finish safely. `providerSetup.test.ts` covers probe
cancellation, idle waiters and preservation of an explicitly requested install.
`tests/integration/providerSetupProcess.test.ts` runs a disposable packaged-helper
fixture with a hung CLI and grandchild, and checks that cancelling stops all three.
The kill goes out before the provider setup becomes idle, and each process then has
up to 5 seconds to be reaped, because a killed process still answers `kill(pid, 0)`
until then. The test reports how long the processes took to start, so a slow runner
can be told from a hang.

#### Linux relaunch and update elevation

`tests/shell/linuxRelaunch.test.ts` checks that a relaunch starts only after the host
has exited, keeps its arguments and does not change `NoNewPrivs`, that a relaunch that
cannot start is logged rather than thrown, and that no Linux path reaches Electron's
`app.relaunch()`, which sets that flag. `tests/shell/updates.test.ts` checks that a host
with the flag refuses before downloading or stopping any bot, and how pkexec and apt exit
codes are reported. After `npm run build`, the same test file also runs real Electron
relaunches. CI does this headlessly on Ubuntu; a Linux desktop also covers the switch to
X11. They open no window and use a disposable profile:

```bash
CATS_TEST_ELECTRON_RELAUNCH=1 node --test tests/shell/linuxRelaunch.test.ts
```

An in-app update needs the administrator password, so only a manual acceptance on an
installed build covers pkexec itself: `NoNewPrivs` in `/proc/<hub pid>/status` is 0
before installing and after the automatic restart, and the next update can install.

#### Host diagnostics

`tests/core/diagnosticLog.test.ts` covers rotation across restarts, bounded legacy
files and UTF-8 records, unavailable disks/mirrors, private exception summaries,
stderr descriptor identity and continued append after Windows-safe truncation,
and a real Node fatal exception that still exits nonzero after synchronous logging.
`tests/shell/hostDiagnostics.test.ts` covers production/default versus opt-in
verbosity, explicit failure severity through CoreRunner, early second launches,
display inventory and transient API failures, window lifecycle and renderer/GPU
exit metadata without URL queries or titles. `bossCatSafety.test.ts` also checks
that arbitrary refusal text does not leak into host diagnostics or its audit.

After building, run `electron scripts/testing/host-diagnostics-acceptance.mjs`
to exercise a real Electron window's show/hide and renderer crash events against
a temporary user-data directory. It starts no Bot/provider, enables no crash
reporter, and prints the retained evidence directory (`host.log`, `result.json`).
Actual monitor hot-plug, resolution/DPI changes and GPU loss require a separate
native session check; synthetic event coverage is not evidence of those OS actions.

The stderr threshold is checked once per second and on orderly core exit. It is
not a hard cap while the event loop is blocked or the process is forcibly killed.
See [ADR-013](decisions/013-keep-bounded-production-host-diagnostics.md).

Validation on 2026-11-02 (Windows x64, Node 26.13.0): locked dependencies installed; typecheck,
production build and the full suite passed (412 passed, one platform-dependent
Codex prerequisite test skipped). Independent review's final focused rerun passed
31 tests with no remaining findings. A separate inherited-fd process probe wrote
400,000 stderr bytes and confirmed a 262,144-byte previous snapshot after the
periodic check. Real Electron 41.2.0 acceptance recorded a controlled renderer
crash (`crashed`, exit code 2), window events and clean host exit without Crashpad.

The full source candidate also wrote startup, actual display inventory and window
events into its private `host.log`, then drained with exit code 0. Its launcher
timed out waiting for a visible first-run window, so this is not a successful
candidate readiness/screenshot check. The retained launch/source receipt is in
the parent workspace's private `.diagnostics/catsbot-host-log-candidate-20261102-2`
directory. The unchanged, clean 0.4.4 checkout at the same HEAD reproduced that
readiness timeout under the same launcher/dependencies and also drained with exit
code 0 (`.diagnostics/catsbot-host-log-baseline-20261102`). Thus the timeout is not
introduced by these logging changes; no visual-readiness claim is made. No
installed profile, provider or real monitor configuration was changed.

`tests/core/busyRetry.test.ts` covers non-busy 409 failures, bounded busy retries,
safe cancellation before HTTP admission and removal of deferred work.
`tests/renderer/workState.test.ts` covers waiting controls and stale/equal-time
work snapshots. `tests/shell/linuxWindowing.test.ts` covers the Linux relaunch
arguments, bounded avatar input regions and the absence of a bounding shape.
`tests/shell/x11InputShape.test.ts` covers the X11 wire format, Xauthority parsing and
failure handling against a fake server. `tests/shell/linuxAutostart.test.ts` covers the
autostart entry, its quoting and the entries it must leave alone. `tests/shell/hub.test.ts`
covers which copies a finished first run turns Start at login on for.

`tests/shell/popupMenuFocus.test.ts` covers temporary menu-owner focus, restoring
the unfocusable avatar after a menu event or callback, popup failure, hidden or
destroyed owners, and replacement menus with delayed callbacks. On Windows/macOS
`popupMenu` applies this only to normally unfocusable owners; ordinary note menus
keep their existing behavior. Native acceptance must use an actual outside click,
Escape and item selection, checking that the menu disappears, the action still
runs and the avatar returns to being unfocusable. CDP input into a page alone does
not prove native menu dismissal. See the [focus findings](research/2026-11-02-avatar-menu-focus.md)
for the Windows reproduction and the macOS validation boundary.

Windows native acceptance on 2026-11-02 passed with Electron 41.2.0 and isolated
Bot/Electron storage, using the worktree's real `FloatingBot` and `popupMenu`:
outside left-click, keyboard Escape, item invocation (with its action observed),
replacement popup, hide/cancel, and normal avatar left-click activation after
showing it again. All six opened menus closed, and the avatar finished unfocusable
and unfocused. CDP telemetry, native UI Automation and screen captures agreed.
The full Node 24.14.0 suite passed 467 tests with one existing skip (468 total);
typecheck and build passed. Independent code/documentation review found no blocker.
The native fixture used a diagnostic menu and no real Bot records. It was not a
packaged-app or native macOS/Linux acceptance run.

After building, run `electron scripts/testing/bot-interaction-acceptance.mjs`
for the real renderer's waiting/polling/cancellation checks, including recovery
with completion notifications deliberately suppressed. The helper creates a temporary
Bot/Electron profile and starts only the fake Runtime, and leaves private screenshots
and `result.json` in the printed evidence directory. Use `--ozone-platform=x11` at
Electron startup to test X11 directly; omitting it on Wayland also exercises the
one-time relaunch.

On Linux, `scripts/linux/test-avatar-input.sh` runs the same helper with `--native-drag`
inside a private headless labwc, with its own configuration, home and Xauthority. It
needs `labwc`, `grim`, `wlrctl`, `xdotool` and `xwininfo`. A maximized native Wayland
window sits behind the avatar, and the checks are: `grim` shows that window through the
transparent area, real `wlrctl` pointer clicks reach the cat and bubble and pass through
everywhere else, including where a dismissed bubble was, a click on that window closes the
right-click menu without leaving anything in the way, and the window has no bounding
shape. `xdotool` still drives dragging, fixed bounds, activation and the context menu. An
X11 background or `xdotool` clicks cannot check click-through, and `capturePage` cannot
see what surrounds the page (ADR-014). The script fails if the session's own Xauthority
changed. `--native-drag` refuses to run without it, because it moves the pointer and
covers the screen.

On macOS, the tray uses a 20pt canvas, matching Cats Desktop, with native 20px
and 40px Retina representations. When checking a native candidate, compare the
menu-bar footprint with Desktop and check sharpness on a Retina display.

`tests/shell/linuxIcons.test.ts` runs electron-builder's icon resolver and
desktop-entry generator against the package configuration. It checks standard
hicolor PNG sizes and matching launcher, icon and window identities. For native
Linux acceptance, inspect the built `.deb` with `dpkg-deb --contents`, then check
that GTK resolves `cats-bot` and the running window shows the cat icon in the
taskbar. These native checks are separate from the cross-platform test suite.

`tests/shell/noteWindows.test.ts` runs the real note window manager against a
controllable Electron double. It covers a close after startup selected its restore
list, overlapping opens during page load, explicit reopening, shutdown/deletion
during a load, and delayed desktop focus after hiding. Page-load completion is
released explicitly, without sleeps or real profile access.

- **Location**: `tests/shell/trayMenu.test.ts`, `tests/shell/bridge.test.ts`,
  `tests/renderer/*.test.ts`
- **Scope**: the Electron-free parts of the shell: the tray menu data and the
  note view state. Everything that needs Electron is checked by hand (below).
  `tests/core/providers.test.ts` covers the provider list, PATH detection,
  the model catalogs and first-run input validation (SPEC-002);
  `trayMenu.test.ts` also covers where the floating bot appears and its bubble text.
  It checks the Hub-only arrange action's order, localization and availability
  with zero Cats or unreadable status. `floatingArrangement.test.ts` checks
  layout on negative-origin monitors, work-area/taskbar bounds, row wrapping and
  small screens. After building, run
  `electron scripts/testing/floating-arrangement-acceptance.mjs` for real native
  avatar recreation, saved positions, hidden/offscreen recovery, repeated resets
  during loading and hiding during a reset. It uses temporary Electron storage
  and fixture pages, starts no Bot/core/provider, and checks that another window
  survives. It does not reproduce Windows virtual-desktop Shell cloaking; that
  needs native acceptance with the popup open across a desktop switch.
  On 2026-11-04 this fixture passed on native Windows with Electron 41.2.0
  for three avatars; typecheck and build passed and independent review found
  no remaining blocker. The standalone Node 24.14.0 full run had 565 tests:
  555 passed, 9 skipped and one existing Runtime-pin Git test failed because
  the host executor did not own the sandbox-created worktree. That exact test
  passed 1/1 when rerun by the owning sandbox executor; the original full run
  was not entirely green. No installed-app upgrade or native macOS/Linux
  arrangement acceptance ran.
  `bridge.test.ts` checks the renderer's `window.catsBot` type against the
  shell (commands, note layers, preload methods; ADR-003), and
  `architecture-boundaries.test.ts` that the renderer takes only types from
  `core/types.ts`. Renderer logic that does not touch the DOM lives in plain
  `.ts` modules so `node:test` can run it; components are checked in the
  real shell (below). For desktop control (SPEC-006),
  `tests/shell/desktopControlIpc.test.ts` covers the host commands and which
  window may send them, `tests/renderer/desktopControl.test.ts` the note and
  Settings wording and visibility, including the banner while the bot holds
  control, `tests/shell/trayMenu.test.ts` the tray's Stop item, and
  `tests/core/desktopControlCore.test.ts` runs `cats-bot desktop` against a
  running core with a fake helper. `tests/core/desktopControl.test.ts` covers
  the phase B guard fixtures (PLAN-006 P5).

### Utility window placement and data reset

`tests/shell/pageWindowState.test.ts` exercises the real page factory and Settings
window against the controllable Electron double: independent saved positions,
normal bounds through maximize/fullscreen, destroy-time flush, removed-monitor
clamping, corrupt-file preservation and a close during page load.
`tests/shell/dataReset.test.ts` checks default Runtime retention for active,
archived and trashed bots, optional erasure of current/previously retained
Runtime, interrupted purge retry, lock refusals, storage/junction protection,
OS-preference failure, sender/confirmation/busy gating and startup arguments.
It also removes the reset's lock during a purge and verifies core/init/lock
entry points remain fenced, then checks CLI Telegram and stale secret/handoff
writers cannot recreate an already purged bot directory.

After building, run:

```bash
node scripts/testing/page-window-reset-acceptance.mjs
```

This launches three real Electron processes with disposable Bot/Electron storage.
The first saves five independent utility placements and confirms the real
localized Data dialog with Runtime unchecked. The second verifies placement
from disk, completes the Bot-only reset and checks the retained Runtime, then
confirms the dialog with Runtime checked. The third completes that purge and
checks retained Runtime and consent are gone. Cancel leaves data untouched.
The printed evidence directory contains screenshots and per-process results.
No core, provider CLI, installed profile or OS login item is used by this fixture.
Reset fixtures canonicalize their temporary root, including macOS's system
`/var` alias; deliberate redirected-storage tests still verify refusal.

On 2026-11-11 this native Windows x64/Electron 41.2.0 fixture passed all three
processes; its Traditional Chinese confirmation screenshot was inspected.
Typecheck and production build passed. Independent review's focused run passed
63 tests and found no remaining blocker after the core/CLI fence fixes.
The broad runs were not entirely green: the host Node 26 sandbox run had
symlink/cache/process-cleanup failures; the Electron Node 24.14.0 run had
794 tests (772 passed, 12 failed, 10 skipped), including Windows symlink
privileges, temporary-directory cleanup, core-process harness/pipe failures,
helper-grandchild readiness and a cross-user Git worktree ownership refusal.
The normal host Node 26 run outside the sandbox subsequently passed 65 focused
core lifecycle, process/channel, secrets, locks, reset and window tests, including
the cases that failed through the Electron-as-Node process harness.
These full-suite runs are not claimed as passing. Real OS reboot, monitor
hot-plug and installed-app acceptance were not performed.

### Hub, cores and Boss Cat (PLAN-009, PLAN-010)

- **Location**: `tests/core/channel.test.ts`, `channelCore.test.ts`,
  `tests/integration/channelRun.test.ts`, `coreProcess.test.ts`,
  `tests/shell/hub.test.ts`, `botManagement.test.ts`, `bossCat.test.ts`,
  `bossCatSafety.test.ts`, `tests/core/botMessages.test.ts`,
  `tests/core/desktopControl.test.ts` (the lease),
  `tests/architecture-boundaries.test.ts`, and for SPEC-012
  `tests/core/workBoard.test.ts`, `tests/core/contactNotes.test.ts` and
  `tests/shell/bossCatStatus.test.ts`.
- **Scope**: the host channel's protocol rules against a fake core and with real
  cores on the fake runtime, the shell's core host starting, reattaching to and
  stopping `cats-bot run` (a slow Runtime, a stop during start, a lock released
  while waiting, a core that answers nothing), the snapshot budgets, the hub's
  registry, state, locks and control endpoint, archive, restore and delete
  through `trash/` with a junction inside a bot, the cap, supervision limits,
  the desktop lease held by another process, and the Boss Cat between two
  cores reached only through their channels: deliveries once, answers back,
  limits, consent and authorization. The security review's cases run with fake
  cores: a former holder's request, one request at a time and the cool-down,
  the dialog's wording, the restart budget, hops with replies on their way, a
  torn log line, a reply lost between two writes, a target that hangs,
  compaction, archived senders, and ids-only logs; and in a core, another bot's
  message in its own conversation, never handed on as the owner's, and an
  interrupted one ending failed. The shell may take from `src/core` only
  modules that start no core.
- **Manual**: the real Electron hub in an isolated `CATS_BOT_HOME` and
  `--user-data-dir`, with the fixture CLI: first run, a second launch, a hub
  crash and reattach, two bots with a killed core, `cats-bot quit` per bot, and
  `cats-bot hub boss-cat`. Compare `~/.catsbot`, `%APPDATA%\Cats Bot`, the
  provider folders and the login items before and after; nothing may change.
- **Manual, first run through the setup page**: launch without `--provider`,
  with an isolated home whose `.npmrc` names an existing global npm prefix, so
  the page's provider check runs the packaged setup helper as an owner's first
  launch does. The check must report its components, and **Create and start**
  must leave the bot running with its note open. Starting with `--provider`
  skips the page and its helper callbacks; 0.3.0 shipped with a first-run
  error this path would have shown.
- **SPEC-012 (Phase 1)**:
  - the status board and the peer section never carry message text; titles are cleaned and
    fenced, and the fingerprint ignores times;
  - pushed boards are validated (ids that could forge marks are dropped), and the board
    commands are host-only;
  - legacy sender conversations are upgraded in memory by any host, written only by a running
    core after a backup, and rebuilt from an allow-listed handoff that leaves out the owner's
    words and replies or receipts that echo them;
  - every owner write into a contact note is refused, from the offline CLI too; owner work
    queued there before the upgrade never runs; provider requests there take only choices;
    and decisions there run as events;
  - contact notes stay out of the `assist` review and the waiting-decision count;
  - `hub_bot_status`, its hourly limit, the per-bot switch and the holder recheck work through
    real channels, and a board naming another bot is dropped;
  - boards reach only the holder, whose heartbeat reads them, sees a new decision after an
    answered one, and cannot call hub tools, nor can its reminders at any depth or a late
    call.

### Windows desktop control helper

- **Location**: `tests/shell/windowsDesktopControl.test.ts` and
  `native/windows-desktop-control/native-check/`
- **Scope**: the test covers the packaging scripts without running dotnet,
  PowerShell or electron-builder, so it runs on every CI platform: one
  self-contained `dotnet publish` per architecture, stale helper removal, the
  .NET runtime license staging and its failure when a runtime pack is missing,
  the packaged architecture check against `Cats Bot.exe`, the no-op on macOS and
  Linux, the Windows-only `extraResources` mapping, and the frozen SPEC-133
  exclusion lists in `Exclusions.cs` (SPEC-006 BDC-11, PLAN-006 P1).
- **Native check** (Windows only, manual): run `dotnet build -c Release` in the
  helper folder, then `node native/windows-desktop-control/native-check/check.mjs
[helper.exe]`. It opens two throwaway PowerShell windows for about 10 s, never
  sends keyboard or mouse input, and checks the handshake, window listing, app
  resolution, capture under a covering window (B4), UI reading without password
  values, the lock state and self exclusion. CI never starts the helper.
- **Native input check** (Windows only, manual, B7): `node
native/windows-desktop-control/native-check/input-check.mjs [helper.exe]`
  builds its probe app on first use and sends real keyboard and mouse input,
  but only to that probe window, after 5 quiet seconds from the owner before
  each action. Run it only on a desktop nobody else is using.

### Manual acceptance

- A real provider CLI on Windows for SPEC-001 A1 to A4.
- The shell: launch it with `--remote-debugging-port=<port>`, drive the note
  page through the Chrome DevTools Protocol (`Runtime.evaluate` on
  `window.catsBot`, `Page.captureScreenshot`) and send messages with
  `cats-bot say`; quit with `cats-bot quit` and confirm the whole process tree
  is gone. The SPEC-001 measurement table was filled this way on 2026-10-27.
- First run and settings (SPEC-002): start the shell with a fresh
  `CATS_BOT_HOME`, an unused `--id` and the fixture CLI
  (`CATS_BOT_PROVIDER_COMMAND=node`, `CATS_BOT_PROVIDER_LAUNCH_ARGS=<fixture>`),
  fill the setup page through CDP, then drive `settings.html` the same way.
  With that override every provider counts as installed, so `hub_create_bot`
  creates the bot at once instead of opening the New cat bot window
  (SPEC-009 FR-4).
- Clean machine (PLAN-010 Phase 3). Run this only when the owner asks; it is
  not part of CI.
  - Windows Sandbox signs in as an administrator with UAC off. The user-scoped
    helpers refuse that unless `-AllowAdmin` is passed.
  - For the app's real path, use a Hyper-V VM built from the Windows 11
    Enterprise evaluation ISO, with UAC on and `ConsentPromptBehaviorAdmin=0`
    standing in for the owner's Yes.
    - Run the helpers through `Invoke-SetupHelper.ps1` as the signed-in user at
      medium integrity: a scheduled task with `RunLevel Limited`.
    - Drive the unpacked app over CDP with its own Electron as Node.
  - A runner started before Node is installed has no `npm` on its PATH. A
    helper reports Codex's `codex.ps1`; run the `codex.cmd` beside it, or
    `cmd.exe` opens the `.ps1` in Notepad.
  - Check sign-in commands in PowerShell too. A clean Windows has the
    Restricted execution policy, which blocks `codex.ps1` and `npm.ps1` there
    but not in `cmd.exe`.
  - The PowerShell scripts step reads and sets only the user's own policy. A
    Group Policy that enforces Restricted (MachinePolicy or UserPolicy) still
    blocks the shims while the step reports ready; sign in from `cmd.exe`
    there.
- The floating bot (SPEC-002 FR-7) needs real input: move the mouse with
  injected events (`mouse_event` with `MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE`
  or `SendInput`), not `SetCursorPos`, which bypasses the low-level hook
  Electron uses to forward moves to a click-through window. Read the cat's
  rectangle from the page (`getBoundingClientRect` plus `window.screenX`,
  times `devicePixelRatio`) before pressing.
- Note layers (SPEC-002 FR-8) on Windows: put the note where no application
  window covers the desktop, confirm the parent with `GetAncestor(hwnd,
GA_PARENT)` (Explorer's icons host for desktop, its `WorkerW` for wallpaper),
  and before sending any key check `GetForegroundWindow()` is the note: a
  click on an attached note does not make it the foreground window, so keys
  sent without that check land in whatever window the owner had active.
- Wallpaper repaint (ADR-011) on Windows: with a solid black background, put
  a note on the wallpaper where no window covers it, then in turn move it to
  the desktop layer and hide it, open it (the lift), delete its conversation
  and quit. After each, read the wallpaper `WorkerW`'s own pixels at the old
  place with `PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT)` and expect black;
  screen captures alone cannot tell which Explorer window holds a white block.
  `RedrawWindow` on that host does not clear a block; 0x052C (13, 1) to
  Progman does.
  Also change a hidden note's layer to desktop or wallpaper from settings and
  check `IsWindowVisible` stays false, and restart Explorer with a wallpaper
  note shown: the note opens again on the wallpaper, and hiding it leaves the
  wallpaper intact.
- Screenshots (SPEC-003 FR-9): on macOS grant Cats Bot Screen Recording first (a build without it
  answers with the permission message). Take a screenshot from a note on the desktop layer and from
  a normal one, with a floating Cat on screen: neither the note nor the Cat is in the picture, the
  note comes back focused and still on its layer once it loses focus. On every display the overlay
  covers the screen, a drag selects, Escape cancels. On wlroots, check with and without `grim`/`slurp`.
- System Settings panes (ADR-020), on a fresh macOS profile with a signed package:
  - The first screenshot is refused with a line naming Screen & System Audio Recording. Cats Bot (not
    `cats-stt-macos`) is now listed there, and "Open System Settings" opens that pane. A grant works after
    restarting Cats Bot.
  - Deny Speech Recognition, then the microphone, and dictate: each line names its own pane and its button
    opens it.
  - Switch Cats Bot off in General > Login Items with start at login on. Cats Bot Settings > General shows the
    approval line, and its button opens Login Items.
- Dictation (SPEC-003 FR-10): only a signed and notarized macOS package (hardened runtime, the
  audio-input entitlement and the usage strings) proves the microphone works as shipped; an unsigned
  development run proves the helper and the note. Grant the microphone and speech recognition, dictate
  English and Chinese, cancel with Escape, start in a second note while the first listens (the first
  stops), and close a listening note. On Windows check the online-speech warning badge.
  - With no available audio input, run
    `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer swift test --package-path native/macos-stt`.
    The native regression calls the production capture path and asserts exactly `mic_unavailable`,
    then `end`, without requesting permission, starting recognition or recording. It skips when an input
    device is available. The 2026-11-11 Mac mini reproduction had 0 Hz / 0 hardware input channels,
    while the output scope reported a default 44100 Hz / 2 channels. Both installed Bot and Desktop
    helpers crashed installing a tap despite granted permissions. This regression covers missing
    hardware, not successful dictation or signed-package microphone acceptance.
    Local validation on 2026-11-11 passed the native regression (1 test, not skipped), the focused
    dictation/host/source/packaging suites (19 tests), and the arm64/x86_64 release helper build.
    Independent review found no issues. Installed applications were not replaced.
  - With the USB microphone connected later that day, installed Bot emitted `ready` (`zh-TW`,
    `on-device`) and `end` for a spoken session, with no partial/final events or draft text.
    Speech defaults to its [main callback queue](https://developer.apple.com/documentation/speech/sfspeechrecognizer/queue),
    which the CLI blocked waiting for completion. The callback-progress regression failed before
    the serial background queue fix and passed afterward. The queue remains suspended during tap
    startup so a fast error cannot tear down an uninstalled tap. Both helpers passed the callback
    test and skipped missing-input coverage while the microphone was connected. That test now
    queries CoreAudio's default input before creating an input node, avoiding a permission request
    on connected hardware. Queue progress is verified; live transcription after the fix remains
    unverified, and installed apps still carry the previous helper.
    Both updated release helpers rebuilt with arm64/x86_64 slices; the native-helper source contract
    tests passed (2 per repository).
    Independent review found no blocking issues in the callback/lifecycle change.
- Note layers (ADR-016) on macOS: read each note's level from WindowServer
  (`CGWindowListCopyWindowInfo`, `kCGWindowLayer`; no Screen Recording needed).
  - Expect `CGWindowLevelForKey(kCGDesktopIconWindowLevelKey) + 1` on the
    desktop layer, listed above Finder's icons window and below every
    application window. Expect `CGWindowLevelForKey(kCGDesktopWindowLevelKey) + 1`
    on the wallpaper layer, below the icons.
  - Check the level through a lift (focus the note: the normal level), a settle
    (focus another window: the layer's level again), hiding and opening, and
    every layer change.
  - By hand: click, drag and type (including an IME) into a desktop note. Use
    Show Desktop, Mission Control, another Space, Stage Manager and Sonoma's
    click-the-wallpaper. A wallpaper note takes no click.
  - Run the universal package once on an Intel Mac or under Rosetta, which
    loads koffi's x64 binary.

## Running Tests

`tests/integration/codexDesktopControl.test.ts` runs the packed Runtime against a
scripted Codex native MCP approval and a fake desktop helper. It verifies decline
and cancellation without tool execution, a separate app grant after tool consent,
read-only tool consent, one execution in the same work item, and input-free receipts.

```bash
npm test                                      # everything
node --test tests/architecture-boundaries.test.ts
node --test "tests/core/*.test.ts"
node --test "tests/integration/*.test.ts"       # about 45 s; starts the real runtime
```

`npm run typecheck` type-checks tests as well as sources (`tsconfig.test.json`)
and the renderer (`tsconfig.renderer.json`).

## Rules

- **State hygiene**: tests only write under a temporary directory they create;
  every bot root, and `CATS_BOT_HOME` and `CATS_RUNTIME_DIR` wherever a test
  sets them, point there. No test touches the real `~/.catsbot` or `~/.cats`,
  and no test reads any provider credential file.
- **Erasable syntax only**: tests are `.ts` files run by Node's type stripping.
  Use `import type` for types and keep to the syntax `erasableSyntaxOnly`
  allows.
- **No sleeps for logic**: time-dependent behaviour takes an injected clock;
  real waits appear only in integration tests, with a bounded timeout.
- **Report honestly**: a test that cannot run (for example a missing CLI for a
  manual check) is reported as not run, never as passed.

## CI/CD Integration

`.github/workflows/ci.yaml` runs `npm ci`, `npm run typecheck`, `npm test` and
`npm run build` on `ubuntu-latest`, `windows-latest` and `macos-latest` with Node 24 for every
pull request and every push to `main` that changes a path outside root `docs/`.
After `npm test` it runs the [store tests inside Electron](#store-tests-inside-electron)
on each platform.
The `changes` job follows the other Cats repositories' docs-only detection: PRs
compare the test merge to its first parent; pushes compare the entire pushed
range. Renames count both old and new paths. An unknown base, empty diff or failed
detection runs full CI.

For confirmed docs-only changes, the existing `node (...)` checks acknowledge the
skip on lightweight Ubuntu runners; no Windows/macOS runner, dependency install,
application test, build or candidate artifact is needed. `preview-contract` is
skipped, while `validate` still checks the expected job results, required files
and tracked YAML. Mixed changes still require all three platforms and the full
package contract. Application tests keep executable inputs
outside repo documentation and exercise the actual workflow detector and final
job gates. Manual publication still reads the prepared release notes.

A push to `main` also skips the checks when its merged pull request already
passed on the same tree. `main` requires up-to-date branches, so a squash merge
usually lands exactly what the pull request's CI tested. The `changes` job
reuses that run only when all of these hold:

- the push adds one commit on the previous `main`;
- the GitHub API names that commit as a pull request's merge;
- the request's final head, fetched from `refs/pull/<n>/head`, contains the
  previous `main` and has the pushed commit's tree;
- CI passed on that head as a `pull_request` run.

The `node (...)` checks then acknowledge the skip on Ubuntu, and
`preview-contract` is skipped. Any other push, or any failed lookup, runs every
check. `tests/shell/ci.test.ts` runs this step against a local origin with a
stubbed `gh`.

The same CI builds all Standard Preview architecture/format combinations as
unsigned candidates and checks the complete asset metadata, source bundle and
checksums. Candidate identity disables updates. The `candidate-windows` artifact
is also the Windows installer and portable build that SPEC-002 FR-9 keeps for
every main update: in the push run, or in the merged pull request's run when the
push reuses it. Publication is a separate manual workflow documented in
[deployment.md](deployment.md). It does not rerun typecheck or the tests: its
guard requires a successful CI push run on `main` for the source commit.

The signed macOS release job routes Apple's ticket requests over TCP before
packaging to avoid the hosted runner's HTTP/3 failure. Candidate CI has no signing
credentials and does not exercise that workaround. Only a signed release run
passing codesign, Gatekeeper and stapled-ticket validation establishes that path;
YAML checks and unsigned candidate packages do not.

`tests/shell/updates.test.ts` covers native-operation timeout fencing, completion
identity, explicit consent, Settings main-frame ownership, drain order, multiple
Bots, crashed/PID-reused installation leases and uncertain handoff recovery.
Its download regressions advance a fake clock beyond the request deadline while
bytes keep arriving, require successful checksum verification and installation
preparation, and require unchanged/late progress to time out without breaking
the pending native-operation fence. Before the inactivity-deadline fix, the
advancing-download case failed with `The update request timed out. Please try again.`
On 2026-11-11, installed macOS Bot 0.5.8 reproduced that error while fetching
0.5.9: the partial ZIP stopped near 80% while a native error alert was open.
After the owner dismissed it, the background download completed with the official
SHA-256, but host state stayed `error` and no new ShipIt installation had started.
Local validation passed the updater suite, typecheck and build. These fixtures do
not install an update or prove an installed-app upgrade; the installed app was
left unchanged during diagnosis.
`tests/shell/releasePipeline.test.ts` covers immutable inputs, version ordering,
draft ownership, signing configuration, source receipts and corrupted/missing
updater assets. Fixtures never run an installer. Real renderer acceptance must use
isolated Bot/userData roots; real installed upgrades remain a separate release
check on each target OS.

After building, run `node node_modules/electron/cli.js scripts/test-updates-renderer.mjs`
for the isolated real Electron renderer/preload acceptance. It exercises check
failure/retry, explicit download, progress, reload persistence and cancelled or
confirmed fixture installation. No provider, real profile or installer is used;
screenshots/results stay in ignored `tmp/updates-renderer-*` directories.

Desktop parity acceptance uses two separate Electron processes after a build:

```bash
node node_modules/electron/cli.js scripts/test-desktop-parity.mjs
node node_modules/electron/cli.js scripts/test-desktop-parity.mjs --restore tmp/desktop-parity-<printed-id>
```

The first process exercises provider-first setup with deterministic missing/installed
helpers, exact model/effort menus, selection persistence, legacy-target preservation,
live language switching, tooltip removal and a close followed by a delayed startup
restore through the real note/preload. It writes mixed visible/hidden windows
and an all-hidden state. The second process confirms all-hidden startup, then
restores mixed bounds/layers and the avatar from disk. Windows includes native
Explorer desktop/wallpaper attachment; other OSes exercise normal/top only.
`--native-dialog` also opens a real localized tray update result and waits for the
operator or a scoped native UI driver to dismiss it. It asserts no Settings window
was opened. Screenshots and JSON evidence stay in ignored `tmp/`.

The helper runner/unit tests verify fixed arguments, prerequisite order, restart
and failure handling, mutual exclusion, startup PATH recovery and source hashes.
On macOS/Linux they also run the packaged Node → npm-folder → Codex checks with
the system Bash and disposable CLI fixtures. An already configured npm folder
must return complete JSON and allow setup to finish, including with macOS Bash 3.2.
They do not install CLIs or access provider credentials. The real Runtime integration
test verifies stale catalog revision recovery and saved effort reaching CLI arguments.

---

_Last updated: 2026-10-29_

Shared tooling regressions live in `tests/shell/sharedTools.test.ts`. They cover
Bot-specific CDP defaults/file-target selection, candidate argument boundaries
and offline source/mode provenance. The common producer tests cover handshake
timeouts, occupied-port/active-Runtime refusal, exact Git objects, skill
preflight and image rendering. Real private candidate acceptance additionally
verifies readiness, screenshot and graceful drain without installed-app changes.

## Setup wizard

`tests/shell/providerSetup.test.ts` runs the Windows npm helper in read-only mode with
temporary paths and explicit probe values. Its `changes_required` result anticipates a
restart after changing PATH; setup keeps that unapplied plan tickable. The renderer
fixture carries the same flag and follows the npm and Codex installs through to creation.
Separate cases keep an actual post-install restart visible until a fresh check confirms
the step.

The Windows Codex regression runs the real helper runner and vendored installer
with a disposable native npm fixture that reports `ENOENT` for an absent global
prefix. The check must return a JSON install plan instead of an unreadable-result
error, so the wizard can offer both npm-folder setup and Codex installation in
the same pass. It runs under Windows PowerShell 5.1 without installing a provider
or changing the owner's npm configuration. The focused helper-runner suite passed
25 tests on Windows, with the Unix-only case skipped; clean-machine installation
remains a separate acceptance check.

`tests/shell/nodeSetupElevation.test.ts` exercises the packaged helper runner,
wrapper, Node helper and a real Windows PowerShell 5.1 child from a `Cats Bot`
path and a temporary user path containing spaces and Unicode. Private fixture
copies replace only the administrator observation and UAC launch, and add
`-SkipNodeProbe` so no download or installer can run. Both cases reproduced the
generic helper error with the original 0.5.2 helper, then passed with the pinned
producer fix: the child result survives the elevation boundary, and a missing
result returns a structured failure with its exit code. The helper-runner and
wizard-logic suites passed 44 cases with one Unix-only case skipped. A third
packaged-runner case verifies successful system-restart data passes through.
Actual UAC
and clean-machine installation remain separate manual acceptance checks. Bot
typecheck passed with the locked worktree dependencies installed.

The synchronized setup helpers also cover Desktop's shared Windows process
quoting and Node previews on all three OSes. The producer's shared process
regressions keep real installer/network calls behind isolated fixtures. Bot
retains explicit Windows machine-restart advice through ready probes, later
installs and rechecks in the current Hub session. The renderer shows that advice
on a usable Node row and offers Windows-restart guidance for an unavailable one;
it does not offer a Cats Bot restart for that machine-level request. Generic
PATH/relaunch requests still clear after a successful fresh check. No restart
marker is persisted and no Windows reboot is initiated by setup.

The Electron renderer fixture registers its work after ESM evaluation instead
of awaiting readiness at module scope; the latter deadlocked before the first
scenario under Electron 41.2.0. Hidden windows disable background throttling and
wait for animation frames before screenshots. The fixture checks that reboot
advice has visible layout and that successful installs keep their change count
after rechecking. It uses private appData/userData and fake installers only.
Final Windows validation passed typecheck, build and all 92 renderer assertions
under the locked Electron 41.2.0; the Windows-restart screenshot was visually
checked. This remains separate from real UAC and clean-machine installation.

`electron scripts/test-setup-wizard-renderer.mjs` (after a build) drives the real page, preload and first-run IPC with fake helpers: no window is shown, no script runs and no terminal opens. It does not replace the installs below on a clean machine, which still need a person (PLAN-011 Phase 4).

`electron scripts/test-agent-clis-renderer.mjs` (after a build) does the same for Cats Bot Settings' Agent CLIs tab and a cat bot's own CLI (SPEC-013): the real settings page, preload and `computer:*` channels, with fake helpers, in English and Traditional Chinese at 860×640. A real install or update still needs a person on a clean machine (PLAN-012 Phase 3).

Windows Codex initialization regressions additionally cover the public app-server
readiness preflight and official terminal entry. `tests/shell/codexSetup.test.ts`
uses real disposable child processes for fragmented RPC replies, notifications,
unsupported/unknown statuses, early exit, timeout, oversized output, cancellation
and descendant cleanup. The request allowlist has only initialize, initialized
and windowsSandbox/readiness. Launcher fixtures cover npm cmd/ps1, Node x64/arm64
independent of Electron, invalid shims/PE headers and standalone executables.
Native fixture assertions compare canonical file identity because macOS temporary
paths may be spelled through either `/var` or its `/private/var` target.
Terminal tests retain CODEX_HOME and a Unicode/spaced working folder, use Command
Prompt and require no execution-policy change. Both creation paths recheck provider
installation, while sandbox readiness is advisory; first-run IPC coverage also
verifies sender and provider scope. Submission does not run the readiness probe,
so a diagnostic that would never settle cannot hold creation open.

The renderer fixture adds an incomplete → terminal opened → unverified → ready
scenario: page 2 can reach login and Create stays available with incomplete or
unverified initialization and optional PowerShell unset. Opening a terminal does
not mark the initialization row ready. Renderer clicks and first-run IPC cover
creating a cat in both advisory states. Native Codex 0.166.0 checks used four private CODEX_HOME configs,
no credentials, no model turns and no sandbox installation; all config bytes
stayed unchanged. MXC readiness depends on the account's machine capabilities.
See the [dated findings](research/2026-11-05-codex-windows-initialization.md).
Actual terminal/UAC completion on a clean machine remains manual acceptance.

For the 2026-11-08 creation-gate correction, the focused provider/setup/renderer
run passed 60 tests with one Unix-only skip, and the real hidden Windows Electron
fixture passed 106/106 assertions. Typecheck and build passed. An independent
review confirmed installation checks, cancellation and Runtime permission
enforcement remain in place; no live model, customer profile or UAC was exercised.

The full Windows run with a checkout-local npm cache reported 580 passed,
9 skipped, one failed and one cancelled (591 total). The existing wedged-core
and helper-descendant termination cases failed under the restricted executor;
both affected integration files then passed all 9 tests under the normal host
account. Two additional host-gate/logging regressions also passed in the focused
suite. Typecheck and the production build passed; Vite required the normal host
account because the restricted executor could not read an ancestor directory.
