# ADR-027: Open the Floating Cat's Quick Menu in Its Own Focusable Window

## Status

Accepted — 2026-11-16, at the owner's request:

- A single click on the floating Cat lists the direct message and the bot's recent
  conversations. The menu closes when the Cat is clicked again or focus goes elsewhere.
- A double click still opens the direct message.
- The menu turns out from the Cat's head where the platform allows.
- A single click waits out the double-click time.
- Contact notes are left out, and too few notes leave room for one New conversation item.
- Opening the menu puts the reply bubble away.
- Cats Bot Settings has a switch, on by default, whose off position restores the old single click.

Amends [SPEC-002](../specs/SPEC-002-desktop-presence-settings-and-first-run.md) FR-7 (adds FR-7a) and
[SPEC-008](../specs/SPEC-008-hub-and-bots.md) (adds FR-32). Evidence:
[quick menu findings](../research/2026-11-16-avatar-quick-menu.md).

## Context

- **The Cat's window:** the floating Cat is a 300 × 230 transparent window with the Cat pinned
  bottom-right. It is unfocusable and ignores the mouse except over the Cat and its bubble. One click
  opened the direct message.
- **Dismissal needs focus:** a menu learns of a click elsewhere only through focus. The avatar's native
  menu gives the avatar focus while it is open, and that toggle is a candidate cause of the
  virtual-desktop cloak ([avatar menu findings](../research/2026-11-02-avatar-menu-focus.md)).
- **No room inside the window:** the window has space only up and left of the Cat. Its Linux input
  regions are capped at eight and clamped to the window, and the Cat may stand half off a screen.
- **Linux:** under XWayland, clicks on native Wayland windows never reach X
  ([ADR-014](014-set-linux-avatar-input-through-the-x11-input-shape.md)), so focus cannot tell a window
  of ours about every outside click.
- **No double-click time:** Electron exposes no system double-click time. A click event's count does
  follow the system setting.

## Decision

1. **Single and double click** (`src/renderer/floatingClicks.ts`). With the menu on:
   - A click waits 300 ms.
   - A second click in that time, or any click counted as the second of a double click, opens the
     direct message.
   - A click while the menu is open closes it at once.
   - A drag cancels both.

   300 ms is below the 500 ms Windows default. A slower double click therefore opens the menu, and
   its second click then closes it and opens the direct message. With the menu off, every click opens
   the direct message at once, as before; a page the shell has not yet told counts as off.
2. **Items** (`src/shell/electron/quickMenu.ts`):
   - The direct message comes first, under the owner's name for it if they renamed it.
   - Up to four notes follow, latest message first, from either side; a note without messages counts
     from when it was made. `updatedAt` is not used, since reading or renaming a note changes it.
   - Contact notes are left out. Fewer than four notes adds one New conversation item.
   - Main builds and translates the items. The page receives only labels, unread counts and positions.
   - A choice is an index checked against the menu that is open.
3. **Placement:**
   - The items form a column beside the Cat, on the left if it fits, else the right, else the side with
     more room.
   - The column is centred on the head and kept inside the work area of the display nearest the head.
     It curves slightly round the head.
   - The window never covers the Cat, so the Cat stays clickable, unless the work area is too small
     for the column.
4. **Window (Windows and macOS)** (`src/shell/electron/quickMenuWindow.ts`):
   - Each opening creates a transparent, frameless, topmost (`screen-saver`), skip-taskbar and
     focusable window, which is shown and focused. On macOS `app.focus({ steal: true })` runs first.
   - It closes on any of these:
     - focus leaving (blur);
     - Escape;
     - a click beside the items, which still lands in its window, or on the Cat;
     - choosing an item;
     - the Cat moving, hiding, stepping out of a screenshot or going;
     - a display change;
     - the switch turned off;
     - 60 seconds.
   - A press that itself took focus from an open menu, and so closed it, does not open it again: the
     open request carries the press time, compared with the blur time.
   - The Cat's own window never changes focusability.
5. **Animation:**
   - Pure CSS. Each item turns out from the head (`transform-origin` at the head) through 16–36°,
     growing from 0.45 scale, 35 ms after the one above.
   - `prefers-reduced-motion` reduces this to a fade.
6. **Linux:** the same items are a native menu through `popupMenu`, which keeps the catcher on Wayland.
   There is no custom placement or animation.
7. **Switch:**
   - `floatingQuickMenu` in `hub-state.json`, shown in the General tab of Cats Bot Settings and
     applied to every running Cat at once.
   - A file without it reads as on, and an older version ignores it, so nothing is migrated.
8. **Bubble:** opening the menu hides the reply bubble. A bubble that arrives while the menu is open
   stays hidden until the menu closes; its own 15-second timer keeps running.

## Consequences

### Positive

- An outside click closes the menu without toggling the avatar's focusability.
- The menu is not cut off by the Cat's window and stays on the screen.
- Item choice, placement and click handling are plain modules with unit tests.

### Negative

- With the switch on, a single click waits 300 ms before the menu opens.
- Opening the menu takes focus from the owner's current application, as the right-click menu does.
- Each opening creates a window, which took about 70 ms on the test machine.
- macOS and Linux have no native acceptance yet.

### Neutral

- The right-click menu is unchanged.
- Linux shows a plainer, native menu.

## Alternatives Considered

### Alternative 1: Grow or re-centre the Cat's own window

- **Pros**: One window; the page already has the conversations.
- **Cons**: Changes what a saved position means, the bubble's layout and the Linux input regions.
  It still needs focus to notice outside clicks.
- **Why rejected**: More risk to existing behavior for no gain in dismissal.

### Alternative 2: A native menu on every platform

- **Pros**: The OS keeps it on screen and closes it on outside clicks.
- **Cons**: No placement beside the Cat and no animation. On Windows and macOS it needs the avatar's
  focus toggle.
- **Why rejected**: Kept only for Linux, where a window of ours cannot see every outside click.

### Alternative 3: Open at once and cancel on a double click

- **Pros**: No wait on a single click.
- **Cons**: The menu flashes open on every double click.
- **Why rejected**: The owner chose to wait out the double-click time.

### Alternative 4: Read the system double-click time

- **Pros**: The wait would match each owner's setting.
- **Cons**: Platform code (the Windows registry, `NSEvent.doubleClickInterval`) for something the click
  count already follows.
- **Why rejected**: A fixed wait degrades gracefully: a slow double click still opens the direct message.

## References

- [Quick menu findings](../research/2026-11-16-avatar-quick-menu.md)
- [Avatar menu findings](../research/2026-11-02-avatar-menu-focus.md)
- [ADR-014](014-set-linux-avatar-input-through-the-x11-input-shape.md)
- [SPEC-002](../specs/SPEC-002-desktop-presence-settings-and-first-run.md) FR-7, FR-7a
- [SPEC-008](../specs/SPEC-008-hub-and-bots.md) FR-32

---

*Decision made: 2026-11-16*
*Decision makers: Owner; Claude*
