# Setup Guide

> How to build, test and run the bot core from a fresh checkout.

## Prerequisites

- Node.js 24 (`.nvmrc`). Tests run `.ts` files directly through Node's type
  stripping, so an older Node cannot run them.
- npm 10 or newer (bundled with Node 24).
- For manual acceptance with a real provider: the provider CLI (for example
  Claude Code or Codex) installed and logged in on this machine. The bot never
  reads the CLI's credential files; setup queries the CLI's status, and agent
  execution runs through cats-runtime.
- For Windows packaging only: the .NET 8 SDK or newer (`dotnet`), which
  publishes the desktop control helper. macOS and Linux never need it.

## Installation

```bash
git clone https://github.com/cats-inc/cats-bot.git
cd cats-bot
npm ci
```

`npm ci` installs the exact `@cats-inc/cats-runtime` version pinned in
`package.json`; the bot starts that package's `cats-runtime` bin as its private
child process. Upgrading the pin is a deliberate change with its own PR and
integration-test run (ADR-001 §1).

## Verify the toolchain

```bash
npm run typecheck   # tsc over src/ and tests/, then over src/renderer/ (DOM, JSX)
npm test            # node --test over tests/**/*.test.ts
npm run build       # tsc -> dist/, then vite build -> dist/renderer/
```

The pages are built, not loaded from the source tree (ADR-003): after
changing anything under `src/renderer/`, run `npm run build` (or just
`npm run build:renderer`) before `npm run shell`.

All three must pass on Windows and on Linux; CI runs them on both.

## Running a bot

The headless entry point is `cats-bot` (`node src/cli/main.ts …` from the
checkout, or `npm run bot -- …` after `npm run build`):

```bash
node src/cli/main.ts init --name Mochi --provider claude --instructions "You are Mochi."
node src/cli/main.ts run                 # foreground; Ctrl+C stops the runtime and the CLI
node src/cli/main.ts say home hello      # to the running bot, or one turn when none runs
node src/cli/main.ts status
node src/cli/main.ts conversations
node src/cli/main.ts schedule add home --in 30 --prompt "remind me to stretch"
node src/cli/main.ts schedule add home --cron "0 9 * * 1-5" --tz Asia/Taipei --prompt "morning check-in"
node src/cli/main.ts schedule list
node src/cli/main.ts approve <workItemId> approve
node src/cli/main.ts heartbeat pause
```

While `run` or the shell holds the instance lock, every other command hands its
request to the running bot through the handoff directory (`open` shows a note,
`quit` stops the instance); without a running instance it applies to the data
root directly (a schedule added that way fires on the next run).

## The tray and conversation windows

Starting without an existing profile or `--provider` opens onboarding. Choose
Codex, Claude, Antigravity, Grok or Muse first. The selected provider's packaged
helper checks installation and provides an install button. Codex first requires
Node/npm and a usable npm installation folder; native providers skip those steps.
Installation and sign-in are reported separately. No other provider is installed.
On Windows, Claude browser/subscription sign-in is checked through the CLI's
read-only `claude auth status --json` command with a 10-second timeout; an API key
also satisfies the existing authentication check. The helper does not read
credential files or expose the command's authentication output. macOS/Linux
native-provider helpers report installation readiness without probing sign-in.
Closing onboarding during a provider check cancels the check and exits without
creating a bot. The New bot window can also close during a check; the hub stays
running. Quit cancels read-only provider checks. An explicitly requested install
and the brief bot-creation step finish before setup closes.

The model and effort lists use Runtime's catalog, matching Desktop. Model controls
are saved for new sessions. The five supported provider names follow Desktop;
choosing Claude runs the Claude Code CLI. Catalog data comes from the pinned
Runtime package or the bot's running Runtime, rather than Desktop's profile.
Cats Bot Settings > General offers Follow system, English and
Traditional Chinese; open conversation windows and the tray update immediately.
Closing a conversation hides it. Avatar visibility/position and conversation
visibility/position/layer survive restart, including an entirely hidden desktop.
Closing a conversation during startup also keeps it hidden: a delayed restore or
page load cannot reopen it. Open it explicitly from the tray or avatar when needed.
Check for Updates in the tray opens a native dialog with the result and available
actions. It does not open Settings.

