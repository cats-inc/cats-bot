# PLAN-002: Desktop Presence

## Metadata

| Field | Value |
|-------|-------|
| **Status** | In progress — the owner asked for the missing parts on 2026-10-28 |
| **Owner** | Claude |
| **Related spec** | [SPEC-002](../specs/SPEC-002-desktop-presence-settings-and-first-run.md) |
| **Related decision** | [ADR-002](../decisions/002-give-the-bot-a-desktop-presence-in-the-electron-shell.md) |

## Overview

One PR per slice, merged automatically once CI is green. The order follows "can the owner try it":
first make it configurable and usable after installation, then add the floating bot, then deliver the
installer, and last the desktop layers that need native calls.

## Implementation Phases

### Slice 1: Settings and first run (SPEC-002 FR-1–FR-6)

- [x] core: `listProviders`, `listModels`, `renameConversation`; `providerModels` in the runtime
      client; `providers.yaml` uses each provider's default command.
- [x] shell: first-run page, settings window (Bot, Notes, Life, Telegram, App), the tray's "Manage notes…"
      and "Settings…", and the ⚙ in the note's title bar.
- [x] tests: providers and catalog, PATH detection, runtime answer and fallback, rename, first-run
      input validation, tray menu.

### Slice 2: Floating bot (FR-7)

- [x] Transparent topmost window, state, dragging and position, click and right-click, bubble, show/hide
      (the tray's "Show floating cat" and the settings App tab).

### Slice 3: Installer (FR-9)

- [x] Application icons (`npm run icons` generates the installer, window and tray icons from `cat.svg`);
      the `Package` workflow builds the Windows installer and portable build on every main update and
      uploads the artifact; the installer creates Start menu and desktop shortcuts and launches the app
      after installation.

### Slice 4: Note layers (FR-8)

- [x] Windows: koffi 2.16.3 calls user32 (`win32Desktop.ts`), porting the fleet's WorkerW/DefView lookup
      (`shellHosts.ts`, tested with a fake window tree), attaching, raising when clicked, putting back
      on blur, reopening after an Explorer restart and periodic re-attachment; the layer menu in the
      note's title bar and the layer choice in the settings Notes tab; other platforms have only normal
      and topmost; packaging includes only koffi's win32_x64.

## Testing Strategy

- The Electron-free parts of the core and the shell use `node:test`.
- The shell is started with `--remote-debugging-port`, operated through CDP with screenshots (manual
  acceptance in docs/testing.md); the desktop layers are additionally checked on a real Windows machine
  with desktop-ui-automation.

## Progress Log

| Date | Update |
|------|--------|
| 2026-10-28 | All 7 Codex review comments on #14, #15, #17 and #18 are fixed (#19–#22): when the provider is switched quickly on the settings page and the first-run page, only the latest model list is used, saving is blocked while loading, and switching back to the original provider preselects the saved model; desktop/wallpaper notes opened by the owner are always raised and given focus (including reopening after hiding, and when no window has yet been created in this run), and only startup restore and the reopen after an Explorer restart put them straight back on their layer; when a required Explorer container is absent it is looked for again at most every 10 seconds; the floating Cat's position is judged by whether the Cat itself can be grabbed and is rechecked when the screens change; unread now looks at focus rather than whether a window exists; services.md corrects the isolation scope of discovery. The old and fixed versions were compared on a real Windows machine (only CDP and read-only window queries, no injected input): the model menu reproduced the bug in 8/8 rounds before and was correct in 8/8 rounds after; a desktop note reopened after hiding was re-attached after 7 seconds in the old version and stays raised after the fix; the first wallpaper note opened after a restart went straight back to the wallpaper in the old version and is raised and takes the foreground after the fix; when a background desktop note received a reply, unread was 1 and the floating Cat showed 1, and both reset to zero after opening. Not verified: actually removing a screen, and Explorer creating the container late (covered by unit tests) |
| 2026-10-28 | Slice 4: first verified with a standalone small Electron program that an Electron window attached to Explorer's desktop window can display and be dragged; also found that clicking an attached child window does not make it the foreground window (the keyboard stays in the original window), so it is now raised to a normal window when clicked and put back on blur. Real-machine acceptance (3840×2160, 150%, injected mouse and keyboard, foreground window confirmed before typing): after setting the desktop layer the parent window was Explorer's icon host, clicking the input raised it and made it the foreground, typing and Enter sent and a reply was received, clicking the desktop put it back, dragging the title bar while attached moved it and the position was written back; the wallpaper layer is attached under WorkerW, raised when opened from settings, and returned to the wallpaper on blur; after reopening it re-attached according to the saved layer; with Win+D showing the desktop the desktop-layer note was still there, and pressing Win+D again restored all windows. Fixes: the Electron window and Explorer have different DPI contexts (v1 vs v2), so the awareness level is compared instead; switching from one layer to another while attached requires re-attaching. Not verified: actually restarting Explorer (it would interrupt the owner's desktop, so it was not done), multiple monitors and monitors with different scaling |
| 2026-10-28 | Slice 3: the icon is now a Cat face (installer, window, tray 1x/2x); build resources moved from `assets/build` to `assets/installer`, because `build/` in `.gitignore` swallows the former; the `Package` workflow runs only on main and on manual trigger and is not a required check |
| 2026-10-28 | Slice 2: the floating Cat was accepted on a real Windows machine (3840×2160, 150%) with injected mouse events: the transparent window overlays other windows, shows thinking during a turn, shows replies as a bubble with an unread count when the home note has no focus, after dragging the position is written to `shell-state.json` and does not change after reopening, one click opens the home note, right-click is the tray menu, and clicks on transparent areas pass through to what is below. Fixes: at 150% scaling Electron's `setPosition` grew the window by one pixel each time, so the fixed-size `setBounds` is used; when toggling mouse ignoring Chromium immediately reported mouseleave, so a hit test on every mouse move now decides whether to accept input; `SetCursorPos` does not go through the low-level hook Electron uses to forward mouse moves, so acceptance must use injected moves |
| 2026-10-28 | Slice 1: the first-run page and settings window were walked through in the real shell with the fixture CLI: create the bot, chat in the home note, after changing the model and saving the conversation is marked to switch session on the next turn, add/rename/delete notes (deleting also closes the window), Life/Telegram/App tabs. Fix: the command names of antigravity, cursor and kiro differ from their provider names, and `providers.yaml` used to call the wrong command |
