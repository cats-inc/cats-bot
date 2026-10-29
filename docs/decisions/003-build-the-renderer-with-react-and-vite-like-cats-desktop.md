# ADR-003: Build the Renderer with React and Vite, Like Cats Desktop

## Status

Accepted — 2026-10-28. The owner asked whether the screen inside the note uses the same technology as
the Cats Desktop conversation screen (React). Told that it did not, the owner agreed to unify them
and asked for the work to be cut into slices. See
[SPEC-003](../specs/SPEC-003-note-reading-and-the-react-renderer.md) for the specification and
[PLAN-003](../plans/PLAN-003-react-renderer.md) for the implementation.

Pending follow-up (2026-10-29): the owner now requires Desktop/Bot conversation
presentation parity, including user/agent bubbles and hierarchy inside messages.
Platform [ADR-142](https://github.com/cats-inc/cats-platform/blob/main/docs/decisions/142-publish-reusable-platform-packages-for-independent-products.md),
[SPEC-134](https://github.com/cats-inc/cats-platform/blob/main/docs/specs/SPEC-134-reusable-platform-packages-and-consumer-boundaries.md)
FR-15 through FR-20 and
[PLAN-127 Phase 4](https://github.com/cats-inc/cats-platform/blob/main/docs/plans/PLAN-127-shared-platform-package-extraction.md#phase-4-desktop-derived-conversation-renderer-in-both-products)
define extraction from Desktop into a versioned shared renderer/styles package.
That coordinated cutover will replace §1's separate implementation and direct-import
alternative for supported public UI entries only. Current code/import guards remain
unchanged until then. Bot data, BotHostApi/channel and authorization stay Bot-owned;
no Platform application/API dependency, native window-layer change or WebView2
migration is implied. Matching React versions alone does not complete this follow-up.

## Context

- The pages of PLAN-001 and PLAN-002 (note, settings and first run, floating Cat) are plain HTML, CSS
  and untyped JS under `assets/renderer/`, loaded directly by Electron with no build step.
- The note shows messages with `textContent`: agent CLI replies are almost always markdown, so bold,
  lists, tables and code blocks appear as raw characters; a tool call is only one line, "⚙ name
  arguments".
- The data types the renderer reads (`BotHostEvent`, `ConversationRecord`, etc.) are defined in the
  core but invisible to the JS pages; when the core changes a field, the pages report no error. The
  renderer also has no automated tests: the settings-page model-menu race reviewed by Codex on
  2026-10-28 slipped through here. `settings.js` is already 573 lines of imperative DOM code.
- The Cats Desktop (cats-platform) conversation screen is React 18.3.1 + Vite 7; messages are rendered
  with `react-markdown` 10 plus `remark-gfm` and `remark-breaks`, and the link and image handling
  rules are in `MessageBodyMarkdown.tsx`.
- ADR-001 requires the bot to depend on cats-runtime only through HTTP and not on cats-platform;
  Desktop's components are also tied to react-router, Cat mention parsing and the platform API.

## Decision

### 1. The same technology, our own implementation

The renderer moves to React 18.3.1 + Vite 7 + TypeScript, with the same versions as Desktop; markdown
uses `react-markdown` 10, `remark-gfm` 4 and `remark-breaks` 4. No code or package of cats-platform is
imported; Desktop's rules (for example link and image handling) are ported and their source noted. If
UI is to be shared across repos later, another ADR will split it into a shared package.

### 2. Build and loading

- The source is in `src/renderer/`; Vite builds multiple pages to `dist/renderer/` (`base: './'`), and
  the shell loads them via file://. The page names (`note.html`, `settings.html`, `floating.html`) and
  query strings (`?conversation=`, `?mode=setup`, `?tab=`) are unchanged; they are the contract
  between the shell and the pages.
- The preload remains `assets/preload.cjs` (a sandboxed preload cannot be an ES module), and the icons
  remain in `assets/`.
- `npm run build` runs `tsc` and then `vite build`; the Package workflow and CI need no change.
- Measured 2026-10-28: the `<script type="module" crossorigin>` that Vite emits loads normally from
  file:// in Electron 41, and the page CSP (`script-src 'self'`, `style-src 'self'`) does not need to
  be relaxed.

### 3. Types and boundaries

- At run time the renderer goes only through `window.catsBot`; its type is written in
  `src/renderer/bridge.ts`.
- The renderer may take types from the core only, and only via `import type` from
  `src/core/types.ts` (erased, not in the bundle). The command result types the shell exposes to the
  pages (`BotStatus`, `ProviderInfo`, `ModelCatalog`, `TelegramStatus`, etc.) are therefore moved into
  `types.ts`, and the original modules re-export them. `electron` and `node:*` are not imported. The
  architecture boundary test checks these rules; another test compares the bridge's command and layer
  lists with the shell's `HOST_COMMANDS` and `NOTE_LAYERS`, and checks that the preload implements
  every method of the bridge.
- `tsc -p tsconfig.renderer.json` (DOM, JSX) checks the renderer; the Node-side configuration excludes
  `src/renderer`.

### 4. Which pages use React

The note and settings (including first run) use React. The floating Cat stays frameworkless
TypeScript: it is small and depends on a hit test on every mouse move, so an extra framework layer
brings no benefit.

### 5. Testable logic

Logic that does not touch the DOM (link rules, arranging the transcript into cards, the request
sequence number of the model list, etc.) is written as standalone `.ts` modules and tested with
`node:test`; Node's type stripping does not support JSX, so the components themselves are accepted by
CDP in the real shell.

### 6. Third-party licenses

React and the other packages are bundled into `dist/renderer`, listed as devDependencies, and not
shipped through node_modules. The build generates `dist/renderer/THIRD-PARTY-NOTICES.txt`, listing
every bundled package, its version, its license and the full text of its license file.

### 7. Content security

- Raw HTML in agent replies is not rendered (it is shown as text); `react-markdown` drops unsafe URL
  protocols by default.
- http(s) links are handed to the system browser; other links (local files, anchors) are not
  clickable and show their target in the title; remote images are not loaded automatically and are
  shown only as links. The shell refuses to let a page open a new window or navigate.
- No inline style is used (the CSP's `style-src 'self'` would block it); classes are used throughout.

## Consequences

- The note can read markdown, show tool cards and take an approval; the settings page logic has types
  and tests.
- One more build step and two tsconfig files; changing a page requires rerunning `npm run build` (or
  `npm run build:renderer`).
- The installer grows by a few hundred KB for React and the markdown packages, negligible compared
  with Electron itself.

## Alternatives Considered

- **Keep plain JS and add only a markdown library (for example marked + DOMPurify)**: solves
  markdown, but the typing, testing and settings-page maintenance problems remain, and it still
  diverges from Desktop.
- **Import Desktop's components directly**: makes the bot depend on cats-platform, violating ADR-001.
- **Move the floating Cat to React too**: no benefit, and mouse hit testing and dragging would have to
  be verified again.
