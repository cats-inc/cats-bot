# SPEC-004: Provider Interactions and Tool Visibility

## Metadata

| Field | Value |
| --- | --- |
| Status | Implemented; for the acceptance scope and the upstream helper limits see PLAN-004 |
| Owner | Bot core, headless CLI, Electron shell |
| Reviewer | Product owner, Runtime maintainers |
| Baseline | Bots `7951c28`; Runtime package pin 0.6.1; 2026-10-28 |
| Decision | [ADR-001](../decisions/001-build-a-resident-bot-core-on-cats-runtime-with-disposable-presentation.md); Runtime ADR-048 (accepted) |
| Plan | [PLAN-004](../plans/PLAN-004-provider-interactions-and-tool-visibility.md) |

## Summary

Let the standalone Bot answer the provider's native approvals, questions and MCP forms through
cats-runtime, and see the actual tools and effective permissions of this bot's session. The Bot core
owns the wait/reply/recovery state; the CLI, note and tray are only presentations of the same host API
and do not depend on cats-platform.

The shared contract follows
`cats-runtime/docs/specs/SPEC-039-provider-session-capabilities-and-interactions.md`; it corresponds to
Runtime PLAN-049, and Platform SPEC-132/PLAN-124 is another, independent consumer. The contract
documents are merged; the Bot currently adopts exactly the 0.6.2 candidate artifact of Runtime source
`487e7c9698ac4ef4b3f19dcf4baee9ee3d61ae21`, with the digest in vendor/README, and no new package
version has been published. This work follows ADR-001's standalone resident core and does not create a
separate Bot architecture ADR.

## Goals and User Stories

- The owner can answer the same waiting provider request from the headless CLI or the note, without
  rerunning the original turn.
- When no note is open, background work waits safely; the tray/notification can take the owner back to
  the right conversation.
- Differences in MCP/tools/permissions from the Terminal can be diagnosed, and Chrome and desktop
  tools verified separately.
- A bot's global provider/model, per-conversation isolation and bot-wide serialization remain in
  effect.

## Non-Goals

- Importing Platform, bypassing the Runtime to spawn Codex directly, or handling the app-server
  JSON-RPC itself.
- Merging the existing `ask_owner`, the interrupted-rerun approval and the native tool approval into
  one kind of boolean answer.
- Running several turns at the same time, moving the user's Codex home/credentials, or building a
  general plugin installer.
- Providing Telegram native form/approval replies in this phase; Telegram can send notifications, and
  replies use the local CLI/shell.

## Before implementation

The Bot already has `awaiting_owner`, `ask_owner`, interruption recovery and the `approve` operation,
but the Runtime currently does not hand Codex native questions/MCP elicitation to this pipeline. The
native callback is not yet connected. At that time the Bot's permissions and cwd were provided by the
profile, and the Runtime package was fixed at 0.6.1; having a tray or using spawn does not by itself
give all the capabilities of the Terminal. This document changes no existing bot's provider or
settings.

## Requirements

### B1. Interaction boundary of the Bot core

The Runtime client consumes SPEC-039 capability, snapshot/events and typed response. The core declares
only the interaction categories that the CLI/shell really support; when the selected Runtime or
provider does not support one, it reports so explicitly. `BotHostApi` adds methods to
list/observe/answer/cancel native interactions, and the shell must not obtain the Runtime URL/key.

Each interaction is bound to the bot, conversation, work item, runtime session, worker generation,
execution and interaction ID. A reply across bots, across notes or from an old generation never takes
effect. `ask_owner`, recovery rerun and `provider_interaction` are distinguished by explicit kinds, and
the semantics of the existing `approve` command are not silently changed into answering any native
question.

### B2. Serialized queue and background work

A work item can be projected as `awaiting_owner`, but the original provider turn is still running, so
the original bot-wide turn gate must be kept. Other turns queue up; waiting does not release the slot
to run a new model turn in parallel. Answers and cancellation go through an independent control path
and cannot be queued behind the work being waited on, to avoid a self-deadlock.

The reconcile tick continues to do health reconciliation without calling a model, recognizing
active/waiting sessions, and must not close one, rebuild it as an orphan or resend the original
prompt. The heartbeat is coalesced/deferred during waiting; due schedules are kept according to the
existing journal and coalescing and must not create unbounded retries or notifications. Interactions
and background turns use the same admission policy; having no window is not a reason to widen
privileges.

### B3. Journal, closing windows and recovery

The journal stores the necessary kind, association, deadline and de-sensitized state; the native
callback exists only in the Runtime. Closing all notes, rebuilding the renderer or the CLI being
briefly offline does not affect a native request that is still alive. Reconnecting reconciles with the
authoritative snapshot/revision, and does not resend an answer based on the journal's pending field.

When the core/Runtime/worker restarts, first confirm whether the original execution is still alive with
the same identity; if that cannot be proven, mark it interrupted. An old id cannot be applied to the
new worker after resume. If the owner chooses to retry, it must be stated explicitly that it is a new
execution; it must not claim to continue an approval that was lost, and work with external effects must
not be replayed automatically. Expiry, provider resolve, cancel and duplicate replies converge
according to the Runtime's terminal states.

### B4. Global retarget and deletion

