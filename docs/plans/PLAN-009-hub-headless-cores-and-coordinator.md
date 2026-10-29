# PLAN-009: Hub, Headless Cores and Coordinator

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Implemented on 2026-10-30 except part of 6.2 and the release (6.4, the owner's); choices D1 to D28 wait for the owner |
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

- [x] 2.1: Hub single-instance lock on `%APPDATA%\Cats Bot`, installation id and
      root lock (FR-1); bot registry with lock and atomic writes (FR-2,
      FR-3); hub state file for language and start at login (FR-18, FR-23).
      `src/shell/electron/hub/registry.ts` and `hubState.ts`; the reconcile
      reports unregistered, missing and invalid entries and deletes nothing.
- [x] 2.2: First run creates the registry, the native environment profile and the
      first bot, then assigns it as coordinator holder (FR-4, FR-24).
- [x] 2.3: Windows bound to a bot id with per-window AUMIDs and bot-scoped IPC
      (FR-17); one tray that matches today's menu for one bot (FR-16).
      `src/shell/electron/botPresenter.ts` holds one bot's windows; every IPC
      message is answered for the bot whose window sent it.
- [x] 2.4: `environment: { kind: 'native' }` in the bot profile; refuse any
      other kind.
- [x] 2.5: The hub's own control endpoint for owner CLI hub commands (FR-25).
      `src/core/host-api/hubControl.ts`; `cats-bot hub status`.

**Deliverables**: the product runs as hub plus one core, with no visible
regression.

### Phase 3: Bot management

- [x] 3.1: Settings → Bots: list, create, start, stop, start automatically and
      order; archive, restore, and delete from the archive under the instance
      lock, with `trash/` and start-time recovery, and `cats-bot run` refusing
      archived ids (FR-3, FR-5); bot cap of 3 (FR-6).
      `src/shell/electron/hub/botManager.ts` and
      `src/renderer/settings/BotsTab.tsx`; the hub's own Bots page opens when no
      bot runs.
- [x] 3.2: Tray submenus per bot and aggregated attention (FR-16).
- [x] 3.3: Core supervision: crash restart with backoff and limits, Quit order
      for every managed core including reattached ones, process-tree kill
      fallback, and listing externally hosted cores (FR-9 to FR-11).
      `src/shell/electron/hub/coreRunner.ts`.

**Deliverables**: up to three bots managed from one hub, with archive and
delete; tests also cover the cap.

### Phase 4: Host services

- [x] 4.1: Secret cipher served by the hub through the asynchronous path from 1.2;
      truthful protection status (FR-20). The hub serves `os-safe-storage` to
      every core; Telegram's status reports how the stored token is protected.
- [x] 4.2: Provider setup helpers run in the hub, one operation at a time (FR-19).
      One `ProviderSetup` serves every bot, and a CLI it finds reaches every
      core's PATH.
- [x] 4.3: Hub-owned updates replace the cross-shell exclusion for hub-hosted bots
      (FR-22). The drain stops every runner and checks every core and Runtime;
      an install is refused while a bot runs in another program.
- [x] 4.4: Hub PID changes reach every running core's helper before the next
      desktop-control call (FR-21). Done with task 1.4: every attach or detach
      restarts the helper with the hosts' PIDs and executables.
- [x] 4.5: Account-wide desktop lease taken by every core, hub-started or not,
      before control and clipboard calls (FR-26).
      `src/core/desktopControl/lease.ts`.

**Deliverables**: update, setup and secrets work for several bots.

### Phase 5: Coordinator

- [x] 5.1: Role state, Settings assignment, a CLI command through the hub's
      control endpoint, and the default holder (SPEC-009 FR-1, FR-2, FR-10).
      `bots.json` records holder, time and how; Settings → Bots and
      `cats-bot hub coordinator <id> | --clear` assign it; the holder's note
      title shows the role.
- [x] 5.2: The `cats-hub` server in the holder's core, attached per send while the
      hub reports it as holder and the session supports session MCP servers,
      with hub-side authorization of every call and the refusals (FR-3, FR-4,
      FR-6, FR-11). `src/core/tools/hubTools.ts`; the hub binds each channel to
      its bot and answers the calls in `src/shell/electron/hub/coordinator.ts`.
- [x] 5.3: Owner confirmations, chains, limits (4 hops and 10 messages per hour
      by default, adjustable in Settings), replies and audit (FR-5, FR-7 to
      FR-9); work items with source `bot`, admitted at once; delivery ids, the
      delivery log, deduplication and resend (FR-12).
- [ ] 5.4: Independent security review.

**Deliverables**: a holder hands work to another bot, and every boundary in
SPEC-009 FR-6 is enforced and tested.

### Phase 6: Acceptance and documentation

- [x] 6.1: Measurement table: hub alone, hub + 1 bot, hub + 2 bots, against the
      0.2.x baseline. Windows 11, development build, isolated home, fixture CLI,
      working sets 15 seconds after every bot ran; "ready" is from launch until
      `cats-bot hub status` reports every bot running.

      | Setup | Hub processes | Hub | Per bot: core + Runtime + CLI | Total | Ready |
      |-------|---------------|-----|-------------------------------|-------|-------|
      | 0.2.x, one bot | - | - | - | about 560 MB | - |
      | Hub alone (Bots page) | 4 | 355 MB | - | 355 MB | 1.0 s |
      | Hub + 1 bot | 5 | 449 MB | 65 + 144 + 49 MB | 707 MB | 1.1 s |
      | Hub + 2 bots | 7 | 646 MB | 65-96 + 145-172 + 49 MB | 1224 MB | 1.8 s |

      One bot costs about 150 MB more than 0.2.x, mostly the core's own process.
      Each further bot adds its windows to the hub and one core with its Runtime.
- [ ] 6.2: Windows acceptance in isolated profiles: hub restart, core crash,
      update with two bots, desktop-control self-exclusion, two bots contending
      for the desktop lease; macOS and Linux package smoke tests.
      Done with the development build: hub restart and reattach, a killed core
      restarting alone, two bots, per-bot quit, the coordinator role, and the
      lease held by another process (a test). Still open: an update with two
      bots (needs a published release to update from), the native helper check
      with the hub's PID (needs the built helper), and the macOS and Linux
      package smoke tests.
- [x] 6.3: Make the superseded text real: ADR-001, ADR-002, ADR-004 and ADR-006
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
  - Writes of one secret take effect in call order: the last set or delete
    wins, even while an earlier set still waits for the cipher. Re-storing
    reads the file again and replaces only entries that still hold the same
    plain value.
  - A token that could not be opened is read again when a host attaches, and
    a token handed off while no host serves the cipher starts Telegram anyway;
    it is re-stored encrypted later.
- **D5, the shell's core process (1.3).**
  - The shell starts `dist/cli/main.js run --json` with its own executable as
    Node, detached and hidden. The core keeps writing its log to
    `<bot root>/logs/core.log`. Its stderr, such as a crash before that log
    opens, goes to `core-stderr.log`, and the previous start's copy is kept as
    `core-stderr.previous.log`. Its stdout carries events with conversation
    text and is discarded.
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
- **D10, turns before the Runtime is ready (1.3).** A host can send as soon as
  the channel is up, while the Runtime still starts. Such a turn used to wait
  for its 30-second retry; it now runs as soon as the Runtime is ready, for
  every host including the CLI.
- **D11, bots made before the hub (2.2).** A hub that finds no registry but bot
  directories registers them instead of running first-run setup, up to the
  cap. A bot named with `--id` comes first, then the others by id, and the
  first is the coordinator holder. Further directories stay unregistered.
  This keeps `cats-bot init` and development shells working. Later, a launch
  that names an unregistered bot (`--id`) adds it within the cap and starts
  it; at the cap the Bots page opens.
- **D12, the first run (2.2).**
  - The environment step has nothing to choose while native is the only
    profile, so the page does not show it and the registry records native.
  - The first bot's id is `--id`, or derived from its name as `cats-bot init`
    derives it (`deriveBotId` moved to `src/core/store/paths.ts`).
  - `--provider` still creates the first bot without the page.
- **D13, hub preferences (2.1).**
  - `hub-state.json` holds the display language and start at login.
  - A hub's first start takes them from the `shell-state.json` of the bot it
    presents, so a development setup keeps its choice.
  - The registry also stores `maxBots` (3), the hub setting of FR-6.
- **D14, hub windows and tray (2.3).**
  - Each bot's windows use `io.catsinc.catsbot.<botId>`. In a packaged build
    a pinned window relaunches the hub with `--id <botId>`.
  - The hub itself uses `io.catsinc.catsbot` and one login item without
    arguments, which the uninstaller already removes.
  - The renderers keep no storage, so they share one session.
  - Until task 3.2 the tray shows the first running bot.
  - `cats-bot quit` for a bot ends the hub while it presents one bot, as it
    ended the shell; with more bots only that bot's windows close.
  - A core that ends unasked still offers to restart the whole hub until
    Phase 3 supervises cores.
- **D15, the manager of a core (2.1).** The hub names its installation id as
  manager, replacing Phase 1's id derived from the executable. A core that a
  Phase 1 development shell started is therefore not taken over; stop it once.
- **D16, the hub's user data (2.1).** The hub's Electron user data is
  `%APPDATA%\Cats Bot` instead of `…\Cats Bot\bots\<id>`. Secrets stored with
  the old user data's OS key, as 0.2.0 to 0.2.5 did, cannot be opened and need
  to be entered again, such as a Telegram token. Under the pre-launch policy
  there is no migration.
- **D17, Settings → Bots (3.1).**
  - Every bot's settings window gets a Bots tab. The hub also has a Bots page
    of its own (tray "Bots…" with no bot or several), which opens by itself
    when no bot runs.
  - "New bot" opens the provider-first setup page. The id comes from the name,
    with `-2`, `-3` and so on when it is taken. The new bot starts at once.
  - Archive and delete each ask in a native dialog that names the bot, shown
    by the hub, so no page can skip it. Delete is offered only for archived
    bots.
  - Directories without a registry entry are listed with "Add", within the cap.
  - An entry whose directory is missing shows as "Folder missing".
  - A bot whose core another program runs shows as running in another
    program; it cannot be started or archived from the hub.
  - The archive and delete dialogs name the bot and its id, since two bots
    can share a name.
  - Deleting removes the bot's folder without entering a junction or
    symbolic link in it, under every Node the hub may run on.
  - Open for the owner (review of #66): any bot's settings window manages
    every bot, which is wider than FR-17's "a window reaches only its own
    bot". The Bots page could be the hub's alone.
- **D18, supervision (3.3).**
  - A core that ends unasked closes its windows and is started again after 1,
    5 and 15 seconds, at most three times in ten minutes. After that the bot
    stays failed with its error, and the hub says so once in a dialog.
  - A start that fails counts the same way, and so does a bot whose lock
    another process holds without a channel past the wait (a busy bot, such
    as `cats-bot say` running a turn). A start by the owner clears the count.
  - The dialog appears once, when the hub stops restarting the bot.
  - Stop and Quit never restart. Quit stops every core this hub manages,
    reattached ones included, and leaves external ones running.
- **D19, external cores (3.3).** A core is external when its lock is held but
  its channel descriptor does not name this installation. At start the hub
  attaches to it only to give it the hub's identity (FR-21); one started after
  the hub gets it at the next hub start. A core this installation started,
  before the hub's own restart, is taken back and managed whatever its start
  setting (FR-10).
- **D20, the tray with several bots (3.2).**
  - Each running bot gets a submenu named after it, with the sum of its unread
    replies, waiting work and requests.
  - The hub items are Bots…, Start at login, Check for Updates… and Quit.
  - The tooltip sums unread replies and waiting items.
  - The tray click opens the first bot's direct message, or the Bots page.
  - Open for the owner (review of #66): FR-16 lists a hub "Settings…" item,
    which this tray does not have, and with one bot the tray has no "Bots…".
  - `cats-bot quit` for a bot stops only that bot while others run; the last
    running bot's quit ends the hub.
- **D21, the desktop lease (4.5).**
  - The lease is a named pipe (a socket file outside Windows) named from a hash
    of the account's user name and home folder. Only one process can listen on
    it, and the OS frees it when that process ends.
  - A turn takes it before its first input or clipboard call and keeps it
    until the turn ends, Stop, a revoke or the core stops. A refused call
    returns `unavailable` with "Another bot is using the desktop right now."
  - A call whose turn was cancelled while it waited sends nothing, and a call
    stopped while it waited gives the lease back.
  - The lease is named from the account's user name and the home folder the
    OS reports, so a different `USERPROFILE` gets the same lease.
  - Another local account could hold the name and keep this account's bots
    off the desktop. That is a denial of service only, within the account
    boundary SPEC-008 already states.
- **D22, hub-owned updates (4.3).**
  - Any bot that runs in another program blocks the install and is named,
    whatever executable runs it. This is stricter than "from this
    installation", and needs no process inspection.
  - The bots that ran when the update began start again after it, besides
    those set to start automatically.
- **D23, one user data per account, not per installation (review of 2.1).**
  - Every copy of Cats Bot (installed, portable, `npm run shell` without
    `--user-data-dir`) shares `%APPDATA%\Cats Bot`. Its installation id and
    single-instance lock are therefore per account.
  - A second copy hands its launch to the running hub even when it points at
    another root, and copies cannot tell each other's cores apart by manager.
  - This follows FR-1 to the letter. A user data per installation would also
    give each copy its own OS key for secrets, so the choice is the owner's.
- **D24, hub windows (review of 2.3).**
  - A bot's notes and floating Cat that were never placed open a step further
    per bot, so two bots never stack.
  - A note's window title and the floating Cat carry the bot's name.
  - A second quit handed to a bot that is already stopping changes nothing.
  - A hub that cannot start shows why in a dialog.
  - A hub lock left by a process that no longer runs is taken over. One whose
    PID now belongs to another program names the file to delete.
- **D25, owner confirmations (5.3).** SPEC-009 FR-5 shows a request as a
  decision in the holder's note and in the tray. This version asks in a native
  dialog the hub shows, which no page or bot can answer. The dialog names the
  holder and the request, and expires as declined after 10 minutes, when the
  hub stops, or when the holder's channel is lost. A decision card in the note
  can replace it later. A provider CLI whose own tool-call timeout is shorter
  than the owner's answer reports a failure first; what the owner then allows
  still happens.
- **D26, which bot needs consent to start (5.3).** The owner confirms
  `hub_start_bot` for any stopped bot except one that failed. The hub cannot
  tell after its own restart whether the owner stopped a bot or never started
  it.
- **D27, providers without the tools (5.2).** The holder gets no `cats-hub`
  tools on the providers that FR-11 names for the pinned Runtime: Antigravity,
  Grok and Muse. Its note title and Settings → Bots say so. A capability probe
  can replace the list when Runtime reports it.
- **D28, chains and deliveries (5.3).**
  - A chain is the holder's: only the bot that started a chain can continue it.
  - A message is accepted only when it and its reply fit the hop limit, so a
    reply is never refused.
  - A reply returns to the holder's conversation that sent the message, as
    background work. A message arrives in the target's direct message.
  - The delivery log (`coordinator/deliveries.jsonl` under the Cats Bot root)
    keeps each delivery's text so it can be sent again. The audit
    (`logs/hub-audit.jsonl`) and the bots' journals record calls without text.
  - A target that fails or is archived answers the holder with the reason.

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
| 2026-10-30 | Independent review of 1.1 and 1.2 (after #64 merged; nothing used those paths yet): fixed a secret re-store that could restore a cleared token, `attach` applying events before the caller had the snapshot, a late answer closing the connection, a token reload failing without a host, and an FR-13 test that did not test its filter. Hardened refused connections, cipher answers, the welcome PID check, server errors and a stop during start. |
| 2026-10-30 | Tasks 2.1 to 2.5 implemented. With the real Electron hub in an isolated home (Windows 11, fixture CLI): the first run wrote the registry, hub state, root lock and installation id; `cats-bot hub status` answered; a second launch handed over and exited; killing the hub left the core running and a new hub reattached; `cats-bot quit` ended both and released the hub's files. |
| 2026-10-30 | Tasks 3.1 to 3.3 implemented. Unit tests cover the cap, archive, restore, delete through `trash/`, interrupted deletes, a junction inside a deleted bot, and restart limits. With the real Electron hub and two bots made by `cats-bot init`: both were taken in and ran; killing one core restarted only that bot; `cats-bot quit` stopped one bot alone and quitting the last one ended the hub. |
| 2026-10-30 | Tasks 4.1 to 4.5 done: 4.1, 4.2 and 4.4 were in place from Phases 1 and 2; 4.3 refuses an install while a bot runs elsewhere; 4.5 adds the desktop lease, with a test of two processes. |
| 2026-10-30 | Independent review of the Phase 2 commit: a corrupt profile ending the hub and the restart dialog stopping other bots were already gone with Phase 3; fixed a core lost before its close was watched, a second quit ending the hub, stacked windows of several bots, a launch-named bot that the hub ignored, window titles and a silent start failure; D23 records the reviewer's challenge of per-account user data. |
| 2026-10-30 | Tasks 5.1 to 5.3 implemented. Tests with two cores on the fake runtime, reached through their channels: a message reached the other bot once and its answer returned to the holder's conversation, also after the hub started again; refusals for a non-holder, unknown tools, other chains, hop and hourly limits; consent for create and transfer. With the real Electron hub and two bots, `cats-bot hub coordinator` moved and cleared the role and each core heard it. |
| 2026-10-30 | Tasks 6.1 and 6.3 done: the measurement table above; ADR-001, ADR-002, ADR-004, ADR-006 and ADR-008 statuses, SPEC-001 FR-3, SPEC-002 FR-1, FR-4 and FR-7, SPEC-006's hub changes, and `architecture.md`, `services.md`, `setup-guide.md` and `testing.md` describe the hub. Task 6.2 is partly done; 6.4 waits for the owner. |
| 2026-10-30 | Independent review of Phases 3 and 4: fixed deleting a bot emptying a junction's target under Electron's Node (critical), quit during start leaving cores, own cores treated as external after a hub restart, the restart dialog's timing, the lease after a cancel, Stop or revoke, a busy lock counted as external, trash keeping foreign files, and a missing folder being archived; tests now remove under Electron's Node too. |

---

*Created: 2026-10-29*
*Author: Claude*
