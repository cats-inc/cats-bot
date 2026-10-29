# ADR-002: Give the Bot a Desktop Presence in the Electron Shell

## Status

Accepted — 2026-10-28. After trying the PLAN-001 result, the owner pointed out that it had only one
note that could chat: no settings page to choose a model, no first run, no floating bot, no note
management, no wallpaper/desktop/topmost layers, and the installer could not be used directly. The
owner asked for all of this to be completed. This ADR replaces the PLAN-001 Phase 5 arrangement
"needs a new ADR, not scheduled in this plan".
See [SPEC-002](../specs/SPEC-002-desktop-presence-settings-and-first-run.md) for the specification and
[PLAN-002](../plans/PLAN-002-desktop-presence.md) for the implementation.
Pending (2026-10-29): under [ADR-008](008-run-every-bot-as-a-headless-core-under-one-hub.md) the settings
page, first run and floating Cat (§2–§4) are hosted by one hub per fleet once PLAN-009 lands.

## Context

- ADR-001 left the desktop layer, character appearance and the cross-platform native host to a
  separate ADR, because every claimed platform needs native acceptance evidence.
- The shell delivered by PLAN-001 had only the tray, the note and a CLI. `updateProfile` had IPC, but
  no screen called it. The packaged installer had no first-time setup, and starting it without
  `--provider` only showed an error.
- desktop-work-fleet has proven three layers on a real Windows machine: wallpaper (Explorer's
  WorkerW, below the icons), desktop (above the desktop window that hosts `SHELLDLL_DefView`, below
  ordinary windows) and floating (topmost). It also recorded two lessons: a child window attached to
  Explorer's desktop window must paint itself (WPF and transparent layered windows do not appear on
  screen, while Chromium's windowed windows do); and the wallpaper layer is below the icons, so it
  receives no clicks.
- The cats-runtime 0.6.1 `GET /providers/{provider}/models` answers only for providers configured in
  `providers.yaml`; an unconfigured provider gets 400 `provider_not_configured`. The runtime package
  itself ships a curated model catalog (`config/curated-model-catalogs.generated.json`).

## Decision

### 1. The shell stays Electron, and the desktop presence is built in the shell

Settings, first run, the floating bot and note management are ordinary Electron windows and need no
native code. On Windows the wallpaper and desktop layers use FFI calls to user32 to attach the note
window under Explorer's desktop window (porting the lookup rules of desktop-work-fleet
`NativeShellLayers.cs`). macOS and Linux provide only "normal" and "topmost" and do not claim a
desktop layer. The fleet's C#/WPF host is not adopted: it would give the bot another native program to
build and sign, and the fleet has already proven that Chromium windows paint correctly inside
Explorer's desktop window.

### 2. The settings page goes through `BotHostApi` and does not touch the runtime

The settings page's provider list, model list, rename and Telegram token are all core commands
(SPEC-002 FR-3–FR-6); the shell still holds no runtime client (the architecture boundary test is
unchanged). Sources of the model list: the bot's current provider is answered by the running runtime
(including local overrides); other providers, and the case before the runtime has started, read the
catalog file shipped with the runtime package. It is read as data, and no runtime code is imported.

### 3. First run is completed in the shell

When a bot with no profile starts, it opens the settings page in first-run mode (name, agent CLI,
model, personality). The bot is created and the core opened only after submission. The command-line
`--provider` is kept for development and scripts.

### 4. The floating bot is a topmost Cat

A small transparent, borderless, topmost window that does not appear in the taskbar. It shows the
bot's state (awake, thinking, asleep, unread), can be dragged, opens the home note on a click, and
its right-click menu is the same as the tray's. A bubble pops up when there is a new reply. It can be
hidden from the tray and from settings.

### 5. Each note chooses its own layer

The layer is part of the note's view state (stored in `shell-state.json`, in the same place as
position and size): `normal`, `top`, `desktop`, `wallpaper`. Explorer's desktop window does not become
the foreground window when its child window is clicked, so the keyboard does not reach a note attached
under it. Therefore a desktop-layer note is temporarily raised to a normal window as soon as it is
clicked (typing and IME work), and put back to its layer after a click elsewhere, the same approach as
desktop-work-fleet ADR-030, which projects the scene being operated to floating. A wallpaper-layer note
takes no input (it is below the icons), and when opened from the tray or settings it is likewise raised
first and put back after use. Dragging in the attached state is handled by Windows through the child
window's title-bar drag, with no need to raise it.

2026-10-28 measured addition: Electron 41 windows are per-monitor v1 (DPI awareness context 0x12),
while Explorer's desktop window is per-monitor v2 (0x22). The fleet requires the two contexts to be
identical; here only the awareness level is compared (both are per-monitor), and display, input and
dragging are correct at 3840×2160 with 150% scaling.

### 6. Installers

The Windows NSIS installer and the portable build are built by CI on every main update outside root `docs/` and uploaded
as Actions artifacts; publishing a GitHub Release still follows the release SOP and owner
authorization.

## Consequences

- It is usable the first time it is opened after installation: the settings page, first run and tray
  are all there.
- The desktop layer depends on Explorer's private behavior (the `0x052C` message and the WorkerW
  structure). When Explorer restarts or the structure changes, the window must be looked up and
  attached again; when it cannot be found, the note falls back to the normal layer and the reason is
  recorded, instead of disappearing.
- The FFI package is the first native dependency; it is loaded only in the Windows shell, and the core
  and the CLI are unaffected (the architecture boundary test is unchanged).

## Alternatives Considered

- **The fleet's C#/WPF/WebView2 host plus a core child process**: all three layers are already
  verified, but it adds a native program and build chain; Chromium windows can be attached by
  themselves, so the benefit is insufficient.
- **Only `setAlwaysOnTop` and sending to the bottom**: cannot produce a wallpaper layer below the
  icons, and does not survive "Show desktop" (Win+D).
- **Writing every provider into `providers.yaml` just for the model list**: the runtime's sample
  configuration notes say the listed CLIs are probed for compatibility during setup, diagnostics and
  execution priming, and CLIs that are not installed would show up in diagnostics; reading the
  catalog shipped with the package is enough.
