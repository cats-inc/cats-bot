# Runtime candidate

The Bot consumes a packed Runtime artifact over its process/HTTP boundary, never
source imports from another checkout. This candidate contains the merged Runtime
source `e38e56bfd54fe783df22a5e0d914b14d186ee6bf` (Runtime main after PR #198: the Codex
interaction work of #194/#195 plus Claude Code interactions, policy and inventory
from PLAN-050), package version 0.6.2. The tarball is 1,786,213 bytes, SHA-1
`bbeded4d5149807302ecbac932582400c237ddcb`.
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
