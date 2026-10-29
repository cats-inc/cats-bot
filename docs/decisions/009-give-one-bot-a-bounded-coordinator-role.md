# ADR-009: Give one bot a bounded coordinator role

## Status

Accepted — 2026-10-29, owner decisions recorded from discussion; implementation
pending in [PLAN-009](../plans/PLAN-009-hub-headless-cores-and-coordinator.md).
Depends on [ADR-008](008-run-every-bot-as-a-headless-core-under-one-hub.md).

## Context

The owner wants a "chief of staff" bot, like the first assistant in Grok's bot,
that can hand work to other bots and open or initialize new ones. The role must
be transferable, and the fleet may also run without it. Today no channel exists
between bots: each bot's session MCP tools (`schedule_*`, `ask_owner`) act only on
itself, and the owner control pipe carries the owner's own authority.

The consent rules must survive: provider approvals never stand in for desktop
grants (SPEC-006), chat text is never taken as an approval (SPEC-004), and only the
owner answers a bot's questions.

## Decision

- **A role, not a kind of bot.** The fleet registry names zero or one coordinator.
  The first bot created at first run holds it by default. Any bot can hold it,
  and archiving the holder leaves the role vacant. A holder whose provider
  cannot load session MCP servers keeps the role without its tools, and the hub
  shows why.
- **Coordination only.** The holder's core attaches an extra session MCP server
  (`cats-fleet`) to its sessions only while the hub confirms that it holds the
  role. The decision is made before every send, as for `cats-desktop`. The hub
  brokers and authorizes every call over the host channel. Its tools can:
  - list bots and their states;
  - hand a message or task to another bot (it arrives at once as that bot's
    background work, marked as coming from the coordinator, never as the owner);
  - ask the hub to create and initialize a bot from first-run defaults;
  - start or stop bots, and pause or resume their heartbeat.
- **Never owner authority.** The coordinator cannot:
  - answer any bot's provider interactions, desktop-control grants, `ask_owner`
    or recovery decisions;
  - change any bot's provider policy, permissions, desktop or Telegram settings,
    or secrets;
  - read another bot's transcripts beyond the replies to its own requests;
  - archive or delete bots, or change who holds the role.
  Work it hands over runs under the target bot's own policy and approvals, and is
  not an owner turn. These are refusals of the role's tools and the hub's API,
  not a sandbox: a native provider CLI still runs under the owner's OS account
  with its file access, limited only by its own provider policy.
- **Owner confirmation** is required before creating a bot, before starting a bot
  the owner stopped, and before any role transfer.
- **Transfer.** The owner assigns or clears the holder in Settings. The holder may
  propose a transfer, which takes effect only after the owner confirms. The old
  holder loses the tools and the new one gains them at their next session send.
- **Loop limits and audit.** Bot-originated work carries a chain id and hop count,
  with per-chain and per-hour limits (by default 4 hops and 10 messages per hour,
  adjustable by the owner). Only the holder can start a chain, and other bots can
  only reply to it. Every coordinator action is recorded in the hub log and in the
  journals of both bots. Each delivery has an id, so a crash on either side
  neither loses nor repeats it.
- **Native environments only** until Runtime supports session MCP in other
  environments (ADR-010).

## Consequences

### Positive

- Bots can work together without diluting the owner's consent.
- The role's authority is one tool server, attached only while allowed and
  revocable at the next send, like `cats-desktop`. The hub re-checks every call,
  so a stale descriptor grants nothing.

### Negative

- The hub becomes a broker for cross-bot work: it needs queues, a durable
  delivery log, limits and error reporting for the coordinator's calls.
- Confirmation prompts can interrupt the owner. Only creating or waking capacity
  and role transfers ask; messaging and stopping a bot do not.

### Neutral

- With one bot in the fleet, the role exists but has no other bot to act on.

## Alternatives Considered

### No role; only the owner orchestrates

- **Pros**: nothing new to secure.
- **Cons**: rules out the owner's requested chief-of-staff workflow.
- **Why rejected**: owner decision.

### Every bot can message every bot

- **Pros**: symmetric and simple.
- **Cons**: reply loops, authority spread across the fleet, quota burn.
- **Why rejected**: one accountable holder makes limits and audit tractable.

### Coordinator acts with owner authority

- **Pros**: can unblock other bots by itself.
- **Cons**: a model could approve its own or other bots' native requests.
- **Why rejected**: breaks SPEC-004/SPEC-006 consent.

## References

- [SPEC-009](../specs/SPEC-009-coordinator-role.md),
  [SPEC-008](../specs/SPEC-008-hub-and-bot-fleet.md)
- [SPEC-004](../specs/SPEC-004-provider-interactions-and-tool-visibility.md),
  [SPEC-006](../specs/SPEC-006-desktop-control-session-mcp.md)

---

*Decision made: 2026-10-29*
*Decision makers: product owner (sammykenny2), recorded by Claude*
