# Linux Avatar Black Area and Lost Clicks — 2026-11-02

## Report and environment

The owner reported that the installed 0.4.5 avatar has a broken black area behind it
and blocks clicks. The machine is a Raspberry Pi 5 running labwc 0.20.2 and Xwayland
24.1.6, one 1920×1080 output at scale 1, with Electron 41.2.0. A screen capture of the
running avatar showed the report: black across the 300×230 window except for holes at
the cat and the bubble. Chromium's GPU process exits at startup on this machine
(`GLES3 is unsupported`), so it composites in software.

## Evidence

A standalone fixture used the avatar's window options and Electron version, with no Bot
data. Pixels outside the shape were read through `grim` on the real desktop:

| Case | Compositing | Outside the shape |
|------|-------------|-------------------|
| `setShape` | software (default, or `--disable-gpu`) | black |
| no shape | software | transparent |
| `setShape`, `--use-gl=angle --use-angle=gles` | GPU | transparent |
| no shape, `--use-gl=angle --use-angle=gles` | GPU | transparent |

Clicks went through `wlrctl`'s virtual pointer, so through the compositor, in a private
headless labwc (pixman renderer). A maximized native Wayland window sat behind the avatar:

| Case | Click on the transparent area | Click on the cat | Pixels outside |
|------|-------------------------------|------------------|----------------|
| `setShape` | reaches nothing | avatar | black |
| no shape, no input shape | not the background | avatar | transparent |
| input shape only | background window | avatar | transparent |

The input shape was applied from outside the fixture with `XShapeCombineRectangles`.
The result matches the Xwayland behaviour ADR-014 describes; that mechanism is inferred
from these results and was not traced in Xwayland's source.

## Why the 0.4.5 acceptance passed

The [2026-11-01 note](2026-11-01-linux-input-and-busy-retry.md) recorded transparent
click-through as passing. That fixture's background was an X11 window and its click came
from `xdotool`, whose XTEST input reaches the X server directly, so the compositor's
input routing never took part. Its screenshots used `capturePage`, which sees only the
page. `scripts/linux/test-avatar-input.sh` now checks real pointer input over a native
Wayland window and pixels the compositor actually shows.

## Menus that stay open

Under XWayland, a click on a native Wayland window left an open Electron `Menu` in place,
while the click reached that window. This happened with the avatar's unfocusable window
and with an ordinary focusable one. A transparent window over the display, taking the
click into X11, closes it. Whether the menu painted depended on the order, measured in the
same private compositor by reading a pixel inside the menu, over repeated right-clicks:

| Transparent window | Menu painted | Outside click closed it |
|--------------------|--------------|-------------------------|
| shown just before the menu, page loaded | 1/5 | 5/5 |
| shown, then two or three rendered frames awaited | 2/10 each | 10/10 each |
| shown 100 ms before the menu, no page | 8/10 | 10/10 |
| shown 200 ms before the menu, no page | 10/10 | 10/10 |
| shown right after the menu, no page | every time it opened | 9/10 |
| shown 100 ms after the menu, no page | 10/10 | 10/10 |
| shown 250 ms after the menu, no page | 10/10 | 10/10 |

Waiting for rendered frames did not help, so the cause is not simply the window's first
frame; it was not traced further. ADR-014 shows the window 150 ms after the menu, where a
miss leaves today's behaviour rather than an invisible menu. At 150 ms, menu items still
worked, and a focusable owner also passed 6/6. The menu opened within 7–14 ms.

## The implementation

`scripts/linux/test-avatar-input.sh` passed against the built code in a private compositor.
A build from `electron-builder --linux dir` was then started there as a fresh install: the
first run wrote a valid autostart entry and set Start at login on, a real right-click opened
the menu with the transparent window, and a click elsewhere removed both. After the entry was
deleted, the next start left it deleted and the setting off, and a fresh hub adopting an existing
bot left the setting off.

On the owner's real labwc desktop the built avatar code used the session's real Xauthority
cookie, with no logged failure. An outside reader of the window saw a full bounding shape and an
input shape of the cat, and of the cat and bubble while the bubble showed. Terminal text showed
through the transparent area, under software compositing. The menu painted 3 of 3 times, and
with the transparent window up 0.3% of sampled pixels outside the menu had changed.

## Limits

- The tables above come from fixtures. They do not cover other compositors or GPU drivers.
- Real pointer clicks were sent only in the private compositor, which uses pixman and has no
  panel, so as not to move the owner's pointer. A panel above the transparent window may keep
  a click on it from closing a menu. This has not been tried.
- Over 50 real pointer right-clicks whose press and release were almost simultaneous, one menu
  closed within 4 ms of opening, before the transparent window appeared, and an acceptance run
  saw the same at 87 ms. Right-clicks held for 0 to 400 ms through `xdotool` stayed open 90 of 90
  times. The plain menu's 13 openings were too few to tell whether this predates ADR-014.
- Starting from a real sign-in has not been tried, including whether the tray is ready by then.
- With an X11 background in the same headless session, clicks on the cat went to that
  background, with event coordinates that did not match the pointer. This was seen once
  and is not understood: an X11 window under the avatar may still take its clicks.

## Running a private compositor safely

A nested labwc given only `XDG_CONFIG_HOME` still read `/etc/xdg/labwc/environment` and
`autostart`. It rewrote the session's `~/.Xauthority` for its own display, which stopped
new X11 clients from connecting to the live display until the next login, and it started
the desktop's autostart programs. Use `--config-dir` with private `HOME`, `XAUTHORITY` and
`XDG_RUNTIME_DIR`, as the test script does, and compare the session's Xauthority afterwards.
