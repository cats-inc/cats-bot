# SPEC-006: Desktop Control Session MCP (Windows)

## Metadata

| Field | Value |
| --- | --- |
| Status | Draft; direction accepted, implementation not authorized |
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

*Created: 2026-10-29. Draft; implementation not authorized.*
