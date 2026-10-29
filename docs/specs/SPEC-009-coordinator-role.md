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
tools that never carry the owner's authority. These are limits on the tools and
the hub's API, not a sandbox around the holder's provider CLI (FR-6).

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
2. FR-2: First run assigns the first bot, whatever its provider (FR-11).
   Archiving the holder clears the role (SPEC-008 FR-5). The owner can assign or
   clear it in Settings → Bots, or with a CLI command through the hub's control
   endpoint (SPEC-008 FR-25).
3. FR-3: The holder's core attaches the `cats-fleet` session MCP descriptor to
   its sessions only while the hub reports it as holder and Runtime's capability
   snapshot for the session supports session MCP servers. The decision is made
   before every send, as for `cats-desktop` (SPEC-006 BDC-04). The hub
   authorizes every call against the current holder. After a transfer, a call
   from the former holder is refused, even if its session still holds the old
   descriptor.
4. FR-4: Tools:
   - `fleet_list`: ids, names and states of bots that are not archived. No
     transcripts.
   - `fleet_message`: target bot id and text. The target must be running and
     managed by the hub (SPEC-008 FR-10); otherwise the call is refused with
     the reason. The hub delivers it as a work item in the target's home
     conversation, with source `bot`, a `sourceRef` naming the holder and the
     delivery id, a chain id and a hop count (FR-12). The call returns once the
     hub has recorded the delivery; the reply arrives later (FR-8).
   - `fleet_create`: name and persona, plus a provider from those installed. It
     uses first-run defaults: desktop control off, Telegram off, the fleet's
     environment profile, and the fleet cap applies.
   - `fleet_start`, `fleet_stop`, `fleet_heartbeat` (pause or resume) for
     another bot.
   - `fleet_propose_transfer`: the target bot id, or none.
5. FR-5: The owner must confirm `fleet_create`, `fleet_start` for a bot the
   owner stopped, and `fleet_propose_transfer`. The request appears as a decision
   in the holder's note and in the tray's pending requests. A decline or expiry
   returns as the tool result, and nothing happens. A request still pending when
   the hub stops or loses the holder's channel expires the same way.
6. FR-6: The hub and `cats-fleet` refuse, regardless of arguments:
   - answering any provider interaction, desktop grant, `ask_owner` or recovery
     decision of any bot;
   - changing any bot's provider policy, permissions, desktop or Telegram
     settings, or secrets;
   - reading another bot's transcripts or conversations;
   - archiving, restoring or deleting bots;
   - assigning the role directly.

   These refusals limit the role's tools and the hub's API. They are not a
   security boundary around the holder's provider CLI: a native CLI with file
   or command access runs under the owner's OS account, can read bot roots and
   control descriptors (SPEC-008 Security), and is limited only by its own
   provider policy.
7. FR-7: Work from `fleet_message` runs under the target's own execution target,
   policy and approvals. It is not an owner turn, so desktop control is
   unavailable to it (SPEC-006). The target admits it at once as a background
   work item (SPEC-001 FR-16): it waits behind owner messages but not for the
   target's heartbeat, and a paused heartbeat does not hold it.
8. FR-8: The target's reply returns to the holder as a work item in the same
   chain. Only the holder starts chains; other bots get no messaging tool. Each
   delivery, the holder's message or a reply, is one hop. The hub refuses a
   message beyond the hop limit (default 4 per chain) or beyond the holder's
   per-hour limit (default 10 `fleet_message` calls), and tells the holder why.
   The owner can change both limits in Settings → Bots. A delivery the hub sends
   again (FR-12) is not a new hop and does not count toward the hourly limit.
9. FR-9: Every coordinator call (tool, target, chain, outcome) goes to the hub
   log and to the journals of the holder and the target. Delivered text appears
   in the target's transcript, attributed to the holder bot.
10. FR-10: Settings → Bots shows the holder. The holder's note shows its role,
    and messages from another bot render with that bot's name.
11. FR-11: A holder that is not bound to the native environment (ADR-010), or
    whose provider's sessions do not support session MCP servers (FR-3; in the
    pinned Runtime 0.6.2, Antigravity, Grok and Muse), keeps the role but gets
    no `cats-fleet` tools. Settings → Bots and the holder's note show why. The
    role is never refused or cleared for this: first run, assignment and a
    confirmed transfer all succeed, and the tools return at the next send after
    the holder moves to a provider that supports them. With one bot in the
    fleet, the tools that target another bot report that none exists.
12. FR-12: A crash on either side neither loses nor repeats a delivery. When
    the hub accepts a `fleet_message` it gives it a delivery id and records it
    in a delivery log under `<CATS_BOT_HOME>` before sending it. The target
    admits it as a work item whose `sourceRef` carries the delivery id; the same
    id admitted again returns the existing work item, as Telegram's `sourceRef`
    does (SPEC-001 FR-26). The hub marks a delivery sent only after the target
    confirms the journal write, and resends unconfirmed deliveries when it
    attaches (SPEC-008 FR-13, FR-15). Replies are read from the target's journal
    by delivery id, so a reply that finished while the hub was down is collected
    at the next attach and admitted to the holder once, deduplicated the same
    way. A delivery whose target was archived or can no longer run returns to
    the holder as failed, with the reason.

### Non-Functional Requirements

- **Security**: the hub authorizes every call against the current holder and
  FR-6, never trusting the calling core's claim. FR-6 also states what these
  refusals do not cover. Independent security review is required before
  release.
- **Cost**: limits keep a single chain from consuming unbounded model turns.

## Design Overview

```
holder core ──cats-fleet MCP──▶ (served by the holder core, backed by the hub)
        hub: authorize (holder? FR-6? limits?) ─▶ owner confirmation when FR-5
        hub ─channel─▶ target core: work item (source bot, chain, hop, delivery id)
        target reply ─▶ hub ─▶ holder: work item (same chain)
```

## Dependencies

- SPEC-008 hub, registry and channel.
- The existing session MCP server class (`src/core/tools`) and descriptor-per-send
  pattern (SPEC-006).

## Open Questions

- [x] Default limits (2026-10-29): 4 hops per chain and 10 messages per hour,
      adjustable by the owner (FR-8).
- [x] Delivery timing (2026-10-29): admitted at once as background work, not
      held for the target's heartbeat (FR-7).
- [x] Strength of the refusals (2026-10-29, after review): API limits, stated
      as not a security boundary (FR-6).
- [x] Providers without session MCP (2026-10-29, after review): the holder
      keeps the role without tools, and the reason is shown (FR-11).

## References

- [ADR-009](../decisions/009-give-one-bot-a-bounded-coordinator-role.md)
- [SPEC-004](SPEC-004-provider-interactions-and-tool-visibility.md),
  [SPEC-006](SPEC-006-desktop-control-session-mcp.md),
  [SPEC-008](SPEC-008-hub-and-bot-fleet.md)

---

*Created: 2026-10-29*
*Author: Claude, from the owner's decisions*
*Related Plan: [PLAN-009](../plans/PLAN-009-hub-headless-cores-and-coordinator.md)*
