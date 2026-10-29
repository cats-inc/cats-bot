# SPEC-002: Desktop Presence, Settings and First Run

## Metadata

| Field                | Value                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Status**           | Accepted — 2026-10-28 together with [ADR-002](../decisions/002-give-the-bot-a-desktop-presence-in-the-electron-shell.md) |
| **Owner**            | Claude                                                                                                                   |
| **Reviewer**         | Owner                                                                                                                    |
| **Related decision** | ADR-002                                                                                                                  |
| **Related plan**     | [PLAN-002](../plans/PLAN-002-desktop-presence.md)                                                                        |

## Summary

An installed Cats Bot can be configured and used the first time it is opened: the first-run page
chooses a name, an agent CLI and a model; the settings window can change the provider, model,
personality, permissions, life rhythm, Telegram and start at login, and manages all notes; a floating
Cat shows the bot's state on top; each note can be placed on the normal, topmost, desktop or wallpaper
layer. The core's behavior is still defined by SPEC-001; this document defines only the shell and the
`BotHostApi` commands it adds.

## Functional Requirements

The owner's 2026-10-29 correction supersedes the original picker and setup details
below: [PLAN-007](../plans/PLAN-007-desktop-experience-parity.md) and
[ADR-006](../decisions/006-share-runtime-catalogs-and-package-provider-setup-helpers.md).
Product text uses Conversation / Direct message. Provider-first setup runs packaged
check/install helpers for the selected provider only; pickers expose the five
approved providers and Runtime model/control entries with no synthetic default or
custom rows. Existing saved targets stay unchanged until explicitly edited.
Language offers System / English / Traditional Chinese. Startup restores each
view's visibility, position and layer, including all hidden; the avatar has no
hover tooltip. Tray Check for Updates uses a native result/action dialog.

1. FR-1: When a bot with no profile starts, it opens the first-run page (name, agent CLI, model,
   optional personality); after submission it creates the bot and opens the core and the home note;
   closing the page exits the program and leaves no half-built bot. The input is validated again in
   the main process.
2. FR-2: Every change on the settings page goes through `updateProfile`; changes to the provider,
   model, personality and permissions make existing conversations switch to a new session on the next
   turn (with a handoff summary) per SPEC-001 FR-27, and the page tells the owner so; when the
   provider changes, the runtime restarts only after the turn in progress ends.
3. FR-3: `listProviders` lists the CLI providers supported by cats-runtime 0.6.1, each one's default
   command (for example antigravity is `agy`) and whether that command is on PATH; `listModels(provider)`
   asks the running runtime for the bot's current provider and reads the catalog shipped with the
   runtime package in every other case; it can always be left empty (provider default) or given
   another model id. The generated `providers.yaml` uses the provider's default command and no longer
   uses the provider name as the command.
4. FR-4: There is one settings window per bot, opened from the tray ("Settings…", "Manage notes…") and
   from the ⚙ in a note's title bar; the tabs are Bot, Notes, Life, Telegram, App.
5. FR-5: The Notes tab lists all conversations (home first, the rest ordered by last activity), shows
   unread and session state; they can be opened, added, renamed (`renameConversation`, must not be
   empty) and deleted (not home, needs a second confirmation; deleting closes its note window).
6. FR-6: The Telegram tab can save or remove the token (`setTelegramToken`; the token is not returned
   to the page), toggle polling, and shows the protection method, the polling state and the owner chat.
7. FR-7: The floating bot: a transparent, borderless, topmost Cat that does not appear in the taskbar;
   it shows awake/thinking/asleep/unread count; it can be dragged and remembers its position; one click
   opens the home note; right-click gives the same menu as the tray; a short bubble is shown on a new
   reply; it can be hidden from the tray and from settings. The remembered position is reused only if
   at least half of the Cat itself (not the whole transparent window) falls on some screen, otherwise it
   returns to the bottom-right corner of the primary screen; the same check is made when screens are
   added or removed or the scaling changes. Unread follows focus: when a note on the desktop or
   wallpaper layer, or one covered by other windows, is open but not focused, a new reply still counts
   as unread, and is marked as read only when it is focused.
8. FR-8: The layer of each note: `normal`, `top`, `desktop`, `wallpaper`, stored in
   `shell-state.json`; on Windows `desktop` and `wallpaper` are attached under Explorer's desktop
   window (lookup rules as in desktop-work-fleet `NativeShellLayers`), re-attached after an Explorer
   restart; when it cannot be found it falls back to `normal` and the reason is recorded, and while a
   note needs that layer it is looked for again at most every 10 seconds (Explorer may create the
   container a little later); other platforms provide only `normal` and `top`. Dragging works on every
   layer; the wallpaper layer takes no input. A desktop-layer note temporarily becomes an ordinary
   window when clicked so that it can be typed into (including IME), and returns to its layer after it
   loses focus. When the owner opens a desktop- or wallpaper-layer note from the tray, settings or the
   floating bot, it is likewise raised and given focus, whether or not it was attached at the time and
   whether or not a window has been created in this run; only startup restore and the reopen after an
   Explorer restart put it straight back on its layer without taking focus. An old `shell-state.json`
   without `layer` derives it from `alwaysOnTop` (`top` or `normal`), and writing still keeps
   `alwaysOnTop`, so that versions that do not support layers still float a `top` note on top as
   before.
9. FR-9: CI builds the Windows NSIS installer and portable build on every main update and uploads them
   as artifacts; starting from the shortcut after installation enters FR-1 or the existing bot.

## Acceptance

- A1: Start the packaged build in a brand-new folder: the first-run page appears, and after
  submission the home note opens and can chat (once with the fixture CLI and once with a real CLI).
- A2: After changing the model on the settings page, the next turn uses the new model; adding,
  renaming and deleting in the Notes tab are all reflected in the tray and the note windows.
- A3: The floating bot is above other applications, can be dragged, and its position is unchanged
  after reopening; it shows thinking while a turn is in progress.
- A4: On Windows, after a note is switched to the desktop layer, it is still there after Win+D and can
  still be typed into; after switching to the wallpaper layer it is below the icons; after Explorer
  restarts it returns to its layer.

## Non-Goals

- Desktop and wallpaper layers on macOS and Linux.
- Code signing, automatic update and GitHub Release publishing (authorized separately per the release
  SOP).
