# Runtime candidate

Bot consumes an exact packed Runtime artifact through its process/HTTP boundary,
never source imports from another checkout.

<!-- runtime-pin:start -->
Source `c1d0111dd8d2bd4668e0d6d4f93afc20af9bd77b`, package version 0.6.2.
Artifact: `vendor/cats-runtime-0.6.2-c1d0111d.tgz`; 1,824,430 bytes.
SHA-256: `0a66ac17326047261baefd8f9fe4cc7e972659fc3560720873cc609968d88936`.
<!-- runtime-pin:end -->

`vendor/runtime-source.json` is the machine-readable source/artifact pin, and
`package-lock.json` records the SHA-512 integrity. This is not an npm publication.

The candidate separates legacy ephemeral CLI startup (30 seconds) from provider
silence after init (120 seconds), preventing a reasoning agy turn from being killed
at the startup deadline. Provider progress resets the latter; Runtime HTTP
heartbeats do not. Explicit legacy global/instance timeout overrides, including
zero, retain their existing meaning. No new Bot-local timeout is introduced.

The artifact also carries the Copilot catalog refresh (GPT-6.1 Terra and the
Copilot Fusion / Standard mapping), which does not add a Bot provider or change its
provider selection. It carries cats-inc/cats-runtime#212 too: Runtime waits for
Grok's exact session ID instead of matching its session files by working directory,
so a new Grok session's next message no longer fails with
`skill_content_profile_conflict`.

It retains explicitly selected native Muse MSP and Grok/official Google
ACP execution. Existing targets keep their legacy invocation. Muse/Grok support
private session MCP and live native interactions; Google ACP supports local
work/approvals while its session MCP is gated pending verified native credential
persistence. See [setup and limits](../docs/provider-interactions.md#muse-grok-and-antigravity-native-work-tools).

Reproduce an artifact from its exact source with its lockfile: `npm ci`, `npm run
build`, then `npm pack --ignore-scripts`. `node scripts/refresh-runtime-pin.mjs` does
this from a clean clone for any commit on Runtime `main`. It names the artifact with
the source commit and updates the record above, the manifest, package dependency and
lockfile together. It does not change the description in this file, so update that by
hand. A Runtime without the advertised policy/interaction capability is unavailable
for the new mode, never silently used with different permissions.

No package version, profile/journal format or data migration changes in this
slice. Existing profiles retain `providerPolicy: null` until the owner enables
native tools. Existing Codex/Claude catalogs, interactions, policy and inventory
are retained. Desktop control keeps its separate permission and platform gates.
