# SPEC-006: Desktop Control Session MCP (Windows)

## Metadata

| Field | Value |
| --- | --- |
| Status | Contract frozen (P0, 2026-10-29); phases A and B implemented under PLAN-006 |
| Owner | Bot core, headless CLI, Electron shell |
| Reviewer | Product owner, Platform and Runtime maintainers |
| Baseline | Bots `a0a9ec5`; 2026-10-29 |
| Decision | [ADR-005](../decisions/005-give-the-bot-owner-consented-desktop-control.md); Platform ADR-141 |
| Plan | [PLAN-006](../plans/PLAN-006-desktop-control-session-mcp.md) |
| Contract | [Platform SPEC-133 § Cross-implementation contract](../../../cats-platform/docs/specs/SPEC-133-desktop-control-session-mcp.md#cross-implementation-contract) |

## Summary

Let the Bot's provider session observe and operate native Windows apps, with the owner's
consent, through a second Bot-served session MCP named `cats-desktop`. The Bot core serves
it on loopback next to `cats-bot`; a native helper that the Bot packages makes the OS calls.

Cats Desktop implements the same capability separately in Platform SPEC-133. This document
does not repeat the shared parts. The server name, tools (SPEC-133 R4 and R5), error codes,
exclusion categories, and the injection, turn, grant, hold, stop, privacy and capability
state rules are SPEC-133's cross-implementation contract, and this implementation follows it
exactly. A change to the contract updates both SPECs on the same day. Below are only the
Bot's own requirements.

## Goals and User Stories

- After the owner turns desktop control on in the profile and enables it for a conversation,
  messages the owner sends from the note or `cats-bot say` can use the observation tools on
  apps the owner granted.
- The owner answers app grant requests in the note or the CLI. A Telegram message only says
  that a grant is waiting.
- In phase B, every input action goes through the provider's `tool_approval` (SPEC-004),
  and the owner can stop from the tray, the note or the CLI.

## Non-Goals

- Importing Platform or reusing its helper.
- Desktop tools in heartbeats, schedules, other background work or Telegram-triggered turns.
- Answering grants or approvals from Telegram.
- macOS and Linux: the tools are not injected there, and the capability reports
  `unavailable`.

## Bot-Specific Requirements

| ID | Requirement |
| --- | --- |
| BDC-01 | Available only on Windows when the packaged helper exists and its handshake succeeds. Otherwise `cats-bot capabilities` and the note show `unavailable` with the reason, and nothing is injected |
| BDC-02 | A profile switch for desktop control, off by default, changed only by the owner. Whether this needs a profile schema change, and how existing profiles upgrade, is decided in PLAN-006 P0 under the Bot's protected profile upgrade rules. Turning it off revokes all grants and control, cancels helper actions and ends the helper |
| BDC-03 | A per-conversation switch, off by default and persisted with the conversation. Turning it off revokes that conversation's grants and control |
| BDC-04 | `mcpServersFor(conversationId)` adds `cats-desktop` only when BDC-01 to BDC-03 hold and Runtime's capability snapshot for the session shows an explicit `providerPolicy` under which injected MCP tools require interactive approval (SPEC-133 DC-04). Otherwise it is not injected and the capability snapshot says why |
| BDC-05 | Tools serve only a turn whose work item is `owner_message` with source `owner`. Any other work item, including `source: 'telegram'`, heartbeats and schedules, gets `not_owner_present`. The decision is made per turn without changing the descriptor |
| BDC-06 | The server follows the existing `cats-bot` server pattern: loopback HTTP, the conversation in the URL path, and a per-session bearer token that is never written to logs, the journal or receipts |
| BDC-07 | Grant requests (SPEC-133 DC-08) appear through `BotHostApi` as their own snapshot and response pair, shown in the note and by a new CLI command. They never pass through `respondProviderInteraction` or `resolveApproval`. Grants live in the core's memory only and are cleared by stop, switching off and core restart |
| BDC-08 | The never-grantable list adds the Bot's own processes and windows (shell, note, tray menus) and Cats Desktop |
| BDC-09 | A waiting grant request keeps the global gate like other owner interactions, so background work cannot take over the waiting session |
| BDC-10 | While control is held, the tray shows it and the note shows a banner with "Stop". Stop is also a CLI command. Stopping has the meaning of SPEC-133 DC-12 |
| BDC-11 | The helper lives in `native/windows-desktop-control/` in this repository and is packaged as an electron-builder extra resource for Windows builds only, signed under ADR-004's Standard signing rules. Its internal protocol may follow SPEC-133 R7 but is this repository's own |
| BDC-12 | The journal, receipts, logs and Telegram notices contain no screenshot bytes, UIA values, typed text or clipboard content (SPEC-133 DC-17) |
| BDC-13 | The session capability snapshot adds a "Cats desktop control" entry with the SPEC-133 DC-18 state values, separate from the provider-native `computer_use` dependency |

## P0 Decisions (2026-10-29)

These follow the contract version frozen in Platform SPEC-133 on 2026-10-29, including its
"Frozen contract details".

- **Profile field (BDC-02)**: `desktopControl: { enabled: boolean }` inside profile schema 2.
  `normalizeProfile` already fills a missing field with its default, so the default
  `{ enabled: false }` needs no schema bump or upgrade step. An older Bot that rewrites the
  profile drops the field, which turns the feature off, so a downgrade fails closed.
- **Conversation switch (BDC-03)**: `desktop-control.json` in the Bot's data directory,
  `{ "version": 1, "conversations": [] }`, written atomically. Conversation records keep
  schema 1.
- **Policy gate (BDC-04)**: the same rule as SPEC-133 DC-04, read from the Bot's
  `sessionCapabilities` snapshot: `interactions.host` lists `tool_approval`, the policy source is
  `explicit`, the requested approval is `on-request` or `untrusted`, and the status is
  `verified` or `not_observed`. Anything else, or no snapshot, injects nothing.
- **Owner-present turn (BDC-05)**: the running work item has `kind: 'owner_message'` and
  `source: 'owner'`.
- **Host API (BDC-07)**: `BotHostApi` gains `desktopControlState(conversationId)`,
  `setConversationDesktopControl(conversationId, enabled)`,
  `respondDesktopGrant(conversationId, requestId, decision)` and
  `stopDesktopControl(conversationId?)`. The profile switch uses `updateProfile`.
- **CLI (BDC-07, BDC-10)**: `cats-bot desktop <conversation> --id <bot>` shows state;
  `--enable`/`--disable` set the conversation switch; `--grant <requestId> allow|deny` answers
  a grant; `--stop` stops control.

## P2 Implementation Details (2026-10-29)

These are the Bot's own choices where SPEC-133 leaves the detail to each implementation; the
cross-implementation contract is unchanged.

- **Descriptor per send (BDC-04)**: a session has no capability snapshot before it exists,
  so sessions are created without `cats-desktop`. Before every send the core reads the
  session's snapshot and, for a qualifying conversation, passes the full `mcpServers` set
  with the send; Runtime recycles the worker once, when the set first changes, and the set
  then stays identical on every send (BDC-05). While the profile switch is on, every send
  carries its explicit set, so a conversation that stops qualifying loses the descriptor;
  its token is revoked at the same time. A new session of the conversation gets a new token
  and no grants. Turn `instructions` are not used, because Runtime would persist them over
  the Bot's own; the rules travel in the MCP `initialize` instructions.
- **Availability (BDC-01)**: the helper must also complete its `hello`. A helper that
  answers with another protocol keeps desktop control `unavailable` (`handshake_failed`)
  until the owner turns the feature off and on.
- **Never grantable (BDC-08)**: `hello` carries the core's process id and executable (the
  Electron main process, whose renderer, GPU and runtime children run the same executable)
  and Cats Desktop's default install paths. The core also refuses `Cats.exe` and
  `Cats Bot.exe` by file name wherever they are installed. The parent process is not
  listed: for the Electron main process it is the launcher, not the Bot.
