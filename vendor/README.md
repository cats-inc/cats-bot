# Runtime candidate

The Bot consumes a packed Runtime artifact over its process/HTTP boundary, never
source imports from another checkout. This candidate contains the merged Runtime
source `50ef02b4686c1fff6b60819d292acc5b2e1ef773` (interaction implementation from
PR #194 plus exact Codex thread admission and transcript-preserving failure
cleanup), package version 0.6.2. The tarball is 1,770,749 bytes, SHA-1
`5f360927ece194dc3e0abbd690fb7b43cb292fc3`.
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
