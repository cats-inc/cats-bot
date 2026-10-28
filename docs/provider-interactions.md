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
