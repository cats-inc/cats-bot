# ADR-030: Split a Cat Bot's Settings into the Wizard's Pages and Ask Two Questions About Permissions

## Status

Accepted — 2026-11-16, at the owner's request. The owner found the Cat bot tab unreasonable. It put the Cat's look,
its provider and its permissions on one page. It also did not match the setup wizard, so the pages worked
differently, and its tool permissions were a mess. The owner reviewed a proposal and decided:

- The tool allowlist is not kept. Nobody uses it; a cat bot that still has one moves to asking first.
- The defaults stay as they are.
- A row that cannot apply is not shown, and no text explains what is unbuilt elsewhere.
- Saving never waits on a CLI being installed. A check cannot promise the CLI is still there later.
- The simulated terminal suits the wizard, but not a settings page with a Save button.

Everything else was left to the proposal. Amends [SPEC-002](../specs/SPEC-002-desktop-presence-settings-and-first-run.md)
FR-2 to FR-4, [SPEC-001](../specs/SPEC-001-resident-bot-core-and-global-execution.md) FR-1 and FR-30, and
[SPEC-013](../specs/SPEC-013-agent-clis-in-cats-bot-settings.md) FR-7, FR-8, FR-13 and FR-14. SPEC-010, the wizard, is
unchanged.

## Context

- The Cat bot tab held, top to bottom:
  - the name and look;
  - the provider with its checklist and log;
  - Claude in Chrome, the model and effort;
  - the personality and the reply language;
  - "Filespace and permissions";
  - "Provider access and tools";
  - the current session's diagnostics;
  - desktop control.
