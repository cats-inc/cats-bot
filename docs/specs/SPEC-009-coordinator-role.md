# SPEC-009: Coordinator Role

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Draft |
| **Owner** | Product owner |
| **Reviewer** | Independent security review before implementation |

## Summary

Implement [ADR-009](../decisions/009-give-one-bot-a-bounded-coordinator-role.md):
one transferable role lets a bot coordinate the fleet through hub-brokered
tools, without ever acting with the owner's authority.

## Goals

- A holder can list bots, hand them work and ask for new bots.
- The owner keeps every consent decision and controls who holds the role.
- Cross-bot work is bounded, attributable and auditable.

## Non-Goals

- General bot-to-bot messaging for bots without the role.
- Sharing transcripts, memory or secrets between bots.
- Non-native environments (ADR-010).

## Requirements

### Functional Requirements

1. FR-1: `fleet.json` (SPEC-008 FR-2) stores `coordinator`: the holder's bot id
   or null, when it was assigned, and how (`first-run`, `owner`, or
   `confirmed-proposal`).
2. FR-2: First run assigns the first bot. Removing the holder clears the role.
   The owner can assign or clear it in Settings → Bots, or with a CLI command
   through the hub's control endpoint (SPEC-008 FR-25).
3. FR-3: The holder's core attaches the `cats-fleet` session MCP descriptor to
   its sessions only while the hub reports it as holder. The decision is made
   before every send, as for `cats-desktop` (SPEC-006 BDC-04). The hub
   authorizes every call against the current holder. After a transfer, a call
   from the former holder is refused, even if its session still holds the old
   descriptor.
4. FR-4: Tools:
   - `fleet_list`: bot ids, names and states. No transcripts.
   - `fleet_message`: target bot id and text. The hub delivers it as a work item
     in the target's home conversation, with source `bot`, `sourceRef` naming the
     holder, a chain id and a hop count.
   - `fleet_create`: name and persona, plus a provider from those installed. It
     uses first-run defaults: desktop control off, Telegram off, the fleet's
     environment profile, and the fleet cap applies.
   - `fleet_start`, `fleet_stop`, `fleet_heartbeat` (pause or resume) for
     another bot.
   - `fleet_propose_transfer`: the target bot id, or none.
5. FR-5: The owner must confirm `fleet_create`, `fleet_start` for a bot the
   owner stopped, and `fleet_propose_transfer`. The request appears as a decision
   in the holder's note and in the tray's pending requests. A decline or expiry
   returns as the tool result, and nothing happens.
6. FR-6: Refused regardless of arguments:
   - answering any provider interaction, desktop grant, `ask_owner` or recovery
     decision of any bot;
   - changing any bot's provider policy, permissions, desktop or Telegram
     settings, or secrets;
   - reading another bot's transcripts or conversations;
   - deleting bots;
   - assigning the role directly.
7. FR-7: Work from `fleet_message` runs under the target's own execution target,
   policy and approvals. It is not an owner turn, so desktop control is
   unavailable to it (SPEC-006).
8. FR-8: The target's reply returns to the holder as a work item in the same
   chain. Only the holder starts chains; other bots get no messaging tool. The
   hub refuses a message beyond the hop limit, or beyond the holder's per-hour
   message limit, and tells the holder why.
9. FR-9: Every coordinator call (tool, target, chain, outcome) goes to the hub
   log and to the journals of the holder and the target. Delivered text appears
   in the target's transcript, attributed to the holder bot.
10. FR-10: Settings → Bots shows the holder. The holder's note shows its role,
    and messages from another bot render with that bot's name.
11. FR-11: A holder that is not bound to the native environment gets no
    `cats-fleet` tools, and the hub shows why (ADR-010). With one bot in the
    fleet, the tools that target another bot report that none exists.

### Non-Functional Requirements

- **Security**: the hub authorizes every call against the current holder and
  FR-6, never trusting the calling core's claim. Independent security review is
  required before release.
- **Cost**: limits keep a single chain from consuming unbounded model turns.

## Design Overview

```
holder core ──cats-fleet MCP──▶ (served by the holder core, backed by the hub)
        hub: authorize (holder? FR-6? limits?) ─▶ owner confirmation when FR-5
        hub ─channel─▶ target core: work item (source bot, chain, hop)
        target reply ─▶ hub ─▶ holder: work item (same chain)
```

## Dependencies

- SPEC-008 hub, registry and channel.
- The existing session MCP server class (`src/core/tools`) and descriptor-per-send
  pattern (SPEC-006).

## Open Questions

- [ ] Default limits: hop count and messages per hour.
- [ ] Should a coordinator message wake a sleeping target bot immediately, or
      wait for its next tick?

## References

- [ADR-009](../decisions/009-give-one-bot-a-bounded-coordinator-role.md)
- [SPEC-004](SPEC-004-provider-interactions-and-tool-visibility.md),
  [SPEC-006](SPEC-006-desktop-control-session-mcp.md),
  [SPEC-008](SPEC-008-hub-and-bot-fleet.md)

---

*Created: 2026-10-29*
*Author: Claude, from the owner's decisions*
*Related Plan: [PLAN-009](../plans/PLAN-009-hub-headless-cores-and-coordinator.md)*
