# Runtime candidate

Bot consumes an exact packed Runtime artifact through its process/HTTP boundary,
never source imports from another checkout.

<!-- runtime-pin:start -->
Source `b95d9294a91164c6225beb717e42249288594239`, package version 0.6.2.
Artifact: `vendor/cats-runtime-0.6.2-b95d9294.tgz`; 1,890,762 bytes.
SHA-256: `838dee2cca538e019a8f8758fa5a3159ee64c5462e79422c20f3fb3197d366aa`.
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

The Runtime selection also carries Runtime #219's preview-plugin installation and
restart recovery, #220's native Codex developer items for turn instructions, and
#221's reference-based media jobs. #222 loads optional FFmpeg/FFprobe only when
needed, so a missing media binary does not prevent Runtime startup. These Runtime
capabilities do not add a Bot media UI, a provider or a new Bot storage format.

Bot 0.5.11 selects Runtime main at `512c074713cbe563124f21c4ed9218e0b408c33f`,
including #223 write-only OpenClaw gateway token storage. This pin does not add
a Bot token-setting UI or change Bot profile/conversation/journal formats.

The Kimi Code selection (ADR-025) moves the pin to Runtime main at
`b9819a6c1213aa6954babaf086d50dedbaf9ea1c`. It adds three Runtime changes:
- #224: the Kimi Code provider, its catalog and native session management.
- #225: the hosted `kimi acp` target. It keeps Kimi in Default mode, so every
  computer-use, shell and file call waits for an approval card, and it reports
  Kimi's computer-use plugin in the session capabilities.
- #226: a 45-second hosted start-up, command and file approval cards, and Kimi's
  own plan errors.

A Kimi bot always runs on that hosted target; print mode is never selected for it.
The pin adds no Bot profile, journal or conversation format change.

ADR-028 moves the pin to Runtime main at `b95d9294a91164c6225beb717e42249288594239`, which adds
#230 (Runtime ADR-055): standing grants for computer use, commands and file changes, used only by
sends the Bot marks as owner-started, revoked by Stop. It carries #229 too, a Muse catalog-probe
fallback that does not change Bot behavior.

Bot 0.5.12 selects the same Runtime main, which had nothing after that commit at
selection; a clean-clone rebuild reproduced the same artifact bytes.
Bot 0.5.13 again selects that commit, still Runtime main at selection.
Bot 0.5.14 selects it once more; a clean-clone rebuild again reproduced the same bytes.

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
persistence. See [setup and limits](../docs/provider-interactions.md#muse-grok-kimi-and-antigravity-native-work-tools).

Reproduce an artifact from its exact source with its lockfile: `npm ci`, `npm run
build`, then `npm pack --ignore-scripts`. `node scripts/refresh-runtime-pin.mjs` does
this from a clean clone for any commit on Runtime `main`. It names the artifact with
the source commit and updates the record above, the manifest, package dependency and
lockfile together. It does not change the description in this file, so update that by
hand. A Runtime without the advertised policy/interaction capability is unavailable
for the new mode, never silently used with different permissions.

Runtime remains version 0.6.2; Bot 0.5.11 adds no profile/journal format change or
mandatory data migration. Existing profiles retain `providerPolicy: null` until the owner enables
native tools. Existing Codex/Claude catalogs, interactions, policy and inventory
are retained. Desktop control keeps its separate permission and platform gates.
