# SPEC-003: Note Reading and the React Renderer

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Accepted — 2026-10-28 together with [ADR-003](../decisions/003-build-the-renderer-with-react-and-vite-like-cats-desktop.md) |
| **Owner** | Claude |
| **Reviewer** | Owner |
| **Related decision** | ADR-003 |
| **Related plan** | [PLAN-003](../plans/PLAN-003-react-renderer.md) |

## Summary

The note shows the bot's replies as markdown, tool calls are expandable cards, and matters that need
the owner's decision have buttons; the settings and first-run pages keep their functions but are
implemented in React. The pages' behavior is still defined by SPEC-001 FR-33 and SPEC-002; this
document only adds reading and interaction.

Owner-requested follow-up (2026-10-29):
[Platform SPEC-134](https://github.com/cats-inc/cats-platform/blob/main/docs/specs/SPEC-134-reusable-platform-packages-and-consumer-boundaries.md)
FR-15 through FR-20 and UI-1 through UI-6 require a Desktop-derived shared renderer
for Desktop and Bot: user/agent bubbles, message-internal hierarchy, live/durable
continuity, scoped interactions and narrow conversation layout. Bot adapters must
preserve the necessary identities/block data through the core and transcript store;
missing history cannot be repaired by a live-only renderer. That planned cutover
supersedes the component-sharing non-goal below, not the implemented status of this
spec. Other non-goals and Bot action/consent/redaction policies remain in force.
See [ADR-003](../decisions/003-build-the-renderer-with-react-and-vite-like-cats-desktop.md)
for the current-versus-pending boundary.

## Functional Requirements

1. FR-1: Build. The renderer is built by Vite from `src/renderer` to `dist/renderer`, with page names
   and query strings unchanged; the CSP stays `script-src 'self'` and `style-src 'self'`; the build
   generates `THIRD-PARTY-NOTICES.txt`.
2. FR-2: Markdown. The bot's replies (including streaming replies) are rendered as GFM: paragraphs,
   bold and italics, lists, quotes, tables, code and code blocks, strikethrough; a single line break is
   kept as a line break. Raw HTML is shown as text. Code blocks and tables scroll horizontally inside
   themselves within the note width, and the note itself shows no horizontal scrollbar. The owner's own
   messages remain plain text.
3. FR-3: Links and images. http(s) links are opened in the system browser and the note does not
   navigate; other links are not clickable and show their target in the title on hover; remote images
   are not loaded and are shown as a link to the image. The shell refuses any page opening a new window
   or navigating to another URL.
4. FR-4: Tool cards. One tool call (`tool_use` and its `tool_result`, matched by `toolId`) is shown as
   one card: collapsed by default, showing the tool name, a one-line summary and the state (running,
   done, error); expanded, it shows the full input and result. Items without a `toolId` each get their
   own card.
5. FR-5: The owner's decisions. A system message corresponding to an `awaiting_owner` work item shows
   "Approve" and "Deny" buttons, which call `resolveApproval` when pressed; an item that is already
   decided, expired or no longer waiting shows only the result, with no buttons.
6. FR-6: The settings and first-run pages are rewritten in React with the same functions as SPEC-002
   FR-1–FR-6, and keep these existing behaviors: the model list uses only the latest request, saving is
   not possible while loading, the model can still be left empty or a model id typed when the query
   fails, switching back to the saved provider preselects the saved model, the Notes tab refreshes when
   the window gains focus, and a rename in progress is not interrupted by an event redraw.
7. FR-7: Retrying a failed reply, as in Cats Desktop. When the latest owner message's work item has
   failed and nothing runs, its bubble shows "Response failed" and a retry action. `retryOwnerMessage`
   queues the same work item again: no second owner entry is added, and the failure stays in the
   transcript. The retry starts a fresh busy-retry budget, and recovery after a crash reads only the
   transcript entries written after the retry (`attemptFromSeq`). The core refuses a work item that is not the conversation's latest
   owner message, not failed, or in a conversation with a queued or running turn. Cancelled and
   interrupted turns are not offered, and a send the note could not deliver (shown only in the note) has
   no work item to retry.
8. FR-8: Attachments, as in Cats Desktop's composer (ADR-017). The composer has an "Add photos and files"
   button of its own (Desktop keeps it and the screenshot in a plus menu; the note shows both as buttons);
   picked files wait above the input as cards (images with a preview) and can be removed. On send,
   each file (at most 10 MB) is stored by `addOwnerAttachment` in `.cats-attachments/` in the bot's working
   directory (git-ignored there, a taken name gets a numbered one), and the message starts with Cats
   Desktop's `[Attached files in working directory:]` block listing their relative paths, so the provider
   CLI reads them with its own tools. A message may be only files. If storing or sending fails, nothing is
   sent and the draft and files come back with a composer notice saying why; a file over 10 MB is a notice
   until it is removed, and a refused retry is a notice too
   ([ADR-024](../decisions/024-show-composer-failures-as-one-composer-notice.md)). In the transcript an owner bubble shows the block's images
   inline (read back by `attachmentPreview`, PNG, JPEG, GIF and WebP) and other files as names; copying
   it copies the text without the block.
9. FR-9: Screenshots, as in Cats Desktop's composer. The composer's "Take screenshot" button hides the note
   (without closing it; a lifted desktop or wallpaper note stays lifted) and every floating Cat, freezes
   each display under an overlay window where the owner drags out a region (Escape cancels), and gives
   the windows back. The region waits in the composer as a PNG file like a picked one: scaled down to
   at most 8000 px a side and 10 MB on the overlay path, as `grim` writes it on wlroots (where a larger
   picture is refused on send like any file over 10 MB). macOS needs Screen Recording for Cats Bot: while it is
   not granted the shell asks once per run through the dictation helper, so Cats Bot is listed in Privacy &
   Security > Screen & System Audio Recording; the refusal is a composer notice naming that pane, with "Open
   System Settings" ([ADR-020](../decisions/020-send-the-owner-to-the-macos-system-settings-pane-a-permission-needs.md)).
   wlroots desktops use `grim` and `slurp`. Cancelling or a region too small adds nothing; other failures are
   a composer notice, and a captured region clears the screenshot's notice
   ([ADR-024](../decisions/024-show-composer-failures-as-one-composer-notice.md)).
10. FR-10: Dictation, as Cats Desktop's composer "voice input" (ADR-018). On macOS and Windows the composer
    has a microphone button; it turns speech into text with a native helper (macOS on-device speech
    recognition, Windows speech recognition, which may be online by Windows settings and is marked so) and
    inserts each final phrase at the owner's selection, or at the end. No audio is kept or sent. Clicking
    again stops; Escape, the composer becoming busy, closing the note and another note starting dictation
    cancel. Helper errors (permission, no microphone, language, unavailable, stopped) are a composer
    notice (ADR-024), cleared when the helper next starts listening. A denied microphone and a denied
    Speech Recognition are separate notices, each with "Open System Settings" for its macOS pane (ADR-020). Before creating a recognition task or tap on macOS, validate
    the hardware input format's sample rate and channel count. Missing or disabled input emits
    `mic_unavailable` and `end`, without a tap; the output scope's default format is not proof of a
    microphone. The macOS helper delivers recognition callbacks on a serial background queue while
    its main thread waits; callbacks remain suspended during tap startup and resume after `ready`
    or startup-failure cleanup. Linux has no helper yet and shows no button.
11. FR-11 (2026-11-14): The note header reads "bot name · conversation", with the Boss Cat's role between
    them (SPEC-009 FR-10). An (i) follows the title, as in Cats Desktop's model picker: not a button, it
    shows on hover and on focus the bot's provider, model and reasoning effort as the model catalog names
    them ("Claude · Opus 5.5 · Medium effort"), falling back to the ids without a catalog. When the header
    is short of room the title is cut; the (i) and the status stay whole and on one line.

## Acceptance

2026-10-30 candidate: the conversation-sharing non-goal is superseded by the
public `@cats-inc/platform-ui-web` package. Ordered response segments and tools
persist in a versioned, validated atomic sidecar; original JSONL/API remain intact.
Bot-specific interactions and authorization remain in the existing core/host.
Full final UI-6/package/CI signoff is separate from this implemented cutover.

- A1: A reply containing a heading, list, table, code block and link displays correctly in a 340 px
  wide note, and the note has no horizontal scrollbar.
- A2: Clicking an https link in a reply opens that URL in the default browser, and the note stays on
  its page; clicking a link to a local path does nothing.
- A3: A turn that uses tools shows a collapsed tool card on the note, and expanding it shows the input
  and result.
- A4: A question from `ask_owner` has buttons on the note, and after pressing Approve the work item
  completes and the buttons disappear.
- A4a: A message whose turn failed shows "Response failed" and a retry action; retrying runs the turn
  again without a second owner bubble, and the label and action go away once the reply arrives.
- A4b: Attaching a picture and a text file with the attach button shows two cards; sending stores both in
  `.cats-attachments/`, the bubble shows the picture and the file name, and the reply can refer to them.
- A4c: "Take screenshot" hides the note, shows the frozen screen, and a dragged region comes back as a
  card in the composer of the note, which is open, visible and focused again; Escape adds nothing.
- A4d: On macOS and Windows, dictating a sentence (also in Chinese) puts it in the composer; Escape cancels.
- A5: The existing acceptance scripts (settings-page model race and saving, raising a desktop-layer
  note, unread of a background note) still pass on the new pages.
- A6: The packaged installer shows the first-run page the first time it is opened, and after the bot is
  created the home note can chat.

## Non-Goals

- Sharing components or packages with Cats Desktop (ADR-003 §1).
- Markdown in the owner's messages, editing or resending messages, attachments.
- Moving the floating Cat to React.
