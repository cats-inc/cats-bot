# Runtime candidate

Bot consumes an exact packed Runtime artifact through its process/HTTP boundary,
never source imports from another checkout. This candidate contains source
`f53a2058a4a81f23d8d7b010865e0d80a9d6d868`
([Runtime PR #211](https://github.com/cats-inc/cats-runtime/pull/211)), package version 0.6.2.
Artifact: `vendor/cats-runtime-0.6.2-f53a2058.tgz`; 1,824,365 bytes.
SHA-256: `443fb7f8efecc5eb92756623ac99747d93623d7b02a774342a5b9e8cde5b349e`.
`vendor/runtime-source.json` is the machine-readable source/artifact pin, and
`package-lock.json` records the SHA-512 integrity. This is not an npm publication.

The candidate separates legacy ephemeral CLI startup (30 seconds) from provider
silence after init (120 seconds), preventing a reasoning agy turn from being killed
at the startup deadline. Provider progress resets the latter; Runtime HTTP
heartbeats do not. Explicit legacy global/instance timeout overrides, including
zero, retain their existing meaning. No new Bot-local timeout is introduced.

The source base is Runtime main `f9dd13ea`, so this artifact also carries its
already merged Copilot catalog refresh (GPT-6.1 Terra and the Copilot Fusion /
Standard mapping). It does not add a Bot provider or change its provider selection.

It retains explicitly selected native Muse MSP and Grok/official Google
ACP execution. Existing targets keep their legacy invocation. Muse/Grok support
private session MCP and live native interactions; Google ACP supports local
work/approvals while its session MCP is gated pending verified native credential
persistence. See [setup and limits](../docs/provider-interactions.md#muse-grok-and-antigravity-native-work-tools).

Reproduce from the exact source with its lockfile: `npm ci`, `npm run build`, then
`npm pack --ignore-scripts`. Name the artifact with the source commit and update
this manifest, package dependency and lockfile together. A Runtime without the
advertised policy/interaction capability is unavailable for the new mode, never
silently used with different permissions.

No package version, profile/journal format or data migration changes in this
slice. Existing profiles retain `providerPolicy: null` until the owner enables
native tools. Existing Codex/Claude catalogs, interactions, policy and inventory
are retained. Desktop control keeps its separate permission and platform gates.
