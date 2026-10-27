# Testing Strategy

> How the bot core is tested, and the rules every test follows.

## Overview

The bot core is headless by design (ADR-001 §2), so almost everything is
testable without a window: state machines, the queue, schedules and heartbeats
run against a fake runtime client and a fake clock, and the few things that
need a real process run against the real pinned `cats-runtime` package with a
scripted fixture provider. Manual acceptance with a real provider CLI is the
last step, not the first.

## Test Types

### Architecture boundary test

- **Location**: `tests/architecture-boundaries.test.ts`
- **Scope**: `src/core/**` and `src/cli/**` never import `electron`, any
  `cats-platform` path or a relative path outside `src/`; `src/shell/**` never
  imports `src/core/runtime/`; no file reaches outside the repository
  (SPEC-001 A6).

### Unit tests (PLAN-001 Phase 1 onward)

- **Location**: `tests/core/*.test.ts`
- **Scope**: profile defaults, atomic writes and journal rebuild, attachment and
  work-item state machines, the session gate, retry and backoff, handoff-pack
  truncation, schedule due/missed policies, heartbeat deferral and `[quiet]`.
- **Doubles**: a fake runtime client and an injectable clock; no network, no
  child processes.

### Integration tests (PLAN-001 Phase 1 onward)

- **Location**: `tests/integration/*.test.ts`
- **Scope**: the real `cats-runtime` bin from `node_modules`, started the way
  the bot starts it (`--startup-mode app-managed --port 0`, private
  `CATS_RUNTIME_DIR`), with a scripted fixture CLI registered as the provider.
  Covers create, streaming, cancel, resume, runtime restart and core restart.
- Every test starts its own runtime in a temporary directory and stops it in
  `after`, so no child process outlives the test run.

### Manual acceptance

- A real provider CLI on Windows for SPEC-001 A1 to A4; PLAN-001 Phase 3 adds
  tray and sticky-note checks with the `desktop-ui-automation` skill and fills
  the measurement table.

## Running Tests

```bash
npm test                                      # everything
node --test tests/architecture-boundaries.test.ts
node --test "tests/core/*.test.ts"
```

`npm run typecheck` type-checks tests as well as sources (`tsconfig.test.json`).

## Rules

- **State hygiene**: tests only write under a temporary directory they create;
  `CATS_BOTS_HOME` and `CATS_RUNTIME_DIR` always point there. No test touches
  the real `~/.cats`, and no test reads any provider credential file.
- **Erasable syntax only**: tests are `.ts` files run by Node's type stripping.
  Use `import type` for types and keep to the syntax `erasableSyntaxOnly`
  allows.
- **No sleeps for logic**: time-dependent behaviour takes an injected clock;
  real waits appear only in integration tests, with a bounded timeout.
- **Report honestly**: a test that cannot run (for example a missing CLI for a
  manual check) is reported as not run, never as passed.

## CI/CD Integration

`.github/workflows/ci.yaml` runs `npm ci`, `npm run typecheck`, `npm test` and
`npm run build` on `ubuntu-latest` and `windows-latest` with Node 24 for every
pull request and every push to `main`.

---

*Last updated: 2026-10-27*
