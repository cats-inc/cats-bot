# PLAN-009: Hub, Headless Cores and Coordinator

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Draft |
| **Owner** | Product owner |
| **Assigned To** | Unassigned |
| **Reviewer** | Independent agent; security review for Phase 5 |

## Related Spec

[SPEC-008: Hub and Bots](../specs/SPEC-008-hub-and-bots.md) and
[SPEC-009: Coordinator Role](../specs/SPEC-009-coordinator-role.md), decided in
[ADR-008](../decisions/008-run-every-bot-as-a-headless-core-under-one-hub.md),
[ADR-009](../decisions/009-give-one-bot-a-bounded-coordinator-role.md) and
[ADR-010](../decisions/010-bind-each-bot-to-an-execution-environment.md).

## Overview

Start after PLAN-008 Phase 1, so every new file uses the `~/.catsbot` layout.
The two plans ship together as 0.3.0 (SPEC-007 FR-8), with no release in between.
Phase 1 proves the split with today's single-bot shell talking to an
out-of-process core. Later phases turn that shell into the hub and add bot
management, host services and the coordinator. Each phase is a separately
reviewable PR and keeps the application usable.

## Implementation Phases

### Coordination with proposed shared Platform packages

[Platform PLAN-127](https://github.com/cats-inc/cats-platform/blob/main/docs/plans/PLAN-127-shared-platform-package-extraction.md)
proposes extracting setup/native helpers before additional host mechanisms.
Coordinate consumer changes with this plan's host-service phase; the Hub owns
setup/updates/language/cipher, while each core owns its Runtime/helper and Bot
state. Until a reviewed package exists, this plan can use the current adapters.
Do not make the Hub depend on the Platform application or pass Runtime credentials
to it. Package extraction does not complete any Hub/coordinator acceptance task.

PLAN-127 Phase 4 additionally requires the Desktop-derived conversation renderer
in both Desktop and Bot, including internal message hierarchy, streaming/recovery,
interactions and narrow-layout acceptance (Platform SPEC-134 FR-15 through FR-20,
UI-1 through UI-6). Coordinate Bot's live/durable data mapping and renderer adapter
with the channel client introduced here; a shared renderer may first serve the
current shell or the Hub, without a Platform API dependency. Hub acceptance does
not complete this UI slice, and the UI slice does not implement hub policy.
Native window layers and the Electron host remain unchanged by UI extraction.

### Phase 1: Core out of Electron, still one bot

- [x] 1.1: Host channel in `src/core/host-api/`: a server in the core and a client
      for hosts, with version, token, manager and descriptor, and attach by
      subscribe, buffer and snapshot sequence (SPEC-008 FR-12 to FR-15). It
      carries every `BotHostApi` call from the host, and from the core the event
      stream and host-service requests (cipher, host identity). The owner control
      operations keep their behavior. `channel.ts` holds the server and client;
      `commands.ts` holds the command table both the renderer IPC and the
      channel dispatch through; `endpoint.ts` holds what owner control shares.
- [x] 1.2: The headless host (`cats-bot run`) serves the channel and accepts from
      its host the packaged Runtime entry, the helper path and the secret cipher.
      Give `src/core/secrets.ts` an asynchronous cipher path (FR-7, FR-20).
      `run` takes `--runtime-entry`, `--desktop-control-helper`, `--manager` and
      `--host-cipher`, and exits when a host stops the core over the channel.
- [x] 1.3: The current shell spawns its bot's core with `ELECTRON_RUN_AS_NODE`
      (already used for the Runtime child, so the RunAsNode fuse stays enabled)
      and routes `ipc.ts` through the channel client instead of an in-process
      `BotCore`. `src/shell/electron/coreHost.ts` starts or reattaches to the
      core and stops it; `src/core/host-api/remote.ts` gives the shell a
      `BotCore`-shaped client; `initializeBot` and the profile reader moved to
      `src/core/profile/initialize.ts`.
- [x] 1.4: Pass the shell PID and executable path to the desktop-control helper's
      self-exclusion (FR-21). Every attached host's PID and executable join the
      helper's self lists; a change restarts the helper before its next call.
- [x] 1.5: Extend `tests/architecture-boundaries.test.ts`: `src/shell/**` reaches
      the core only through the channel client and core types. Value imports
      from `src/core` are limited to a list of modules that start no core.
- [x] 1.6: Bot id validation (SPEC-008 FR-27) in `src/core/store/paths.ts`, used
      by the CLI, the core and the shell before any path is resolved; Phase 3's
      create and reconcile reuse it. Tests cover `..`, path separators,
      uppercase, length and device names. Every bot root is resolved through
      `botRootIn`, which refuses an invalid id; the shell shows the rule in a
      dialog before the id reaches Electron's user data.

**Deliverables**: closing or crashing the shell leaves the bot running, and
restarting the shell reattaches. First working-set measurement.

### Phase 2: The hub

- [ ] 2.1: Hub single-instance lock on `%APPDATA%\Cats Bot`, installation id and
      root lock (FR-1); bot registry with lock and atomic writes (FR-2,
      FR-3); hub state file for language and start at login (FR-18, FR-23).
- [ ] 2.2: First run creates the registry, the native environment profile and the
      first bot, then assigns it as coordinator holder (FR-4, FR-24).
- [ ] 2.3: Windows bound to a bot id with per-window AUMIDs and bot-scoped IPC
      (FR-17); one tray that matches today's menu for one bot (FR-16).
- [ ] 2.4: `environment: { kind: 'native' }` in the bot profile; refuse any
      other kind.
- [ ] 2.5: The hub's own control endpoint for owner CLI hub commands (FR-25).

**Deliverables**: the product runs as hub plus one core, with no visible
regression.

### Phase 3: Bot management

- [ ] 3.1: Settings → Bots: list, create, start, stop, start automatically and
      order; archive, restore, and delete from the archive under the instance
      lock, with `trash/` and start-time recovery, and `cats-bot run` refusing
      archived ids (FR-3, FR-5); bot cap of 3 (FR-6).
- [ ] 3.2: Tray submenus per bot and aggregated attention (FR-16).
- [ ] 3.3: Core supervision: crash restart with backoff and limits, Quit order
      for every managed core including reattached ones, process-tree kill
      fallback, and listing externally hosted cores (FR-9 to FR-11).

**Deliverables**: up to three bots managed from one hub, with archive and
delete; tests also cover the cap.

### Phase 4: Host services

- [ ] 4.1: Secret cipher served by the hub through the asynchronous path from 1.2;
      truthful protection status (FR-20).
- [ ] 4.2: Provider setup helpers run in the hub, one operation at a time (FR-19).
- [ ] 4.3: Hub-owned updates replace the cross-shell exclusion for hub-hosted bots
      (FR-22).
- [ ] 4.4: Hub PID changes reach every running core's helper before the next
      desktop-control call (FR-21).
- [ ] 4.5: Account-wide desktop lease taken by every core, hub-started or not,
      before control and clipboard calls (FR-26).

**Deliverables**: update, setup and secrets work for several bots.

### Phase 5: Coordinator

- [ ] 5.1: Role state, Settings assignment, a CLI command through the hub's
      control endpoint, and the default holder (SPEC-009 FR-1, FR-2, FR-10).
- [ ] 5.2: The `cats-hub` server in the holder's core, attached per send while the
      hub reports it as holder and the session supports session MCP servers,
      with hub-side authorization of every call and the refusals (FR-3, FR-4,
      FR-6, FR-11).
- [ ] 5.3: Owner confirmations, chains, limits (4 hops and 10 messages per hour
      by default, adjustable in Settings), replies and audit (FR-5, FR-7 to
      FR-9); work items with source `bot`, admitted at once; delivery ids, the
      delivery log, deduplication and resend (FR-12).
- [ ] 5.4: Independent security review.

**Deliverables**: a holder hands work to another bot, and every boundary in
SPEC-009 FR-6 is enforced and tested.

### Phase 6: Acceptance and documentation

- [ ] 6.1: Measurement table: hub alone, hub + 1 bot, hub + 2 bots, against the
      0.2.x baseline.
- [ ] 6.2: Windows acceptance in isolated profiles: hub restart, core crash,
      update with two bots, desktop-control self-exclusion, two bots contending
      for the desktop lease; macOS and Linux package smoke tests.
- [ ] 6.3: Make the superseded text real: ADR-001, ADR-002, ADR-004 and ADR-006
      statuses; SPEC-001 FR-3 notes, SPEC-002 FR-1/FR-4/FR-7, SPEC-006 BDC-04,
      BDC-08 and the desktop lease; `docs/architecture.md`, `docs/services.md`,
      `docs/setup-guide.md`, `docs/testing.md`.
- [ ] 6.4: Publish 0.3.0 through PLAN-008 Phase 4.

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/core/host-api/channel.ts` (name indicative) | Create | Channel server, client, descriptor, protocol |
| `src/core/host-api/control.ts` | Modify | Share transport and auth with the channel |
| `src/cli/main.ts` | Modify | `run` serves the channel and takes a host cipher |
| `src/core/types.ts`, `src/core/profile/profile.ts` | Modify | `environment` binding; work-item source `bot` |
| `src/core/bot.ts`, `src/core/desktopControl/*` | Modify | Host PID and executable in self-exclusion |
| `src/core/secrets.ts` | Modify | Asynchronous cipher path |
| `src/core/store/paths.ts`, `src/cli/main.ts`, `src/shell/electron/main.ts` | Modify | Bot id validation (FR-27) |
| `src/shell/electron/main.ts`, `ipc.ts`, `windows.ts`, `tray.ts`, `trayMenu.ts`, `settingsWindow.ts`, `floatingBot.ts`, `viewState.ts` | Modify | Hub, bot-bound windows, one tray |
| `src/shell/electron/hub/` | Create | Registry, core supervisor, hub state |
| `src/shell/electron/update/*` | Modify | Hub-owned update coordination |
| `src/core/tools/` (hub tool server) | Create | `cats-hub` tools |
| `src/renderer/settings/` | Modify | Bots page, coordinator display |
| `tests/core/`, `tests/shell/`, `tests/integration/`, `tests/architecture-boundaries.test.ts` | Create/Modify | Channel, registry, supervision, coordinator |

## Technical Decisions

- Reuse the headless `run` host as the core entry rather than adding another
  one, so CLI and hub cores behave the same.
- Phase 1 changes no product surface, so the riskiest change (the split) is
  reviewed alone.
- Events are not persisted for replay; snapshots recover state after reattach
  (SPEC-008 FR-15).

## Testing Strategy

- **Unit Tests**: registry reads and writes, corruption handling, cap; archive,
  restore and delete, each interrupted after its rename; channel auth,
  versioning, size limits; coordinator authorization tables (holder or not,
  every refused operation, holder without session MCP); chain and rate limits;
  delivery deduplication and resend; bot id validation.
- **Integration Tests**: the packed Runtime behind a channel-hosted core; two cores
  in temporary roots; attach with events between subscribe and snapshot; hub
  restart reattaches and keeps managing its cores; core crash restarts; two
  cores contending for the desktop lease; a coordinator message round trip with
  the fixture CLI, including a hub restart before the reply.
- **Manual Testing**: isolated Windows hub with two bots over CDP; desktop-control
  native check with the hub PID; update handoff with two bots.

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Streaming deltas over IPC add latency or drop events | Medium | Sequence numbers, snapshots after gaps, measurements in Phase 1 |
| Reattach races after a hub crash | Medium | PID and token check, instance lock as the single source |
| A bot operates its own note UI through desktop control | High | Executable and hub-PID exclusion, native check in 6.2 |
| Coordinator loops burn quota | Medium | Hop and rate limits, holder-only chains |
| Two bots drive the desktop or clipboard at once | High | Account-wide desktop lease taken by every core (SPEC-008 FR-26) |
| A native CLI reads a control token and calls the hub directly | High | Not prevented; stated as API limits, not a boundary (SPEC-008 Security) |
| A crash loses or repeats a coordinator message | Medium | Delivery ids, a delivery log and receiver deduplication (SPEC-009 FR-12) |
| Process-tree cleanup on Windows leaves orphans | Medium | Graceful stop first, tree kill fallback, acceptance check |

## Decisions to Confirm

The owner asked on 2026-10-30 for the whole plan to be implemented unattended,
with open questions decided by best practice and reviewed together afterwards.
Each entry names where it is implemented.

- **D1, WSL and docker (scope).** Not in 0.3.0. SPEC-008's Non-Goals and
  ADR-010 keep this version native, and non-native profiles need a cats-runtime
  ADR for session MCP outside native first. Task 2.4 records the `native` binding
  and refuses any other kind, so the profiles can open later without reshaping
  data.
- **D2, bot id details (1.6).**
  - `com0` and `lpt0` are refused with the other device names, as Microsoft's
    naming rules reserve them too.
  - An explicit invalid `--id` or `CATS_BOT_ID` is refused, never corrected.
  - `cats-bot init` without `--id` truncates the derived id to 64 characters
    and appends `-bot` to a device name, so `Con` becomes `con-bot`.
  - The CLI's bot listing skips a directory whose name is not a valid id.
- **D3, host channel shape (1.1).**
  - A pipe and descriptor of its own (`host-channel.json`) beside owner control,
    which keeps its HTTP endpoint unchanged; both share `endpoint.ts`.
  - Newline-delimited JSON over one duplex connection per host. A `hello` with
    the token and protocol comes first; a mismatch is refused with its reason.
    Frames are bounded to 16 MiB, bodies are never logged, and a host that
    reads too slowly (32 MiB queued) is disconnected rather than sent a gap.
  - Every core response carries the event number current when the request
    started, and appliers are idempotent, so a host that subscribed first
    misses nothing (FR-13).
  - The host sends its identity (PID, executable, installation id) in its hello
    instead of the core asking for it; the core keeps the identities of the
    attached hosts for the helper's self-exclusion (FR-21, task 1.4).
  - Commands live in one table shared with the renderer IPC. The host also gets
    the window lifecycle commands, `protectSecretsAtRest`, `quit` and
    `stopAllDesktopControl`, which no renderer can send.
- **D4, secrets through the host (1.2).** A core started with `--host-cipher`
  reads and writes secrets through the attached host's cipher, waiting up to
  30 seconds for a host that serves that label; status says `os` only when such
  a cipher is configured. Telegram starts once its token is read, so a later
  start or a stop supersedes an attempt still waiting.
- **D5, the shell's core process (1.3).**
  - The shell starts `dist/cli/main.js run` with its own executable as Node,
    detached and hidden. The core writes its log lines to
    `<bot root>/logs/core.log` (the previous start's log is kept as
    `core.previous.log`); stdout, which carries conversation text in a
    terminal, is discarded.
  - The manager a shell names is derived from its executable path, so a shell
    reattaches only to cores started by the same installation. A core with any
    other manager, or a `cats-bot run`, gets today's "another instance" dialog.
    Phase 2 can replace this with the hub's installation id.
  - Quit asks the core to stop through the channel and waits 30 seconds for
    its process, then kills its process tree. The update drain does the same
    and then checks that the core and Runtime PIDs are gone.
  - A core that ends while the shell is not quitting shows a dialog offering
    to restart Cats Bot. This stands in for Phase 3's supervision.
  - A shell's first window waits only for the channel, not for the Runtime,
    which keeps starting in the core.
- **D6, event order across the channel (1.3).** The client handles frames in
  the order the core wrote them, and after a response it lets that response's
  awaiters run before the next frame. A renderer therefore never gets an
  event before a snapshot the event postdates, as in-process before.
- **D7, views belong to a connection (1.3).** The views and focus a host set
  are cleared when its connection ends, so a crashed shell leaves no note
  counted as read; the next shell opens its notes again.
- **D8, helper exclusion on a host change (1.4).** The helper takes its self
  lists only in `hello`, so a changed set of hosts ends the running helper
  (failing a call in flight) and the next call starts one that names them.
  There is no new helper protocol.
- **D9, provider CLI directories (1.3).** Setup found or installed a CLI in the
  shell's process, which changed only the shell's PATH. The new host-only
  command `useCommandDirectory` puts that directory first on the core's PATH
  too, so the next Runtime start finds it without a restart (ADR-006).

## Progress Log

| Date | Update |
|------|--------|
| 2026-10-29 | Plan created from the owner's decisions; nothing implemented. |
| 2026-10-29 | Owner answered the SPEC-008 and SPEC-009 open questions: a cap of 3; archive before delete; externally hosted cores listed only; 4 hops and 10 messages per hour by default, adjustable; coordinator work admitted at once. |
| 2026-10-29 | Codex review: eight findings written back. Owner chose API limits stated as no security boundary, an account-wide desktop lease that external cores also take, and holders without session MCP keeping the role without tools. |
| 2026-10-30 | Owner scheduled bot id validation as task 1.6 (SPEC-008 FR-27). The PLAN-008 review found that `--id ..` resolves into the hub's part of the root. |
| 2026-10-30 | Owner asked for the whole plan unattended, decisions logged above. Task 1.6 implemented: 246 tests, typecheck and build passed on Windows. |
| 2026-10-30 | Tasks 1.1 and 1.2 implemented: the host channel and `cats-bot run` as a channel-hosted core. An integration test runs `cats-bot run` with the packed Runtime and the fixture CLI, converses through the channel and stops it there. |
| 2026-10-30 | Tasks 1.3 to 1.5 implemented. With the real Electron shell in an isolated home (Windows 11, fixture CLI): the shell started its core as a separate process; killing the shell left the core running; a new shell reattached to the same core; `cats-bot quit` ended both. First working set: shell 461 MB over five Electron processes, core 64 MB, Runtime 80 MB, fixture CLI 59 MB. |

---

*Created: 2026-10-29*
*Author: Claude*
