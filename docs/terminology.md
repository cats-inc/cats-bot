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
