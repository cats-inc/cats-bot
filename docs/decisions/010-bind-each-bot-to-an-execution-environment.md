# ADR-010: Bind each bot to an execution environment

## Status

Accepted — 2026-10-29, owner decisions recorded from discussion. This version
implements only the native profile, through
[SPEC-008](../specs/SPEC-008-hub-and-bot-fleet.md) FR-24. WSL and docker profiles
need a separate spec once their Runtime prerequisite exists.

## Context

cats-runtime already models execution environments. `providers.yaml` can name
`native`, `wsl` (a distro) and `docker` (a container) environments and provider
instances per environment (Runtime ADR-003, ADR-007). Runtime stays on the host
and starts the CLI through `wsl -d <distro> bash -lc …` or
`docker exec <container> bash -lc …`. It does not create or start containers.
The Bot writes its own `providers.yaml` and has no environment field
(`ExecutionTarget` holds provider, model and controls).

Three facts limit non-native bots:

- Runtime supports session MCP servers only for native CLI instances. Runtime
  ADR-044 rule 4 gives the reason: a WSL or docker launch payload can reach
  argv. ADR-044's Consequences add that such instances cannot reach host
  loopback tools. A non-native bot therefore loses every Bot-injected tool:
  `schedule_*`, `ask_owner` and `cats-desktop`. Host-driven heartbeat and
  owner-created schedules still run.
- WSL is not a sandbox by default. It mounts the Windows drives with the user's
  rights and allows running Windows executables (interop). The reference setup in
  environment-bootstrap enables both.
- A docker container is a real boundary: it sees only the volumes mounted into
  it. Its CLIs need their own sign-in, and rotating refresh tokens must not be
  copied between containers.

## Decision

- **Per-bot binding, any topology.** Each bot profile stores
  `environment: { kind: 'native' } | { kind: 'wsl', distro } |
  { kind: 'docker', container }`. The design and tests must allow any mix,
  including one distro or container per bot.
- **Three fleet profiles in the product.** The registry's `environmentProfile`
  constrains every binding, and the owner chooses one at first run:
  1. `native`: every bot runs its CLI on the host;
  2. `wsl:<distro>`: every bot uses one owner-chosen distro;
  3. `docker`: every bot gets its own container.
  Switching profiles later is an explicit rebuild. All bots stop, environments
  are provisioned, CLIs sign in again and workspaces move. Provider sessions then
  resume through the existing handoff.
- **This version offers only `native`.** WSL and docker open only after a
  cats-runtime ADR (and its implementation) defines session MCP for non-native
  instances: delivering descriptors without argv, and making the host reachable.
  They also need native acceptance on each OS. Until then, a non-native bot would
  be a chat-only bot, which the product does not ship.
- **Desktop control is native-only.** SPEC-006 BDC-04 additionally requires a
  native binding, both because the helper is a host process and because a
  sandboxed bot must not operate the host desktop.
- **Wording and ownership for later profiles.** The WSL profile is presented as
  "run CLIs in a Linux environment", never as a sandbox. Its workspaces live on
  the distro's own file system, not under `/mnt/c`. Docker is the sandbox
  profile. The hub owns the container lifecycle (image, one container and volume
  per bot, start and stop with the bot), because Runtime does not. Each
  container's CLIs sign in separately.
- **Availability by OS.** Native everywhere; WSL on Windows only; docker where
  Docker Desktop or Docker Engine is installed and running.

## Consequences

### Positive

- The data model and hub never need reshaping to add WSL or docker, or mixed
  fleets.
- The product cannot ship a bot that silently lacks its own tools.

### Negative

- Docker bots will need per-container sign-in for each provider.
- Profile switching is disruptive by design.

### Neutral

- Per-bot overhead differs: one container per bot shares one image and one
  Docker VM. One distro per bot (not offered) costs a full root file system
  each, roughly 1–3 GB with Node and CLIs (an estimate, not measured), plus
  setup and sign-in per distro.

## Alternatives Considered

### Expose every topology in the UI

- **Pros**: maximum flexibility.
- **Cons**: many combinations to explain, support and test.
- **Why rejected**: the architecture allows them, but the product offers three.

### Ship WSL/docker bots now as chat-only

- **Pros**: earlier availability.
- **Cons**: bots without schedules or `ask_owner` look broken.
- **Why rejected**: owner chose native-only first.

### Treat WSL as the sandbox option

- **Pros**: no Docker dependency on Windows.
- **Cons**: default automount and interop give full access to the host.
- **Why rejected**: it would misrepresent the protection.

## References

- cats-runtime ADR-003 (provider instances), ADR-007 (docker adapter), ADR-044
  (session MCP servers)
- [ADR-005](005-give-the-bot-owner-consented-desktop-control.md),
  [SPEC-006](../specs/SPEC-006-desktop-control-session-mcp.md)
- [ADR-008](008-run-every-bot-as-a-headless-core-under-one-hub.md),
  [SPEC-008](../specs/SPEC-008-hub-and-bot-fleet.md)

---

*Decision made: 2026-10-29*
*Decision makers: product owner (sammykenny2), recorded by Claude*