- **Owner-present turn (BDC-05)**: an interrupted turn that the owner approves to run
  again is queued with source `recovery`, so it is not owner-present.
- **Global gate (BDC-09)**: while any grant request waits, the queue starts only owner
  messages; heartbeats, schedules and events stay queued, and the life loop treats the
  waiting conversation as busy, until the request is answered, denied by stop or a switch,
  or expires.
- **Stop (BDC-10)**: a helper answer that arrives after a stop is discarded and the call
  returns `stopped`.
- **Capability entry (BDC-13)**: `sessionCapabilities` adds
  `desktopControl: { name: 'Cats desktop control', status, reason }` beside Runtime's
  `observation`, also when the snapshot is unavailable. `holding` is reported from phase B.
- **Redaction (BDC-12)**: the transcript and turn events keep a one-line summary instead of
  a desktop tool's result (errors stay readable). Telegram gets one generic notice per new
  grant request in the home conversation, naming no app and no request.

## P3 Implementation Details (2026-10-29)

- **Who may act (BDC-07)**: the shell accepts `setConversationDesktopControl`,
  `respondDesktopGrant` and `stopDesktopControl` only from the note of the named
  conversation, and `desktopControlState` from that note or, without a conversation, from
  Settings. Settings, the floating cat and the tray never answer a grant; the tray opens the
  note that waits.
- **CLI (BDC-07, BDC-10)**: every `cats-bot desktop` action goes through the running Bot's
  control endpoint (`desktop_state`, `desktop_switch`, `desktop_grant`, `desktop_stop`) and
  prints the resulting state as JSON. `--stop --all` stops every conversation, like the
  tray. Without a running Bot only `--stop` succeeds, since grants and requests end with the
  core.
- **Visibility (BDC-01, BDC-10)**: the note shows desktop control while the profile switch is
  on, including the unavailable reason, and always while the conversation has grants or
  waiting requests. Settings hides the profile switch off Windows unless it is on. In phase A,
  Stop appears in the note whenever the conversation has grants or waiting requests, and in
  the tray whenever the profile switch is on.
- **Notices (BDC-12)**: the shell's bubble for a new grant request, the tray and `cats-bot run`
  output name no app, path or reason.

