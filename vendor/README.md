# Runtime candidate

The Bot consumes a packed Runtime artifact over its process/HTTP boundary, never
source imports from another checkout. This candidate contains the merged Runtime
source `b75da37b5e79f1f9831406ab5017359ce47cf0e6` (PR #194), package version 0.6.2.
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
