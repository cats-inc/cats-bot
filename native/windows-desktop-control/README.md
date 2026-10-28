# Windows desktop control helper

`cats-desktop-control-windows.exe` is the native executor behind the Bot's `cats-desktop`
session MCP ([SPEC-006](../../docs/specs/SPEC-006-desktop-control-session-mcp.md) BDC-11,
[PLAN-006](../../docs/plans/PLAN-006-desktop-control-session-mcp.md)). The Bot core starts it
and speaks protocol 1 over stdio, one JSON object per line. It runs as the user, unelevated and
per-monitor DPI aware.

This is the Bot's own copy. Cats Desktop ships a separate implementation; nothing here is built
from or loaded from Platform. The protocol, the ops and the exclusion lists in `Exclusions.cs`
follow the frozen
[cross-implementation contract](../../../cats-platform/docs/specs/SPEC-133-desktop-control-session-mcp.md#cross-implementation-contract)
of Platform SPEC-133 and must not change on one side only.

Phase A ops only observe: `hello`, `resolve_apps`, `list_windows`, `capture_window` (PrintWindow
with `PW_RENDERFULLCONTENT`, so covering windows never appear), `read_ui` (UI Automation through
its COM client; password values are never read), `open_app`, `state` and `cancel`. The Bot's own
processes and executables, and Cats Desktop's (BDC-08), are excluded at runtime through
`hello.selfProcessIds` and `hello.selfExecutables`; the helper always excludes itself.

Phase B ops send input: `click`, `scroll`, `type`, `key`, `invoke`, `clipboard_read` and
`clipboard_write`. Each re-checks its target first (owner idle for 3 seconds, not observe-only
or elevated, in front, unmoved, uncovered) and `cancel` stops typing between chunks; SPEC-133
"Phase B helper rules" has the details. Ops run one at a time in arrival order, except
`cancel`, which is answered at once.

Build: `dotnet build -c Release` (.NET 8 SDK or newer, Windows only). Windows packages publish
it self-contained per architecture through `scripts/windows-desktop-control.mjs`, which
`npm run dist:win`, `npm run dist:dir` and `scripts/build-preview.mjs` call before
electron-builder; the package carries it at `resources/native/windows-desktop-control/` with the
.NET runtime's license texts under `licenses/`. electron-builder signs it with the installer when
Windows signing credentials exist (ADR-004).

Native checks (Windows only): `node native-check/check.mjs` opens two throwaway windows, checks
capture under a covering window (B4), UI reading and exclusions, and closes them; it never sends
keyboard or mouse input. `node native-check/input-check.mjs` sends real input (B7), but only to
its own probe app (`native-check/probe/`, built on first use and never packaged), and waits for 5
quiet seconds from the owner before each action. macOS and Linux CI never build or start this
helper.