## P5 Implementation Details (2026-10-29)

Phase B follows SPEC-133's R5, "Phase B helper rules" and "Phase B server rules" as written:
the seven tools, their schemas, the key allowlist, the snapshot and element-id rules, the order
of checks for the five input tools, holding, and clipboard tools that need no grant. Where
SPEC-133 leaves the detail to each implementation, the Bot decides as follows.

- **Helper (BDC-11)**: the Bot's copy carries Platform's phase B ops, guards, element cache and
  immediate `cancel` unchanged, plus `native-check/input-check.mjs` and its probe app, which
  are test tools and never packaged. Packaging needs no change: publishing compiles the
  project, which excludes `native-check/`.
- **End of turn (SPEC-133 DC-11)**: Platform releases control when its send returns. The Bot
  releases it when the core finishes the work item that took control, whatever the outcome,
  including a cancel. Only that work item shows or releases the hold, so a later turn of the same
  session never inherits it.
- **Stop (BDC-10, SPEC-133 DC-12)**: the note's banner, the tray and `cats-bot desktop --stop`
  all reach `stopDesktopControl`. Besides revoking grants, Stop forgets the conversation's
  window ids, snapshots and element ids, so after a new grant the bot lists windows again. A
  stop that lands while an input tool checks its window sends nothing to the helper. Both rules
  are now shared with Platform (SPEC-133 "Stop and revoke win every race"). The helper's
  `cancel` is global, so it is sent only when a stopped conversation held control. Turning the
  conversation's switch off while it holds control also sends `cancel`, since BDC-03 revokes
  control. A turn that ends while one of its input ops is still in the helper (the owner
  cancelled the turn) sends `cancel` too, and a later Stop sends it while such an op is still
  in progress. The queue runs one turn at a time, so this `cancel` reaches only that
  conversation's op.
- **Indicator (BDC-10)**: the Bot has no topmost notice window. While control is held:
  - The tray's first item is "Stop desktop control (app)" and its tooltip says the bot is
    operating the app.
  - The note shows a banner under its header that names the app, with Stop.
  - The core does not open or raise the note when control starts, because a Bot window brought
    forward would cover the target or take its focus (`covered`, `not_foreground`).
  - `DesktopControlState.holding` lists `{ conversationId, app }`, `conversation.holding` names
    the app, and `desktop.control` events carry `holding`.
  - The held app is named only in these indicators and in `cats-bot desktop`. Logs, `cats-bot
    run` output and Telegram name no app.
- **Diagnostics (BDC-12)**: the helper client drains the helper's stderr and keeps only its
  tail in memory. When the helper exits unexpectedly, the Bot's log gets one line with the exit
  code and only the exception type names and stack frames from that tail. Exception messages
  are dropped, since one could quote typed or on-screen text.
- **Redaction (BDC-12)**: the transcript keeps a one-line summary instead of the input of
  `type_text` and `clipboard_write`, as it already does for every desktop tool's result. Tool
  summaries give character counts, never the text. Interaction receipts carry no tool input.
- **Helper call timeouts**: `type` 180 seconds, other input ops 30 seconds, clipboard ops 10
  seconds.
- **Instructions**: the MCP `initialize` instructions are Platform's phase B text with the Bot's
  two additions: the full tool id `mcp__cats-desktop__request_app_access`, since Claude Code
  defers MCP tools behind ToolSearch, and the owner-present rule (BDC-05).
- **Argument errors**: the same wording as Platform: "Unexpected argument `<name>`; this tool
  takes only `<arguments>`." and "`<id>` is required and must be an id returned by a tool.",
  still with the `unavailable` code. The Bot cuts an echoed argument name at 40 characters.
- **Strings**: the repository has no localization, so the new note and tray strings are English
  only.

## Acceptance Criteria

| ID | Required evidence |
| --- | --- |
| B1 | Nothing is injected on macOS/Linux, without the helper or after a failed handshake; `capabilities` shows the reason |
| B2 | Injection and turn matrix: with the profile switch off, the conversation switch off, no explicit policy, `never`, a heartbeat, a schedule or a Telegram message, no tool can be used; an owner message from the note and from `cats-bot say` with an explicit `on-request` policy can use the tools, and a real Claude Code run shows a `tool_approval` for every call |
| B3 | Grants: only the note or the CLI can grant; a provider approval, "allow for this session" or Telegram text cannot; the Bot's own windows and Cats Desktop are refused; grants are cleared after stop, switching off and core restart |
| B4 | The SPEC-133 A4 capture check (a covering ungranted window leaves no pixels) passes with the Bot's helper |
| B5 | Stop from the tray, the note and the CLI, the lock pause, and the operator-active pause are verified on a real desktop |
| B6 | A waiting grant holds the global gate, and background work resumes after it resolves |
| B7 | Phase B: guard fixtures for every input tool, plus native acceptance against a throwaway test window |
| B8 | The journal, receipts, logs and Telegram notices contain no screenshot bytes, typed text or clipboard content |

*Created: 2026-10-29. Phase A and phase B authorized by the owner on 2026-10-29.*
