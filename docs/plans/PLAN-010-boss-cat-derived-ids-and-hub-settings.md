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

- [x] 3.1: Take inventory of the five providers on a clean Windows, with the
      pinned helpers
      ([ADR-006](../decisions/006-share-runtime-catalogs-and-package-provider-setup-helpers.md)).
  - Windows Sandbox: Windows 11 22621, signed in as an administrator with UAC
    off, so the user-scoped helpers ran with `-AllowAdmin`.
  - A Hyper-V VM, run once at the owner's request (2026-10-31) and not part of
    CI: Windows 11 Enterprise evaluation 26H2 (build 26300), Traditional
    Chinese. Both helper runs and the app ran at medium integrity with UAC on;
    `ConsentPromptBehaviorAdmin=0` stood in for the owner's Yes.
  - Every provider installs and starts:
    - Claude Code 2.1.314 in 85 to 253 seconds;
    - Antigravity 1.4.11 in 62 to 77 seconds;
    - Grok 1.0.70 in 80 to 111 seconds;
    - Muse 1.4.14 in 94 to 210 seconds;
    - Codex 0.166.0 in about 3.5 minutes, Node.js 26.13.0 included.
  - None needs winget, Git for Windows, the VC++ runtime or PowerShell 7.
    Claude Code falls back to its PowerShell tool on Windows PowerShell 5.1.
    No provider binary imports the VC++ runtime.
  - Node.js installs from the nodejs.org MSI when winget is missing or fails.
    The fresh 26H2 VM's winget 1.6 failed with 0x8A15005E. In the VM the
    helper's elevation went through UAC and handed its result back to the
    medium-integrity caller.
  - One gap in the helpers: Claude Code's leaves `%USERPROFILE%\.local\bin`
    off the user PATH, so a new terminal cannot run `claude` to sign in. The
    Grok, Antigravity and Muse helpers add their folders.
  - The app's own setup page, driven over CDP in the VM, worked for:
    - Codex on first run;
    - Claude Code from a bot's settings;
    - a relaunch.

    It also showed restarts that were not needed, a stale PATH hint, and help
    lines in English or twice. Task 3.4 fixes these.
- [x] 3.2: Nothing is ported from `environment-bootstrap`; nothing it offers is
      needed. SPEC-008 FR-19 and SPEC-009 FR-4 carry the changes, with no
      separate SPEC and PLAN.
  - Git is the exception to come (owner, 2026-10-31). When a feature needs it,
    such as worktrees and branches as in Cats Code, Git becomes a step installed
    with the owner's consent, as Node.js is for Codex. Without it, Runtime
    already reports repository status, commit and push as unsupported. The
    tools follow `environment-bootstrap`:
    - Windows: Git for Windows, not MinGit. `Install-Git-Admin.ps1` tries
      winget, then the official installer; the fresh Windows 11 VM's winget
      failed.
    - macOS: Homebrew's git, so Homebrew is a step before it.
    - Linux: the system package manager.
    - `Setup-Git` sets the commit identity.
- [x] 3.3: cats-platform #355 (`cce4ff6e`) puts Claude Code's folder on the user
      PATH and adds TLS 1.2 (3.7). The six helpers it changed are pinned here
      at that commit.
- [x] 3.4: Setup page and Bot tab (SPEC-008 FR-19):
  - After an install the fresh check decides the step. A restart or relaunch
    stands only while that check cannot confirm the step; a failure or
    refused elevation always stands. Before this, every native provider
    showed 「需要重新開啟程式」 and kept Create and start disabled until Check
    again.
  - The provider hint follows an install.
  - A finished step drops installer diagnostics, and a help line the check and
    the install both give shows once.
  - The five providers' sign-in lines are in Traditional Chinese.
  - A declined UAC prompt shows 「需要管理員授權」. The Node helper reports it
    as an interruption, not as its status.
- [x] 3.5: D30 open item 3 (owner, 2026-10-31): first-run setup and New bot
      install before the bot exists, and a bot's settings reinstall a removed
      CLI. `hub_create_bot` for a provider not on the hub's PATH opens the New
      bot window filled in with the request, after the owner's consent
      (SPEC-009 FR-4). The consent dialog says the window will open. An open
      window refuses the request before the owner is asked. Names are
      limited to 40 characters, as the window takes.
- [x] 3.6: The VM's app test, rerun with these changes, passed:
  - Codex on first run, with no Check again and no restart;
  - Codex reinstalled from a bot's settings after npm removed it;
  - Claude Code from settings, straight to 需要登入 with the hint updated;
  - a relaunch.
