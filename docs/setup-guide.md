# Setup Guide

> How to build, test and run the bot core from a fresh checkout.

## Prerequisites

- Node.js 24 (`.nvmrc`). Tests run `.ts` files directly through Node's type
  stripping, so an older Node cannot run them.
- npm 10 or newer (bundled with Node 24).
- For manual acceptance with a real provider: the provider CLI (for example
  Claude Code or Codex) installed and logged in on this machine. The bot never
  reads the CLI's credential files; it only runs the CLI through cats-runtime.

## Installation

```bash
git clone https://github.com/cats-inc/cats-bots.git
cd cats-bots
npm ci
```

`npm ci` installs the exact `@cats-inc/cats-runtime` version pinned in
`package.json`; the bot starts that package's `cats-runtime` bin as its private
child process. Upgrading the pin is a deliberate change with its own PR and
integration-test run (ADR-001 §1).

## Verify the toolchain

```bash
npm run typecheck   # tsc over src/ and tests/
npm test            # node --test over tests/**/*.test.ts
npm run build       # tsc -> dist/
```

All three must pass on Windows and on Linux; CI runs them on both.

## Running a bot

The headless entry point `cats-bot` (`npm run bot -- <command>`) arrives with
PLAN-001 Phase 1 (`init`, `run`, `say`, `status`, `conversations`). Until it
lands, there is no runnable bot.

Bot data lives under `~/.cats/bots/<bot-id>/` unless `CATS_BOTS_HOME` points
elsewhere (`docs/services.md`). Never point a test or an experiment at your
real `~/.cats`.

## Common Issues

### `node --test` reports a syntax error inside a `.ts` file

Node only strips erasable TypeScript syntax. `enum`, `namespace`, parameter
properties and `import x = require()` are rejected; `tsc` enforces the same
rule through `erasableSyntaxOnly`, so run `npm run typecheck` first.

### Relative imports end in `.ts`

That is intentional: Node resolves the file that exists on disk, and
`rewriteRelativeImportExtensions` makes `tsc` emit `.js` in `dist/`.

---

*Last updated: 2026-10-27*
