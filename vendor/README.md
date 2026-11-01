# Runtime candidate

The Bot consumes a packed Runtime artifact over its process/HTTP boundary, never
source imports from another checkout. This candidate contains Runtime source
`c6e575b672ecaf3d6113c08260720b57c7d62765`, package version 0.6.2. It refreshes the
requested provider catalogs, adding Codex GPT-6.1 Terra and Cursor DeepSeek V4.1 Flash
1017. Bot's menu remains Codex, Claude, Antigravity, Grok and Muse; Copilot's prior
catalog is retained because its account feature returned HTTP 403. Existing Codex
and Claude Code interactions, policy and inventory stay available. The tarball is
1,790,301 bytes, SHA-256
`b26c51765a686a9f18ffb1381bce19b3984de3a9bf0180c4439049984fbc2b12`.
It is not an npm publication. `package-lock.json` pins the tarball integrity.
Independent comparison of all 1,473 archive members found that only the authored
and generated catalog files changed from the previous pinned artifact; executable bytes are unchanged.

Build the exact Runtime source with its lockfile, run `npm run build`, then
`npm pack --ignore-scripts`; name the artifact with the source commit and retain
its provenance here. The candidate enables interaction/policy v1. An older
Runtime is reported as unavailable for explicit/provider policy, never silently
used with different permissions.

Bot profile schema 2 preserves schema 1 permissions with `providerPolicy: null`.
The original profile is backed up before atomic upgrade; unknown versions stop.
This persisted contract requires the next Bot minor line (0.2) before publication.
No package version or release is changed by this implementation slice.

The Codex consent follow-up changes no public schema or persisted format and stays
compatible within Runtime 0.6 / Bots 0.2. The existing desktop-control policy gate
still requires explicit interactive approvals; app grants remain a separate owner
decision. A provider plugin's app-consent request using the same native marked
form is also answerable; other plugin/OS permission protocols are not bridged.
