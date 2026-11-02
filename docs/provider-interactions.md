# Provider interaction control

This control answers the existing live provider turn. `approve` still answers
Bot `ask_owner` or interrupted-turn rerun decisions; it cannot approve native tools.

```text
cats-bot interactions home --id <bot>
cats-bot respond home <interactionId> --id <bot>   # JSON response from stdin
cats-bot capabilities home --id <bot> --refresh
```

Build a response using the live snapshot's identities and revision:

```json
{
  "workerGeneration": "<from snapshot>",
  "executionId": "<from snapshot>",
  "workItemId": "<from snapshot>",
  "expectedRevision": 1,
  "idempotencyKey": "<unique owner attempt>",
  "answer": { "action": "accept", "values": { "<field-id>": "<answer>" } }
}
```

Supply JSON through stdin, not argv or the file handoff queue. Use the same
idempotency key for an unchanged retry. Offered command/file choices use `choice`;
permission requests use an explicit subset in `grants` and an offered `scope`;
`decline`/`cancel` do not carry form values. Runtime validates the typed answer.
Expired requests and different work/generation/conversation identities cannot
reach a new worker. URL opening is separate from completion.

Desktop control (SPEC-006, Windows) has its own command; `respond` and `approve`
never answer an app grant request:

```text
cats-bot desktop home --id <bot>                        # state, grants and waiting requests as JSON
cats-bot desktop home --enable --id <bot>               # or --disable: the conversation switch
cats-bot desktop home --grant <requestId> allow --id <bot>   # or deny
cats-bot desktop home --stop --id <bot>                 # --stop --all: every conversation
```

The profile switch is in Settings > Bot. `capabilities` shows a `desktopControl`
entry ("Cats desktop control") beside Runtime's observation.

BotHostApi exposes `providerInteractions`, `respondProviderInteraction`, and
`sessionCapabilities`. The control path remains available while a model turn is
waiting. Pending requests keep the global gate, so ticks and queued work cannot
replace the waiting session. Telegram only notifies the owner to use a local
surface; ordinary Telegram text is never interpreted as a native answer.

Profile schema 2 stores `providerPolicy: null` for existing behavior, or the
versioned Runtime provider/explicit policy. Explicit policy separates local
access, network and approval. Read-only workspace and allowlist boundaries cannot
be overridden. Selecting a policy requires Runtime capability negotiation before
create/resume; absence is unavailable, never silently ignored. Global changes
take effect after the current turn, through the existing configuration revision.

The receipt sidecar is a bounded v1 journal projection with no prompts, answers,
URLs or credentials. Both primary and backup are validated; unknown versions
stop, and a syntactically corrupt primary may recover from a recognized backup.
Core restart marks pending receipts interrupted and does not resurrect callbacks.
See [architecture](architecture.md) for the protected profile upgrade.

Inventory is an observation of the current worker's top-level MCP servers and
Runtime dynamic tools. Nested/lazy tools, built-ins and successful invocation are
not inferred. Helper/browser status remains unknown unless separately measured.
The exact Runtime candidate is recorded in [vendor provenance](../vendor/README.md).

Claude Code bots use the same control (Runtime SPEC-039 R8). Questions arrive as
`user_input`, shell commands and file edits as command/file approvals, and every
other tool, including Claude in Chrome, as `tool_approval`; MCP forms and URL
requests work as for Codex. Claude Code has no native-Windows sandbox, so only the
full-access-with-network policy can be selected for it, and a narrower one is
refused when it is saved while the runtime is ready. The Bot tab's Claude in Chrome
option adds `--chrome` to the CLI launch and restarts the runtime after the
current turn. Computer use is not available to headless Claude Code.

The note displays native requests near the current turn, separate from `ask_owner`.
Only pending and responding requests are shown; a finished request leaves the note,
and its redacted receipt stays available through `cats-bot interactions`.
Closing/reloading a note leaves the core request alive. The tray's pending-request
entry opens the waiting note; floating/Telegram notifications contain no prompt.
Bot settings separate access, network and approval, and can inspect each note's
current policy and top-level tools. Legacy tool controls are inactive while an
explicit/provider policy is selected. Inventory refresh never starts a model turn.

Windows acceptance on 2026-10-28 used an isolated data root, Electron 41.2.0 and
the pinned Runtime with a scripted Codex native protocol fixture. Source and
unpacked Windows candidates completed a same-turn reply after renderer reload.
Five empty-form turns verified required empty string/array and an optional enum
whose selected value is empty. The last request remained visible after long
transcripts and four terminal receipts. Settings showed the observed policy and
separated MCP discovery from invocation. URL control rejects stale/unavailable,
expired and unsafe-scheme requests; opening is not completion. The candidate was
not signed or installed. Real Codex Chrome/computer-use acceptance is recorded
separately when performed; these fixture checks do not establish tool parity.


## Muse, Grok and Antigravity native work tools

In Bot settings → Provider access, choose **Enable native tools with provider
permissions** and save. Existing bots retain legacy behavior until this selection.
Changing modes waits for the current turn, replaces the private Runtime target,
and starts a new session with a transcript handoff; queued messages are not replayed.
No profile or journal format migration is required.

These providers initially require full machine access with network. Native
permission settings and reviewers still decide actions; the setting does not
switch to unconditional approval. To require human review, configure that in the
native provider. Bot rejects smaller ceilings and explicit overrides because
these native modes cannot prove the requested hard boundary. Existing read-only
workspace or allowlist settings must be removed deliberately before enabling it.

| Provider | Native transport | Cats tools | Approval/input support |
| --- | --- | --- | --- |
| Muse | `muse serve` MSP | Private session HTTP MCP; inventory is unobserved because MSP does not enumerate tools | Commands, files, network/tool approval, native questions; changing approval stages invalidate old cards |
| Grok | `grok agent --no-leader stdio` ACP | Private session HTTP MCP; discovery reports actual connection state | One-action tool approvals, questions and implementation plans |
| Antigravity | Google's official `agy_acp_server.par` / `.exe` ACP | Unavailable until native credential persistence and name isolation are verified | Standard ACP one-action approvals; native IO belongs to Google ACP |

Antigravity requires the separate official ACP distribution and its authentication,
not just the normal `agy` CLI or the third-party `agy-acp` package. Obtain the
platform archive from the [official ACP registry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json),
verify its SHA-256 and keep the executable's accompanying files together. Put the
executable on the Bot process PATH, then complete the official client's sign-in.
The checked Linux ARM64 1.4.5 build requires 4 KiB system pages and aborts on this
machine's 16 KiB kernel; this is an upstream binary limitation, independent of X.
No native Google authentication/tool success is claimed here.

Boss Cat tool status becomes connected only after the authenticated provider
fetches the tool list for a current live conversation. A configured policy or
launched process alone is insufficient. Retargeting, session recreation/resume and Runtime restart rotate the descriptor
and invalidate that observation. The current Boss Cat role also gates availability. Connected does not claim successful execution
of every tool. Desktop control keeps its separate platform and permission gates.

Verification uses disposable homes and protocol fixtures. Muse echo and Grok
local fake-API probes cover native cold resume and MCP without paid prompts;
Grok reasoning effort is set and read back after resume. Desktop UI acceptance
was skipped at the owner's request while X authorization is broken.
