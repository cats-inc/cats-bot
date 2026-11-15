# Terminology

> Reference checked 2026-09-05. Project conventions and protocol contracts have
> separate responsibilities.

| Term | Meaning |
|------|---------|
| AAIF | Agentic AI Foundation: an open governance home for hosted projects. It is not a wire protocol or a repository-layout certification. |
| AGENTS.md | Markdown guidance for coding agents. It has no required field schema. |
| Agent Skills | Packages containing SKILL.md metadata/instructions and optional scripts, references, and assets. |
| MCP | Model Context Protocol for access to tools, resources, and prompts. Host configuration syntax is separate from protocol messages. |
| A2A | Agent2Agent Protocol for discovery and communication between independent agent systems. |
| A2A AgentSkill | A descriptive capability in an Agent Card, not an executable SKILL.md package. |
| Open Agent Specification | Oracle's declarative agent/workflow representation; distinct from Agent Skills and AGENTS.md. |
| Base | Core template layer copied into every generated project. |
| Flavor | Optional template layer selected for a capability or technology. |
| Preset | A named base-plus-flavors combination. |
| Review copy | A changed upstream template staged as a .bootstrap file for deliberate merging into an existing project. |

## Working folders

Decided by the owner on 2026-11-16 for Cats Bot and Cats Desktop. Filespace, Codespace and Workspace name
one thing, the CLI session's current working directory (`cwd`), as each product surface projects it, each
knowing more of its structure than the last. The zh-TW names share 空間 and avoid 工作區.

| Term | Meaning |
|------|---------|
| Filespace (檔案空間) | The Chat surface's working folder, and the only one Cats Bot has: a plain folder of the owner's files that the cat reads and writes. Cats does not interpret its version control, although the provider CLI may still see a repository there. A bot's is `permissions.cwd`; a new bot's default is `<bot root>/filespace/`, while bots made before 2026-11-16 keep `workspace/` (SPEC-007). |
| Codespace (程式空間) | Cats Desktop's Code surface: one git repository. Cats reads its `.git` first, searching upward from the chosen folder, and offers its branches and a worktree. |
| Workspace (工作空間) | Cats Desktop's Work surface: a folder tree holding any number of codespaces, found by a bounded scan that groups linked worktrees and submodules with their repository. A workspace that is itself a repository holds one codespace; one with none is a filespace. |
| Data folder (資料位置) | Where Cats Bot keeps a bot's own data (`~/.catsbot/bots/<id>`), or all of it (`~/.catsbot`) in Cats Bot Settings; not a working folder. Cats Desktop's counterpart is `~/.cats`. |

## Project Roles

| Role | Responsibility |
|------|----------------|
| Conductor | Coordinate approved work and the project status record |
| Architect | Record system design choices |
| Security Specialist | Review security concerns relevant to the task |
| UX Lead | Guide interface and user experience decisions |
| Specialist | Implement assigned work and update its tests/documentation |

These role names are project conventions, not A2A protocol roles.

## Primary Sources

- [AGENTS.md](https://agents.md)
- [Agent Skills specification](https://agentskills.io/specification)
- [MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28)
- [A2A 1.0.0](https://a2a-protocol.org/v1.0.0/specification/)
- [AAIF: A2A joins](https://aaif.io/blog/a2a-joins-aaif)
- [Open Agent Specification](https://github.com/oracle/agent-spec)
