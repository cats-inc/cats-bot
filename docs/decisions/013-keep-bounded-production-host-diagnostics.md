# ADR-013: Keep Bounded Production Host Diagnostics

## Status

Accepted — 2026-11-02. The owner requested production host/core/stderr diagnostics
after a missing Bot investigation and explicitly excluded crash dumps.
Implementation and validation are recorded in [testing](../testing.md#host-diagnostics).

## Context

Core logs cannot explain a missing Electron window, renderer/GPU failure or display
change. The hub previously wrote its diagnostics only to stderr. Existing core
logs grew without rotation. Cores must continue running and writing evidence when
the disposable hub exits (ADR-008).

## Decision

- The primary hub writes `<Electron userData>/logs/host.log`, starting after the
  single-instance lock and before `app.whenReady()`. Secondary launches are
  recorded by an early listener in the primary. Invalid arguments or native
  failures before that point may still have no host file record.
- Production defaults to INFO. `CATS_BOT_LOG_LEVEL=trace|debug|info|warn|error`
  is read at launch; invalid values use INFO. DEBUG adds movement/resize events.
  TRACE currently includes the same events. Failure callers supply explicit severity.
- Record version/PID/runtime/platform/paths, lifecycle and second launches;
  display IDs/bounds/work areas/scales/rotations; window IDs/page kinds/bounds and
  visibility; renderer/child exit reason/code; page-load codes; core start/reattach
  and failures; and avatar repositioning. Never record titles, URL queries,
  raw arguments, environment dumps, prompts or replies.
- Use synchronous, best-effort file writes: 256 KiB per host/core log, three
  backups (`.1` newest), and at most 16 KiB per record. First use bounds oversized
  legacy files and known backups, preserving their newest bytes. File and mirror
  failures never stop execution. These diagnostic files are not execution state;
  no public contract/version or persisted-data migration is needed.
- Exception records retain type, safe OS code and stack locations, omitting
  arbitrary message/source text. Existing credential-like strings are redacted as
  defence in depth. Boss Cat diagnostic/audit outcomes use fixed labels rather
  than potentially private refusal text; its caller still gets the original answer.
- Keep core stderr on an inherited append-mode file descriptor, never a pipe
  owned by the hub. At launch, preserve at most the latest 256 KiB in
  `core-stderr.previous.log`. The core checks once per second and on orderly exit,
  snapshots a bounded tail and truncates the current file in place through a
  separate verified read/write handle (Windows append handles cannot truncate).
  The original append handle remains usable. This is a soft threshold: bursts or
  a blocked event loop can temporarily exceed it. A forcibly killed core cannot
  perform its final check; the next launch bounds its previous evidence.
- Core stdout still contains conversation events and is never captured to disk.
  Raw engine stderr remains a separate diagnostic file, not expanded into a
  blanket capture of renderer consoles or provider content.
- Monitor uncaught exceptions synchronously without adding a handler that
  suppresses the existing fatal behaviour. The core's existing unhandled-rejection
  policy remains unchanged. Do not add automatic hub restarts.
- Do not start Electron crashReporter, collect dumps or upload diagnostics.

## Consequences

### Positive

- Installed builds leave useful local evidence without a special debug build.
- Bounded ordinary logs and bounded stderr snapshots avoid indefinite accumulation.
- Detached cores retain independent diagnostics when the hub disappears.

### Negative

- Text records cannot explain native failures that occur before JavaScript starts.
- Size limits discard older evidence; raw stderr has only periodic enforcement.
- Synchronous writes add a small filesystem cost, especially with DEBUG enabled.

### Neutral

- Existing core log line/timestamp syntax and UI error answers stay compatible.
- Cats Desktop is outside this change; its own outer host diagnostics need a
  separate follow-up despite its existing sidecar service logs.

## Alternatives Considered

### Extend only core.log

Does not observe the disposable presentation process or display events.

### Debug-only logging or crash dumps

Debug-only logs miss installed-build incidents. Dumps were explicitly excluded
by the owner because of size and accumulation.

## References

- [ADR-008](008-run-every-bot-as-a-headless-core-under-one-hub.md)
- [Diagnostic locations and retention](../setup-guide.md#diagnostic-logs)
- [Electron crash events](https://www.electronjs.org/docs/latest/tutorial/crash-reporting)
- [Node uncaughtExceptionMonitor](https://nodejs.org/api/process.html#event-uncaughtexceptionmonitor)

Decision made: 2026-11-02.
