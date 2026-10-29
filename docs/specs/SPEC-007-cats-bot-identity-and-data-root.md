# SPEC-007: Cats Bot Identity and Data Root

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Draft |
| **Owner** | Product owner |
| **Reviewer** | Independent agent before implementation |

## Summary

Give Cats Bot one consistent identity and an ecosystem root outside Cats
Desktop's `~/.cats/`, as decided in
[ADR-007](../decisions/007-give-cats-bot-its-own-identity-and-data-root.md). This
is a clean break before public launch: nothing reads the 0.2.x locations, names
or releases.

## Goals

- Every engineering identifier uses the singular product identity.
- All Bot state lives under `~/.catsbot/`; nothing is created under `~/.cats/`.
- Fleet-level files have a place that cannot collide with a bot id.

## Non-Goals

- Migrating, importing or detecting 0.2.x data, environment variables or
  installations.
- The hub, registry and coordinator contents themselves (SPEC-008, SPEC-009);
  this spec only reserves their location.
- Changing Desktop's identifiers or the `io.catsinc` prefix.

## Requirements

### Functional Requirements

1. FR-1: Names. Repository `cats-inc/cats-bot`; package `@cats-inc/cats-bot`
   with the `cats-bot` bin unchanged; appId `io.catsinc.catsbot`; product name,
   executable and asset prefix stay "Cats Bot" / `Cats Bot.exe` / `Cats-Bot-`.
2. FR-2: Windows AUMIDs derive from the appId: `io.catsinc.catsbot` for the hub
   and `io.catsinc.catsbot.<botId>` where a surface is attributed to one bot
   (SPEC-008 defines which surfaces). Today's `io.catsinc.cats-bot.<botId>` is
   not kept.
3. FR-3: The ecosystem root defaults to `~/.catsbot/`. Each bot root is
   `<root>/bots/<botId>/` with the SPEC-001 FR-2 layout unchanged inside it,
   including `runtime/` as `CATS_RUNTIME_DIR`. Everything directly under
   `<root>/` other than `bots/`, including `archive/`, belongs to the fleet
   (SPEC-008).
4. FR-4: `CATS_BOT_HOME` overrides the ecosystem root, so one variable moves
   the fleet files and every bot together.
   `CATS_BOTS_HOME` is no longer read, and setting it has no effect. Every test
   sets `CATS_BOT_HOME` to a temporary directory. The development and fixture
   variables `CATS_BOTS_PROVIDER_*` and `CATS_BOTS_FIXTURE_*` become
   `CATS_BOT_PROVIDER_*` and `CATS_BOT_FIXTURE_*`.
5. FR-5: The core never creates, reads or writes a path under `~/.cats/`.
   Path containment checks compare whole segments, so `~/.catsbot` is never
   treated as inside `~/.cats` (or the reverse).
6. FR-6: Runtime is started with `--managed-by cats-bot` (SPEC-001 FR-5).
7. FR-7: Updates and releases use `cats-inc/cats-bot` everywhere: the updater
   feed, the packaged release descriptor and `parseBotRelease`, the release page
   link, `scripts/release-contract.mjs`, `scripts/build-preview.mjs`, build
   receipts and source manifests. No code path names `cats-inc/cats-bots`.
8. FR-8: 0.3.0 is the first release under the new identity and ships together
   with the hub (SPEC-008, PLAN-009). No release is published between PLAN-008
   Phase 1 and 0.3.0. Its release notes state that 0.2.x has no upgrade path:
   uninstall 0.2.x first (its uninstall entry has a different GUID), then install
   0.3.0; `~/.cats/bots` and `%APPDATA%\Cats Bot` from 0.2.x may be deleted by
   hand.

### Non-Functional Requirements

- **Security**: the new root keeps today's file permissions and secret
  protection; moving the root changes no protection.
- **Test hygiene**: no test touches the real `~/.catsbot`, `~/.cats` or the
  provider CLIs' folders (docs/testing.md).

## Design Overview

```
~/.catsbot/                      CATS_BOT_HOME
  <fleet files>                  SPEC-008 registry, SPEC-009 role state
  bots/
    <botId>/                     SPEC-001 FR-2 layout
      profile.json  conversations/  transcripts/  journal.jsonl
      runtime/                   this bot's CATS_RUNTIME_DIR
      workspace/                 default CLI working directory
  archive/
    <botId>/                     an archived bot, same layout (SPEC-008 FR-5)
  trash/                         confirmed deletes finishing (SPEC-008 FR-5)
```

## Dependencies

- GitHub repository rename and release deletion by the owner (PLAN-008).
- cats-one workspace manifest and generated AGENTS.md (owned by cats-one).

## Open Questions

- [x] `CATS_BOT_HOME` meaning (2026-10-29): the ecosystem root `~/.catsbot`,
      not `bots/` as `CATS_BOTS_HOME` was (FR-4).
- [x] 0.3.0 scope (2026-10-29): published together with PLAN-009's hub, so the
      owner reinstalls once (FR-8).

## References

- [ADR-007](../decisions/007-give-cats-bot-its-own-identity-and-data-root.md)
- [SPEC-001](SPEC-001-resident-bot-core-and-global-execution.md) FR-2, FR-5
- [SPEC-005](SPEC-005-standard-preview-releases-and-updates.md)

---

*Created: 2026-10-29*
*Author: Claude, from the owner's decisions*
*Related Plan: [PLAN-008](../plans/PLAN-008-cats-bot-identity-and-data-root.md)*
