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

The headless entry point is `cats-bot` (`node src/cli/main.ts …` from the
checkout, or `npm run bot -- …` after `npm run build`):

```bash
node src/cli/main.ts init --name Mochi --provider claude --instructions "You are Mochi."
node src/cli/main.ts run                 # foreground; Ctrl+C stops the runtime and the CLI
node src/cli/main.ts say home hello      # to the running bot, or one turn when none runs
node src/cli/main.ts status
node src/cli/main.ts conversations
```

`init` takes `--model`, `--id`, `--cwd` (the CLI's working directory; default is
the bot's own `workspace/`) and `--permission-mode skip|whitelist|default`.
The provider is the CLI's product name as cats-runtime knows it (`claude`,
`codex`, `copilot`, `pi`, …); that CLI must be installed and logged in.

Bot data lives under `~/.cats/bots/<bot-id>/` unless `CATS_BOTS_HOME` points
elsewhere (`docs/services.md`). Never point a test or an experiment at your
real `~/.cats`.

For development without a real CLI, `CATS_BOTS_PROVIDER_COMMAND` points the
provider at another executable (for example
`tests/support/fixture-cli/claude-fixture.cmd`) and
`CATS_BOTS_PROVIDER_PROJECTS_DIR` moves its discovery directory; both are read
by `run` and `say` only.

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
