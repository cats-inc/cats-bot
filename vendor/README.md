# Runtime candidate

The Bot consumes a packed Runtime artifact over its process/HTTP boundary, never
source imports from another checkout. This candidate contains Runtime source
`487e7c9698ac4ef4b3f19dcf4baee9ee3d61ae21`, package version 0.6.2. It adds Codex's
native MCP `tool_approval` mapping and explicit per-call prompting to the existing
Codex and Claude Code interactions, policy and inventory. The tarball is 1,788,203
bytes, SHA-1 `6b73f49b3192f3b4ae13e7cb4167727f53f59c0e`.
It is not an npm publication. `package-lock.json` pins the tarball integrity.

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
