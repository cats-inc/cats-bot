# ADR-011: Have Explorer Redraw the Wallpaper a Note Leaves

## Status

Accepted — 2026-10-31. Fixes a defect the owner reported on the installed 0.4.0: a direct-message
note moved from the wallpaper layer to the desktop layer and then hidden left a white rectangle on
the (black) wallpaper. Supplements [ADR-002](002-give-the-bot-a-desktop-presence-in-the-electron-shell.md) §1.

## Context

Measured on the owner's machine (Windows 11 23H2, build 22631, classic shell: the icons in a top-level
`WorkerW` holding `SHELLDLL_DefView`, the wallpaper in a sibling `WorkerW` behind it, solid black
background), reading each Explorer window's own content with `PrintWindow(PW_RENDERFULLCONTENT)`:

- The white is in the wallpaper `WorkerW`. The icons host and Progman stay black there; the icons
  host shows the wallpaper host through, so a hole in the wallpaper shows on the desktop layer too.
- Any way a note leaves the wallpaper host whitens the area it covered: hidden while attached,
  moved to the icons host while visible (`setLayer` to desktop), made top-level while visible (the
  lift when the owner opens it). A window still covering the area hides the white until it moves or
  hides. The icons host does not show the problem.
- The wallpaper host erases an uncovered area white and does not draw the wallpaper again by
  itself. `RedrawWindow` with `RDW_INVALIDATE | RDW_ERASE | RDW_ALLCHILDREN`, with or without
  `RDW_UPDATENOW | RDW_FRAME`, on the wallpaper host, the icons host, its list view or Progman,
  changes nothing.
- Explorer's private 0x052C message to Progman, which `shellHosts.ts` already sends while looking for
  the wallpaper host: (13, 0) and (0, 0) leave the white; (13, 1) draws the wallpaper again within
  about 40 ms, whether sent at once after the hide or 50 to 300 ms later, keeps the same host windows
  and does not cover notes still attached to the wallpaper.

desktop-work-fleet met the same white block on 23H2 with a black wallpaper (its ADR-035). It shipped
hide-before-move, `SWP_NOCOPYBITS`, clipping styles and an asynchronous `RedrawWindow` of the parent,
recorded that the redraw was not enough and that the cause was never reproduced, and the owner later
stopped seeing it. The measurements above explain why the redraw cannot work on the wallpaper host;
porting fleet's handling would not fix this defect.

## Decision

- `repaintWallpaper` in `shellHosts.ts` sends 0x052C (13, 1) to Progman, only when a wallpaper host
  is known and alive. It is sent only when a note was attached to the wallpaper host, so a machine
  that never uses the wallpaper layer never receives it.
- The Win32 desktop host asks for it on every way off the wallpaper layer: `attach` to another host,
  `detach` (including a destroyed window), and a new `released(windows)` for windows the shell hid or
  destroyed.
- The note manager reports a note after hiding it, and destroys notes (forget, quit) by hiding all of
  them first, destroying them, then reporting them in one call, so a quit with several wallpaper
  notes sends one request after all of them are gone, before the process exits.
- The request is synchronous with the same bounded `SendMessageTimeout` (abort if hung, 250 ms) as
  discovery. Nothing global changes: no wallpaper setting, registry value or Explorer restart.

## Consequences

### Positive

- Hiding, lifting, deleting or quitting with wallpaper notes leaves the wallpaper intact on the
  measured machine, and the white left by earlier builds is cleared the next time a note leaves the
  wallpaper.
- The decision is a pure function with unit tests; the note manager's reports are tested against a
  recording host.

### Negative

- It relies on undocumented Explorer behaviour, measured on one build. The modern shell (24H2 and
  later, where the wallpaper `WorkerW` is a child of Progman), picture and slideshow wallpapers and
  multiple monitors are unverified; a picture wallpaper could visibly redraw.
- A hung Explorer makes the request time out and the white stays until the next one.
- Moving or resizing an attached wallpaper note (display or scaling changes) is not covered; the shell
  does not move attached notes itself.

### Neutral

- Each request blocks the Electron main thread for about 40 ms.

## Alternatives Considered

### Port fleet's RedrawWindow of the parent

- **Pros**: matches the reference implementation.
- **Cons**: measured to erase the area white again instead of drawing the wallpaper.
- **Why rejected**: it does not fix the defect.

### Re-apply the wallpaper (`SPI_SETDESKWALLPAPER`)

- **Pros**: documented; fleet's owner cleared the white this way by hand.
- **Cons**: changes global desktop state on every hide, and fleet's ADR-035 rejected it for that.
- **Why rejected**: (13, 1) repairs the area without touching settings.

### Paint the wallpaper into the host ourselves (`PaintDesktop`)

- **Pros**: no private message.
- **Cons**: draws into Explorer's window, and user32's wallpaper need not match the shell's per-monitor
  fit modes.
- **Why rejected**: Explorer drawing its own wallpaper is the more faithful result.

## References

- desktop-work-fleet `docs/decisions/035-windows-attached-scene-background-lifecycle.md` and
  `src/native/windows/app/DesktopSurface.cs` at revision fcaa942
- [SPEC-002](../specs/SPEC-002-desktop-presence-settings-and-first-run.md) FR-8
- [Testing](../testing.md), manual acceptance of note layers

---

*Decision made: 2026-10-31*
*Decision makers: product owner (sammykenny2) reported the defect; recorded by Claude*
