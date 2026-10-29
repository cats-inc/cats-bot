# ADR-004: Publish Standard Previews with Host-Owned Updates

## Status

Accepted — 2026-10-28. The owner requested manually triggered GitHub releases,
Check for Updates, and Windows/macOS/Linux coverage. This authorizes the delivery
mechanism, not a version bump or release dispatch.
On 2026-10-30 the code adopted [ADR-007](007-give-cats-bot-its-own-identity-and-data-root.md)'s release
repository `cats-inc/cats-bot`, and the repository was renamed the same day (PLAN-008 Phases 1–2). Also on
2026-10-30, PLAN-009 implemented [ADR-008](008-run-every-bot-as-a-headless-core-under-one-hub.md): updates
are owned by the one hub, which stops every core it manages before installing and refuses while a bot runs
in another program. The installation gate between processes of one installation stays as a guard.

## Context

The Package workflow only retains Windows CI artifacts. A resident Bot needs a
release identity, reproducible inputs and an update path which stops its Runtime
before replacing installed files. Multiple bots can use the same installation.
Cats Desktop ADR-108/117 are design references, not package dependencies.

## Decision

- Only `workflow_dispatch` publishes Bots Standard Preview. An unused `vX.Y.Z`
  must match package and lockfile versions. The protected profile-schema change
  already recorded in SPEC-004 requires the first release to use 0.2 or later.
- Build one immutable Bot commit and its tracked Runtime tarball/source pin.
  Publish a draft only after all platform packages, updater metadata, checksums
  and source receipts validate. Published releases are immutable, prereleases,
  and never marked latest. Ordinary pushes and tags cannot publish.
  Serialize all preview releases and require monotonically increasing versions
  so feed publication order cannot hide a newer version.
- Windows ships x64/arm64 NSIS and portable EXEs; macOS universal DMG and updater
  ZIP; Linux x64/arm64 DEBs. Standard signs when complete credentials exist.
  Partial credentials fail. macOS signing includes notarization; absent signing
  credentials are reported honestly and disable in-app installation on macOS.
- The Electron host owns one update controller. Tray/floating menu and Settings
  share it through a narrow, sender-checked IPC bridge. The headless core has no
  Electron/updater dependency. `electron-updater` consumes the public Bot feed;
  renderer code never supplies a feed, URL, installer path or credentials.
- Checks, downloads and installation are separate user actions. No startup
  polling, automatic download, install-on-quit or downgrade. Preview plain tags
  use `allowPrerelease=true`, an unset channel and `allowDowngrade=false` last.
- Only workflow-identified packages self-update. Development/local packages
  explain their distribution. Portable and unsigned macOS builds can check and
  open the validated release page for manual replacement.
- Installing first excludes other live Bot shells sharing this installation,
  then drains this Bot core and Runtime. A failed handoff restarts the current
  application; an uncertain timed-out handoff exits without reviving sidecars
  into a potentially running installer. User bot identity is preserved on relaunch.
  A persistent atomic per-account gate blocks newly starting shells. Shared Unix
  installations also check other accounts' running processes before handoff.
  Linux package installation is asynchronous; uncertain or partially failed
  package-manager work retains the gate until recovery is acknowledged.

## Consequences

GitHub release results remain in Actions/Releases. Signing secrets belong to the
Bots repository or an applicable organization secret scope. Existing artifacts
without an updater require one manual installation. Installed cross-OS upgrade
acceptance remains separate from CI packaging and mocked updater tests.

## Alternatives Considered

Custom installer downloads duplicate checksum/signature/platform behavior already
owned by electron-updater. Importing Desktop internals violates ADR-001. Publishing
on every main push would turn ordinary development into release authorization.

## References

- [SPEC-005](../specs/SPEC-005-standard-preview-releases-and-updates.md)
- [electron-builder v26 updates](https://www.electron.build/v26/docs/features/auto-update/)
- [Cats Desktop ADR-108](https://github.com/cats-inc/cats-platform/blob/main/docs/decisions/108-use-host-owned-github-release-updates-for-official-desktop-builds.md)
- [Cats Desktop signing profiles](https://github.com/cats-inc/cats-platform/blob/main/docs/deployment.md#desktop-signing-profiles)
