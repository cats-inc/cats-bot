# PLAN-003: React Renderer

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Done — 2026-10-28, the four slices were merged in #23–#26 |
| **Owner** | Claude |
| **Related spec** | [SPEC-003](../specs/SPEC-003-note-reading-and-the-react-renderer.md) |
| **Related decision** | [ADR-003](../decisions/003-build-the-renderer-with-react-and-vite-like-cats-desktop.md) |

## Overview

One PR per slice, merged automatically once CI is green. First replace the build flow alone (screens
and behavior unchanged) and confirm that file:// loading, the CSP and packaging are all fine, then
rewrite page by page: the note first (what users see every day), then the tool cards and decision
buttons, and the settings page last. After everything is merged, build an installer from main and give
it to the owner.

## Implementation Phases

### Slice 1: Vite and TypeScript build (SPEC-003 FR-1)

- [x] Pages moved to `src/renderer/`, Vite builds multiple pages to `dist/renderer/`; the shell loads
      from there, and the icon path is now passed in explicitly.
- [x] `bridge.ts` defines the type of `window.catsBot`; the command result types moved into
      `core/types.ts`; the floating Cat is now TypeScript.
- [x] `THIRD-PARTY-NOTICES.txt`; `tsconfig.renderer.json`; architecture boundary and bridge contract
      tests.
- [x] Acceptance: the existing scripts were rerun on the Vite build, and the first-run page of the
      packaged build works.

### Slice 2: Note moves to React and renders markdown (FR-2, FR-3)

- [x] The note page is rewritten in React, keeping the IME Enter check, marking as read only when
      focused, returning focus to the input after raising, matching a streaming reply by `workItemId`,
      and rereading the transcript after a turn ends.
- [x] `react-markdown` + `remark-gfm` + `remark-breaks`; link and image rules; the shell refuses new
      windows and navigation, and http(s) goes to the system browser.
- [x] Tests: link rules, transcript arrangement.

### Slice 3: Tool cards and the owner's decisions (FR-4, FR-5)

- [x] Tool cards (merged by `toolId`, collapse and expand, error state); the core stores as JSON the
      tool input that the runtime gives only as `toolArgs`.
- [x] Approve/Deny buttons for `awaiting_owner`, updated after `work.updated`.
- [x] Tests: card grouping and decision state.

### Slice 4: Settings and first run move to React (FR-6)

- [x] The Bot, Notes, Life, Telegram and App tabs and the first-run page are rewritten in React, with
      the same behavior as SPEC-002.
- [x] The request sequence number logic of the model list is extracted into a testable module and tests
      are added (`settingsLogic.ts`).
- After merging, build an installer from main and give it to the owner (local `release/`, not
  committed).

## Testing Strategy

- Logic that does not touch the DOM is tested with `node:test`; components are accepted by CDP in the
  real shell (docs/testing.md).
- Each slice reruns the existing acceptance scripts: the settings-page model race and saving, raising a
  desktop-layer note, unread of a background note.

## Progress Log

| Date | Update |
|------|--------|
| 2026-10-28 | Slice 4: the settings and first-run pages moved to React, with the logic concentrated in `settingsLogic.ts` (7 tests). Real-machine acceptance: switching the model menu quickly stopped on Codex's list 8/8 times and saving kept `claude · haiku`; in the Notes tab, add, rename (Enter), change layer (the toast and `shell-state.json` both say top), and delete requires two presses; in the Life tab, saving the idle minutes and restoring worked, and entering 0 was stopped by form validation with the setting unchanged; the Telegram tab shows the status and Remove cannot be pressed when there is no token; the App tab turns the floating Cat off and on; opening a specified tab from the note's ⚙; on the first-run page with a brand-new bot id, quick switching was correct 5/5, and after creating `Setup Cat · claude · haiku` the home note opened and replies were shown as markdown. Found during the rewrite: React applies updates in a microtask, so the model menu additionally decides whether saving is allowed by "the catalog belongs to the current provider", without depending on when the effect runs |
| 2026-10-28 | Slice 3: tool cards and the owner's decisions. On a real machine (fixture CLI through the real runtime): a `tool` turn shows one collapsed Read card (summary `file.txt`, ✓), and expanding it shows the input `{"path": "file.txt"}` and the result; an `ask:` question shows Approve/Deny, after pressing Approve the card becomes Approved, the buttons disappear and the bot receives an "approved" message, and on another question pressing Deny shows Denied. Found: the runtime's Claude tool events carry the input only as `toolArgs`, and the core used to store only `text` (an empty string), so the card could not show the input; the core now stores `toolArgs` as indented JSON, with the same length limit as the result |
| 2026-10-28 | Slice 2: the note moved to React, and bot replies are shown with `react-markdown` + GFM. Real-machine acceptance (the fixture CLI returns markdown as is): headings, bold, italics, strikethrough, lists, quotes, tables, code blocks and single line breaks are all correct; external links carry `target=_blank`, local paths are non-clickable text, raw HTML is shown as text, and remote images become links; a 340 px wide note has no horizontal scrollbar, and code blocks and over-wide tables scroll inside themselves (tables used to inherit the note's `word-break` and break character by character, now fixed). `window.open` and navigation are both blocked by the shell and the page stays at `note.html`. During a turn the owner's message appears immediately (the old version waited for the turn to end), thinking… is shown, and Cancel can be pressed. The desktop-layer raising scripts (focus returns to the input after raising) and the background unread script both pass when rerun. Not tested: clicking an https link really opens the browser (to avoid opening tabs on the owner's desktop; the rule has unit tests), and IME |
| 2026-10-28 | Slice 1: Vite 7.3.6 builds the three pages; Electron 41 loads the `type="module"` output from file:// normally, and the CSP does not need to be relaxed. The acceptance scripts were rerun: quick switching of the model menu was correct 8/8, saving kept `claude · haiku`, a desktop-layer note reopened after hiding was still raised after 7 seconds, a background note had unread 1 and the floating Cat showed 1, and both reset to zero after opening; the `dist:dir` packaged build opened the first-run page with a brand-new bot id, with 15 providers and the model list loaded. esbuild's postinstall is blocked by npm yet it still works (same as koffi) |
