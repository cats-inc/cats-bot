# Standalone Living Bot Feasibility

Date: 2026-10-27
Scope: A read-only inventory of source code and documents, covering the existing cats-inc members and `../sammykenny2/desktop-work-fleet`.
This round ran no program, created no Runtime session, called no provider and wrote to no existing repo.
This is a research record, not an ADR: the "candidate topology" and "suggestions" below are proposals awaiting decision, and none of them has been adopted.

Errata (2026-10-27, after Codex review; the rest of this document is kept as it was):

- "Point the discovery directory at an empty folder" in the "Candidate topology" is insufficient and wrong:
  the runtime also has background native/agent scanning (`CATS_RUNTIME_NATIVE_DISCOVERY_INTERVAL_MS`) and
  WSL/Docker policy, and the provider's session directory is the read source for both `history` and resume,
  so changing the directory would break its own sessions. The correct policy is in ADR-001 §1.
- "If the session is not ready, resume or rebuild it" is too coarse: the runtime states are
  `initializing | ready | busy | closing | closed`; `initializing` can be brought to ready by the first turn
  (including a heartbeat), and `busy` is a turn in progress; neither may be rebuilt. The correct decision is in
  ADR-001 §5 and SPEC-001 FR-20.
- "Use runtime wakeup as the cron timer" has been rejected by ADR-001 §5; the truth of the schedule is in the
  bot's own journal.

