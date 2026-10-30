# PLAN-010: Boss Cat, Derived Ids and Hub Settings

## Metadata

| Field | Value |
|-------|-------|
| **Status** | In Progress |
| **Owner** | Product owner |
| **Assigned To** | Claude |
| **Reviewer** | Independent agent |

## Related Spec

[SPEC-008: Hub and Bots](../specs/SPEC-008-hub-and-bots.md) and
[SPEC-009: Boss Cat Role](../specs/SPEC-009-boss-cat-role.md), after the
owner's review of [PLAN-009](PLAN-009-hub-headless-cores-and-coordinator.md)'s
decisions.

## Overview

The owner went through PLAN-009's decisions D1 to D30 on 2026-10-30. All were
confirmed except the changes below, which this plan carries out.

- **The role is renamed Boss Cat (主控貓).**
  - In cats-platform, a conversation's **Coordinator** is the participant its
    orchestrator is bound to; it routes turns within that conversation.
  - A **Boss Cat** is the admin cat that may act beyond the conversation, such
    as opening conversations or assigning work.
  - This role hands work to other bots and asks to create, start or stop them,
    so it is Platform's Boss Cat, not its coordinator. The difference is that
    one bot holds it at a time.
- **D2:** every id derived from a bot's name ends in `-catsbot` (`Mochi` becomes
  `mochi-catsbot`). An id given with `--id` is taken as given.
- **D17:** only the hub's Bots page manages bots. A bot's settings window no
  longer reaches other bots.
- **D20:** the hub has a Settings window of its own, with the app language,
  start at login, the version and updates, and the Bots tab. The tray offers it
  with any number of bots.
- **D23:** user data stays one per account.
- **D30:**
  - Open items 1 (resuming a heartbeat without consent) and 2 (one `cats-hub`
    token per bot) stay as they are.
  - Open item 3 becomes the clean-machine setup of Phase 3.

PowerShell 7 is not part of setup. Runtime runs no provider through `pwsh` by
default: the shipped and generated provider settings use `runner: auto`, which
on Windows uses `cmd.exe` or Windows PowerShell 5.1. `PWSH_PATH` came from a
GitHub Copilot workaround that Runtime has since removed.

## Implementation Phases

### Phase 1: Boss Cat and derived ids

- [x] 1.1: Rename the role in code, data, CLI and UI.
  - The `bots.json` field `coordinator` becomes `bossCat`. Under the
    pre-launch policy a 0.3 registry's assignment is not carried over; the
    owner assigns the role again.
  - `cats-bot hub coordinator` becomes `cats-bot hub boss-cat`, and the hub
    control endpoint's command follows.
  - The `cats-hub` instructions and the text a delivered message carries say
    Boss Cat.
  - The interface says "Boss Cat" in English and 「主控貓」 in Traditional
    Chinese.
- [x] 1.2: SPEC-009 becomes the Boss Cat Role spec, renamed file included. ADR-009
      and PLAN-009 get a terminology note and keep their history. The guides
      follow; published release notes stay as they are.
- [x] 1.3: `deriveBotId` appends `-catsbot` to every derived id, keeping the name
      part to 56 characters; a taken id gets `-2`, `-3` and so on after it, in
      `cats-bot init` as on the Bots page. A `--provider` first run without
      `--name` names the bot Mochi.

**Deliverables**: no "coordinator" role remains in Cats Bot's code, data, CLI,
interface or living documents; new bots get `-catsbot` ids.

### Phase 2: Hub settings

- [x] 2.1: The hub's Settings window (`scope=hub`) gets a General tab and the Bots
      tab.
  - General holds the app language, start at login, the version, updates and
    the data folder.
  - The tray offers "Settings…" for it with one bot or several.
- [x] 2.2: A bot's settings window loses the Bots tab and the hub-level items. It
      keeps its bot, notes, life and Telegram tabs, and its own app items: the
      floating cat, its facts and its folder.
- [x] 2.3: The hub accepts bot management only from its own Settings window:
      `hub:botAction`, `hub:setLimits`, `hub:create` and the Bots listing
      (SPEC-008 FR-17).

**Deliverables**: one place manages the bots and the app; each bot's window
reaches only its own bot.

### Phase 3: Clean-machine setup

- [ ] 3.1: A separate SPEC and PLAN, in cats-platform for the shared setup scripts
      ([ADR-006](../decisions/006-share-runtime-catalogs-and-package-provider-setup-helpers.md))
      and here for the setup page. Following them:
      1. Take inventory on a clean Windows (Windows Sandbox) for each of the five
         providers.
      2. Port the missing installers, such as winget and Git for Windows, from
         `environment-bootstrap`. Each one runs only with the owner's consent.
      3. Pin the new scripts here.

**Deliverables**: a clean machine can set up any of the five providers.

### Phase 4: Release

- [ ] 4.1: 0.4.0 when the owner selects it. The renamed registry field and CLI
      command are a breaking contract, so this is the next minor.

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/shell/electron/hub/coordinator.ts` | Rename | `bossCatBroker.ts` |
| `src/shell/electron/hub/registry.ts`, `botManager.ts`, `main.ts` | Modify | `bossCat` field, role wiring, hub Settings |
| `src/core/tools/hubTools.ts`, `src/core/bot.ts` | Modify | Instructions and delivered-message text |
| `src/cli/main.ts` | Modify | `hub boss-cat`; `init` numbers a derived id |
| `src/core/store/paths.ts` | Modify | `-catsbot` derived ids |
| `src/renderer/settings/*`, `src/shared/language.ts` | Modify | Hub Settings, labels |
| `src/shell/electron/trayMenu.ts` | Modify | "Settings…" in every shape |
| `docs/specs/SPEC-009-*.md` and the docs that name the role | Modify | Boss Cat |

## Technical Decisions

- Boss Cat over a Bot-only name, so the two products use one term for one
  concept; SPEC-009 states that one bot holds it at a time.
- No migration of the 0.3 `coordinator` field: Cats Bot is pre-launch.

## Progress Log

| Date | Update |
|------|--------|
| 2026-10-30 | Plan created from the owner's review of PLAN-009 D1 to D30. |
| 2026-10-30 | Phase 1 done: the role is Boss Cat in code, data (`bossCat`), CLI (`hub boss-cat`), interface (主控貓) and the living docs; derived ids end in `-catsbot`. 334 tests pass. |
| 2026-10-30 | Phase 2 done: Cats Bot Settings (General and Bots) opens from the tray's Settings… in every shape and by itself when no bot runs; a bot's settings keep its own tabs (the former App tab is Details) and its tray item is "Bot settings…". Bot management, start at login and updates refuse any other window. Verified with the real Electron hub in an isolated home over CDP. |
| 2026-10-30 | Independent review of #71: `cats-bot init` now numbers a derived id as the Bots page does, a `--provider` first run without `--name` keeps the name Mochi, only Cats Bot Settings receives bot and update broadcasts, the macOS Boss Cat sheet opens on Bots, the update prompt says every bot stops, and stale docs and comments were corrected. A protocol bump for the renamed host command was not made: a 0.3 core reattached after a hub crash is restarted, which the pre-launch policy allows. |

---

*Created: 2026-10-30*
*Author: Claude*
