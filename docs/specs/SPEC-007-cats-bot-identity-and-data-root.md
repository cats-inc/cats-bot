# SPEC-007: Cats Bot Identity and Data Root

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Implemented on 2026-10-30 (PLAN-008 Phases 1–3 and 1b) except FR-8, which the 0.3.0 release completes; FR-9's interactive acceptance is PLAN-008 1b.4 |
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
- Hub files have a place that cannot collide with a bot id (bot ids follow
  SPEC-008 FR-27).

## Non-Goals

- Migrating, importing or detecting 0.2.x data, environment variables or
  installations.
- The hub, registry and Boss Cat contents themselves (SPEC-008, SPEC-009);
  this spec only reserves their location.
- Changing Desktop's identifiers or the `io.catsinc` prefix.

## Requirements

### Functional Requirements

1. FR-1: Names. Repository `cats-inc/cats-bot`; package `@cats-inc/cats-bot`
   with the `cats-bot` bin unchanged; appId `io.catsinc.catsbot`; product name,
   executable and asset prefix stay "Cats Bot" / `Cats Bot.exe` / `Cats-Bot-`.
2. FR-2: Windows AUMIDs derive from the appId: `io.catsinc.catsbot` for the hub
   and `io.catsinc.catsbot.<botId>` where a surface is attributed to one bot
   (SPEC-008 defines which surfaces). The 0.2.x `io.catsinc.cats-bot.<botId>` is
   not kept.
3. FR-3: The ecosystem root defaults to `~/.catsbot/`. Each bot root is
   `<root>/bots/<botId>/` with the SPEC-001 FR-2 layout unchanged inside it,
   including `runtime/` as `CATS_RUNTIME_DIR`. Everything directly under
   `<root>/` other than `bots/`, including `archive/`, belongs to the hub
   (SPEC-008).
4. FR-4: `CATS_BOT_HOME` overrides the ecosystem root, so one variable moves
   the hub files and every bot together.
   `CATS_BOTS_HOME` is no longer read, and setting it has no effect. Every test
   keeps its bots under a temporary root and sets `CATS_BOT_HOME` to it wherever
   paths come from the environment. The development and fixture
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
   Phase 1 and 0.3.0. Its release notes state that 0.2.x has no upgrade path.
   Do not use Check for Updates in 0.2.x: its feed can follow GitHub's rename
   redirect to 0.3.0. Turn off Start at login in 0.2.x first, because its login
   entry is named after the old AUMID and would start 0.3.0 against an empty
   root. Then uninstall 0.2.x (its uninstall entry has a different GUID) and
   install 0.3.0; `~/.cats/bots`, `%APPDATA%\Cats Bot` and the update cache
   `%LOCALAPPDATA%\@cats-inccats-bots-updater` from 0.2.x may be deleted by
   hand.
9. FR-9: Like Cats Desktop's, the Windows uninstaller has a page with an
   unchecked "Remove all user data" box. When it is checked, the uninstaller
   deletes three roots: `%USERPROFILE%\.catsbot` (every bot, archived bot and
   hub file, default workspaces included), `%APPDATA%\Cats Bot` (Electron user
   data and installation gates) and `%LOCALAPPDATA%\cats-bot-updater`
   (downloaded updates; electron-builder names the cache after
   `build.extraMetadata.name`, `cats-bot`).
   - Deletion never follows a link. A junction or symlink inside a root is
     removed and its target kept, and a root that is itself a link loses only
     the link. A root moved with `CATS_BOT_HOME` is never touched. Any root
     that remains, for example because another program holds files in it or a
     path is too long, is listed in a message.
   - Every uninstall also deletes the Run values that Start at login created,
     `io.catsinc.catsbot` and `io.catsinc.catsbot.<botId>`, when they start
     this installation, with their StartupApproved values. On Windows, an
     installed copy registers Start at login again at a bot's next start when
     the owner has it on and no entry starts that copy, so a reinstall that
     kept the data keeps the setting. An entry disabled in Task Manager still
     exists and stays disabled, and a portable copy never registers itself.
   - Installing over an existing copy, updates included, runs the old
     uninstaller silently with `--updated`, so it removes neither data nor
     login entries. The exception is an installer run with `--delete-app-data`:
     its old uninstaller removes the login entries, and electron-builder itself
     deletes `%APPDATA%\Cats Bot`. A per-machine install (`/allusers`) skips the
     page and removes neither.
   - The 0.2.x uninstaller has none of this (FR-8), and macOS and Linux
     packages have no uninstaller hook. Linux's autostart entry names the
     program in `TryExec`, so one left behind does nothing (SPEC-008 FR-23).

### Non-Functional Requirements

- **Security**: the new root keeps today's file permissions and secret
  protection; moving the root changes no protection.
- **Test hygiene**: no test touches the real `~/.catsbot`, `~/.cats` or the
  provider CLIs' folders (docs/testing.md).

## Design Overview

```
~/.catsbot/                      CATS_BOT_HOME
  <hub files>                    SPEC-008 registry, SPEC-009 role state
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
