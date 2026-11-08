# Codex Windows first-run initialization — 2026-11-05

Cats Bot 0.5.3 on a clean Windows machine installed Codex CLI 0.166.0 and
completed login, but the first turn requested `workspace-write / never` and
received `readOnly / never`. Runtime correctly refused to start the turn.
PowerShell's disabled npm `.ps1` shim is separate: `codex.cmd` worked without
changing execution policy.

The [Windows sandbox guide](https://learn.chatgpt.com/docs/windows/windows-sandbox)
describes Codex-owned initialization and sandbox choices. The
[app-server reference](https://learn.chatgpt.com/docs/app-server) exposes
`windowsSandbox/readiness`: `ready`, `notConfigured`, or `updateRequired`.
The actual 0.166.0 `codex sandbox --help` showed only `uninstall`, so Bot does
not depend on a documented `sandbox setup` subcommand that this CLI lacks.
Interactive CLI daemon defaults do not initialize Bot's explicit stdio app-server.

Native checks used separate empty workspaces and private `CODEX_HOME` directories,
without credentials, model turns or sandbox installation. An unset mode reported
`notConfigured`; selected elevated mode reported `updateRequired`; selected
unelevated mode reported `ready`. An MXC preference reported different readiness
under the restricted test account and the normal host account. Bot follows the
public result, rather than guessing from mode names, version or local config.
Readiness does not prove actual turn permissions or every machine policy.

Even an ephemeral `thread/start` in 0.166.0 persisted project trust in a private
test config. Production therefore sends **only** `initialize`, `initialized`
and `windowsSandbox/readiness`. Readiness-only native checks kept all four seeded
config files byte-identical. Runtime retains its actual-session permission guard.

The chosen entry is a fixed `codex` command in Command Prompt after login, from
an owned temporary workspace. Codex handles config, mode selection and UAC.
No terminal lifecycle event counts as success. Following the clean-machine
creation regression reported on 2026-11-08, readiness is advisory: both creation
paths recheck installation but do not reject incomplete or unverified sandbox
setup. Runtime still enforces permissions when a turn actually starts.
The preflight resolves the checked official npm launcher to a native executable
using its Node executable's PE architecture, avoiding PowerShell policy,
Electron/Node architecture mismatches and extra console windows. Standalone
Codex executables run directly. Unsupported launchers remain unverified.
