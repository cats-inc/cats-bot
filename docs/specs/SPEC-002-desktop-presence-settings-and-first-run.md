# SPEC-002: Desktop Presence, Settings and First Run

## Metadata

| Field                | Value                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Status**           | Accepted — 2026-10-28 together with [ADR-002](../decisions/002-give-the-bot-a-desktop-presence-in-the-electron-shell.md) |
| **Owner**            | Claude                                                                                                                   |
| **Reviewer**         | Owner                                                                                                                    |
| **Related decision** | ADR-002                                                                                                                  |
| **Related plan**     | [PLAN-002](../plans/PLAN-002-desktop-presence.md)                                                                        |
| **Pending change**   | [SPEC-008](SPEC-008-hub-and-bots.md) moves first run (FR-1), settings (FR-4) and the floating bot (FR-7) into one hub (PLAN-009) |
| **Changed by**       | [SPEC-010](SPEC-010-setup-wizard.md) replaces the first-run page (FR-1) with a wizard, and `setup:providers` no longer scans PATH (FR-3) (PLAN-011); [ADR-027](../decisions/027-open-the-floating-cats-quick-menu-in-its-own-focusable-window.md) adds the floating Cat's quick menu (FR-7a); [ADR-030](../decisions/030-split-a-cat-bots-settings-into-the-wizards-pages-and-ask-two-questions-about-permissions.md) splits the Bot tab into three pages with one save bar (FR-2 to FR-4) |

## Summary

An installed Cats Bot can be configured and used the first time it is opened: the first-run page
chooses a name, an agent CLI and a model; the settings window can change the provider, model,
personality, permissions, life rhythm and Telegram, and manages all notes; Cats Bot Settings holds
the display language, start at login and updates; a floating
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
hover tooltip. Tray Check for Updates uses a native result/action dialog. On
macOS it comes in front of the active app without revealing a bot window: a
transparent 1x1 window is made key until Cats Bot is active (at most 1 s) and is
destroyed, then the standard parentless alert opens where macOS places it, not
as a sheet. A quit that begins during that wait answers with the dismissal
instead of opening the alert.

1. FR-1: When a bot with no profile starts, it opens the first-run page (name, the Cat's look (SPEC-008 FR-29), agent CLI, model,
   optional personality); after submission it creates the bot and opens the core and the home note;
   closing the page exits the program and leaves no half-built bot. The input is validated again in
   the main process. Under the hub (SPEC-008 FR-4) this is the hub's first run, which also writes the
   registry; Settings → Bots opens the same page for each further bot.
2. FR-2: Every change on the settings page goes through `updateProfile`; changes to the provider,
   model, personality, reply language and permissions make existing conversations switch to a new session on the next
   turn (with a handoff summary) per SPEC-001 FR-27, and the page tells the owner so; when the
   provider changes, the runtime restarts only after the turn in progress ends. A change to the name or
   the Cat's look (SPEC-008 FR-29) keeps every session.
   - Name and look, Provider and model, and Permissions (FR-4) share one save bar (ADR-030, 2026-11-16). It
     appears with the first edit and says before saving what the save will do. A dot in the rail marks a page with
     an edit not saved, and an edit survives a look at another tab.
   - One `updateProfile` carries a provider together with the permissions it allows. An untouched page sends
     nothing.
   - Saving waits for its own fields only, never for a CLI to be installed.
3. FR-3: `listProviders` lists the CLI providers supported by cats-runtime 0.6.1, each one's default
   command (for example antigravity is `agy`) and whether that command is on PATH; `listModels(provider)`
   asks the running runtime for the bot's current provider and reads the catalog shipped with the
   runtime package in every other case; it can always be left empty (provider default) or given
   another model id. The generated `providers.yaml` uses the provider's default command and no longer
   uses the provider name as the command.
