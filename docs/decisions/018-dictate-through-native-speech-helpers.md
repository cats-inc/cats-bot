# ADR-018: Dictate through Native Speech Helpers

## Status

Accepted — 2026-11-11, at the owner's request to bring Cats Desktop's composer voice input to the note.
Specified by [SPEC-003](../specs/SPEC-003-note-reading-and-the-react-renderer.md) FR-10.

## Context

- Cats Desktop's composer "voice input" is dictation: speech becomes text in the composer and no audio is
  kept. Its host runs a native helper per platform that speaks JSON lines: `macos-stt` (Swift,
  `SFSpeechRecognizer` with on-device recognition required) and `windows-stt` (C#, WinRT speech
  recognition, which Windows may run online). It has no Linux helper; its Web Speech fallback has no
  recognition service in Electron.
- The microphone under macOS's hardened runtime needs the `com.apple.security.device.audio-input`
  entitlement for the app and its nested helpers, and Info.plist usage strings for the microphone and
  speech recognition.
- Cats Bot already ships a Windows helper (desktop control) published self-contained per architecture
  with its .NET runtime notices.

## Decision

1. Port Desktop's helpers unchanged (`native/macos-stt`, `native/windows-stt`) and its host controller
   (`src/shell/electron/voiceCapture.ts`):
   - One helper runs at a time.
   - Each session's events go to the note that started it.
   - A note being closed or destroyed, or another note starting, ends its session at once.
2. Packaging:
   - macOS: `scripts/macos-voice-helper.mjs` builds the helper universal into
     `build/native-macos/macos-stt`, which the package maps to `Resources/native/macos-stt`, and verifies
     both slices in the package.
   - Windows: `scripts/windows-desktop-control.mjs` publishes the dictation helper beside the desktop
     control helper per architecture, with notices, and verifies its architecture.
   - `assets/installer/entitlements.mac.plist` and `.inherit.plist` keep electron-builder's defaults and
     add audio input. `mac.extendInfo` carries the usage strings.
   - The release workflow checks the Windows helper's signature like the desktop control helper's.
3. The note offers dictation only where a helper exists (macOS, Windows). Linux is not built yet.

## Consequences

### Positive

- Same behaviour, wording and privacy as Cats Desktop; nothing is recorded.

### Negative

- macOS packaging needs Swift from Xcode (CI's macOS runner has it). The universal helper does not build
  with the Command Line Tools alone on macOS 27.
- Only a signed and notarized macOS package shows the microphone works as shipped.
- The Windows package grows by a second self-contained .NET helper.

### Neutral

- Like Desktop, no language is passed; the helper uses the system's.
