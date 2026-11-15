# ADR-025: Name Notes from Their First Exchange in a Side Session

## Status

Accepted — 2026-11-16, at the owner's request ("實作看看吧") that a note get a fitting title before the owner
renames it, as Cats Desktop's conversations do. Amends [SPEC-002](../specs/SPEC-002-desktop-presence-settings-and-first-run.md)
FR-5 (adds FR-5a), [SPEC-012](../specs/SPEC-012-boss-cat-status-board-and-contact-notes.md) FR-3 and its privacy
note, and makes an exception to [SPEC-001](../specs/SPEC-001-resident-bot-core-and-global-execution.md) FR-16.

## Context

- A new note was called "Conversation N" until the owner renamed it, and most never were.
- Cats Desktop drafts a new conversation's title from the start of its first message (`titleSource: 'draft'`).
  After the first reply its Guide Cat ("Catlas", not the orchestrator) names it
  (`src/products/chat/api/catlasTitles.ts`):
  - It uses a short-lived session of its own: an empty read-only sandbox, no tools, no MCP servers, and Codex
    keeps no session of its own.
  - The session sees the owner's first message and the first reply, 2,000 characters of each, and returns
    `{"title":"…"}`, at most 48 characters.
  - It is asked twice at most, only while the title is still drafted. The owner's rename is final.
  - Its Boss Cat board shows only titles the owner set, since a drafted or named title is message text.
- Cats Bot has no Guide Cat; each bot is one cat with one execution target.
- SPEC-012 FR-3 lets note titles reach the Boss Cat because the owner set them, and says they are "never
  derived from a message".

## Decision

1. **Titles have a source.** A note record keeps `titleSource`:
   - `default`: the name it was made with.
   - `draft`: the start of the owner's first message.
   - `cat`: the name the bot gave it.
   - `owner`: the owner's own name, from a rename or a name given when the note was made.

   Records written earlier have no source and read one from their title: "Conversation" or "Conversation N"
   is `default`, any other note title is `owner`, because only the owner renamed notes. The direct message
   and contact notes are always `default` and never renamed by the bot.
2. **Draft at the first message.**
   - When the owner writes in a note whose title is still `default`, the note takes the first 48 characters
     of the transcript's first owner message, without its attachment block, and becomes `draft`.
   - That is the first owner message, not the one being sent, so an older note with a talk under way is
     named after how it began.
   - A message of files only keeps the old name, still marked `draft`.
3. **The bot names it after a reply.**
   - When an owner turn completes in a `draft` note, the core asks the bot for a title:
     - It uses the bot's own provider and model, in a Runtime session with an empty read-only sandbox.
     - The session gets no MCP servers and no tools, and Codex runs `ephemeral`.
     - It is sent the first owner message and the first reply, as JSON data.
   - The session is cancelled on timeout (90 s) or when the bot stops, and is closed and deleted when the
     naming ends. Only a bot killed outright, or a stop that waits longer than 5 s, leaves it in the
     Runtime's registry.
   - A usable answer is one JSON object with a `title`, also in a code fence. It is cleaned like a board
     title and cut to 48 characters.
   - The title is applied only while the note is still `draft`, and it becomes `cat`.
   - The bot is asked at most twice (`titleAttempts`, persisted), once per turn.
   - Naming writes nothing into the note: no transcript line and no session error.
4. **Naming is not a turn.** It does not enter the serialized queue (SPEC-001 FR-16) and may run beside the
   next turn, as Catlas runs beside Desktop's turns. It holds one Runtime session for a few seconds and never
   touches a conversation's own session.
5. **The owner's name wins.** A rename makes the title `owner`, after which the bot never names it.
6. **Only owner and default titles leave the bot.** The status board lists a `draft` or `cat` note with an
   empty title, which the Boss Cat reads as "an untitled note".

## Consequences

### Positive

- A note is named after its subject from its first message, and better after its first reply, without the
  owner doing anything.
- The conversation's own session, transcript and provider context are untouched.
- The Boss Cat learns no more about a note than before.

### Negative

- Each new note costs one more short provider call, on the bot's own model and account.
- Two provider processes of one bot can run at once while a naming overlaps the next turn. A Runtime that is
  at its session limit refuses the naming, which then counts as one of the two attempts.
- Runtime deletes the naming session and its sandbox, but a provider CLI may keep its own record of the
  exchange in its own folders (Claude Code's projects, for example), as with Desktop's Catlas. Only Codex is
  told to keep nothing.
- An older build that rewrites a note record drops `titleSource`. A drafted or named title then reads as the
  owner's, and reaches the Boss Cat's board.
- A note whose owner never renames it is listed untitled on the Boss Cat's board, where it showed
  "Conversation N" before.

## Alternatives Considered

### Alternative 1: Ask in the conversation's own session

- **Pros**: no second session.
- **Cons**: it puts a hidden turn into the provider's context and transcript, waits for or collides with the
  conversation's turns, and the answer could leak into the next reply.
- **Why rejected**: the conversation would no longer be only what the owner and the bot said.

### Alternative 2: Let the Boss Cat name other bots' notes

- **Pros**: one cat for the chore, like Desktop's Guide Cat.
- **Cons**: another bot would read this bot's conversations, which SPEC-012 forbids.
- **Why rejected**: a note's content stays with its bot.

### Alternative 3: Draft only, no naming

- **Pros**: free and immediate.
- **Cons**: the start of a message is often a greeting or half a sentence.
- **Why rejected**: the owner asked for Desktop's behavior; the draft remains the first step.
