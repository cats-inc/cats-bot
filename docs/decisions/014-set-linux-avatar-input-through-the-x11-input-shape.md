# ADR-014: Set Linux Avatar Input through the X11 Input Shape

## Status

Accepted — 2026-11-02, amending [ADR-012](012-use-xwayland-for-linux-floating-windows.md)
at the owner's request after the Linux avatar showed black areas and blocked clicks.

## Context

ADR-012 used Electron's `setShape` for the avatar's cat, bubble and state indicators.
On X11 that sets the window's bounding shape, and it has no effect on Wayland input:

- XWayland shows the window's whole buffer. Under software compositing the area
  outside the shape stays black, leaving the visible regions as holes in it.
- XWayland turns only an X11 *input* shape into a Wayland input region. Without one the
  compositor sends every click inside the 300×230 window to the avatar, the X server
  finds no window there, and the click is lost. Only other X11 windows can receive it,
  because the X server routes between them itself.

The original acceptance could not see either defect. It captured the page rather than
the screen, and its click-through check used `xdotool` input over an X11 background.
See the [findings](../research/2026-11-02-linux-avatar-black-area-and-clicks.md).

## Decision

- Linux avatars never call `setShape`. The renderer's validated regions, scaled to
  pixels, become the window's X11 input shape, and nothing clips what the window draws.
- Linux avatars never call `setIgnoreMouseEvents`. It resets the input shape over
  Electron's own X connection, in no fixed order relative to another connection.
- Electron has no API for an input shape, so the hub's shell sends SHAPE's Rectangles
  request itself over one local X connection shared by its avatars, authenticated by
  the session's Xauthority cookie. The cookie is never logged.
- The input shape is sent again after each page load, each `show` and each display
  change. A request can reach the server before the window it names does.
- A failed connection is logged once and retried on the next region. The avatar then
  draws correctly and its whole window takes clicks.
- Under XWayland a menu's X grab never sees a click on a native Wayland window, whichever
  window owns the menu. While a shell menu is open, a transparent, unfocusable window over
  every display takes that click, which closes the menu like any other outside click.
  It appears 150 ms after the menu: mapped with it or just before it, the menu often
  never paints. If it fails, the menu only stays open as it would without it.

## Consequences

### Positive

- The transparent area is transparent under GPU and software compositing alike.
- Clicks outside the visible regions reach native Wayland and X11 windows.
- No native dependency reaches the Linux package.

### Negative

- The shell holds a small X11 protocol client: connection setup, Xauthority parsing,
  `QueryExtension` and one SHAPE request.
- An explicit `--ozone-platform=wayland` has no input regions, so its whole window takes
  clicks. ADR-012 already leaves that override unsupported for floating windows.
- The outside click that closes a menu is consumed, as on most desktops, rather than also
  reaching the window under it.

### Neutral

- Windows and macOS keep their mouse forwarding. Core, Runtime, public host commands and
  persisted data are unchanged.

## Alternatives Considered

### Calling Xlib through koffi

- **Pros**: no protocol code; koffi is already a dependency on Windows.
- **Cons**: Xlib's error handler is process-wide and ends the process by default, and
  a request naming a window the server has not seen yet is an ordinary error here. It
  would also add koffi to the Linux package, which excludes it today.
- **Why rejected**: an avatar input error must never be able to end the hub.

### Forcing GPU compositing with ANGLE flags

- **Pros**: `--use-gl=angle --use-angle=gles` removed the black area on the affected Pi 5.
- **Cons**: it depends on the machine's GPU, and it leaves the bounding shape in place
  without creating an input shape.
- **Why rejected**: it hides one symptom on one machine.

### Resizing the window to fit the cat

- **Pros**: no X11 client; a much smaller area takes clicks.
- **Cons**: the corners still block clicks, the bubble needs its own window or a larger
  bound, and placement and dragging depend on the fixed window size.
- **Why rejected**: it reduces the defect without removing it.

### Other ways to close a menu

- **A short-lived focusable owner window**, closing the menu on blur, segfaulted Electron
  on the affected machine and did not gain focus.
- **Delaying the menu until the transparent window is up** works at about 200 ms, but a
  machine slower than that gets a menu that opens without painting. A menu that stays
  open is the better failure.

## References

- [ADR-012](012-use-xwayland-for-linux-floating-windows.md)
- [Findings](../research/2026-11-02-linux-avatar-black-area-and-clicks.md)
- [X Nonrectangular Window Shape Extension](https://www.x.org/releases/current/doc/xextproto/shape.html)
- [X Window System Protocol](https://www.x.org/releases/current/doc/xproto/x11protocol.html)
