# Avatar quick menu: focus, outside clicks and click counts

Date: 2026-11-16. Scope: Electron 41.2.0 on Windows 11 with native `SendInput`
input, one display at scale 1. macOS and Linux are covered by API contract only.
Evidence for [ADR-027](../decisions/027-open-the-floating-cats-quick-menu-in-its-own-focusable-window.md).

## Question

A single click on the floating Cat should open a menu beside it, which closes
when the owner clicks the Cat again or focus goes anywhere else. The Cat's window
is unfocusable and click-through, so it never sees focus leave. The
[avatar menu findings](2026-11-02-avatar-menu-focus.md) show that an outside click
dismisses only a menu whose owner has focus. They also name the temporary focus
toggle on the avatar as a candidate cause of the virtual-desktop cloak.

This spike tested whether a separate focusable window can carry the menu
instead, and whether the Cat's page can tell a single click from a double click.

## Spike

The spike used diagnostic windows only:

- **Cat:** a window configured as `FloatingBot` configures it (transparent,
  `focusable: false`, `setIgnoreMouseEvents(true, { forward: true })` reset after
  load), with the same hit-test and pointer-capture code as `floating.ts`.
- **Menu:** a window created 300 ms after a single click, then `show()` and
  `focus()`.
- **Another app:** an ordinary window of a separate process, which also sat
  behind the Cat.

Results:

- **Focus:** the menu window became the foreground window (`GetForegroundWindow`).
  This held when the desktop had been in the foreground and also when the other
  process's window had been.
- **Click on the Cat:** a click on the Cat while the menu was open did not blur
  the menu. The Cat's window does not activate, so the shell must close the menu
  itself, and no blur-then-reopen race arises on Windows.
- **Click elsewhere:** a click on the other process's window blurred the menu.
- **Menu input:** the first click on a menu item reached its page, and so did
  Escape.
- **Click counts:**
  - `click.detail` went from 1 to 2 for second clicks 90 ms and 350 ms after the
    first, and `dblclick` fired. Clicks 700 ms apart counted as two single clicks,
    matching the 500 ms Windows default.
  - Pointer events report `detail` 0.
  - Click counting worked alongside the existing pointer-capture drag code.

Pitfalls for native fixtures:

- Electron forwards moves to a click-through window from a low-level mouse hook
  on the main thread. A fixture that runs a synchronous child process (for example
  `execFileSync` of an input helper) blocks that thread, so the hook misses the
  injected moves. The Cat then never takes the mouse. Use asynchronous child
  processes. `docs/testing.md` already warns that `SetCursorPos` bypasses the hook.
- A click the Cat does not take falls through to whatever is under it. In the
  first attempt such a click reached the desktop. Later runs put a window of a
  separate fixture process behind the Cat. They also refused any click whose
  target window did not belong to a fixture process.
- The owner saw several Electron "JavaScript error" dialogs during these runs.
  Their text was not captured, because the runs' output was filtered. A fixture
  should handle `uncaughtException` and `unhandledRejection` itself and keep its
  full output, so no modal dialog is left on the owner's desktop. It should also
  check the owner's last input before every run, not only the first.

## Implementation acceptance

The second fixture ran the built `FloatingBot`, `QuickMenuWindow` and
`quickMenuItems` with a disposable bot, the fake Runtime and zh-TW labels. Input
went through the same guarded helper. All 14 checks passed:

1. A single click opened the menu about 310 ms later.
2. The items were 私訊, then the note with a message, then the next three notes.
   A long title was cut short with an ellipsis. With five notes, no New
   conversation item appeared.
3. The menu window did not cover the Cat.
4. The menu window had focus.
5. A click on the Cat closed the menu at once.
6. That click neither reopened the menu nor opened the direct message.
7. A click on another process's window closed the menu.
8. Choosing an item reported that note and closed the menu.
9. A 90 ms double click opened the direct message only.
10. A 400 ms double click opened the menu, then closed it and opened the
    direct message.
11. Escape closed the menu.
12. A reply bubble was shown.
13. That bubble was put away when the menu opened.
14. With the preference off, a single click opened the direct message without
    the wait.

The first run also found a defect. Closing the menu while its page loaded
rejected `loadURL`, and that error reached the IPC handler. `QuickMenuWindow` now
ignores a load stopped by its own close, and the rerun passed.

This session had reduced motion on, so the items faded in. With
`prefers-reduced-motion: no-preference` emulated through CDP, frozen animation
frames at 30, 90, 150 and 400 ms showed the turn-out from the head. Each item
started small and turned, the first item led, and the arc settled in place.

## Not verified

- **macOS:** whether `app.focus({ steal: true })` plus `focus()` makes the menu
  key after a click on a non-activating Cat. Also unverified: that blur follows an
  outside click there, and Spaces and full-screen apps.
- **Linux:** the native-menu path has not been run.
- **Displays:** several displays, mixed or fractional scale factors, and Windows
  virtual desktops while the menu is open.
- **The hub's wiring:** the fixture registered its own `floating:*` and
  `quickMenu:*` handlers, so the hub's handlers in `main.ts` were not run. That
  includes opening a chosen note, New conversation and the switch's channel.
  Type checks and the channel tests in `tests/shell/bridge.test.ts` cover them.
  Both fixtures were throwaway scripts and are not in the repository.
- **Settings and packaging:** the packaged app, and the Cats Bot Settings switch
  on screen.

## Primary sources

- [Electron 41.2.0 BrowserWindow](https://github.com/electron/electron/blob/v41.2.0/docs/api/browser-window.md): `focus`, `blur`, `show`, `setIgnoreMouseEvents` with `forward`.
- [Electron 41.2.0 app](https://github.com/electron/electron/blob/v41.2.0/docs/api/app.md): `app.focus({ steal })` on macOS.
- [UI Events: `detail` of click events](https://w3c.github.io/uievents/#dom-uievent-detail): the click count.
- [Media Queries 5: `prefers-reduced-motion`](https://drafts.csswg.org/mediaqueries-5/#prefers-reduced-motion).
