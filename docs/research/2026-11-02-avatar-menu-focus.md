# Avatar menu focus and outside-click dismissal

Date: 2026-11-02. Scope: Electron 41.2.0, Windows native input; macOS API contract.

## Reproduction

After PR #102, source commit `54d1104`, an isolated instance of the real
`FloatingBot` and `popupMenu` reproduced the Windows defect. CDP confirmed the
real avatar page and preload bridge. A native Windows right-click opened its
menu while another process's window remained foreground. That window received a
subsequent native left-click, but the menu stayed visible and emitted no close
event. It also remained open past 30 seconds: #102's catcher and expiry apply
only to X11 windows under Wayland.

In the same isolated fixture, making the owner focusable and focusing it before
opening the menu made the same outside click dismiss it. Restoring the original
unfocusable-owner behavior reproduced the defect again. Native menu presence was
checked through UI Automation and screen captures, not renderer screenshots alone.

## Implementation

On Windows/macOS, normally unfocusable owners temporarily become focusable and
receive focus for the popup. A menu close event or callback restores them. Hiding
the owner cancels the popup; destruction removes listeners without native calls.
Opening another popup cancels the old one before acquiring focus, and late old
callbacks cannot restore the next popup's owner. Failure to open also restores
the owner. Owners that were already focusable and Linux menus retain their paths.

Cleanup blurs the owner only if it still has focus. Electron documents that on
macOS making a window unfocusable does not remove existing focus. Cleanup does
not explicitly focus another window or refocus over a menu action's newly opened view.
No public API, configuration or stored-data format changes; no migration or
compatibility version boundary is required.

## Validation boundary

Windows native acceptance of the final implementation is recorded with the
checks in `docs/testing.md`. Unit tests run against controllable owners/menus and
cover cleanup ordering and failures. They do not emulate the OS's menu behavior.
macOS has no native acceptance in this Windows session. Its explicit blur follows
the API contract; actual menu dismissal, item actions and avatar ordering there
still need a native Mac check. Linux's catcher/input-shape path is unchanged.

## Windows virtual-desktop recovery (2026-11-04)

In the installed Bot 0.5.0 / Electron 41.2.0, opening the avatar's menu and
switching Windows virtual desktops left its native window Shell-cloaked
(`DWMWA_CLOAKED=2`). The Hub and core stayed alive, CDP remained responsive and
the avatar's coordinates were unchanged. Neither desktop showed the avatar after
switching back. Moving it to the center and hiding/showing it did not clear the
cloak. Closing and recreating only the avatar window restored it (`cloaked=0`),
with the core and conversations still running.

The Hub therefore offers **Arrange all floating cats**, directly below **Show
floating cats**. It recreates all running avatars, including hidden ones, and
saves a row-wrapped layout in the pointer monitor's work area. It is an explicit
recovery action, not a fix for the virtual-desktop trigger. Electron's Windows
`SetFocusable` also changes taskbar registration, making the popup's focus
transition a candidate cause; this has not been isolated by a controlled comparison.

The isolated native arrangement fixture checks replacement windows, saved
positions, repeated reset/hide requests and preservation of other windows. It
does not reproduce Shell cloaking or prove the root cause. The live installed
recovery above and the source fixture establish different validation boundaries.

## Primary sources

- [Electron 41.2.0 menu API](https://github.com/electron/electron/blob/v41.2.0/docs/api/menu.md): popup owner, callback and close event.
- [Electron 41.2.0 BaseWindow API](https://github.com/electron/electron/blob/v41.2.0/docs/api/base-window.md): focusability and the macOS focus caveat.
- [Electron 41.2.0 macOS native window](https://github.com/electron/electron/blob/v41.2.0/shell/browser/native_window_mac.mm): focus and window-order behavior.
- [Electron 41.2.0 Views native window](https://github.com/electron/electron/blob/v41.2.0/shell/browser/native_window_views.cc): Windows focusability and taskbar registration.
- [Microsoft DWMWINDOWATTRIBUTE](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute): `DWM_CLOAKED_SHELL` is the Shell's cloak flag, separate from window visibility.