The UI names the built-in conversation Direct message. Existing `home` CLI
arguments, IDs, persisted roles and owner-assigned titles remain compatible.

On Linux, the shell uses X11 (XWayland on a Wayland desktop) for avatar dragging,
position restoration and transparent input regions. Installations need an X server
or XWayland (`DISPLAY`). The installed launcher supplies `--ozone-platform=x11`;
a direct executable launch on Wayland relaunches once with that flag before
starting any bot. Explicit `--ozone-platform=wayland` remains an advanced override
and does not support these floating-window features. See
[ADR-012](decisions/012-use-xwayland-for-linux-floating-windows.md).

A busy conversation keeps its waiting status and Cancel button through automatic
retries. After eight owner-message attempts, retrying stops and the message stays
in history; wait for the other turn to finish before sending it again. Other
Runtime conflicts show their original reason immediately. This fix does not
automatically replace sessions or replay potentially executed work.

```bash
npm run build
npm run shell -- --provider claude --name Mochi   # first run: creates the first bot, mochi-catsbot
npm run shell                                      # later launches
npm run shell -- --id mochi-catsbot                # later launches, opening that bot's note
```

The shell is the hub (SPEC-008): one Electron process for every bot, with one
tray icon (open direct message, conversations, new conversation, pause
heartbeat, start at login, quit) and one frameless window per conversation.
Each bot runs as a core process of its own (`cats-bot run`, started with the
hub's executable as Node) that the hub reaches over its host channel. Closing a
conversation hides its window; the bots keep running until Quit. A hub that
closes or crashes leaves its cores running, and the next hub reattaches to
them. A core writes its log lines to `<bot root>/logs/core.log`. The same
`CATS_BOT_PROVIDER_*` variables apply.

### Diagnostic logs

The primary desktop hub writes `logs/host.log` below Electron's user-data directory
(Windows default: `%APPDATA%\Cats Bot\logs\host.log`). It records startup/exit,
display topology, window visibility/placement, renderer/GPU exits and core lifecycle
metadata. No crash dumps or uploads are enabled. A program that never starts, or
fails before the primary-instance lock, may leave no host record.

Host and core logs each keep a 256 KiB current file and three backups (`.1` newest).
Existing oversized files are bounded on first use. Records are limited to 16 KiB.
Arbitrary exception messages, titles, URL queries, prompts and credentials are
excluded from new host events; exception summaries retain type/code/stack locations.

Each hub-managed core retains `logs/core-stderr.log` and
`logs/core-stderr.previous.log` in its bot root. It writes independently of the hub.
The previous snapshot holds at most 256 KiB. The core checks the current stderr
file once per second and on orderly exit, saving a bounded tail before truncating
it in place. Bursts or a blocked event loop can exceed this soft threshold;
the next start also bounds stderr left by a killed core. Core stdout is never saved.

Set `CATS_BOT_LOG_LEVEL=debug` in the launch environment for detailed window
movement/resize records. Allowed levels are `trace`, `debug`, `info` (default),
`warn`, `error`; changing it requires restarting the hub. TRACE currently includes
the same events as DEBUG. This works in packaged builds without a debug installer.
See [ADR-013](decisions/013-keep-bounded-production-host-diagnostics.md).

The hub keeps its registry (`bots.json`), preferences (`hub-state.json`) and
locks beside `bots/` in the Cats Bot root. Its first run creates the first bot;
bots that `cats-bot init` made before then are taken in, up to three. While the
hub runs, `cats-bot hub status` lists its bots.
Electron's binary is downloaded by its install script, which `allowScripts`
in `package.json` permits for the pinned version.

## Telegram (optional)

```bash
node src/cli/main.ts telegram set-token <token-from-BotFather>
node src/cli/main.ts telegram enable
node src/cli/main.ts telegram status
```

While the bot runs, the first private chat that writes to it becomes the
owner's chat (send `/start`); only that chat is accepted afterwards. Inbound
messages reach the home conversation; every home reply, including heartbeat
and schedule results, is mirrored back. One bot polls one token; run a bot's
token nowhere else or Telegram answers 409. The CLI stores the token as a
file with owner-only permissions where the platform supports them and says
so; a shell with the OS facility re-stores it encrypted, at once when it is
running and otherwise on its next start. `telegram status` reports how the
stored token is actually protected (`file` or `os`). An update is
acknowledged only after it was accepted, so a failure retries it; the last
accepted update id lives in `telegram-state.json`.

Packaging (Windows): `npm run dist:dir` builds `release/win-unpacked/`,
`npm run dist:win` builds the NSIS installer and the portable executable.
CI builds both, for x64 and arm64, for every main update outside `docs/` and keeps
them in the run's `candidate-windows` artifact. When the push run reuses its merged
pull request's green run, that pull request's run has them. Candidate builds do
not update themselves. The installer is
per-user, needs no administrator, adds Start menu and desktop shortcuts and
starts the app; a bot that was never set up opens the first-run page
(SPEC-002 FR-1). Uninstalling removes Cats Bot's login entries and offers an
unchecked "Remove all user data" box for `~/.catsbot`, `%APPDATA%\Cats Bot` and
the update cache, which never follows links inside them (SPEC-007 FR-9);
installing over a copy, updates included, removes neither. Icons come from `src/renderer/cat.svg` through
`npm run icons` (`scripts/make-icons.mjs`, rendered by Electron itself).
Linux packages use the generated `assets/installer/linux/` icon set at standard
hicolor sizes (16, 24, 32, 48, 64, 128, 256 and 512 pixels). A single 1024-pixel
PNG is not discoverable in standard hicolor themes and leaves the taskbar with a
generic icon. The package's `desktopName` is `cats-bot.desktop` and
`linux.syncDesktopName` keeps the installed launcher filename and
`StartupWMClass` aligned with Electron's desktop identity.
The runtime package ships inside the app and runs with the app's own Node
(`ELECTRON_RUN_AS_NODE=1`); the app is not packed into an asar so the
runtime bin stays a plain file.
Before electron-builder runs, `dist:win` and `dist:dir` publish the desktop
control helper (`native/windows-desktop-control/`, SPEC-006 BDC-11)
self-contained for the host architecture with `dotnet publish`; afterwards they
check that the package carries it at `resources/native/windows-desktop-control/`
for the app's architecture, with the .NET runtime's license texts. Both steps
do nothing on macOS and Linux.

`init` takes `--model`, `--id`, `--cwd` (the CLI's working directory; default is
the bot's own `workspace/`) and `--permission-mode skip|whitelist|default`.
The provider is the CLI's product name as cats-runtime knows it (`claude`,
`codex`, `copilot`, `pi`, …); that CLI must be installed and logged in.

Bot data lives under `~/.catsbot/bots/<bot-id>/`; `CATS_BOT_HOME` moves the
whole `~/.catsbot` root (`docs/services.md`). Cats Desktop's `~/.cats` is never
used. Never point a test or an experiment at your real `~/.catsbot`.

For development without a real CLI, three variables (read by `run`, `say` and
`tick` only) point the provider at the scripted fixture instead:

```bash
CATS_BOT_PROVIDER_COMMAND=node                      # the interpreter, spawned directly
CATS_BOT_PROVIDER_LAUNCH_ARGS=tests/support/fixture-cli/claude-fixture.mjs   # one argument per line
CATS_BOT_PROVIDER_PROJECTS_DIR=/tmp/fixture-projects # the discovery directory it would scan
```

The fixture is launched through the runtime's `launch.args`, never through a
`.cmd` wrapper: on Windows that wrapper would go through cmd.exe, which mangles
the quoted `--mcp-config` JSON the runtime passes to the CLI.

## Common Issues

### `node --test` reports a syntax error inside a `.ts` file

Node only strips erasable TypeScript syntax. `enum`, `namespace`, parameter
properties and `import x = require()` are rejected; `tsc` enforces the same
rule through `erasableSyntaxOnly`, so run `npm run typecheck` first.

### Relative imports end in `.ts`

That is intentional: Node resolves the file that exists on disk, and
`rewriteRelativeImportExtensions` makes `tsc` emit `.js` in `dist/`.

---

_Last updated: 2026-10-27_
