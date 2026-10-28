# Bots Standard Preview releases

[ADR-004](decisions/004-publish-standard-previews-with-host-owned-updates.md)
defines the delivery contract. This is the Electron Bot distribution; the headless
CLI does not install application updates. GitHub Actions **Bots Standard Preview**
(`.github/workflows/bots-preview.yml`) publishes only on manual dispatch.

## Prepare the release commit

1. Obtain authorization for the version and publication. Set the same plain
   `X.Y.Z` in package.json and both root version fields in package-lock.json.
   The existing profile schema-2 migration requires the first release to be
   **0.2.0 or later**. Each release must exceed every published plain version,
   because preview discovery follows GitHub feed order.
2. Keep `vendor/runtime-source.json`, the vendored tarball and lockfile exact.
   The manifest records the Runtime repository, full source SHA, package version,
   tarball path and SHA-256. The workflow also checks lockfile SHA-512 integrity.
3. Prepare `docs/releases/vX.Y.Z.md` in the original bump PR: changes, supported
   OS/architectures, signing policy, exact Bot/Runtime source identity and artifact
   pins, compatibility, upgrade/backup/failure recovery. Use the release commit
   as the Bot identity; the workflow appends its exact SHA without a self-reference
   in the commit. Data migrations need tested validation, backup and atomic
   recovery; a version bump alone is insufficient.
4. Pass CI and independent review, merge the prepared commit, then select that
   ref in Actions → Bots Standard Preview → Run workflow, with tag `vX.Y.Z`.
   Nothing here authorizes publishing from an ordinary feature PR.

The workflow pins the selected SHA, serializes all preview releases, reserves a
draft, builds all platforms, verifies every asset, attaches source/checksums and
provenance, then publishes a prerelease with `make_latest=false`. The tag is
created only at publication. No push or tag trigger publishes.

## Artifacts and signing

| Platform | Architectures and assets | Standard trust |
| --- | --- | --- |
| Windows | x64/arm64 NSIS setup EXEs and portable EXEs; latest.yml | Authenticode when configured, otherwise explicitly unsigned |
| macOS | Universal (x64 + arm64) DMG and updater ZIP; latest-mac.yml | Developer ID + notarization when fully configured; otherwise unsigned/manual updates |
| Linux | amd64/arm64 DEBs; latest-linux.yml and latest-linux-arm64.yml | Unsigned, OS package manager authorization at installation |

Windows packages also carry the desktop control helper (SPEC-006 BDC-11) at
`resources/native/windows-desktop-control/`. `build-preview.mjs` publishes it
self-contained for each Windows architecture with the runner's preinstalled .NET
SDK, stages the .NET runtime's license texts under `licenses/`, and reads every
unpacked package back to confirm the helper matches the app's architecture.
electron-builder signs it with the app when Windows credentials exist, and signed
releases verify its Authenticode signature as well. macOS and Linux builds never
run dotnet.

Each release includes per-platform build receipts, SHA256SUMS and a complete
Bot + pinned Runtime source ZIP with a source/checksum manifest. Portable assets
are not updater targets. Candidate CI artifacts carry a different distribution
identity and cannot self-update.

Reuse Cats Desktop's existing macOS credentials through `cats-inc` organization
secrets. Configure all five with **Selected repositories** access only to
`cats-platform` and `cats-bots`; no new Apple certificate or API key is needed.
Desktop repository secrets alone are not visible to Bots: they must first be
shared at organization scope. Windows signing is configured separately with
repository or applicable organization secrets.

| Platform | Secrets |
| --- | --- |
| Windows | WIN_CSC_LINK (PFX file as base64 or supported certificate URL), WIN_CSC_KEY_PASSWORD |
| macOS | CSC_LINK, CSC_KEY_PASSWORD, APPLE_API_KEY_P8_BASE64, APPLE_API_KEY_ID, APPLE_API_ISSUER |

