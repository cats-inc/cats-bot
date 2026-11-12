# Runtime candidate

Bot consumes an exact packed Runtime artifact through its process/HTTP boundary,
never source imports from another checkout.

<!-- runtime-pin:start -->
Source `77d3e861aff5a8871e138e3be5ed28ce96c2ab09`, package version 0.6.2.
Artifact: `vendor/cats-runtime-0.6.2-77d3e861.tgz`; 1,845,079 bytes.
SHA-256: `e7d26ea82887ad85af8e8c5c74883553fb5a3ee41ca73b7507a32b75d96b1448`.
<!-- runtime-pin:end -->

`vendor/runtime-source.json` is the machine-readable source/artifact pin, and
`package-lock.json` records the SHA-512 integrity. This is not an npm publication.

Runtime #214 preserves terminal `provider_session_unavailable` evidence, and
#215 adds explicit native-history retention and best-effort names for Codex.
Runtime #218 also classifies the archived Codex thread/resume rejection, so
the product can hand off its conversation without unarchiving the native thread.
Internal jobs can request ephemeral history; persistent Bot conversations retain
their native identity and receive a bounded name through Runtime. The Bot restart
repair resumes its saved Runtime record with fresh host descriptors. Neither the
pin refresh nor this lifecycle change deletes existing native conversations.

The 0.5.10 selection also carries Runtime #219's preview-plugin installation and
restart recovery, #220's native Codex developer items for turn instructions, and
#221's reference-based media jobs. #222 loads optional FFmpeg/FFprobe only when
needed, so a missing media binary does not prevent Runtime startup. These Runtime
capabilities do not add a Bot media UI, a provider or a new Bot storage format.

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

Runtime cats-inc/cats-runtime#213 keeps an owner-only backup before replacing an
unreadable provider-selection configuration and retains the five newest backups.
If that copy cannot be made, the save is refused and the original file remains.
Readable or missing configurations do not create a backup; the data format and
selection routes remain unchanged.

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

Runtime remains version 0.6.2; Bot 0.5.10 adds no profile/journal format change or
mandatory data migration. Existing profiles retain `providerPolicy: null` until the owner enables
native tools. Existing Codex/Claude catalogs, interactions, policy and inventory
are retained. Desktop control keeps its separate permission and platform gates.
