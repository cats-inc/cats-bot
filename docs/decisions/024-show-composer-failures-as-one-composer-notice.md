# ADR-024: Show Composer Failures as One Composer Notice

## Status

Accepted — 2026-11-14, at the owner's report that "No microphone was detected." lines kept occupying the
bottom of the note. The owner approved the placement and the 8 s lifetime, and asked for send and retry
failures to follow. Amends [SPEC-003](../specs/SPEC-003-note-reading-and-the-react-renderer.md) FR-8, FR-9
and FR-10 and [ADR-020](./020-send-the-owner-to-the-macos-system-settings-pane-a-permission-needs.md)
decision 2.

Amended 2026-11-14: the owner decided that an error does not clear itself. The 8 s lifetime first
approved is removed (decision 3). Cats Desktop makes the same change in the same round: its new `error`
toast level stays until it is closed.

Amended 2026-11-14, later the same day: the notice moved from between the draft and the buttons to the top
of the composer (decision 1). Between them it pushed the draft up by its own height whenever it came or
went, which now happens when an action starts working again, while the owner is typing or dictating.

## Context

- SPEC-003 made a failed dictation or screenshot "a line in the note". A file too large to send, a send the
  core refused and a retry it refused were lines too. The note added each as a local transcript entry with
  a negative sequence number.
- The transcript sorts negative sequence numbers after every real entry, so the line stayed below each
  later message until the note was reloaded.
- Nothing dismissed or merged the lines. On a Mac without a microphone, each click on the microphone button
  added another "No microphone was detected." under the conversation.
- Each failure is about the composer, not the conversation: a failed send already puts the draft and files
  back in the composer. Cats Desktop shows dictation and screenshot failures as toasts
  (`useVoiceInputComposer`, `screenshotCapture.ts`), which do not stay in the conversation.

## Decision

1. **One notice in the composer.** A failed dictation, screenshot, attachment, send or retry is a notice
   at the top of the composer, above the waiting files and the draft (`src/renderer/note/composerNotice.ts`).
   The composer is anchored to the bottom of the note, so on top nothing the owner is typing in or about to
   click moves when the notice comes or goes; only the transcript gets shorter. The note no longer adds
   lines of its own to the transcript.
2. **A new failure replaces it.** A repeated failure is shown again with the notice's entrance, so the
   owner sees that the click was answered.
3. **It stays until it is answered.** The owner can dismiss it. The action working again clears its own
   notice: dictation reaching `ready`, a captured region, removing the file that was too large, or a send or
   retry the core accepted. It never clears itself on a timer.
4. **A missing permission offers "Open System Settings".** A notice for a missing macOS permission keeps
   ADR-020's button.
5. **It names its button.** The notice shows the struck-out glyph of the microphone, screenshot or attach
   button it is about. Send is a text button, so its notice has an alert mark.
6. **A turn that failed stays on its message.** "Response failed" and its retry action belong to the
   owner's message in the transcript and do not change.

## Consequences

### Positive

- The conversation shows only conversation. A missing microphone no longer stacks lines under replies.
- The failure sits on the composer it is about, with the struck glyph of its button, and a file too large
  is named right above its card.
- With no local lines, the transcript sorts by sequence number alone.

### Negative

- A notice stays until it is answered, so a failure the owner ignores keeps a line of the composer.
- A notice is not kept as a record once it is closed.

## Alternatives Considered

### Alternative 1: Keep transcript lines, deduplicated

- **Pros**: smallest change.
- **Cons**: the line still sits under every later message and is still about a button, not the
  conversation.
- **Why rejected**: it keeps the reported problem.

### Alternative 2: A toast, as in Cats Desktop

- **Pros**: parity with Desktop.
- **Cons**: a 340 × 460 note has no free corner; a toast would cover the newest message, and a toast with a
  System Settings button is a second surface to keep.
- **Why rejected**: the composer already has room under the draft.

## References

- [SPEC-003](../specs/SPEC-003-note-reading-and-the-react-renderer.md) FR-8, FR-9 and FR-10
- [ADR-017](./017-attach-owner-files-through-the-working-directory.md),
  [ADR-018](./018-dictate-through-native-speech-helpers.md),
  [ADR-020](./020-send-the-owner-to-the-macos-system-settings-pane-a-permission-needs.md)

---

*Decision made: 2026-11-14*
*Decision makers: Owner, Claude*
