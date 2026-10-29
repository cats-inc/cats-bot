# ADR-007: Give Cats Bot its own identity and data root

## Status

Accepted — 2026-10-29, owner decisions recorded from discussion; implementation
pending in [PLAN-008](../plans/PLAN-008-cats-bot-identity-and-data-root.md). Once
implemented this replaces the default data root of ADR-001 §6 and SPEC-001 FR-2.

## Context

Cats Desktop and Cats Bot are two independent ecosystems. `~/.cats/` belongs to
Cats Desktop (`desktop/`, `platform/` and its Runtime under `runtime/`); its
uninstaller removes all of `~/.cats` when the owner selects "Remove all user
data", which is correct for Desktop. Cats Bot nevertheless keeps every bot under
`~/.cats/bots/<id>/` (`src/core/store/paths.ts`), so a Desktop uninstall can
delete every bot's profile, conversations, journal and Telegram token.

The product is already singular on every user-facing surface ("Cats Bot",
`Cats Bot.exe`, the `cats-bot` CLI, `Cats-Bot-*` assets), while engineering
identifiers are plural: repository `cats-inc/cats-bots`, package
`@cats-inc/cats-bots`, `CATS_BOTS_HOME`, Runtime `--managed-by cats-bots`, and
the update feed/release contract. The plural followed `cats-apps` and
`cats-plugins`, which produce many artifacts; this repository produces one
application. Several bots in one installation are a feature of that application
([ADR-008](008-run-every-bot-as-a-headless-core-under-one-hub.md)), not a reason
for a plural product. Grok follows the same split on this machine: the CLI keeps
`~/.grok` (with its sign-in files), and the bot keeps its own state in
`~/.grokbot`, with no sign-in files of its own.

The application has not launched publicly. The owner accepts deleting existing
releases and requires no upgrade path for installed copies.

## Decision

- **Names.** Product stays "Cats Bot" and the CLI stays `cats-bot`. Rename the
  repository to `cats-inc/cats-bot`, the package to `@cats-inc/cats-bot`, the
  appId to `io.catsinc.catsbot` (Windows AUMIDs derive from it), and Runtime
  `--managed-by` to `cats-bot`. Runtime requires a non-empty value in
  app-managed mode and only echoes it in its ready output, health and
  diagnostics. Development variables `CATS_BOTS_*` become `CATS_BOT_*`. The last
  appId segment is plain lowercase alphanumerics, the character set that Apple
  bundle IDs, Windows AUMIDs, Android/Java package names and freedesktop/D-Bus
  IDs all accept. The
  `io.catsinc` prefix stays aligned with Desktop's `io.catsinc.cats`; changing it
  would be a family-wide decision.
- **Data root.** `~/.catsbot/` is the Cats Bot ecosystem root. Each bot lives in
  `~/.catsbot/bots/<id>/`, with its own Runtime directory at
  `~/.catsbot/bots/<id>/runtime/`. Hub files (registry, roles, update
  coordination; ADR-008, ADR-009) live directly under `~/.catsbot/`, outside the
  bot-id namespace. `CATS_BOT_HOME` replaces `CATS_BOTS_HOME` and points at the
  ecosystem root, so one variable moves hub files and bots together.
- **Boundary.** Cats Bot never creates, reads or writes anything under `~/.cats/`
  and never depends on Desktop data. Provider CLI sign-in and native sessions stay
  in the CLIs' own folders (`~/.codex`, `~/.claude`, …), as today.
- **No compatibility layer.** No migration from `~/.cats/bots`, no reading of
  `CATS_BOTS_HOME`, no reliance on GitHub's rename redirect, and existing
  releases v0.2.0–v0.2.4 and their tags are deleted (an owner-confirmed step in
  PLAN-008). The next release is 0.3.0, published together with the hub (ADR-008)
  so the owner reinstalls once. The version stays monotonic and the release
  workflow's 0.2.0 floor still holds.

## Consequences

### Positive

- A Desktop uninstall can no longer remove Bot data, and Desktop needs no Bot
  exclusions.
- Repository, package, appId and product name agree; the Bot can later offer its
  own "Remove all user data" over `~/.catsbot` and its Electron user data.
- Hub files have a reserved place that can never collide with a bot id.

### Negative

- Installed 0.2.x copies are abandoned: the new appId changes the Windows
  uninstall GUID, so the owner uninstalls 0.2.x before installing 0.3.0 (otherwise
  two uninstall entries share one folder), and removes `~/.cats/bots` by hand.
- Each conversation's first turn after reinstalling may not resume its provider
  session (the workspace path changes) and falls back to the existing handoff.
- `~/.catsbot` shares the string prefix `~/.cats`. Any containment check must
  compare whole path segments. electron-builder's NSIS running-app check
  (`allowOnlyOneInstallerInstance.nsh`, identical in app-builder-lib 26.17.0 and
  26.18.0 on 2026-10-29) already matches `Programs\Cats Bot` for `Programs\Cats`,
  because it omits the separator.

### Neutral

- Electron user data keeps the product name (`%APPDATA%\Cats Bot`); SPEC-008
  FR-1 defines its layout under the hub.
- Release asset names (`Cats-Bot-<version>-…`) are unchanged.

## Alternatives Considered

### Keep `~/.cats/bots` and narrow Desktop's uninstaller

- **Pros**: no change in Bot.
- **Cons**: makes Desktop responsible for another ecosystem's data.
- **Why rejected**: the owner ruled that the ecosystems are independent and that
  Desktop removing all of `~/.cats` is correct.

### `~/.cats-bots/` or a flat `~/.catsbot/<id>/`

- **Pros**: `.cats-bots` matches the old repository name; a flat layout is one
  level shorter.
- **Cons**: `.cats-bots` follows the repository, not the product; a flat layout
  puts hub files in the bot-id namespace.
- **Why rejected**: `.catsbot` follows the product name like `.grokbot`, and
  ADR-008/009 need hub files.

### Keep the plural repository and package names

- **Pros**: no rename work.
- **Cons**: names a collection the repository does not produce.
- **Why rejected**: one product; multiple bots are its feature.

### Migrate existing data and keep redirects

- **Pros**: installed previews would keep their data and updates.
- **Cons**: migration, backup and bridge-release work for an unlaunched product.
- **Why rejected**: owner decision; there is no installed base to preserve.

## References

- [ADR-001](001-build-a-resident-bot-core-on-cats-runtime-with-disposable-presentation.md),
  [SPEC-001 FR-2](../specs/SPEC-001-resident-bot-core-and-global-execution.md)
- [SPEC-007](../specs/SPEC-007-cats-bot-identity-and-data-root.md),
  [PLAN-008](../plans/PLAN-008-cats-bot-identity-and-data-root.md)
- [ADR-008](008-run-every-bot-as-a-headless-core-under-one-hub.md)

---

*Decision made: 2026-10-29*
*Decision makers: product owner (sammykenny2), recorded by Claude*
