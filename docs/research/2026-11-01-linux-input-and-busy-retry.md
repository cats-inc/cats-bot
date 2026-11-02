# Linux Input and Busy Retry Findings — 2026-11-01

## Sources and boundaries

Electron's [BrowserWindow notices](https://www.electronjs.org/docs/latest/api/browser-window#platform-notices)
document Wayland's positioning limits and recommend XWayland for applications that
need them. The [mouse input API](https://www.electronjs.org/docs/latest/api/base-window#winsetignoremouseeventsignore-options)
limits move forwarding to Windows/macOS; its window shapes provide bounded Linux
drawing and input regions. These primary sources were checked on 2026-11-01.

A live Bot report showed sustained retries after a completed Muse heartbeat. Bot
had collapsed every HTTP 409 into `session_busy`, so the original rejection body
is unavailable and its initial cause remains unproven. The confirmed defects are
unbounded retries, hidden original conflicts and oscillating waiting controls.
No private conversation content or raw logs are included here.

## Implementation and validation

Linux uses startup-time X11 selection and native input shapes (ADR-012). On the
affected ARM64 labwc/Wayland machine with XWayland and Electron 41.2.0, the isolated
acceptance fixture passed real pointer dragging by 100×60 pixels, fixed window
dimensions, transparent click-through and bubble clicks. The actual note renderer
kept its waiting controls stable across the three-second poll and cancelled its
deferred item. The fixture used only a fake Runtime and temporary state.
With terminal work, turn-completed and conversation-updated notifications
deliberately suppressed, authoritative work polling restored the idle controls.
The direct-executable path without an X11 flag also passed: it relaunched once,
selected X11, then completed the same acceptance fixture. Single-click activation
and right-click menu requests passed with native pointer input as well.

An initial attempt to append the X11 switch from main JavaScript produced invalid
native window IDs. Backend initialization had already happened. This is why the
implementation supplies the switch at launch or relaunches before opening a Bot.

Core regressions cover bounded retrying and non-busy conflicts. Independent review
identified late snapshots reviving finished work and cancellation during history
lookup affecting another Runtime turn; regression tests now cover terminal-state
merging and HTTP admission ownership. Waiting errors clear when a send is admitted.
Final local validation passed: 377 Node 24 tests, typecheck and build. Independent
review and follow-up review found no remaining blocking issue after these fixes.

This establishes this machine's XWayland behavior, not native Wayland support or
acceptance on every Linux compositor. The private CDP session remains separate
from the fixture and no test messages were written to the owner's Bot.

Correction, 2026-11-02: the transparent click-through above used an X11 background and
`xdotool`, so it did not exercise compositor input routing. See the
[later findings](2026-11-02-linux-avatar-black-area-and-clicks.md) and ADR-014.
