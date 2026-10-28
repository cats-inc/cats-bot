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

### Unit tests

- **Location**: `tests/core/profile.test.ts`, `store.test.ts`, `handoff.test.ts`,
  `queue.test.ts`, `cron.test.ts`, `schedules.test.ts`, `heartbeat.test.ts`,
  `tools.test.ts`, `secrets.test.ts`, `telegram.test.ts` (against an
  in-process fake Telegram Bot API)
- **Scope**: profile defaults and field-by-field normalisation, atomic writes,
  the instance lock and handoff files, journal rebuild, handoff-pack
  truncation, queue ordering and the session gate. Pure functions and the
  file system only.

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
  their timeout, idle notes.

### Integration tests

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

- **Location**: `tests/shell/trayMenu.test.ts`, `tests/shell/bridge.test.ts`,
  `tests/renderer/*.test.ts`
- **Scope**: the Electron-free parts of the shell: the tray menu data and the
  note view state. Everything that needs Electron is checked by hand (below).
  `tests/core/providers.test.ts` covers the provider list, PATH detection,
  the model catalogs and first-run input validation (SPEC-002);
  `trayMenu.test.ts` also covers where the floating bot appears and its bubble text.
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
  `CATS_BOTS_HOME`, an unused `--id` and the fixture CLI
  (`CATS_BOTS_PROVIDER_COMMAND=node`, `CATS_BOTS_PROVIDER_LAUNCH_ARGS=<fixture>`),
  fill the setup page through CDP, then drive `settings.html` the same way.
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

## Running Tests

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
  `CATS_BOTS_HOME` and `CATS_RUNTIME_DIR` always point there. No test touches
  the real `~/.cats`, and no test reads any provider credential file.
- **Erasable syntax only**: tests are `.ts` files run by Node's type stripping.
  Use `import type` for types and keep to the syntax `erasableSyntaxOnly`
  allows.
- **No sleeps for logic**: time-dependent behaviour takes an injected clock;
  real waits appear only in integration tests, with a bounded timeout.
- **Report honestly**: a test that cannot run (for example a missing CLI for a
  manual check) is reported as not run, never as passed.

## CI/CD Integration

`.github/workflows/ci.yaml` runs `npm ci`, `npm run typecheck`, `npm test` and
`npm run build` on `ubuntu-latest`, `windows-latest` and `macos-15-intel` with Node 24 for every
pull request and every push to `main`.

The same CI builds all Standard Preview architecture/format combinations as
unsigned candidates and checks the complete asset metadata, source bundle and
checksums. Candidate identity disables updates. Publication is a separate manual
workflow documented in [deployment.md](deployment.md).

The signed macOS release job routes Apple's ticket requests over TCP before
packaging to avoid the hosted runner's HTTP/3 failure. Candidate CI has no signing
credentials and does not exercise that workaround. Only a signed release run
passing codesign, Gatekeeper and stapled-ticket validation establishes that path;
YAML checks and unsigned candidate packages do not.

`tests/shell/updates.test.ts` covers native-operation timeout fencing, completion
identity, explicit consent, Settings main-frame ownership, drain order, multiple
Bots, crashed/PID-reused installation leases and uncertain handoff recovery.
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

---

*Last updated: 2026-10-29*
