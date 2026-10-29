# Setup Guide

> How to build, test and run the bot core from a fresh checkout.

## Prerequisites

- Node.js 24 (`.nvmrc`). Tests run `.ts` files directly through Node's type
  stripping, so an older Node cannot run them.
- npm 10 or newer (bundled with Node 24).
- For manual acceptance with a real provider: the provider CLI (for example
  Claude Code or Codex) installed and logged in on this machine. The bot never
  reads the CLI's credential files; it only runs the CLI through cats-runtime.
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

The model and effort lists use Runtime's catalog, matching Desktop. Model controls
are saved for new sessions. Settings > App offers Follow system, English and
Traditional Chinese; open conversation windows and the tray update immediately.
Closing a conversation hides it. Avatar visibility/position and conversation
visibility/position/layer survive restart, including an entirely hidden desktop.
Closing a conversation during startup also keeps it hidden: a delayed restore or
page load cannot reopen it. Open it explicitly from the tray or avatar when needed.
Check for Updates in the tray opens a native dialog with the result and available
actions. It does not open Settings.

The UI names the built-in conversation Direct message. Existing `home` CLI
arguments, IDs, persisted roles and owner-assigned titles remain compatible.

```bash
npm run build
npm run shell -- --provider claude --name Mochi   # first launch initializes the bot
npm run shell -- --id mochi                        # later launches
```

The shell mounts the same core in the Electron main process: a tray icon
(open direct message, conversations, new conversation, pause heartbeat, start at login, quit) and
one frameless window per conversation. Closing a conversation hides its window; the bot
keeps running until Quit. The same `CATS_BOT_PROVIDER_*` variables apply.
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
The `Package` workflow builds both on every main update and keeps them as a
workflow artifact (`cats-bot-windows-<sha>`, 30 days). The installer is
per-user, needs no administrator, adds Start menu and desktop shortcuts and
starts the app; a bot that was never set up opens the first-run page
(SPEC-002 FR-1). Icons come from `src/renderer/cat.svg` through
`npm run icons` (`scripts/make-icons.mjs`, rendered by Electron itself).
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
