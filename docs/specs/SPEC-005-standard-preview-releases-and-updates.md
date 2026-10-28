# SPEC-005: Standard Preview Releases and Updates

Status: implemented; CI acceptance for the submitted commit is tracked in [PR #32](https://github.com/cats-inc/cats-bots/pull/32).
Governing decision: [ADR-004](../decisions/004-publish-standard-previews-with-host-owned-updates.md).

## Requirements

1. A manually dispatched workflow creates a GitHub prerelease from the selected
   immutable commit; exact version/tag/lockfile/Runtime artifact identity gates
   publication. Reject existing published tags and drafts from another source.
   Serialize all releases and reject versions below or equal to any published
   plain version, including versions published between build and finalization.
2. Windows x64/arm64 installer + portable, macOS universal DMG + ZIP, and Linux
   x64/arm64 DEB assets are required before publication. Standard signing follows
   available complete credentials; report per-platform trust without claiming
   missing credentials imply signed artifacts. Publish exact source inputs and
   SHA256SUMS; verify every update file's referenced asset size and SHA-512.
3. Package a validated release descriptor; missing/malformed/mismatched identity
   never enables self-update. Public updates use only cats-inc/cats-bots.
4. Settings > App and the tray/floating menu expose Check for Updates. Show
   current version, Standard Preview identity and checking/current/available/
   downloading/downloaded/installing/error states. Settings survives reload by
   reading host state. Errors remain retryable and never imply success.
5. Downloads and restart/install require explicit actions. Serialize operations,
   reject stale/invalid actions, disallow downgrades and bound failures. No
   background checks, automatic download or install on ordinary quit.
   A timed-out request retains its native-operation fence until it actually ends;
   downloaded bytes and completion events must match the selected version.
6. Portable/unsigned macOS packages offer the official release page for manual
   installation. Source and unofficial packages explain why updating is disabled.
7. Drain Bot core, ongoing provider work and Runtime before installation. Reject
   installation while another Bot shell uses the same installed executable.
   Preserve the bot id on restart and recover safely from definite handoff failure.
   Keep an atomic, persistent handoff gate for new shells and uncertain installers;
   incomplete markers require explicit recovery. Check other users' processes on
   shared Unix installations; they must keep the app closed during installation.
   Linux authorization/install runs asynchronously and is not killed on timeout.
8. The core/CLI remain independent of Electron. Settings IPC validates its sender
   and main frame. No renderer-origin URL, file path, executable or feed is accepted.

## Acceptance

- Release guards reject bad versions, altered pins, wrong-source drafts, missing
  platforms, unsafe asset references and checksum mismatch; no push/tag trigger.
- Unit/integration fixtures cover updater events, serialization, reload, failures,
  unsupported distributions, no downgrade, multi-instance exclusion and drain order.
- Linux/Windows/macOS CI validates code and packages; local Windows candidate
  validates the real Settings/tray flow using isolated state. Hosted package tests
  do not claim installed macOS/Linux upgrade acceptance.
- A release dispatch is outside this implementation request. No version bump,
  signing-secret mutation, actual installer launch or real user-profile migration
  is performed as an incidental test.
