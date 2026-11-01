# Scripts

Repository maintenance is pinned from cats-one; shared Desktop/Bot mechanisms
are pinned from Platform. `scripts/shared-tools.provenance.json` records the
complete source closure, commits, SHA-256, executable modes and producer licenses.
Each checkout remains independently runnable.

| Task | Command |
| --- | --- |
| Restart installed Bot Hub with CDP | `./scripts/macos/restart-bot-with-cdp.sh` (9223) |
| Restart without CDP | `./scripts/macos/restart-bot-with-cdp.sh --disable` |
| Inspect windows | `node scripts/testing/bot-renderer-cdp.mjs targets` |
| Inspect note/settings | `node scripts/testing/bot-renderer-cdp.mjs info --target note.html` |
| Screenshot/text/eval | Same client commands; `--port`, `--target`, `--out` available |
| Isolated source candidate | `npm run desktop:candidate -- start --root /absolute/new-directory` |
| Candidate status/screenshot/stop | `npm run desktop:candidate -- status --root /absolute/directory` (replace status with screenshot or stop) |
| Verify shared source hashes | `npm run tools:check` |
| Verify provider helper hashes | `node scripts/sync-shared-tools.mjs --manifest assets/setup/provenance.json` |
| Skill sync preview | `./scripts/macos/sync-agent-skills.sh --dry-run` |
| Merged-branch preview | `./scripts/macos/remove-merged-branches.sh --dry-run` |

CDP restart asks the Hub to quit normally, waits, then launches the selected app.
It refuses unrelated occupied ports and active provider child processes unless
`--force`. The Hub stops only its managed cores; external cores stay running.
Restart can interrupt work. CDP exposes the renderer to other local processes.
The inspection client uses loopback only, understands Bot's file pages and
`window.catsBot`, and can select a particular note/settings URL fragment.

Candidates require installed development dependencies, snapshot source edits into
a new directory outside the checkout, build there, and isolate Bot/userData roots.
They never install dependencies or publish. A private authenticated control channel
supports status, screenshot, evidence and graceful stop; it never kills a stored PID.
Use `--dependencies CHECKOUT` for a worktree with dependencies in another matching
checkout, or `--electron EXECUTABLE` for an already installed development Electron.
A candidate initially shows onboarding; no provider or real profile is copied.

Refresh tools explicitly from committed producers:

```sh
node scripts/sync-shared-tools.mjs --refresh \
  --source cats-inc/cats-one=/path/to/cats-one \
  --source cats-inc/cats-platform=/path/to/cats-platform
```

## Standards

Follow `docs/SCRIPT-STANDARDS.md` for naming and documentation rules.

`testing/bot-interaction-acceptance.mjs` exercises real Electron waiting controls
with a fake Runtime and an isolated temporary profile. Its optional `--native-drag`
mode uses Linux `xdotool` input for avatar dragging, click-through and bubbles;
see [the testing guide](../docs/testing.md#shell-tests) before running it.

Use the provider manifest separately to refresh its complete closure from Platform.
Skill sync discovers nested packages, rejects duplicates/links and preserves
unrelated skills even with `--clean`. Windows PowerShell and Linux wrappers expose
the corresponding behavior. Icon artwork/output paths, renderer notice formatting,
release descriptors and signing remain Bot-owned; their underlying mechanisms are
shared. Follow `docs/SCRIPT-STANDARDS.md` for new scripts.
