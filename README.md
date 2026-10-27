# Cats Bots

Standalone, always-alive desktop bots for the Cats ecosystem: one process per bot,
wrapping an agent CLI through `cats-runtime`.

## Current status

Research and decision phase; there is no runnable code yet and nothing is released.

- The feasibility survey of `cats-runtime` 0.6.2, `cats-platform` 0.11.1 and a
  sticky-note desktop host is in
  [docs/research/2026-10-27-standalone-living-bot-feasibility.md](docs/research/2026-10-27-standalone-living-bot-feasibility.md).
- A second, independent research note by Codex is in
  [docs/research/2026-10-27-resident-bot-architecture-assessment.md](docs/research/2026-10-27-resident-bot-architecture-assessment.md).
- [ADR-001](docs/decisions/001-build-a-resident-bot-core-on-cats-runtime-with-disposable-presentation.md) (proposed) fuses both notes: it decides the
  dependency direction, the resident-core boundary, the conversation and session model and the
  shell roadmap. [SPEC-001](docs/specs/SPEC-001-resident-bot-core-and-global-execution.md) and
  [PLAN-001](docs/plans/PLAN-001-resident-bot-core-foundation.md) are drafts awaiting approval by the owner.

## Direction

Proposed in ADR-001, awaiting approval:

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
| `src/`, `tests/` | Empty until the first implementation plan lands |
| `scripts/` | Skill sync and merged-branch sweep helpers from the bootstrap |

## Development

Requires Node.js 24 (`.nvmrc`). The scripts and dev dependencies in `package.json`
are still the bootstrap template: no install, build or test command has been
verified, and tests should be reported as missing until a runner is chosen.

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
