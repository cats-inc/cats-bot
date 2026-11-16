# ADR-026: Let the Owner Grant a Conversation's Actions Once

## Status

Accepted — 2026-11-16. The owner found per-call cards unusable for Kimi's computer use: while Kimi drives the
mouse and windows, the owner cannot keep taking them back to click "Approve once". Runtime decision:
[Runtime ADR-055](../../../cats-runtime/docs/decisions/055-let-the-owner-grant-computer-use-shell-and-file-approvals-once.md).

## Context

ADR-025 made a Kimi bot ask before each tool call Kimi does not consider safe. That rule stays. What changes is how
long one answer lasts. The owner decided on 2026-11-16:

- Computer use, commands and file changes can be allowed once, either for the whole conversation or for 30 minutes.
- Only messages the owner sends in person, from a note or the local `cats-bot say`, may use such a grant.
- Telegram messages, heartbeats and schedules never use a grant. Their cards wait for the owner as before.
- Safety then comes from a grant that is always visible and a Stop that is always reachable.
- Cats desktop control (`cats-desktop`, SPEC-006) is unchanged.

## Decision

- **Runtime keeps the grant.** Runtime holds grants per Runtime session, in memory only.
  - The note's card offers "Allow for this conversation" and "Allow for 30 minutes" beside the provider's own
    one-time choice. These buttons appear only on prompts Runtime marks with a grant category.
  - A computer-use card adds a warning: operating the desktop is as broad as the owner at the keyboard, and it can
    start programs and change files too.
- **The Bot decides per send.** A send carries `standingGrants: true` only when its work item is an `owner_message`
  with source `owner`, the same owner-present rule as SPEC-006 BDC-05. A contact note can never create a grant.
- **No waiting state.** A request Runtime answered from a grant never counts as waiting. No bubble, Telegram notice
  or gate fires for it.
- **Visible and stoppable.** While a conversation holds grants:
  - Its note shows them with the time left and a Stop. Stop cancels the conversation's running turn, then
    revokes the session's grants, and fails visibly unless Runtime confirms. Queued messages stay queued and run
    afterwards, asking again; one that starts while Stop is still ending grants never uses them.
  - The tray's first item is "Stop actions allowed without asking", for every bot.
  - The global hotkey Ctrl+Alt+Shift+S does the same. The Hub registers it only while a grant is in force, so it
    never holds the chord otherwise.
  - The CLI offers `cats-bot grants [conversation] [--stop [--all]]`.
  - Kimi Computer Use's physical Escape still interrupts its input.
- **Lifetime.** A grant ends on Stop or on expiry. It also ends when Runtime restarts, when the conversation's
  Runtime session is replaced, or when the bot's provider changes.

## Consequences

### Positive

- Kimi can work through a task on the desktop after one decision, while background triggers still wait.
- The grant applies to every provider whose Runtime target tags its prompts. Today that is the hosted ACP targets
  for commands and file changes, plus Kimi's computer use.

### Negative

- While a grant is in force, Kimi acts in its category without asking, so Stop is the only control left. The
  hotkey can fail to register if another app holds the chord; the Hub logs this, and the tray and the note still
  offer Stop.
- A computer-use grant is broader than its name: through the desktop, Kimi can start programs and change files.

### Neutral

- No profile, journal or conversation format changes. Grants are never written to disk by the Bot.