Rotate the shared macOS values in the organization's **Settings → Secrets and
variables → Actions**, retaining the selected-repository access. Do not create
same-name repository or environment overrides, which take precedence and can
keep Bots on stale credentials. Pause signed releases during rotation, then verify
signing and notarization authentication in both repositories before resuming.

Follow the [shared Apple credential migration procedure](https://github.com/cats-inc/cats-platform/blob/main/docs/deployment.md#desktop-release-signing)
when moving an existing Desktop set. Keep Desktop's source copies until Bots
passes native signing, signature verification and notarization API authentication;
then remove the Desktop overrides and verify Desktop again. If the baseline or
Bots checks fail, keep the Desktop source copies and stop. If Desktop fails after
switching, pause signed releases and diagnose the shared configuration before
proceeding. Temporary credential probes do not publish a release or establish full
product notarization, and both existing release workflows already read these
secret names without code changes.

Windows certificates may have an empty password; a password without a certificate
is rejected. macOS requires all certificate and notarization credentials together.
The P8 key is staged in the runner's temporary directory, never in source or
release assets. Missing signing configuration is reported as unsigned; incomplete
configuration fails. Signed builds additionally validate Authenticode or
codesign/spctl/stapler before uploading. Unsigned macOS cannot self-install.

## Check for Updates

Use the tray/floating cat menu **Check for Updates…**, or Settings → App →
**Check for Updates**. Checks only query the public cats-inc/cats-bots feed.
Choose Download update, then Restart and install and confirm the native prompt.
Installation interrupts the current Bot task after stopping its Runtime. There
are no background checks, automatic downloads or install-on-quit.

Quit other Bots sharing the installation first. An atomic per-account installation
gate blocks new shells during handoff. On macOS/Linux a system process snapshot
also rejects another signed-in account running this installation; all users must
keep it closed until installation completes. An indeterminate installer keeps
the gate until the updated version starts or the user explicitly confirms the
installer has finished. Linux uses an asynchronous pkexec/apt-get handoff so the
permission prompt does not freeze the host; it never kills an active package
manager on timeout.

Portable and unsigned macOS builds can check and open the official release page,
then must be replaced manually. Development, candidate and unrecognized local
builds explain why checks are disabled. Older artifacts with no updater require
one manual installation. An unsigned existing Mac app needs a manual signed
installation before in-app updates become available.

## Validation and failure recovery

CI builds the same full architecture/format matrix as unsigned candidates,
validates the combined metadata/checksums and creates the complete-source ZIP.
The shared packager also checks the macOS executable's Intel and Apple Silicon
architecture slices in both candidate CI and release builds. CI does not publish.
A local Windows unpacked candidate can be built after
`npm ci` and `npm run build`, with the .NET 8 SDK or newer installed:

```powershell
$sourceCommit = git rev-parse HEAD
$releaseTag = 'v' + (Get-Content package.json | ConvertFrom-Json).version
npm run dist:preview -- --platform windows --tag $releaseTag --source $sourceCommit --dir
```

Omit `--dir` for all Windows packages. Use `--platform macos` or `linux`
on their own OS. Local builds default to candidate identity; `--release` is
restricted to the exact manual workflow/repository/source context. These checks
establish provenance conventions, not a defense against a locally modified app.

A failed build leaves a draft. Re-run from the same commit and tag; only a draft
whose recorded source matches may be replaced. Existing tags, another source's
draft and published releases are rejected. Do not edit a published release to
repair it; prepare a new version and obtain publication authorization.

After publication verify the Actions result, public prerelease/tag SHA and complete
asset names/digests. Installed upgrade acceptance must separately exercise Windows
NSIS, signed/notarized macOS and Linux DEB using isolated profiles and two real
released versions. CI packaging and mocked updater tests are not that evidence.
Report publication results and stop; do not add post-release status commits or
edit published metadata. See the
[workspace release policy](https://github.com/cats-inc/cats-one/blob/main/docs/release-guide.md#release-preparation-and-completion).
