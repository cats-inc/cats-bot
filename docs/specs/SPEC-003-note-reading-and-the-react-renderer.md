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
- A5: The existing acceptance scripts (settings-page model race and saving, raising a desktop-layer
  note, unread of a background note) still pass on the new pages.
- A6: The packaged installer shows the first-run page the first time it is opened, and after the bot is
  created the home note can chat.

## Non-Goals

- Sharing components or packages with Cats Desktop (ADR-003 §1).
- Markdown in the owner's messages, editing or resending messages, attachments.
- Moving the floating Cat to React.
