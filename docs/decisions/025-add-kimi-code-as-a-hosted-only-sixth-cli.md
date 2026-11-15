# ADR-025: Add Kimi Code as a Hosted-Only Sixth CLI

## Status

Accepted — 2026-11-16. On 2026-11-16 the owner asked for two things:

- Kimi Code should use computer use from Cats Desktop and Cats Bot with the same approval logic
  as Codex.
- Cats Bot should therefore support Kimi as its sixth CLI.

Plan: [PLAN-015](../plans/PLAN-015-kimi-code-sixth-cli.md). Runtime decision:
[Runtime ADR-054 decision 11](../../../cats-runtime/docs/decisions/054-drive-kimi-code-through-print-mode-stream-json.md).

## Context

- Kimi Code's computer use is its own marketplace plugin, `kimi-cu-win` on Windows.
  - The owner installs it from Kimi's TUI with `/plugins`, then starts a new session.
  - The plugin needs its native runtime (`%LOCALAPPDATA%\Kimi Computer Use\kimi-cu.exe`) and
    Node.js 24.15 or later on PATH.
  - Kimi loads the plugin at session start from the owner's Kimi home, `~/.kimi-code`.
  - The Kimi desktop app keeps a separate home, so installing the plugin there does not install it
    for the CLI.
- Runtime's default Kimi target runs print mode (`kimi -p`).
  - Print mode loads the plugin too, but it approves every tool without asking.
  - Kimi has no flag or variable that disables plugins for one process.
  - A resident bot on print mode could therefore move the owner's mouse and keyboard from a
    heartbeat or a schedule, with nobody asked.
- Runtime's hosted target (`protocol: hosted`) runs `kimi acp` instead.
  - It keeps the session in Kimi's Default mode, so each call Kimi does not consider safe becomes a
    provider approval card. That includes every computer-use call, and the card shows the
    JavaScript cell about to run.
  - This is the path Codex's computer-use plugin already takes into the note (SPEC-006 "Codex
    consent follow-up").

## Decision

- **Sixth CLI.** Add `kimi` (label Kimi, command `kimi`) after Muse wherever the Bot lists
  providers: the provider picker, the setup wizard and the Agent CLIs tab.
  - Its row is in the "With their own installer" group.
  - Sign-in is `kimi login`.
- **Packaged helpers.** Copy Platform's Kimi Code helpers into `assets/setup/` through ADR-006's
  provenance refresh: `Install-KimiCode.ps1` and `install-kimi-code.sh` for macOS and Linux.
  - Their changed common files come too, with Platform `d808080c` as the pinned source.
  - The Bot-owned `Invoke-SetupHelper.ps1` maps `-Helper kimi` to the new helper.
- **Hosted only.** A bot whose provider is Kimi always carries the hosted policy: the provider
  policy with full machine and network access.
  - Creating, loading or retargeting a profile to Kimi fills it in.
  - Clearing it while Kimi stays the provider has no effect.
  - Leaving Kimi keeps the policy unless the owner changes it in the same change or later in
    Settings. The next provider then follows its own native approvals. Dropping the policy
    instead would put the bot back on whatever legacy permission mode it had before, which may
    be `skip`, and would also discard a policy the owner chose for Grok or Muse before trying Kimi.
  - Creating a Kimi bot with a read-only filespace or a tool allowlist is refused. Those cannot
    hold full machine access, and such a profile could not be loaded again.
  - Settings does not offer the legacy choice for Kimi and explains how to add computer use.
- **Approvals.** Kimi's approval cards use SPEC-004's existing path, so nothing new is needed.
  - In background work they wait for the owner like any other provider interaction (SPEC-004 B2).
  - Telegram can notify but cannot answer.
- **Desktop control is unchanged.** `cats-desktop` still requires an explicit interactive policy
  (SPEC-006 BDC-04), which a hosted provider never has. A Kimi bot therefore does computer use
  through Kimi's own plugin, never through Cats desktop control.

## Consequences

### Positive

- Kimi joins the Bot with the same approval guarantee Codex's computer-use plugin has: no desktop
  action without the owner's approval in the conversation.
- The Kimi helpers stay byte-identical to Desktop's and are refreshed by the same tool.

### Negative

- Kimi's full machine access cannot be narrowed. Its native approvals are the only limit, so
  read-only filespaces and tool allowlists cannot be combined with Kimi.
- The hosted target has no usage readback yet (Runtime ADR-054).

### Neutral

- No profile, journal or conversation format changes. An older Bot cannot select Kimi, and one
  that rewrites a Kimi profile keeps the policy it read.
- The plugin and its runtime remain the owner's to install.
  - The Bot's capability view reports whether Kimi loaded the plugin, whether its runtime is
    installed and whether Node.js is new enough.
  - It never installs either one.

## Alternatives Considered

### Alternative 1: Keep Kimi on print mode with the legacy settings

- **Pros**: Matches Runtime's default target. No policy is filled in automatically.
- **Cons**: Every installed plugin, computer use included, runs unasked, also in background turns.
- **Why rejected**: It breaks the owner-consent rule the Bot applies to desktop actions.

### Alternative 2: Inject `cats-desktop` for Kimi instead of using Kimi's plugin

- **Pros**: The Bot's own app grants and exclusion lists would apply.
- **Cons**: It needs an explicit interactive policy that `kimi acp` cannot verify. Kimi's own plugin
  stays loaded and runs in parallel.
- **Why rejected**: The owner asked for Kimi's computer use with Codex's logic, which is the
  provider plugin behind provider approvals.