- [x] 3.7: TLS 1.2 for early Windows 10 (owner, 2026-10-31), in cats-platform
      #355.
  - Every helper adds TLS 1.2 to a legacy TLS 1.0 default and leaves the
    system default alone. Vendor installers run the same line first in their
    child `powershell.exe`.
  - Unit tests force the legacy default. The VM's registry attempt to force it
    did not take effect, so there the run showed only that every install
    still works with these scripts.

- [x] 3.8: A clean Windows defaults to the Restricted execution policy, so
      `codex` and `npm` in a PowerShell terminal hit their `.ps1` shims and
      fail. Signing in with `codex login` there then fails too. The VM tests ran
      through `cmd.exe` and missed it; Cats Desktop's `Setup-CliReadiness.ps1`
      already handles it.
  - Codex on Windows gets a PowerShell scripts step after the npm folder,
    using that helper (pinned at `cce4ff6e`) scoped to the policy.
  - The step sets the user's own policy to RemoteSigned and adds no PATH
    entries; Claude Code's helper adds its own.

**Deliverables**: a clean machine can set up any of the five providers.

#### Decisions to confirm (Phase 3)

The owner confirmed D31 to D34 on 2026-10-31; D35 waits.

- **D31.** A restart or relaunch from a helper no longer hides a fresh check
  that confirms the step. This reverses the rule from #48 for those two
  states; `failed` and `elevation_required` still stand.
- **D32.** `hub_create_bot` decides by PATH whether to create the bot at once
  or open the New bot window. Running the helpers there could interrupt an
  install the owner has open.
- **D33.** A Boss Cat's request is refused while a New bot window is open,
  rather than replacing what the owner is typing.
- **D34.** No separate SPEC/PLAN pair for Phase 3, and nothing ported. The
  owner left these two of the sandbox report's items unanswered, so they
  follow the recommendation.
- **D35.** On Windows the PowerShell scripts step is required before Codex,
  like the npm folder, rather than optional: the sign-in the page asks for
  happens in a terminal, and Windows Terminal opens PowerShell.

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
| `src/shell/electron/providerSetup.ts` | Modify | The fresh check decides a step after an install (Phase 3) |
| `src/renderer/settings/SetupPage.tsx`, `BotTab.tsx` | Modify | Hint follows installs; New bot window filled in from a Boss Cat's request |
| `src/shell/electron/main.ts`, `hub/bossCatBroker.ts`, `assets/preload.cjs`, `src/renderer/bridge.ts` | Modify | `hub_create_bot` for a provider not set up opens the New bot window (`setup:prefill`) |

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
| 2026-10-31 | Phase 3 inventory, in Windows Sandbox and once in a Hyper-V VM with UAC on: the five providers install and start with the pinned helpers, and nothing needs porting. The setup page's install states, PATH hint and help lines, and Boss Cat creation for a provider not set up are fixed. Still to do: re-pin the Platform fix for Claude Code's PATH (3.3) and rerun the VM app test with the changes (3.6). |
| 2026-10-31 | Independent review of Phase 3. Fixed: Boss Cat names allowed 80 characters where the New bot window takes 40; the owner was asked before a busy window refused; a declined UAC prompt for Node showed as a step to set up; the audit recorded the window as done; SPEC-008 FR-19 wording. Added tests for the Codex chain after the npm folder's restart request, a declined UAC prompt, and the Boss Cat's busy window and name limit. 340 tests pass. |
| 2026-10-31 | The owner confirmed D31 to D34 and chose TLS 1.2. cats-platform #355 (`cce4ff6e`) carries Claude Code's user PATH and TLS 1.2, and its six changed helpers are pinned here. The VM's app test, rerun with the changes, passed, and a third VM run installed every native provider and Node.js with the TLS scripts. Phase 3 is done; the VM stays for now at the owner's request. |
| 2026-10-31 | 3.8 verified once in the VM at medium integrity. With the Restricted default, `codex --version` in PowerShell failed on its `.ps1` shim; after the PowerShell scripts step set the user's policy to RemoteSigned, it printed `codex-cli 0.166.0`. The app test passed with the step in the Codex chain: Node.js, the npm folder, PowerShell scripts and Codex each reached 已就緒 with no Check again. The reinstall from a bot's settings, Claude Code from settings and the relaunch passed again. |

---

*Created: 2026-10-30*
*Author: Claude*
