# ADR-005: Give the Bot Owner-Consented Desktop Control

## Status

Accepted — 2026-10-29. The owner asked for desktop control in both Cats Desktop and
Cats Bots, implemented separately in each, and limited to turns the owner starts
locally. This accepts the direction only; implementation is not yet authorized.
Spec: [SPEC-006](../specs/SPEC-006-desktop-control-session-mcp.md). Plan:
[PLAN-006](../plans/PLAN-006-desktop-control-session-mcp.md).

## Context

Runtime launches the Bot's provider CLI as a local process. On Windows, neither Claude
Code nor Codex exposes native computer use to such a session
([Runtime research](../../../cats-runtime/docs/research/2026-10-28-claude-computer-use-remote-devices-gate.md)),
and the Bot's capability snapshot already reports `computer_use` as unavailable. Cats
Desktop solves this with a host-served session MCP under
[Platform ADR-141](../../../cats-platform/docs/decisions/141-host-a-consented-desktop-control-mcp-for-provider-sessions.md),
whose cross-implementation contract lives in
[Platform SPEC-133](../../../cats-platform/docs/specs/SPEC-133-desktop-control-session-mcp.md).

The Bot already has the pieces this needs. Its core serves the `cats-bot` session MCP on
loopback, and Runtime injects it per conversation (SPEC-001 FR-24). SPEC-004 answers
provider `tool_approval` requests from the note and the CLI. Bots must not import Platform,
so the Bot cannot reuse Desktop's implementation.

## Decision

- **Own implementation, shared contract.** The Bot core serves a second session MCP,
  `cats-desktop`, beside `cats-bot`, and runs its own native Windows helper. Nothing is
  imported from Platform. Tool names, schemas, error codes, exclusion categories, and the
  injection, turn, grant and stop rules follow SPEC-133's cross-implementation contract; a
  change to that contract updates both SPECs.
- **Inject only into consented, explicit-policy sessions.** A profile switch (off by
  default) and a per-conversation switch must both be on, and the explicit
  `providerPolicy` must make Runtime report interactive approval for injected MCP tools
  (Runtime SPEC-039). Otherwise injected tools would be pre-approved, so `cats-desktop` is
  not injected.
- **Owner-present turns only.** Tools serve only `owner_message` work items with source
  `owner`, that is, messages the owner sent from the note or the local `cats-bot say`
  command. Heartbeats, schedules, other background work and Telegram messages get
  `not_owner_present`.
- **Grants through the Bot's own surfaces.** App grants are answered in the note or the
  local CLI, never by a provider approval, "allow for this session" or Telegram text.
  Telegram may only notify. The Bot's own windows join the never-grantable list.
- **Visible control and stop.** While the Bot holds control, the tray and the note show it
  with a stop action; the CLI can stop it too. A locked screen pauses every action.
- **Observe before act.** Observation tools ship first. Input tools start only after native
  acceptance of the observation phase, as in SPEC-133.

## Consequences

### Positive

- A Bot can work with the owner's native apps under the same rules as Desktop.
- The Bot stays independent of Platform at build time and at run time.
- Consent reuses SPEC-004's interaction path and the Bot's global gate.

### Negative

- A second native helper to build, sign and maintain, and every contract change must land
  in both repositories.
- New profile fields, grant UI in the note and the CLI, and tray state.

### Neutral

- Background work keeps running as before; it just cannot use desktop tools.
- Desktop and a Bot may each hold grants for the same app in their own sessions.

## Alternatives Considered

### Alternative 1: Share one package with Desktop

- **Pros**: One implementation of the helper and the guards.
- **Cons**: Needs a home both can depend on, either Runtime or a new repository.
- **Why rejected**: The owner chose separate implementations on 2026-10-29.

### Alternative 2: Let background turns use desktop control

- **Pros**: A resident Bot could act on the desktop by itself.
- **Cons**: Approvals would wait with no owner present and hold the global gate;
  pre-granted autonomy needs a stronger audit and stop design.
- **Why rejected**: The owner limited the first version to owner-present turns.

### Alternative 3: Deliver the developer skill into the Bot's sessions

- **Pros**: No new server or helper.
- **Cons**: Approvals show raw PowerShell, the agent can rewrite commands to skip guards,
  and only CLIs with a shell can use it.
- **Why rejected**: Same reasons as Platform ADR-141.

## References

- [Platform ADR-141](../../../cats-platform/docs/decisions/141-host-a-consented-desktop-control-mcp-for-provider-sessions.md) /
  [SPEC-133](../../../cats-platform/docs/specs/SPEC-133-desktop-control-session-mcp.md)
- [SPEC-004: Provider interactions and tool visibility](../specs/SPEC-004-provider-interactions-and-tool-visibility.md)
- [Runtime SPEC-035: Session MCP servers](../../../cats-runtime/docs/specs/SPEC-035-session-mcp-servers.md) /
  [SPEC-039](../../../cats-runtime/docs/specs/SPEC-039-provider-session-capabilities-and-interactions.md)