- It saved three ways: one Save in the middle, "Save provider policy" further down, and desktop control at once.
- Two permission systems were on screen at once.
  - The old one: file access, a permission mode (the CLI's default, an allowlist, or everything).
  - The provider policy: provider or explicit, access, network and approval.
  - They had to be saved separately, which caused errors such as "clear any legacy tool allowlist first".
- The page offered what Runtime refuses.
  - Claude Code admits only the whole computer with the network, on every platform. The page offered a writable
    filespace and said the limit was Windows-only. A save was refused with an error about the filespace and an
    allowlist.
  - For Claude Code, "Ask when requested by the agent" and "Ask for untrusted commands" are the same thing: Runtime
    launches both in `manual` mode.
  - For Codex, Runtime declines command and file approvals below the whole computer with the network. Narrowing
    Codex's reach meant its requests never reached the owner. The page did not say so.
  - Antigravity, Grok, Muse and Kimi admit only the whole computer with the network.
- The wizard asks for the name, look, provider and personality, then checks and installs the CLI, then signs in
  and picks a model. It never asks about permissions.
- In the wizard, the log across the window's foot is the record of what the window is doing. On a settings page
  with Save, the same black panel, a primary "Check again" or "Apply" and ticks made installing look like a second
  form to submit.

## Decision

1. **Three pages, in the wizard's order.** They are the first three tabs, above a rule:
   - **Name and look:** the name, the wizard's look grid, its personality chips and text, the reply language, and
     the floating Cat (from Details).
   - **Provider and model:** the wizard's provider cards with their vendors, the CLI on this computer, sign-in, the
     model and effort.
   - **Permissions:** described in point 3.
   - Details keeps the facts and the folder and gains the session check, folded (the former "Current session").
   - Opening the settings window on `bot` opens Name and look.
2. **One save bar for the three pages.**
   - It appears with the first edit and says what saving will do:
     - a fresh session with a handoff for every conversation;
     - the runtime restarting for a new provider;
     - the permission choice a new provider takes;
     - desktop control's grants being revoked.
   - A dot in the rail marks a page with an edit not saved.
   - The pages stay mounted, so an edit survives a look at another tab. The profile read again on focus never
     undoes an edit: the pages keep only the owner's edits on top of it.
   - A provider and the permissions it allows go in one `updateProfile`. With a new provider the policy always goes
     too, so the core never keeps or drops the old one by its own rules.
   - Save waits only for its own fields: a name or personality the text rule refuses, or a model menu still
     loading. It never waits for a CLI.
3. **Permissions are two questions, answered only with what Runtime admits.**
   - A sentence at the top says what the cat bot can do.
   - "Ask before it acts?" offers per provider:
     - Claude Code: Ask me first; Follow Claude Code's own settings; Read, never change; Never ask.
     - Codex: Ask me first; Work inside the limit; Follow Codex's own settings; Never ask.
     - Kimi Code: Follow Kimi Code's own settings, only.
     - Antigravity, Grok and Muse: Follow its own settings (native tools), or Without native tools.
   - "What it can reach" draws the whole computer around the filespace (read, or read and edit), with the network
     beside both.
     - The owner moves the drawing only for Codex's limit and ceiling.
     - Elsewhere it is fixed, with one line saying why.
     - A network setting Bot leaves to Codex reads "As Codex is set".
   - Every choice is stored in fields the profile already has. Each provider's default is one of the choices:
     Claude Code's own settings, Codex's limit at read and edit, Kimi's own settings, and no native tools for the
     others. Choosing the default writes the default back. The stored values:
     - Ask me first: an explicit policy with the whole computer and the network, asking (`on-request` for Claude
       Code, `untrusted` for Codex).
     - Never ask: the same with `never`.
     - Read, never change, and Codex's limit at read: no policy, with a read-only filespace.
     - Codex's limit at read and edit: no policy (Runtime runs Codex in its sandbox without asking), or an explicit
       policy once the owner sets the network.
     - Follow its own settings: a provider policy (Codex's level is the ceiling), or no policy for Claude Code.
   - Every stored combination reads as exactly one choice, so there is no "custom" row and nothing to keep aside.
     A policy Claude Code cannot hold reads as its choice at another level, so the next save replaces it.
   - Saving an untouched page sends nothing.
   - Extras:
     - "Use Chrome or Edge" appears for Claude Code only.
     - Desktop control appears for Claude Code and Codex where it is available, and only with Ask me first. Its
       row offers that change.
     - A row that cannot apply is not shown.
4. **The tool allowlist is gone.**
   - `permissionMode: 'whitelist'` and `allowedTools` are no longer written: not by Settings, `updateProfile`,
     `createProfile` or `cats-bot init`.
   - A profile that has one is upgraded once when its core starts:
     - Claude Code and Codex with a writable filespace move to Ask me first.
     - A read-only filespace stays read-only.
     - Other CLIs keep their own default.
     - A list beside another mode never reached a session, so it is only dropped.
   - The upgrade bumps `configRevision`, so sessions made with the list are replaced with a handoff. It keeps a copy
     beside the profile.
   - An older Bot run in between may write a list again. That is upgraded again, and a different copy is kept under
     its own name instead of stopping the cat bot.
   - Runtime's allowlist is untouched.
5. **A setup row on a settings page has one action, not a tick.**
   - "Install", "Set up" or "Update" opens a box under the row. The box names the change, its tags, what it will
     do, the command that runs, the script and how to do it by hand. Running is the box's ink button; amber stays
     for saving settings.
   - A run shows its command and a timer, because helpers report only at their end. Its report then stays on the
     row: a version, an update's result, or a failure's output with Try again.
   - The whole log opens beside the rows when asked for ("Log (N)"), with Copy all. It is no longer laid across the
     window's foot.
   - On Provider and model:
     - Installing and saving do not wait for each other.
     - What was read stays with its provider while another is looked at.
     - A run continues across tab and provider changes. The rail shows it while it runs.
     - A step another window is running is said on the row.
   - The same rows replace ticks, "Apply N ticked" and the docked log on Cats Bot Settings' Agent CLIs tab. The
     wizard keeps its ticks and its log.
6. **Signing in from a cat bot's page.** Provider and model shows the wizard's sign-in row, and Windows Codex's
   first-time setup.
   - The shell opens their terminals for that window only for a CLI its last check found working (SPEC-013 FR-10).
   - A CLI removed since then is no longer offered.

## Consequences

### Positive

- The wizard and the settings ask the same things in the same order, with the same controls.
- Every permission choice offered can be saved, and says what it does.
- Settings saves one way. Installing reads as an action on the computer, not part of a form.

### Negative

- A cat bot that used an allowlist now asks before each action instead of refusing tools outside the list. Its
  owner is asked more, not less.
- Desktop control turns off, revoking its grants, when the owner moves away from Ask me first.
- A log is still only what this window heard in this session.

### Neutral

- The profile format is unchanged apart from the allowlist upgrade. An older Bot reads an upgraded profile.

## Alternatives Considered

### Alternative 1: Fix the labels and keep one page

- **Pros**: smallest change.
- **Cons**: the page would still mix three ways of saving, two permission systems and a log.
- **Why rejected**: it fixes neither the order nor the permissions.

### Alternative 2: Keep the allowlist for cat bots that use it

- **Pros**: nothing changes for them.
- **Cons**: a fifth way to set permissions, kept only for itself.
- **Why rejected**: the owner wanted no such way left, and nobody uses it.

### Alternative 3: Block Save until the chosen CLI is installed

- **Pros**: fewer cat bots whose next turn fails.
- **Cons**: a check proves nothing later; the CLI can be removed right after.
- **Why rejected**: the owner rejected it, as for the wizard before.

### Alternative 4: Keep ticks and Apply in Settings

- **Pros**: the wizard's control everywhere.
- **Cons**: on a cat bot's page, Apply would be a second button to submit next to Save.
- **Why rejected**: one action per row says the same with less, and runs at once.
