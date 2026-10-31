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

### Hub, cores and Boss Cat (PLAN-009, PLAN-010)

- **Location**: `tests/core/channel.test.ts`, `channelCore.test.ts`,
  `tests/integration/channelRun.test.ts`, `coreProcess.test.ts`,
  `tests/shell/hub.test.ts`, `botManagement.test.ts`, `bossCat.test.ts`,
  `bossCatSafety.test.ts`, `tests/core/botMessages.test.ts`,
  `tests/core/desktopControl.test.ts` (the lease) and
  `tests/architecture-boundaries.test.ts`.
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
  `cats-bot hub boss-cat`. Compare `~/.catsbot`, `%APPDATA%\Cats Bot` and
  the provider folders before and after; nothing may change.
- **Manual, first run through the setup page**: launch without `--provider`,
  with an isolated home whose `.npmrc` names an existing global npm prefix, so
  the page's provider check runs the packaged setup helper as an owner's first
  launch does. The check must report its components, and **Create and start**
  must leave the bot running with its note open. Starting with `--provider`
  skips the page and its helper callbacks; 0.3.0 shipped with a first-run
  error this path would have shown.

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
  creates the bot at once instead of opening the New bot window
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
`npm run build` on `ubuntu-latest`, `windows-latest` and `macos-15-intel` with Node 24 for every
pull request and every push to `main` that changes a path outside root `docs/`.
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