Changes to provider/model/instructions/permissions/cwd follow SPEC-001's configRevision boundary. A
waiting turn is still an active turn and keeps its old target/policy; applying the setting stays
pending, or the owner cancels that turn first. Its Runtime must not be restarted early in order to
apply new settings. Conversation deletion, quit and cancel must terminate the corresponding live
request and revoke the card's ability to reply, while keeping the existing schedule cancellation and
journal rules.

### B5. CLI, note and notifications

The headless CLI first provides the native interaction list and typed response operations, supporting
automation-readable results. Sensitive form content can be sent through stdin/controlled input, and
need not be put in the command line argv or the log. The Electron note shows the source, the
question/action, the authorization scope and the deadline, and allows options, free text and the
supported form/external URL flow. Opening an external page must not be treated as completing the
authorization.

Tray/floating Cat notifications can locate the original conversation; they are deduplicated by
interaction ID/revision. An invalidated request no longer offers a clickable approval button. The
unread message count and the pending-reply count are defined separately, and a notification update must
not count the same request as several messages. Telegram notifications contain no secrets or form
answers, and ordinary chat text is not parsed as a native approval.

### B6. Permission and tool diagnostics

The settings page and the CLI show the request policy and the effective approval/access scope reported
by the Runtime. Inheriting the provider configuration and an explicit policy are enabled by explicit
choice; the default/skip effect of an old profile is kept and is not automatically upgraded to full
access. A global policy change is managed by configRevision. Ordinary Bot settings are not inferred to
mean the same permissions on every provider/OS.

Tool diagnostics are based on the real session of the selected conversation, listing the sources of the
provider MCP, the Bot-injected MCP and the built-in/dynamic tools, the observation time, partial
inventories and connection limits. With no worker it shows not yet observed; a diagnostic refresh must
not send a prompt or start a heartbeat. The user's provider config is inherited, and the Bot MCP is
only an incremental injection; a name collision must not override the user's server.

The helper, browser extension and OS permissions for computer use/Chrome show the actually observed
result and the direction for repair. They may depend on an upstream Desktop-only host; the Bot must not
claim to replace it just because it ships its own Electron. The Runtime's private data dir does not
mean the provider home has to be replaced; login data is not moved to make the inventories consistent.

### B8. Claude Code

Runtime SPEC-039 R8 makes Claude Code the second native target, and the Bot enables it automatically
according to the capabilities the provider reports. `tool_approval` is added: tool calls that are
neither commands nor file changes, such as MCP and Claude in Chrome, reuse the generic card on the
note, showing the tool name, the MCP server and an input summary. Claude Code has no
`permission_grant`.

Claude Code has no sandbox on native Windows and can accept only the ceiling "full access + network".
The settings page explains this; when the Runtime is ready, saving a narrower ceiling is rejected
first and does not wait until the next session to fail. To approve actions one by one, choose "Ask when
requested by the agent".

Bot settings can turn on Claude in Chrome for a Claude bot: the runtime restarts the CLI with
`--chrome` and treats it the same as a provider change (configRevision advances, and the restart waits
until the current turn ends). This field is stored in `executionTarget.claudeInChrome`, and absent
means off, so the startup of an old profile is unchanged. Whether the browser is really usable is known
only when a tool actually runs; computer use is not in Claude Code's headless mode.

### B7. Upgrade and data protection

Exactly updating the Runtime dependency is handled in the implementation phase; when reading the
capability fails, the new API must not be assumed to exist. If profile/journal gains fields or states,
first do old-data validation, backup, atomic replacement and failure recovery; data that the new
version does not recognize must stop protectively and must not be erased. The reply body/secrets do not
enter the transcript or the journal. Within the existing minor line the old CLI/config semantics are
kept; a breaking change needs the next minor, and versions and publishing follow later authorization
and are not a side effect of this document's work.

## Acceptance Criteria

| ID | Acceptance |
| --- | --- |
| A1 | With only the Bot core + Runtime and no Platform/Electron, a live native request can be answered with the CLI |
| A2 | Multiple notes, different bots and different generations do not cross answers; a duplicate answer is not resent to the provider |
| A3 | Waiting continues with all windows closed; reconcile does not rebuild a busy session, heartbeats do not overlap, and an answer is not blocked by the queue |
| A4 | A renderer reconnect restores the request; worker/core restart, timeout, cancel and retarget invalidate/defer correctly |
| A5 | The original ask_owner/recovery approve, schedules, global retarget and existing profile permissions pass regression |
| A6 | Inventory sources/partial data/helper offline are clear; controlled Chrome and desktop tools are tested separately |
| A7 | Schema upgrade/failure recovery passes; no secret reply or Runtime key is exposed to the shell and history |

## Dependencies and Open Questions

- The protocol, policy mapping and inventory of Runtime SPEC-039 / PLAN-049; the Bot provides no
  substitute adapter.
- Local-safe URL-flow completion and the supported form schema follow the verification results of
  Runtime P0.
- Native Windows is accepted first; the helper/OS permissions and packaging of macOS/Linux are listed
  separately as pending verification.
- Telegram native replies need another design with permissions, identity and replay protection; this
  phase does not guess its semantics.

## References

- [Resident core contract](SPEC-001-resident-bot-core-and-global-execution.md)
- [Desktop settings and shell](SPEC-002-desktop-presence-settings-and-first-run.md)
- Runtime ADR-048 / SPEC-039 / PLAN-049 and research `2026-10-28-codex-host-capability-gaps`.

*Created / last updated: 2026-10-28*
