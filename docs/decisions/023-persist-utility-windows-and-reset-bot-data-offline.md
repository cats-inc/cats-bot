# ADR-023: Persist Utility Windows and Reset Bot Data Offline

## Status

Accepted — 2026-11-11, implementing the owner's request for Desktop-like window
restoration and a Bot data reset with an optional Runtime reset. No version bump
or publication is authorized by this decision.

## Context

Notes and avatars already remember their placement. Setup, Hub Settings, New cat
bot and individual bot Settings did not. Cats Desktop's Settings data reset is a
design reference, but Bot owns one Runtime directory per bot rather than one
Desktop-managed Runtime profile. Deleting a whole bot directory would therefore
erase Runtime even with its reset checkbox off.

## Decision

- The Electron host saves utility windows' normal bounds and maximized/fullscreen
  state during use and on close. Hub utility windows use separate keys in
  `<CATS_BOT_HOME>/window-state.json`; each bot's Settings uses its own
  `<bot root>/window-state.json`. Restore clamps to the nearest remaining display's
  work area. Malformed geometry uses defaults; an unreadable file is preserved.
- Hub Settings gains a Data tab. Reset requires exact `RESET` confirmation;
  **Also reset Runtime data** is unchecked by default. Only the Hub Settings main
  frame may invoke it. Setup/install/update work blocks reset; active Bot work is
  stopped through the normal core shutdown path.
- Before relaunch, the hub drains accepted registry changes, stops its cores and
  verifies their observed core/Runtime PIDs exited, validates owned paths, takes
  every bot instance lock and atomically writes `data-reset.pending.json`.
  Externally held bot locks refuse reset. Relaunch drops bot-selection/creation
  arguments so the next launch returns to interactive setup.
- Under the hub lock, startup completes a pending reset before loading preferences,
  reconciling the registry or opening setup. An ownership allowlist clears active,
  archived and trashed bots (including their owned workspaces, sidecars, backups
  and secrets), Boss Cat deliveries, Hub audit logs, registry, preferences,
  setup drafts and saved utility positions. The OS login item is turned off when
  its Hub preference was enabled. External workspace links are unlinked without
  traversing their destinations.
- With Runtime reset off, each bot's `runtime/` is renamed to
  `retained-runtime/<reset-id>/<bots|archive|trash>/<directory-name>/` before Bot
  data is erased. These are retained Runtime profiles, not restored bots or
  sessions automatically attached to new bots. With Runtime reset on, both current
  and previously retained Runtime data are erased. Desktop's separate data,
  installed software, provider logins/native history outside Bot's Runtime roots,
  external workspaces and Electron's installation identity remain.
- Consent is removed last. An interrupted reset keeps its journal and blocks
  normal startup until a later launch finishes it. Core opening, instance-lock
  acquisition, initialization, CLI target resolution and direct secret/handoff
  writers honor that fence, including after a purge removes a bot's lock file.
  Only the offline reset coordinator bypasses it to acquire its own locks.
- Redirected storage roots/parents, installations overlapping the reset root and
  malformed journals are refused before erasure. Recursive removal uses the
  existing `removeTree` implementation that never enters junctions/symlinks.

## Consequences

Existing profiles and public CLI contracts remain compatible. Window files and
the reset journal are additive; no existing data schema is migrated. A successful
reset intentionally destroys the selected data and does not create a recovery
backup. Retained Runtime storage can take disk space until the owner selects a
later Runtime reset. A failed purge needs a retry on reopening the app; it cannot
return to normal use against partly erased data.

## Alternatives Considered

- Delete whole bot roots immediately in the renderer request: rejected because
  Runtime would be erased by default and live processes could restore old data.
- Keep Runtime-only bot directories in the normal registry layout: rejected
  because archive/trash recovery and bot-id allocation would still encounter them.
- Import Desktop's reset implementation: rejected because the products own
  different layouts and Bot does not depend on the Platform application.

## References

- [SPEC-008 FR-30/31](../specs/SPEC-008-hub-and-bots.md#utility-window-restoration-and-data-reset)
- [Setup guide](../setup-guide.md#window-placement-and-data-reset)
- [Testing strategy](../testing.md#utility-window-placement-and-data-reset)
- Cats Desktop reference: `src/shared/platformDataReset.ts`,
  `desktop/host/runtimeDataReset.ts` and Settings' reset confirmation at Platform
  commit `07cd727d3e5035297f7e8b6780ea3a9c7314a476` (MIT).
