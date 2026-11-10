# ADR-016: Put macOS Notes on the Desktop and Wallpaper through Window Levels

## Status

Accepted — 2026-11-10, at the owner's request: notes on macOS offered only the normal and
always-on-top layers. This updates [ADR-002](002-give-the-bot-a-desktop-presence-in-the-electron-shell.md)
§1, which gave macOS and Linux only those two layers; its Windows design and §5 stay.
Specified by [SPEC-002](../specs/SPEC-002-desktop-presence-settings-and-first-run.md) FR-8.

## Context

- macOS has no desktop window that other windows can be put inside. What sits under every
  application window is ordered by window level: the desktop picture, then Finder's desktop
  icons, then ordinary windows.
- Electron cannot put a window at those levels. Every `setAlwaysOnTop()` level is at or above an
  ordinary window, and `type: 'desktop'` is fixed when the window is created and takes no input,
  so a note could not be lifted to be typed into.
- Measured on 2026-11-10 with Electron 41.2.0 on macOS (arm64), from a scratch program and then
  through the shell's own `NoteWindows`:
  - `setLevel:` on a note's NSWindow, through koffi and the Objective-C runtime, puts it at
    `CGWindowLevelForKey(kCGDesktopIconWindowLevelKey) + 1`. WindowServer then lists it above
    Finder's desktop icons and below every application window. At
    `CGWindowLevelForKey(kCGDesktopWindowLevelKey) + 1` it is below the icons and above the
    desktop picture.
  - Electron's `setBounds`, `hide`, `show`, `showInactive`, `focus`, `maximize` and `unmaximize`
    keep that level. `setAlwaysOnTop(false)` puts the window back at the normal level.
  - The shell's lift and settle work through these levels unchanged: a desktop note that gets
    focus is at the normal level, and back at its layer's level once another window has focus.
    This held after hiding and reopening it, and across every layer change.
- koffi is already the shell's Windows dependency. Its package carries macOS arm64 and x64
  binaries.

## Decision

1. On macOS, `loadDesktopHost` returns a host (`src/shell/electron/macDesktop.ts`) that implements
   the existing `DesktopHost` contract with window levels:
   - **Attaching** sets the level above the desktop icons (desktop) or above the desktop picture
     (wallpaper). It also sets the collection behaviour to join every Space, stay put in Mission
     Control and leave the window cycle, as the desktop does.
   - A wallpaper note ignores the mouse, so it is display only, as on Windows.
   - **Detaching** restores the level, behaviour and mouse handling the note had as an ordinary
     window.
   - The shell's lift, settle, periodic check and layer changes are shared with Windows.
   - A full-screen note has a Space of its own, so it stays an ordinary window, as if lifted, until it
     leaves full screen and then loses focus.
2. The host reads a note's layer back from its level rather than trusting its own record.
   - The shell does not call `setAlwaysOnTop(false)` on a note the host manages.
   - When the level has been reset anyway, the periodic check attaches the note again.
3. AppKit cannot tell a live NSView from a freed one, so the host messages a window only in a call
   the shell makes about a live `BrowserWindow`. `released` never messages one. There is no
   wallpaper to redraw on macOS (ADR-011 is Windows only).
4. The macOS package keeps koffi's `darwin_arm64` and `darwin_x64` binaries. Both are the same in
   the two architecture builds that make the universal app, so they are listed in `x64ArchFiles`.
   If koffi cannot load, `loadDesktopHost` returns null and the shell offers normal and top, as
   before.
5. Linux is not part of this decision. Its notes keep the normal and top layers until a later ADR
   designs its desktop and wallpaper layers.

## Consequences

### Positive

- macOS notes offer the same four layers as Windows. The same settings, header menu and saved
  `shell-state.json` layer apply, with no data change.
- Nothing is reparented, so macOS has no host to lose and nothing to redraw.

### Negative

- The macOS package grows by koffi's two macOS binaries (about 2.7 MB). They are signed and
  notarized with the app.
- Window levels below ordinary windows are not an Electron API. A future Electron that resets
  levels in more places is caught only by the periodic check, up to 5 seconds later.
- Typing into, dragging and clicking a note at these levels, IME, Show Desktop, Mission Control,
  Spaces, Stage Manager, clicking the wallpaper to reveal the desktop, and the x64 slice need
  native acceptance on a Mac; the measurements above cover levels and focus only.

### Neutral

- A desktop or wallpaper note is on every Space, as the desktop is.
- A note maximized while it is lifted is set back to its layer at its maximized size, as on
  Windows.
