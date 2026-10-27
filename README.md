# Cats Bots

Standalone, always-alive desktop bots for the Cats ecosystem: one process per bot,
wrapping an agent CLI through `cats-runtime`.

## Current status

PLAN-001 Phases 0 to 3 are in place: the headless bot core and the `cats-bot` CLI run a
provider CLI through a private cats-runtime child, with conversations, transcripts, a work
journal, cancel, resume and restart recovery, and the bot stays alive on its own: a reconcile
tick keeps the home session attached, durable schedules (one-time and cron in an IANA zone)
fire into work items, hidden heartbeat turns let the bot decide whether to speak, and the
bot's own MCP tool server lets the model create schedules and ask the owner. The first
shell is an Electron tray with sticky-note windows that mounts the same core; multi-note
acceptance and Telegram (Phase 4) are next. Nothing is released.

- `npm ci && npm run typecheck && npm test && npm run build` passes on Windows and Linux
  (CI). The suite includes an integration test that starts the real pinned cats-runtime with a
  scripted fixture CLI; see `docs/testing.md`.
- The feasibility survey of `cats-runtime` 0.6.2, `cats-platform` 0.11.1 and a
  sticky-note desktop host is in
  [docs/research/2026-10-27-standalone-living-bot-feasibility.md](docs/research/2026-10-27-standalone-living-bot-feasibility.md).
- A second, independent research note by Codex is in
  [docs/research/2026-10-27-resident-bot-architecture-assessment.md](docs/research/2026-10-27-resident-bot-architecture-assessment.md).
- [ADR-001](docs/decisions/001-build-a-resident-bot-core-on-cats-runtime-with-disposable-presentation.md) (accepted 2026-10-27) fuses both notes: it decides the
  dependency direction, the resident-core boundary, the conversation and session model and the
  shell roadmap. [SPEC-001](docs/specs/SPEC-001-resident-bot-core-and-global-execution.md) is the
  accepted behavioural contract and [PLAN-001](docs/plans/PLAN-001-resident-bot-core-foundation.md)
  the plan being implemented, phase by phase.

## Direction

Decided in ADR-001:

- One executable is one bot instance: a resident Node bot core (profile, conversations,
  work journal, timers, one global provider/model) that runs `cats-runtime` as an
  app-managed child process, which in turn runs the provider CLI. The core runs headless;
  the shell (tray icon, sticky-note windows) is a disposable client of it.
- The bot stays alive: a per-minute reconciliation tick keeps the home conversation session
  attached without calling the model, durable schedules in the bot journal summon it on
  time, hidden heartbeat turns let it decide whether to speak, and events (owner messages,
  later Telegram) reach it at any time.
- Each sticky note shows one conversation with its own session attachment; one home
  conversation is the inbox the bot keeps warm. Provider and model are set once per
  bot, never per conversation.
- The bot depends on `@cats-inc/cats-runtime` over its process + loopback HTTP
  contract. It copies patterns from `cats-platform` but does not import it.

## Relationship to other Cats members

| Member | Role for this project |
| --- | --- |
| `cats-runtime` | Execution engine: provider CLI adapters, sessions, resume, turn streaming, wakeups |
| `cats-platform` | Reference only: companion life loop, Telegram transport and Desktop host patterns |
| `cats-one` | Workspace composition and release policy; this member is registered in its manifest |

## Layout

| Path | Content |
| --- | --- |
| `docs/research/` | Two independent 2026-10-27 research notes (Claude and Codex) |
| `docs/decisions/`, `docs/specs/`, `docs/plans/` | ADR-001, SPEC-001 and PLAN-001 (proposed and draft) plus the templates |
| `src/core/` | The bot core: profile, store, runtime supervisor and client, conversations, queue, `BotCore` |
| `src/cli/` | The headless `cats-bot` entry point |
| `src/shell/electron/`, `assets/` | The Electron tray and sticky-note shell, its preload bridge and renderer page |
| `tests/` | Boundary, unit, fake-runtime core and real-runtime integration tests |
| `scripts/` | Skill sync and merged-branch sweep helpers from the bootstrap |

## Development

Requires Node.js 24 (`.nvmrc`).

```bash
npm ci
npm run typecheck
npm test
npm run build
```

```bash
node src/cli/main.ts init --name Mochi --provider claude --instructions "You are Mochi."
node src/cli/main.ts run            # keeps the bot in the foreground and prints its events
node src/cli/main.ts say home hello # hands the message to the running bot, or runs one turn
node src/cli/main.ts schedule add home --in 30 --prompt "remind me to stretch"
node src/cli/main.ts heartbeat pause
npm run shell -- --provider claude --name Mochi   # the tray and sticky-note shell
```

See `docs/setup-guide.md` and `docs/testing.md`. The `@cats-inc/cats-runtime` dependency is
pinned to an exact version; bumping it is its own PR with an integration-test run.

## Maintenance

### Updating Agent Rules & Templates

This project uses shared coding-agent guidance. From a separate project-bootstrap
checkout, update this child's infrastructure files using the bootstrap updater.
The updater is not copied into this child. Existing originals and pending review
copies are preserved; resolve each proposed change intentionally.

**Windows**
```powershell
.\scripts\windows\Update-Project.ps1 -TargetPath "C:/Path/To/cats-bots"
```

**Linux / macOS**
```bash
bash scripts/linux/update-project.sh --target-path /path/to/cats-bots
```

## License

This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.