4. FR-4: There is one settings window per bot, opened from the floating Cat menu ("Bot settings…", "Manage
   conversations…") and from the ⚙ in a note's title bar, which opens it on the Notes tab like "Manage
   conversations…" (2026-11-14); its tabs are Name and look, Provider and model, Permissions, Notes, Life,
   Telegram and Details (the bot's facts and folder, and the session check), and it reaches only its own bot.
   - The first three follow the setup wizard's order and use its controls (ADR-030, 2026-11-16).
     - Name and look: the name, the look, the personality, the reply language and the floating Cat.
     - Provider and model: the provider cards, the CLI on this computer and its sign-in (SPEC-013 FR-13), the model.
     - Permissions: whether it asks before it acts and what it can reach, as SPEC-001 FR-30 describes, with Claude
       in Chrome and desktop control (SPEC-006 BDC-02) where they apply.
   - Opening the window on `bot`, the tab before 2026-11-16, opens Name and look. The Life tab holds the
   heartbeat switch, its mode and Cats Desktop's daily rhythm (SPEC-011 FR-12). Cats Bot Settings,
   the hub's own window (tray "Settings…"), has General (display language, reply language, start at
   login, version and updates, the data folder) and Bots (SPEC-008 FR-5, FR-18, FR-28; PLAN-010).
5. FR-5: The Notes tab lists all conversations (home first, the rest ordered by last activity), shows
   unread and session state; they can be opened, added, renamed (`renameConversation`, must not be
   empty) and deleted (not home, needs a second confirmation; deleting closes its note window).
   A note added without a name is "Conversation N" until FR-5a names it. A rename is the owner's name,
   which nothing replaces.
   - The list's rows (2026-11-16, ADR-026) are one grid. Every row has the same three controls in the same
     columns, whatever its kind:
     - where the note lives, a menu button with the layer's short name and a glyph of the layers stacked from
       the top of the screen down, the note's own drawn long and amber; the menu names each layer with a line
       under it, and a list too narrow for the names keeps the glyphs;
     - Open;
     - Delete, which the direct message has as Clear (FR-5b).
   - A pencil beside the title renames a conversation; a contact note, which is not renamed (SPEC-012 FR-6),
     has none.
   - Delete and Clear ask in a box under the button that says what goes and what stays; the button keeps its
     size, so a row never changes width or wraps. Escape or Cancel returns to the button.
   - Unread reads "{count} unread".
   - The rail under the bot's name shows its Runtime's state, and under that, on a line of its own that wraps,
     its provider, model and effort as its note header names them (SPEC-003 FR-11).
   - FR-5a (2026-11-16, ADR-025): A note names itself, after Cats Desktop's Catlas titles.
     - When the owner first writes in a note still called what it was made with, the note takes the first
       48 characters of the first owner message, without its files.
     - After the first owner turn completes, the bot names the note from its first message and first reply
       (2,000 characters of each). It does this in a Runtime session of its own: an empty read-only sandbox,
       no MCP servers or tools, closed and deleted at once.
     - The bot is asked at most twice, and its title applies only while the note still has the drafted one.
     - The record keeps `titleSource` (`default`, `draft`, `cat` or `owner`) and `titleAttempts`. A record
       without a source reads "Conversation" or "Conversation N" as `default` and any other note title as
       `owner`.
     - The direct message and contact notes are never named this way.
     - Drafted and named titles never reach the Boss Cat (SPEC-012 FR-3).
   - FR-5b (2026-11-16, ADR-026): The direct message, which is never deleted, is cleared
     (`clearConversation`), after the same confirmation.
     - Its queued work is cancelled, and a turn running in it is cancelled and waited for (at most 20 s), so
       nothing it still writes lands afterwards. While it is cleared, no turn starts and the owner's message
       to it is refused.
     - Its transcript and presentations go. The record keeps its id, name, layer, desktop control switch and
       schedules, loses its session, unread count, message times and handoff checkpoint, and records
       `cleared` (`at`, and the `throughSeq` its transcript had reached). Its transcript continues after that
       `seq`.
     - Its work from before `at` is no longer the conversation's. The note window and the status board
       (SPEC-012 FR-1) leave it out, but it stays in the journal under its id, so a message accepted once
       stays accepted once (SPEC-001 FR-26).
     - The journal keeps no prompt or reply of that work (SPEC-001 FR-14).
     - Its sessions are closed and deleted in Runtime: the current one and every one a provider or model
       change replaced (SPEC-001 FR-27). Runtime's delete also removes the provider CLI's own session files
       where it can. A session Runtime keeps is remembered for the next clear.
     - Its next message starts a new session with nothing to hand over.
     - A note window showing it drops what it showed (`conversation.cleared`).
     - Telegram's chat keeps its own copy, and the confirmation says so when Telegram is connected.
     - A Boss Cat reply to a message sent before the clear goes to the contact note (SPEC-009 FR-8).
6. FR-6: The Telegram tab can save or remove the token (`setTelegramToken`; the token is not returned
   to the page), toggle polling, and shows the protection method, the polling state and the owner chat.
7. FR-7: The floating bot: a transparent, borderless, topmost Cat that does not appear in the taskbar
   (one per running bot under the hub, each bound to its bot, drawn in that bot's look, SPEC-008 FR-29);
   it shows awake/thinking/asleep/unread count; it can be dragged and remembers its position; one click
   opens the home note, or, with the quick menu on (FR-7a), a double click does and a single click opens
   the quick menu; right-click opens only that Cat’s menu (FR-7b): its conversations, arranging its
   notes, hiding it, heartbeat, desktop-control Stop and bot settings. It never offers hub settings,
   updates, start at login or Quit.
   On Windows/macOS the Cat takes focus only while its native menu is open, so an
   outside click can dismiss it; closing the menu restores the unfocusable avatar.
   A short bubble is shown on a new reply; it can be hidden from its own menu and from settings.
   The hub tray’s "Show floating cats" restores every running Cat, including hidden ones. The remembered position is reused only if
   at least half of the Cat itself (not the whole transparent window) falls on some screen, otherwise it
   returns to the bottom-right corner of the primary screen; the same check is made when screens are
   added or removed or the scaling changes. Unread follows focus: when a note on the desktop or
   wallpaper layer, or one covered by other windows, is open but not focused, a new reply still counts
   as unread, and is marked as read only when it is focused. Linux uses startup-time
   X11/XWayland selection and bounded avatar input shapes (ADR-012); native Wayland
   does not claim global position restoration or this programmatic drag contract.
   - FR-7a (2026-11-16, ADR-027): The quick menu, on unless Cats Bot Settings turns it off (SPEC-008 FR-32).
     - A single click waits 300 ms for a second. A second click in that time, or any click the system
       counts as the second of a double click, opens the home note. Otherwise the quick menu opens. A
       click on the Cat while the menu is open closes it at once, and dragging the Cat cancels both.
     - The menu lists the direct message first, then up to four notes, latest message first (from either
       side; a note without messages counts from when it was made). Contact notes are left out. With
       fewer than four notes, one New conversation item follows. Each item shows its unread count;
       long titles are cut short.
     - On Windows and macOS the menu is a window of its own beside the Cat. It is on the side with room
       (left first), centred on the Cat's head and kept inside the work area of the display nearest the
       head, without covering the Cat. Its items turn out from the head by a small angle; with reduced
       motion they only fade in. It takes focus while open, and closes when focus goes elsewhere, on
       Escape, on a click beside its items or on the Cat, when an item is chosen, when the Cat moves,
       hides or is captured out of a screenshot, when the displays change, when the menu is turned
       off, or after 60 seconds. The Cat's own window stays unfocusable.
     - On Linux the same items are a native menu at the pointer, with no animation.
     - Opening the menu puts the reply bubble away; a bubble that arrives while it is open waits under it.
   - FR-7b (2026-11-16): The right-click menu, in groups separated by lines:
     - Stop desktop control first while the Cat holds it (SPEC-006 BDC-10). Then the status, with
       the provider and desktop-control requests waiting for the owner right under it.
     - Open direct message, the Conversations submenu, New conversation and Manage conversations….
     - Stack conversation windows, Spread conversation windows, Undo arrangement (only after an
       arrangement) and Hide this cat. The hub tray's Show floating cats brings the Cat back.
     - Pause or Resume own initiative, Stop desktop control while it is on or a request waits, and
       Cat bot settings….
   - Stack and Spread arrange this Cat's open notes on the `normal` or `top` layer that are not
     minimized, maximized or full screen. With none they are greyed out. Desktop and wallpaper notes,
     and closed notes, stay as they are. The order is the quick menu's (FR-7a): the direct message,
     then the latest message first, contact notes included.
     - Stack puts them beside the Cat (left first, as the quick menu), centred on it and kept inside
       the work area of its display. Each note behind sits one title bar (36 px) higher, so every
       title shows and the front note shows whole. Top-layer notes stay in front of the others. A
       stack too tall for the display closes up.
     - Spread puts them in rows across the Cat's display, centred and apart, top-layer notes after
       the others. Rows that do not fit overlap evenly, a later row in front, with each row's titles
       showing.
     - Neither resizes a note, takes the focus or marks anything read. The notes are raised without
       activation and their new places are remembered; the front-to-back order is not, so the next
       click on a note changes it. The Cat is raised again afterwards, so no note covers it.
     - Undo arrangement puts the last arrangement's notes back, closed ones included, kept on a
       display. Moving, resizing, maximizing or minimizing any of them, or putting one on the desktop
       or wallpaper layer, ends it; moves the system makes in the first 400 ms after placing (another
       display's scaling) do not. It undoes one arrangement and does not survive a restart.
8. FR-8: The layer of each note: `normal`, `top`, `desktop`, `wallpaper`, stored in
   `shell-state.json`; on Windows `desktop` and `wallpaper` are attached under Explorer's desktop
   window (lookup rules as in desktop-work-fleet `NativeShellLayers`), re-attached after an Explorer
   restart; when it cannot be found it falls back to `normal` and the reason is recorded, and while a
   note needs that layer it is looked for again at most every 10 seconds (Explorer may create the
   container a little later). On macOS they are window levels (ADR-016): `desktop` above the desktop
   icons and below every application window, `wallpaper` below the icons and above the desktop picture,
   both on every Space and kept in place by Mission Control; Linux provides only `normal` and `top`.
   Dragging works on every layer; the wallpaper layer takes no input. While a note is maximized or full screen (the window system can
   do this, for example on a header double-click), the shell keeps the position and size it restores to, so a note
   that was maximized when the bot quit reopens at its own size. A desktop-layer note temporarily becomes an ordinary
   window when clicked so that it can be typed into (including IME), and returns to its layer after it
   loses focus. When the owner opens a desktop- or wallpaper-layer note from bot settings or the
   floating bot, it is likewise raised and given focus, whether or not it was attached at the time and
   whether or not a window has been created in this run; only startup restore and the reopen after an
   Explorer restart put it straight back on its layer without taking focus. An old `shell-state.json`
   without `layer` derives it from `alwaysOnTop` (`top` or `normal`), and writing still keeps
   `alwaysOnTop`, so that versions that do not support layers still float a `top` note on top as
   before.
9. FR-9: CI builds the Windows NSIS installer and portable build for every main update outside root `docs/` and uploads them
   as artifacts: in the push run, or in the merged pull request's run when the push reuses that run because it tested the same
   tree; starting from the shortcut after installation enters FR-1 or the existing bot.

## Acceptance

- A1: Start the packaged build in a brand-new folder: the first-run page appears, and after
  submission the home note opens and can chat (once with the fixture CLI and once with a real CLI).
- A2: After changing the model on the settings page, the next turn uses the new model; adding,
  renaming and deleting in the Notes tab are all reflected in the tray and the note windows.
- A3: The floating bot is above other applications, can be dragged, and its position is unchanged
  after reopening; it shows thinking while a turn is in progress.
- A4: On Windows, after a note is switched to the desktop layer, it is still there after Win+D and can
  still be typed into; after switching to the wallpaper layer it is below the icons; after Explorer
  restarts it returns to its layer. On macOS, a desktop-layer note is below every application window and
  above the icons, can be dragged and typed into (including IME) after a click, and returns below the
  windows once another window has focus; a wallpaper-layer note is below the icons and takes no input,
  and opening it from the tray or settings raises it until it loses focus.

## Non-Goals

- Desktop and wallpaper layers on Linux.
- Code signing, automatic update and GitHub Release publishing (authorized separately per the release
  SOP).