Baseline (all on each checkout's `main`):

| Repo | Version | HEAD |
| --- | --- | --- |
| cats-runtime | 0.6.2 | `5212fa59` |
| cats-platform | Desktop 0.11.1 preview | `0edaffe5` |
| cats-apps | Ask 0.1.0 | `ffddcb7` |
| cats-one | 0.5.0 | `17641cd` |
| cats-plugins | 0.1.0 | `8b62785` |
| desktop-work-fleet | previews 0.4.2 | `fcaa942` |

## User direction

The owner wants to open a new member under cats-inc (tentatively `cats-bots` or `cats-agents`), with these goals:

- One process (one exe) is one bot, wrapping one agent CLI.
- The bot must be "alive": whether by heartbeat, scheduler or event driven, it can be woken at any time to reply or do something.
- It has a tray icon it can dock to; it can be dragged around the desktop; ideally it can be embedded in at least one of the wallpaper layer, the desktop layer or the topmost layer, and failing that it is an ordinary window.
- A greatly lightened conversation interface: a conversation is like a note, and there can be several; there is only one global provider/model, representing the agent behind this bot, and it is not stored per conversation.
- It is uncertain whether the new member should depend directly on cats-runtime like cats-platform does, or depend on cats-platform.
- Priority: first a living bot wrapping a CLI; the desktop layers and dragging come second.

## Terminology: Catlas is not the companion

The owner described the requirement as "a Bot similar to Catlas", but in the cats-platform code these are two different things:

- **Catlas = Guide Cat**. `GUIDE_CAT_SYSTEM_NAME = 'Catlas'`
  ([guideCatIdentity.ts](../../../cats-platform/src/shared/guideCatIdentity.ts)). It is the platform layer's only
  `core.guideCat: GuideCatRecord { executionTarget, modelSelection, status }`, that is, **the only global
  provider/model binding on the whole platform**. Its inference goes through [inference.ts](../../../cats-platform/src/platform/catlas/inference.ts):
  each question opens a one-shot session with `sharingMode: 'isolated'` and `workspaceAccess: 'read_only'`, requires strict JSON
  output, and closes it after use. It has no DM lane, no Telegram and no heartbeat. The draggable pill inside the window is
  [GuideCatSidecar.tsx](../../../cats-platform/src/design/components/GuideCatSidecar.tsx), and the placement model is in ADR-070.
- **What is alive is the Cat with the companion role** (ADR-124). Its unit of life is "the one Runtime session on that Cat's DM lane",
  kept up by the life loop inside the platform server process, and sharing the same lane through the Telegram bridge (ADR-127, SPEC-124, PLAN-117).
- The bot the owner wants is the two combined: Catlas's shape (one global binding, a draggable presence), plus the companion's life mechanisms.

## Local baseline

### cats-runtime 0.6.2

Embedding and consumption contract:

- A loopback HTTP service (default `127.0.0.1:3110`, optional Bearer `CATS_RUNTIME_API_KEY`), with routes registered in
  [http/app.ts](../../../cats-runtime/src/http/app.ts) and the full interface in [docs/api.md](../../../cats-runtime/docs/api.md).
- Managed startup: `--startup-mode app-managed --managed-by <name> --ready-output json`; `--port 0` lets the OS choose the port,
  and the actual port is obtained from the `runtime.ready` event on stdout; shutdown is via SIGINT/SIGTERM or closing the child process's stdin.
- [runtime ADR-009](../../../cats-runtime/docs/decisions/009-keep-cats-runtime-separately-packageable-with-app-managed-local-startup.md)
  requires the host to use the process + HTTP boundary and not source import. Although `src/index.ts` exports
  `loadConfig`, `createRuntimeServer` and `createRuntimeApp`, and tests embed in-process with `app.request()`, the documents position it as
  tests/dev embedding, not a product contract.
- Desktop's precedent: [processSupervisor.ts](../../../cats-platform/desktop/host/processSupervisor.ts) starts the runtime bundle with Electron's
  own executable plus `ELECTRON_RUN_AS_NODE=1`, and sets `CATS_RUNTIME_DIR`,
  `CATS_RUNTIME_PACKAGE_ROOT`, the host and the port.
- MCP (`POST /mcp`, about 85 tools) and ACP (`POST /acp`) are additional facades; the `cats-runtime mcp|acp` stdio subcommands only proxy to
  an already running runtime.

Provider execution:

- `KNOWN_PROVIDERS` has 16 CLIs in all: claude, codex, antigravity, cursor, copilot, opencode, kilo, goose, pi, auggie,
  junie, kiro, grok, cline, devin, muse ([providers/types.ts](../../../cats-runtime/src/backends/cli/providers/types.ts)).
  Gemini CLI has been replaced by Antigravity (runtime ADR-032), and Gemini models remain only in the API backend.
- claude (`-p --input-format stream-json --output-format stream-json`, `--resume`/`--fork-session`),
  codex (`app-server` JSON-RPC, `thread/start|resume|fork`) and pi (`--mode rpc`) each have one resident child process per session;
  the other 13 are `ephemeral`, respawned every turn with `resumeSessionId` carried back.
- Turn contract: `POST /sessions/{id}/messages`, with an SSE response by default and `Accept: application/x-ndjson` switching to NDJSON;
  event kinds are init/text/tool_use/tool_result/result/error/raw/progress/workspace_activity.
  A busy session returns 409 with **no queue**; no active worker returns 404 "Resume the session first"; a worker that has exited returns 410.
- Each session can inject `mcpServers`; when the MCP server set changes, the worker is recycled at the next turn boundary.
- Continuity: for the CLI backend the CLI keeps the native transcript and the runtime stores only `providerSessionId`; for the API/local backend the runtime
  replays its own JSONL. `instructions` and skills are prepended every turn.

Liveness primitives, the most critical constraint for this topic:

- [RuntimeWakeupService](../../../cats-runtime/src/core/wakeup/RuntimeWakeupService.ts): a 1-second tick, at most 8 entries
  handled per tick, persisted in `data/wakeups.json`, supporting coalesceKey, one-shot `scheduleAt` and five-field cron, with **timezone accepting only UTC**,
  and the target can only be `{kind:'session'}`, with no retry/backoff.
- When triggered it only calls `ensureSessionAwake` ([sessionWakeup.ts](../../../cats-runtime/src/core/runtime/sessionWakeup.ts)):
  it reconnects the worker with `--resume`, **sends no message**, and the `metadata` is not handed to the agent.
  [SPEC-012](../../../cats-runtime/docs/specs/SPEC-012-scheduled-wakeup-substrate.md) states explicitly "not a general scheduler,
  heartbeat system, or product workflow engine".
- The NDJSON stream silently sends a `progress kind:"heartbeat"` every 30 seconds; that is a keep-alive, not a product heartbeat.
- The runtime has no webhook, event bus, Telegram or idle reclaim; the only event subscription is `GET /sessions/{id}/stream`.
- The other timers (the FileWatcher of the CLI transcript directory, native/agent discovery every 5 seconds, browser/worktree TTL) are all housekeeping
  and not trigger sources for the agent.

Process, storage and packaging:

- `WorkerPool` has one `WorkerProcess` per runtime session, with the cap controlled by `CATS_RUNTIME_MAX_SESSIONS`
  (the default was 10 when ADR-127 took inventory, and the runtime release guide records that it was later raised to 50; the number was not re-verified in this round).
  Cancellation is SIGTERM followed by SIGKILL after 5 seconds; after a resident CLI is cancelled the session becomes `closed` and needs resume. Idle workers are not reclaimed.
- All state is JSON/JSONL under `~/.cats/runtime` (`CATS_RUNTIME_DIR`): `config/providers.yaml`, `management.yaml`,
  `data/sessions.json`, `data/wakeups.json`, `sessions/history/<id>.jsonl` and so on, with no database.
  The runtime owns the session id, resume id, per-session transcript and wakeup; conversation, room, task, companion memory and
  presence are all in the platform.
- [bundle-runtime.mjs](../../../cats-runtime/scripts/bundle-runtime.mjs) produces a single ESM file with esbuild, but it still needs
  `node_modules/yaml`, `runtime-skills/`, `config/*.example` and the catalog JSON, located by `CATS_RUNTIME_PACKAGE_ROOT`.
  There are no native dependencies that need compiling; Node `>=22.12.0`.
- Telemetry is only the `progress` events, in-memory metering, `/diagnostics/*` and the passive `/usage/snapshot`;
  `POST /usage/refresh` goes through each CLI's own control protocol and reads no credential file.

### cats-platform 0.11.1

Companion life loop (the owner's "alive" is here):

- The entry `startCompanionLifeLoop` ([life/loop.ts](../../../cats-platform/src/products/chat/companion/life/loop.ts))
  is turned on by the official entry `src/index.ts` according to `CATS_COMPANION_LIFE_LOOP`, and the test `createServer` does not start it by default;
  after starting it runs the first time at 5 seconds and then ticks every 60 seconds without overlap.
- On each tick, for every companion Cat that has a DM lane: the rhythm in `CompanionBox.life` (`rhythm.ts`, `profile.ts`, default bedtime
  23:00, wake window 07:00 to 09:00) computes the desired state, asks the runtime whether the session is alive, wakes it through the existing channel activation
  path when it should be awake but is not, and deactivates it when it should sleep and the lane is idle.
- Constants in `loop.ts`: fall asleep after 15 minutes idle, back off 5 minutes on `Max sessions`, defer the heartbeat when the owner spoke within 10 minutes,
  retry 4 minutes after a heartbeat hits busy, retry 30 minutes after a failure, and count as greetable within 3 hours of waking.
- The heartbeat ([heartbeat.ts](../../../cats-platform/src/products/chat/companion/life/heartbeat.ts),
  [companionLifeLoop.ts](../../../cats-platform/src/products/chat/api/companionLifeLoop.ts)): 2 to 10 minutes after waking,
  then at a random 30 to 120 minutes, it sends a turn not shown to the user into the **same** DM runtime session; a `[quiet]` reply is discarded,
  and any other content is written to the DM lane as an ordinary Cat message and mirrored to Telegram. It holds an in-process gate keyed by runtime session
  ([sessionTurnGate.ts](../../../cats-platform/src/products/chat/state/runtime-dispatch/sessionTurnGate.ts)),
  so the owner's messages queue instead of getting a 409.
- Sleep closes only the worker and keeps the DM lease's session id; when it wakes and the execution target is compatible, it reconnects to the same
  provider-native session through Runtime resume; retarget does not resume the old provider. Since 2026-10-26 every proactive turn carries that DM's conversation handoff pack
  (12,000-character limit), role, reply language, checkpoint and the filtered memory (PR #319, #321).
- Explicit non-goal: there is no OS-level background start, and when Cats is not open or the computer is asleep the Cat will not wake (ADR-127 Negative).

Telegram / DM:

- Owned by the platform server process. Long polling by default ([polling.ts](../../../cats-platform/src/platform/transports/telegram/polling.ts),
  ADR-029), with an optional webhook through the Desktop-managed ngrok/Funnel ingress (ADR-139).
- Inbound goes through `bridge.ts`, which resolves the bound Cat and reuses or creates that Cat's DM lane, then into the chat adapter and
  `runtime-dispatch/routing.ts` (about 7.7K lines) for ensure/wake/resume and the supervised runtime send;
  replies are sent in order, split into 4000-character segments, photos go through `sendPhoto`, and heartbeats and Web-originated messages are mirrored via transport fanout.
- `TelegramRoomBridge<TState>` is a generic port, but its only implementation is bound to ChatState; fanout and the adapter import chat product code;
  the token is stored in plain text in core state. Telegram allows only one `getUpdates` consumer per token.

Desktop host (`desktop/host/`):

- `main.ts` is about 2.9K lines; the main window is an ordinary framed window, and closing it hides to the tray. Reusable modules: `tray.ts`, `trayMenu.ts`,
  `desktopStartup.ts` (start at login by default, no window, stay in the tray), `windowPlacement.ts`, `candidateProfile.ts` (single-instance lock,
  and the candidate profile can already isolate home, userData, port and AppUserModelId), `processSupervisor.ts` (runtime first then platform,
  an unexpected exit is marked `failed` with no automatic restart), `updateManager.ts`.
- There has been no attempt at any widget, pet or desktop layer. The only frameless/transparent window is the screenshot overlay
  ([screenshotOverlayWindows.ts](../../../cats-platform/desktop/host/screenshotOverlayWindows.ts): `screen-saver`
  level always-on-top, skipTaskbar) and the update dialog's 1×1 hidden owner.
- The process topology follows ADR-003: Electron main supervises the two sidecars runtime and platform, the renderer talks only to the platform, and the platform talks only to the
  runtime over loopback HTTP.

Package and dependency facts:

- The platform has **no npm dependency** on the runtime and goes only through `CatsRuntimeClient` (`src/runtime/client.ts`) over HTTP; Desktop pins the runtime by SHA at each release (0.11.1 pins `5212fa59`).
- The `exports` of `@cats-inc/cats-platform` has only `.` (Electron main) and `./app-sdk`; the companion, dispatch and Telegram logic
  have no external interface.
- A conversation is a Chat channel, stored together with `CatsCoreState` as one JSON snapshot (`chat-state.local.json`);
  `FileChatStore` queues in-process and then atomically overwrites the whole file; provider/model are set per participant per conversation (ADR-131),
  and Catlas is the only global binding.
- ADR-110 point 7: a new repo needs at least one durable boundary (independent ownership, a truly independent release cadence, a stable versioned dependency contract,
  or a measurable reduction in coordination cost); an artifact format alone is not enough.

App SDK / .catsapp:

- Can: a sandboxed iframe renderer, up to 8 frontends, a Node service and a background worker (ADR-125/SPEC-122, still a candidate).
- Cannot: own a window, tray, always-on-top or login item; keep running after Cats is closed; receive Telegram or drive a conversation/session;
  `jobs.schedule` is validated only in the manifest (`catsAppValidation.ts`) and has no scheduler to run it; third parties cannot run executable components.
- Conclusion: not suitable for "one exe, one bot".

Catlas-related documents: ADR-054, 061, 066, 070, SPEC-071 (the in-window floating/docked pill), ADR-140, SPEC-131, PLAN-123 (curated
assist and titles). ROADMAP open items: schedule- or wakeup-driven Guide Cat refresh, companion surfaces, missions and schedules.
Nowhere in the documents is there a record of a desktop widget, a standalone companion exe or bot-as-process.

### desktop-work-fleet 0.4.2

- It is not an agent fleet. It is the owner's note product "Work Fleet": one card per matter, nine-group formation, per-device layout, Google Drive
  appDataFolder sync. `src/` has no `child_process`, and no calls to claude/codex/gemini, session resume or output parsing.
  Claude Code's "FleetView" is only a name collision.
- What it provides is **a native shell already verified on real machines**:
  - Windows (.NET 10 WPF + WebView2, `src/native/windows/`): three layers wallpaper/desktop/floating. The desktop layer is attached under the Explorer host
    that owns `SHELLDLL_DefView`, above the icons; the wallpaper layer is attached to `WorkerW`, and when there is no ready host it asks Explorer to create one with `0x052C`
    ([NativeShellLayers.cs](../../../../sammykenny2/desktop-work-fleet/src/native/windows/app/NativeShellLayers.cs),
    ADR-030). The floating layer is a per-pixel transparent layered window where only the note area takes input
    ([DesktopSurface.cs](../../../../sammykenny2/desktop-work-fleet/src/native/windows/app/DesktopSurface.cs), ADR-017).
  - Tray (`Shell_NotifyIcon` v4 + WPF Fluent menu, `NativeTray.cs`, `core/TrayMenu.cs`, ADR-019), global shortcuts that do not steal focus,
    a named-pipe single instance (`SingleInstance.cs`), start at login and close-to-tray (ADR-043), a GitHub release feed updater
    (`NativeUpdater.cs`, ADR-044), self-contained MSIX packaging (ADR-036), and CrashGuard, which detaches from Explorer first and then reports (ADR-045).
  - macOS AppKit + WKWebView and Linux GTK + layer-shell each have a corresponding host (ADR-023, 025, 031).
- Two lessons that directly affect the bot's design:
  - Timers of a hidden WebView are throttled to about once a minute, so the fleet added a 20-second `host-tick` in the native main process
    (`FleetWindow.cs`). **The bot's life loop and schedules must live in the main process and not in the renderer.**
  - ADR-049: Explorer's desktop window has no redirection surface, so content drawn by WPF itself does not reach the screen once attached, and it finally succeeded only with a windowed WebView2 going through
    DirectComposition. There is no precedent for how Chromium/Electron behaves under the same conditions.
- ADR-058 + SPEC-009 + PLAN-009 (2026-10-20, Proposed, not implemented): move the data authority to a "non-visual resident core", with the presentation becoming a
  disposable child process, over verified local IPC, with a continuous readiness/recovery state machine. This is exactly the shape the bot should have; PLAN-009 Phase 0.3
  is still choosing the non-visual JS host.

## Dependency direction options

| Option | Content | Assessment |
| --- | --- | --- |
| A. Depend directly on cats-runtime | The new member goes through the process + HTTP contract like the platform, pins the runtime version, and owns its life loop, event entry and note storage | Consistent with runtime ADR-009 and the platform's current state; the runtime is already a public npm package; the durable boundary of ADR-110 point 7 holds (independent release cadence, versioned contract) |
| B. Depend on cats-platform | Import the platform's companion/Telegram/dispatch | The platform `exports` has none of these interfaces; the logic is tied to ChatState's single JSON store and in-process gate; the package extraction of ADR-110 points 4 and 6 would have to be done first |
| C. Make it a .catsapp | Provide the note as an App inside Cats Desktop | Cannot own a window/tray/login item, dies when Cats is closed, has no scheduler or session SDK; opposite to "greatly lightened, independent process" |
| D. Thin presence client | Only a client of the platform server, like Mobile | Reuses the most, but is not standalone and still needs Desktop or a headless platform to stay resident |

This round leans to A; B is listed for re-evaluation if the platform later extracts transport/client packages, and C and D do not meet the owner's core requirements.
This is a research judgment, and the decision is left to an ADR.

## Candidate topology and alive mechanisms

The following are research-level candidates, not an adopted design.

```text
bot.exe             shell: tray, note windows, single instance, updater
  └─ bot core       Node: life loop, event entry, global provider/model, note storage
       └─ cats-runtime   app-managed child process, --port 0, private CATS_RUNTIME_DIR
            └─ provider CLI   claude/codex/pi resident; others spawned each turn and resumed
```

- "One exe, one bot" is three to four processes at the OS level, which is determined by the runtime's process + HTTP contract.
- One runtime instance per bot is simpler than sharing: the runtime's session cap and per-resource singletons are coordinated only inside a single process.
  The cost is a resident Node and CLI memory footprint per bot.
- Each bot needs a private `CATS_RUNTIME_DIR` and must point the discovery directory at an empty folder, otherwise the FileWatcher imports all of the user's CLI sessions.
- The alive mechanisms can directly reuse the shape of ADR-127:
  - Per-minute tick: if the session is not ready, resume or rebuild it; after a runtime restart it wakes itself back within a minute.
  - Heartbeat: send a hidden turn into the same session at a random interval, discard `[quiet]`; defer when the owner just spoke; queue 409 with a gate.
  - Events: Telegram long polling, file watching, a local webhook, OS wake/login events.
  - Schedule: use the runtime wakeup as the cron timer (UTC), and at the due time the bot core itself sends a message into the session.
  - Sleep: close the worker, keep the session id, and on waking resume the same provider session.
- Cost: an awake bot holds one resident CLI process and one runtime session slot; each heartbeat, even `[quiet]`, is a real turn and consumes quota.
- Global provider/model: store only one `{ provider, model }`, in the same shape as `GuideCatRecord`; changing it retargets all sessions.
- The shell has two stages: stage one is Electron, following the platform desktop/host pattern, with the note as a small frameless window with optional alwaysOnTop,
  and no unknowns; stage two is the desktop layer, choosing between "Electron + a native helper porting the fleet's attaching method" and "adopt the fleet's C#/WPF/WebView2 shell
  with the Node core as a child process".

## Open questions for the ADR

1. The mapping between notes and sessions: a bot has only one living main session and the notes are its views; or one session per note, with only the main note kept awake.
   Heartbeats and events must have a unique target session.
2. The shell's technology choice: Electron (the same stack as Desktop, `desktop/host` can be copied directly) or a fleet-style native shell (three layers verified, WebView2 is light,
   but one more .NET toolchain). The desktop layer on Electron needs experimental evidence.
3. Whether multiple bots share a runtime, and each bot's memory and quota budget.
4. Telegram binding: the bot and Desktop cannot share a token; whether it needs its own bot binding settings and a token storage method.
5. Naming: both `cats-bots` and `cats-agents` partly overlap existing vocabulary (a Cat is an agent; the bot binding of ADR-028).
   The semantics of "one process, one bot" are closer to `cats-bots`.
6. The relationship with Cats Desktop: isolation of the data root, runtime instance and CLI login when Desktop and a bot run on the same machine.
7. OS sleep and the signed-out state: as with ADR-127, the bot will not wake while the computer sleeps; whether this boundary is accepted.

## Risks

- Rewriting continuity may regress: PR #319 (the first turn of an initializing session is executed by the heartbeat), #321 (resume after sleep distinguished from retarget,
  handoff pack, filtered memory) and #327 (reply segments delivered in order) are all buried in chat state. These three behaviors should become acceptance items for the bot core.
- Single-process assumption: the platform's store and session gate assume "both writers are inside the platform process"; the bot cannot
  share a data root, runtime session or Telegram token with Desktop.
- Runtime 0.x contract drift: it needs to be pinned by SHA or version like Desktop, with contract tests run on upgrade.
- The desktop layer depends on Explorer's non-public protocol (`0x052C`, WorkerW), and the fleet has accumulated several crash fixes for this in ADR-045, 049, 050 and others;
  the Electron path has no precedent.
- Each bot's resident cost (Node + CLI + possibly Chromium) and heartbeat quota scale linearly in a multi-bot scenario.

## Suggested next steps

1. Use this document as input to write the first ADR: decide the dependency direction (candidate A), the mapping between notes and sessions, and the stage-one technology choice of the shell.
2. Register the new member in cats-one's `config/developer-workspace.json` and `templates/workspace/AGENTS.md.template`, and rerun
   workspace sync; fill in `AGENTS.md` Project Metadata, `package.json`, `README.md` and the LICENSE holder (still a bootstrap
   placeholder for now).
3. First build the bot core without UI, and verify three things: it wakes itself after a runtime restart, the heartbeat replies `[quiet]`, and an incoming Telegram message gets a reply.
4. Only then add the tray and note windows; the desktop layer gets its own experiment and evidence bar.

## References

- cats-runtime: [docs/api.md](../../../cats-runtime/docs/api.md),
  [SPEC-012](../../../cats-runtime/docs/specs/SPEC-012-scheduled-wakeup-substrate.md),
  [ADR-009](../../../cats-runtime/docs/decisions/009-keep-cats-runtime-separately-packageable-with-app-managed-local-startup.md),
  [ADR-032](../../../cats-runtime/docs/decisions/032-replace-gemini-cli-with-antigravity-cli.md),
  [bundle-runtime.mjs](../../../cats-runtime/scripts/bundle-runtime.mjs).
- cats-platform: [ADR-003](../../../cats-platform/docs/decisions/003-electron-host-manages-local-services.md),
  [ADR-035](../../../cats-platform/docs/decisions/035-invert-platform-dependency-and-extract-shared-design-layer.md),
  [ADR-054](../../../cats-platform/docs/decisions/054-use-a-platform-level-guide-sidecar-for-day-0-assist.md),
  [ADR-070](../../../cats-platform/docs/decisions/070-use-a-surface-safe-floating-and-shared-chrome-docked-guide-cat-placement-model.md),
  [ADR-090](../../../cats-platform/docs/decisions/090-adopt-generic-schedule-rules-for-mission-triggers.md),
  [ADR-110](../../../cats-platform/docs/decisions/110-keep-platform-clients-in-one-repository-with-explicit-package-boundaries.md),
  [ADR-124](../../../cats-platform/docs/decisions/124-model-companion-as-a-cat-role-not-a-skill-profile.md),
  [ADR-127](../../../cats-platform/docs/decisions/127-keep-companion-cats-alive-with-a-platform-owned-life-loop.md),
  [SPEC-124](../../../cats-platform/docs/specs/SPEC-124-alive-companion-life-loop.md),
  [PLAN-117](../../../cats-platform/docs/plans/PLAN-117-alive-companion-life-loop.md),
  [ADR-139](../../../cats-platform/docs/decisions/139-manage-one-desktop-remote-ingress.md).
- desktop-work-fleet: [ADR-007](../../../../sammykenny2/desktop-work-fleet/docs/decisions/007-desktop-scene-and-platform-host.md),
  [ADR-017](../../../../sammykenny2/desktop-work-fleet/docs/decisions/017-windows-composition-surface-and-input.md),
  [ADR-019](../../../../sammykenny2/desktop-work-fleet/docs/decisions/019-windows-shortcuts-and-tray.md),
  [ADR-030](../../../../sammykenny2/desktop-work-fleet/docs/decisions/030-windows-explorer-wallpaper-layer.md),
  [ADR-058](../../../../sammykenny2/desktop-work-fleet/docs/decisions/058-desktop-presentation-lifecycle-and-core-isolation.md),
  [platform capability research](../../../../sammykenny2/desktop-work-fleet/docs/research/2026-10-04-desktop-interaction-platform-feasibility.md).
- Relative paths assume the side-by-side checkouts of the cats-inc developer workspace; the fleet is at `../sammykenny2/desktop-work-fleet`.

*Last updated: 2026-10-27*
