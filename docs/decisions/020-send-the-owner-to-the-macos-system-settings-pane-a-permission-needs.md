# ADR-020: Send the Owner to the macOS System Settings Pane a Permission Needs

## Status

Accepted — 2026-11-11, at the owner's request to build this in Cats Desktop first and port it to Cats Bot.
Follows Cats Desktop's
[ADR-147](https://github.com/cats-inc/cats-platform/blob/main/docs/decisions/147-send-the-owner-to-the-macos-system-settings-pane-a-permission-needs.md).
Amends [SPEC-003](../specs/SPEC-003-note-reading-and-the-react-renderer.md) FR-9 and FR-10 and
[SPEC-008](../specs/SPEC-008-hub-and-bots.md) FR-23.

## Context

- On macOS, dictation needs Microphone and Speech Recognition (ADR-018), the region screenshot needs Screen
  Recording (SPEC-003 FR-9), and the hub's login item can wait for the owner's approval in Login Items. Each
  is its own System Settings pane.
- Before this record:
  - Each was a line in the note naming no pane, or no line at all.
  - A denied Speech Recognition read as a denied microphone.
  - Cats Bot refused a screenshot without Screen Recording, as Desktop does, and never asked, so it was not
    listed in the pane.
  - "Start Cats Bot when I sign in" showed on while macOS reported `requires-approval`.
- Desktop control (SPEC-006) has no macOS helper yet, so Accessibility is not needed yet. The macOS
  helper adds that pane when it is built.

## Decision

1. **The shell opens a named pane.** A note or a Settings window, never the floating Cat, sends
   `shell:openSystemSettings` with one of `microphone`, `speech_recognition`, `screen_recording` and
   `login_items` (`src/shared/systemSettings.ts`). The shell maps it to a constant `x-apple.systempreferences:`
   URL (`src/shell/electron/systemSettings.ts`, ported from Desktop) and opens it only on macOS. The preload
   exposes `systemSettings` only there.
2. **A line about a missing permission has "Open System Settings".** In the note, the line that reports a
   refused screenshot, a denied microphone or a denied Speech Recognition carries the button for its pane.
   The text still names the pane.
3. **Speech Recognition is its own reason.** The macOS helper reports `speech_permission_denied`, apart from
   the microphone's `permission_denied`. The helper stays byte-identical to Desktop's.
4. **Cats Bot asks for Screen Recording once per run.** While Screen Recording is not granted, the shell runs
   the dictation helper with `--request-screen-capture` (`CGRequestScreenCaptureAccess`) before refusing. Any
   refusal asks, because Electron reports an app macOS has never asked as `denied` (checked with Electron
   41.2.0 on macOS 27.2); once macOS has an answer the request shows nothing.
   This lists Cats Bot in Screen & System Audio Recording and may prompt. A grant applies after a restart,
   so that capture is still refused, with the button. Without a helper the request is skipped.
5. **Cats Bot Settings shows a login item waiting for approval.** With start at login on and macOS reporting
   `requires-approval` (`app.getLoginItemSettings().status`), General shows a line under the checkbox and a
   button that opens Login Items. Cats Bot Settings has no toast-only rule, and its toasts carry no button;
   the line stays while the state lasts.

## Consequences

- The owner reaches the right pane in one click, and Cats Bot is listed in the Screen Recording pane after
  its first refused screenshot.
- Whether macOS attributes the helper's request to Cats Bot.app is unverified, as for its microphone
  request; it needs a signed build and a fresh profile (testing guide). Until then the line and its named
  pane remain the recovery.
- Windows keeps its plain lines; its `ms-settings:` links can follow later.
