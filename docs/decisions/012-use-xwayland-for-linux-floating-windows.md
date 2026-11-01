# ADR-012: Use XWayland for Linux Floating Windows

## Status

Accepted — 2026-11-01, implementing the owner's Linux avatar drag fix.

## Context

ADR-002's avatar depends on global window coordinates, restored positions and
transparent input. Native Wayland does not offer the positioning APIs it uses.
Electron's mouse-move forwarding through ignored windows supports Windows and
macOS, so the old Linux avatar never became interactive.

## Decision

Use X11/XWayland for the Linux shell when `DISPLAY` is available. The packaged
launcher supplies `--ozone-platform=x11`. Direct executable launches on an
automatically selected Wayland backend relaunch once with that argument before
starting cores, taking locks or creating windows. Preserve other launch arguments,
including CDP and bot selection, and honor an explicit backend override.
The isolated candidate launcher also supplies X11 at startup, keeping its
control receipt attached to the same process instead of relaunching underneath it.

Linux avatars remain interactive inside validated, renderer-reported shapes for
the cat, bubble and state indicators; input outside these shapes passes through.
Windows and macOS retain their existing mouse forwarding. The renderer bridge
accepts shape updates only from that bot's floating window.

## Consequences

- Avatar drag, clicks and position persistence retain their existing contract.
- Wayland desktops require XWayland; explicit native Wayland is an unsupported
  override for floating-window positioning. No desktop security settings change.
- The core, Runtime, public host commands and persisted data formats are unchanged.
- Backend selection must happen at process startup. Mutating the Ozone switch
  after Electron initializes can mix native window and renderer backends.

## Alternatives Considered

- Native Wayland title-bar drag regions consume the pointer events used for
  single-click activation and do not provide saved global position restoration.
- A compositor-specific native overlay helper adds a separate platform integration
  and packaging boundary; it is unnecessary for the existing XWayland contract.

## References

- [ADR-002](002-give-the-bot-a-desktop-presence-in-the-electron-shell.md)
- [Linux input and retry evidence](../research/2026-11-01-linux-input-and-busy-retry.md)
- [Electron BrowserWindow platform notices](https://www.electronjs.org/docs/latest/api/browser-window#platform-notices)
- [Electron ignored mouse events](https://www.electronjs.org/docs/latest/api/base-window#winsetignoremouseeventsignore-options)
