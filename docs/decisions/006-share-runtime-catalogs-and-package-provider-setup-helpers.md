# ADR-006: Share Runtime catalogs and package provider setup helpers

## Status

Accepted — 2026-10-29, implementing the owner's desktop parity request in
[PLAN-007](../plans/PLAN-007-desktop-experience-parity.md). This updates ADR-002
sections 2–3 and SPEC-002 FR-1/FR-3. The resident-core boundary stays unchanged.
Pending (2026-10-29): under [ADR-008](008-run-every-bot-as-a-headless-core-under-one-hub.md) the setup
helpers run in the hub and display language becomes a fleet preference once PLAN-009 lands.

## Context

Proposed follow-up (2026-10-29):
[Platform PLAN-127](https://github.com/cats-inc/cats-platform/blob/main/docs/plans/PLAN-127-shared-platform-package-extraction.md)
would replace selected vendored helpers with versioned resources after Desktop
and Bot prove the same artifact. Until that consumer cutover, this record's
vendoring/provenance rules remain current. Provider-first UX and Runtime catalog
ownership remain unchanged; ADR-008 still owns the future Hub placement.

The original picker omitted catalog controls and added synthetic default/custom
entries. First run only checked PATH and could not install a missing provider.
The reference Desktop uses Runtime's authoritative catalogs and packaged,
provider-specific check/install helpers. Bots must share those contracts without
depending on the Platform application or probing every supported CLI.

## Decision

- Core reads the active provider's advanced HTTP catalog and Runtime's public
  `@cats-inc/cats-runtime/catalogs` read-only projection otherwise. Both retain
  entry order, labels, per-model controls, local overrides and revision. No
  Runtime server internals or Platform modules are imported.
- Product pickers offer only Codex, Claude, Antigravity, Grok and Muse, in that
  order. Existing profiles using other providers, null models or custom IDs
  remain executable and unchanged by unrelated settings saves.
- Persist the explicit model selection and controls as optional execution-target
  fields. A control change invalidates sessions like a model change. Before a
  new session, read the current revision and submit the saved entry/controls
  unchanged for Runtime validation. Removed entries or invalid controls fail
  visibly; they never silently select another model.
- Bundle the selected Platform helpers, their dependency closure and MIT license
  under `assets/setup/`. `provenance.json` records Platform source commit
  `07a02f3a30b9e02f0e25e01c348af69a500b3ae6` and each source SHA-256. This is
  vendored source reuse, not an application dependency.
- Onboarding selects a provider before installation. Native providers have one
  check/install step; Codex checks Node/npm, the npm folder, then Codex. Only an
  owned main-frame IPC may request a fixed helper and fixed action. Installation
  requires its explicit button, rechecks prerequisites/results, excludes concurrent
  operations and completes before shutdown. No arbitrary paths or arguments
  cross IPC. Authentication, restart and failure remain distinct statuses.
- Each GUI launch resolves only the saved provider's installed executable
  environment again, including nvm/custom npm paths. It never installs on launch.
  Explicit development command overrides bypass this discovery.
- Share a browser-safe translation module between native shell surfaces and
  renderers. Language preference is an optional shell-state field; the options
  and system-language resolution match Desktop. Renderer helpers remain free
  of Node/Electron and still import only types from core.

## Compatibility and consequences

The additions are compatible within the current 0.2 minor. Existing schema-2
profiles and schema-1 shell state need no rewrite or migration. Existing schema-1
profile upgrade/backup/recovery remains unchanged. Product text now says
Conversation and Direct message; persisted `home`/`note` roles, IDs, file names,
CLI aliases and IPC routes stay compatible, and owner titles/transcripts are
preserved. Publishing or changing the Runtime pin is outside this change.

Copied setup scripts must be refreshed deliberately with their entire dependency
closure, provenance and tests. Native installer execution still needs acceptance
on each target OS; deterministic tests do not establish that installation succeeds
on every host.
