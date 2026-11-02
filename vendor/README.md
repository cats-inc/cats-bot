# Runtime candidate

Bot consumes an exact packed Runtime artifact through its process/HTTP boundary,
never source imports from another checkout. This candidate contains source
`fb0f1125ecad427852f0c890b36605f335945650` (Runtime PR #208), package version 0.6.2.
Artifact: `vendor/cats-runtime-0.6.2-fb0f1125.tgz`; 1,823,027 bytes.
SHA-256: `8e20c1f65a636a2769fbc4e826828df3b2fdec6dcaf2497e326fc37607f3ce4c`.
`package-lock.json` records the SHA-512 integrity. This is not an npm publication.

The candidate adds explicitly selected native Muse MSP and Grok/official Google
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
