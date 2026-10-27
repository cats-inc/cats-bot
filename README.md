# Cats Bots

Standalone, always-alive desktop bots for the Cats ecosystem: one process per bot,
wrapping an agent CLI through `cats-runtime`.

## Current status

Research phase; there is no runnable code yet and nothing is released.

- The feasibility survey of `cats-runtime` 0.6.2, `cats-platform` 0.11.1 and a
  sticky-note desktop host is in
  [docs/research/2026-10-27-standalone-living-bot-feasibility.md](docs/research/2026-10-27-standalone-living-bot-feasibility.md).
- The first ADR still has to decide the dependency direction, the mapping between
  notes and runtime sessions, and the shell technology. See the research document's
  open questions.
- This member is not yet registered in the `cats-one` developer workspace manifest.

## Direction

Proposed in the research document, not decided:

- One executable is one bot: a thin shell (tray icon, sticky-note windows) over a
  Node bot core (life loop, event intake, one global provider/model per bot) that
  runs `cats-runtime` as an app-managed child process, which in turn runs the
  provider CLI.
- The bot stays alive: a per-minute tick keeps its session attached, hidden
  heartbeat turns let it decide whether to speak, and events (Telegram, files,
  local webhooks, OS wake) or scheduled wakeups can summon it at any time.
- Each conversation is a sticky note; several notes may sit on the desktop.
  Provider and model are set once per bot, never per conversation.
- The bot depends on `@cats-inc/cats-runtime` over its process + loopback HTTP
  contract. It copies patterns from `cats-platform` but does not import it.

## Relationship to other Cats members

| Member | Role for this project |
| --- | --- |
| `cats-runtime` | Execution engine: provider CLI adapters, sessions, resume, turn streaming, wakeups |
| `cats-platform` | Reference only: companion life loop, Telegram transport and Desktop host patterns |
| `cats-one` | Workspace composition and release policy; registration of this member is pending |

## Layout

| Path | Content |
| --- | --- |
| `docs/research/` | Research notes, starting with the 2026-10-27 feasibility survey |
| `docs/decisions/`, `docs/specs/`, `docs/plans/` | ADR, SPEC and PLAN templates; none written yet |
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
