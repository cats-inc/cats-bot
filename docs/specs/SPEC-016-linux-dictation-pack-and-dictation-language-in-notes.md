# SPEC-016: Linux dictation pack and dictation language in notes

## Metadata

| Field | Value |
|-------|-------|
| **Status** | Draft |
| **Owner** | Cats Bot maintainers |
| **Reviewer** | Product owner |
| **Decision** | [ADR-029](../decisions/029-dictate-on-linux-with-the-linux-stt-pack-and-choose-the-dictation-language.md) |
| **Contracts** | Platform [SPEC-145](https://github.com/cats-inc/cats-platform/blob/main/docs/specs/SPEC-145-feature-packs-and-linux-dictation.md) and [SPEC-146](https://github.com/cats-inc/cats-platform/blob/main/docs/specs/SPEC-146-dictation-language-for-desktop-voice-input.md) |
| **Amends on implementation** | [SPEC-003](SPEC-003-note-reading-and-the-react-renderer.md) FR-10 |

## Summary

This SPEC holds the details that ADR-029 left to a Bot SPEC. Through it, Cats
Bot adopts Platform's `linux-stt` feature pack and dictation language setting.

It cites Platform requirements by number and specifies only what differs in
Bot:

- how Platform code arrives;
- where packs live;
- composer notices instead of toasts;
- dictation shared across several notes;
- the Hub Settings General tab.

## Goals

- **Linux dictation.** Bot on Linux x64 and arm64 dictates on the machine itself
  with the same pack as Desktop.
- **Language choice.** On every platform, the owner chooses the dictation
  language without changing the operating system's language.
- **One implementation.** Bot carries Platform's pack manager and helpers
  unchanged, so the two products cannot drift.

## Non-Goals

- **Behavior Platform owns.** Anything SPEC-145 or SPEC-146 already defines,
  which Bot does not restate:
  - the archive and manifest;
  - helper protocol 1;
  - pack statuses;
  - the cap and the timeouts;
  - the language rules.
- **Platform's open questions.** Bot does not resolve them.
- **Sharing packs with Cats Desktop** (ADR-029 point 3).
- **A per-bot dictation language** (ADR-029 D2).
- **Snap, Flatpak, and sandboxed Linux formats in general.**

## Requirements

### A. How Platform code arrives

**FR-A1 — Vendored verbatim.** These come through ADR-006's synchronizer
(`scripts/sync-shared-tools.mjs`), in the cats-platform group of
`scripts/shared-tools.provenance.json`:

- Platform's pack manager closure (SPEC-145 FR-B9);
- the macOS and Windows helper sources, `native/macos-stt` and
  `native/windows-stt`.
  - These are byte-identical to Platform's `desktop/native/` today, so the
    first sync pins the current Platform commit.
  - A later refresh brings `--list-languages` (SPEC-146 FR-3).

Every file is pinned to one Platform commit by SHA-256, refreshed only by the
synchronizer, and verified offline in CI.

**FR-A2 — What vendored TypeScript must satisfy.** Bot runs TypeScript through
Node's type stripping, so vendored files must run unchanged:

- no relative value imports (type-only imports are allowed);
- only `node:` built-ins;
- only erasable syntax.

Platform's files would otherwise import `./x.js`, which Bot cannot resolve at
run time. If Platform's closure cannot meet this, Bot ports those files instead
and records the Platform commit in each file's header, as ADR-018 did.

**FR-A3 — Ported, not vendored.**

- **What is ported:**
  - the voice controller changes: the pack helper path, the cap, the events,
    the timeouts and the language arguments;
  - the shared voice type additions.
- **Why:** Bot's `src/shell/electron/voiceCapture.ts` and
  `src/shared/voice.ts` depend on Bot modules, so they are ported from the same
  Platform commit, recorded in the file headers.
- **Relation to ADR-029.** This refines ADR-029 point 2, which listed the
  controller among the vendored parts.

**FR-A4 — When.**

- **The language slice** starts once Platform's helpers have
  `--list-languages` on Platform `main` and SPEC-146 AC-04 has passed on a real
  Mac. It needs no pack.
- **The pack slice** starts at Platform PLAN-138 milestone M2 (ADR-029 D1).

### B. Packs in Bot

**FR-B1 — Lock.**

- Bot ships `assets/feature-packs.lock.json`, which is packaged with
  `assets/**`. Its schema follows SPEC-145 FR-A1.
- Its entries are identical to Desktop's for the same pack version.
- It stays empty until the first authorized `linux-stt` release. It changes
  only in a Bot release, and is frozen with the other pins.

**FR-B2 — Location.**

- Packs live in `<bot root>/feature-packs/`, normally
  `~/.catsbot/feature-packs/`. Bot's configured root is honored.
- The layout follows SPEC-145 FR-B1.
- There is one copy per Hub, and only the shell process writes it.

**FR-B3 — Manager.**

- The vendored manager runs with a Bot-supplied transport (Electron `net`),
  directories and clock.
- SPEC-145 FR-B2–FR-B7 and FR-B10 apply unchanged.

**FR-B4 — Reset.**

- `feature-packs` stays outside the allowlists in
  `src/shell/electron/hub/dataReset.ts`.
- The Data tab's list of what a reset keeps gains "downloaded offline speech
  recognition".

**FR-B5 — Test isolation.** Tests use temporary roots only and never touch the
real `~/.catsbot` (docs/testing.md).

### C. The note

**FR-C1 — Microphone on Linux.**

- When the shell creates a note window, it decides whether Bot's lock has an
  entry for the machine's architecture.
- It passes the answer to preload, for example through `additionalArguments`.
  Preload's `voice` exposure extends to Linux on that signal, and preload reads
  no files.
- This amends SPEC-003 FR-10's "Linux has no helper yet and shows no button."

**FR-C2 — Composer notices.** Platform shows these as toasts; Bot shows them as
the ADR-024 composer notice.

- **`pack_required`.** The note reads the pack status and shows SPEC-145 FR-C1's
  message for it, with **Open Settings**.
- **`unsupported`.** The notice names the missing glibc version or library, with
  no action.
- **`language_not_supported` while a language is set.** The notice offers
  **Open Settings** (SPEC-146 FR-5).
- **The notice action.** The `pane` field generalizes to an action that is one
  of:
  - a macOS System Settings pane (ADR-020);
  - Open Settings, which uses the existing `openSettings(tab)` extended with a
    section target, and lands on the Hub General tab's Voice input group.

  This amends ADR-024's notice shape.
- **No automatic start.** Dictation never starts by itself after a download.

**FR-C3 — Composer states.** `limit_warning` and `processing` appear in the note
composer as SPEC-145 FR-D5 describes.

**FR-C4 — Several notes (ADR-029 point 6).**

- **While recording**, before `processing`, ADR-018's rules stand. Hiding the
  note, another note starting, the composer becoming busy, Escape and
  destroying the note all end the session.
- **After `processing` starts:**
  - Hiding the note no longer ends the session. The final text is inserted into
    that note's draft; its renderer stays alive while hidden.
  - The shell rejects another note's start with the code `voice_busy`. That
    note shows a notice: "Still transcribing in another note."
  - Escape in the owning note, its composer becoming busy, or its destruction
    still cancels.
- The voice event union stays identical to Platform's. `voice_busy` is a
  rejection of the start call, not an event.

**FR-C5 — Cap and timeouts.** The cap and the timeouts follow SPEC-145 FR-D3
and FR-D4, with the values Platform settles. They are copied by the FR-A3 port.

### D. Hub Settings

**FR-D1 — The Voice input group.** The Hub General tab gains a Voice input
group, below the reply language. It holds:

- the dictation language select, following SPEC-146 FR-6: per-platform
  Automatic labels, native names, and disabled on Linux until the pack allows
  dictation;
- on Linux, when Bot's lock has an entry for the architecture, the offline
  speech recognition row. It follows SPEC-145 FR-C2's statuses and actions,
  including Pause, Resume, Discard, Check files and Remove.

**FR-D2 — Feedback and strings.**

- Feedback follows Bot's Settings conventions.
- Every new string has English and zh-TW translations.

**FR-D3 — Storage.**

- `dictationLanguage` lives in `hub-state.json`, beside `replyLanguage`.
- A missing or invalid value means `"auto"`, and values are validated as
  SPEC-146 FR-1 says.
- A Hub data reset clears it (ADR-029 D3).

**FR-D4 — Bridges.**

- The pack bridge (SPEC-145 FR-C4 operations) and the dictation language bridge
  (SPEC-146 FR-7) accept only the Settings window's main frame.
- A voice start takes its language from the Hub preference, and locales sent by
  a note are ignored (SPEC-146 FR-5).

### E. Packaging

**FR-E1 — What packaging changes.**

- The Linux `.deb` builds for x64 and arm64 change only by the lock in
  `assets/`.
- macOS and Windows packaging change only by the helpers' vendored
  `--list-languages`.
- The existing helper build and verify scripts keep working.

## Acceptance Criteria

- **AC-01 — Vendoring.**
  - The synchronizer verifies the provenance offline, and vendored files are
    byte-identical to the pinned Platform commit.
  - A test imports the vendored manager under Node's type stripping.
- **AC-02 — Packs.** With fixture packs under a temporary Bot root, the
  equivalents of SPEC-145 AC-01–AC-03 pass.
  - A Hub data reset keeps `feature-packs/` and clears `dictationLanguage`.
- **AC-03 — The note.**
  - The Linux microphone appears or not according to the lock.
  - Each status gives the right notice, and Open Settings reaches Voice input.
  - Dictation does not start automatically.
- **AC-04 — Several notes.**
  - Hiding a note during `processing` still inserts its text.
  - Another note's start is rejected with the notice.
  - Escape, a busy composer and destruction still cancel.
- **AC-05 — Settings.**
  - The group appears and its labels match each platform.
  - On Linux, the row shows the right actions for each status.
  - The preference persists across a restart.
- **AC-06 — Manual.**
  - **Linux:** live dictation with the real pack on x64 and on the arm64
    reference board, after Platform M2.
  - **macOS:** choosing a language on a real machine works.
  - **Windows:** text reaching the note waits on Platform SPEC-084's open
    defect, as in Desktop.

## Dependencies

- **Platform PLAN-138 M2,** for the pack slice.
- **Platform's helpers with `--list-languages` on `main`, accepted on a real
  Mac,** for the language slice.
- **The first authorized cats-plugins `linux-stt` release,** for lock entries.
- **Platform PLAN-138's pack manager closure meeting FR-A2.** This is otherwise
  a port.

## Changes to Bot records on implementation

- **SPEC-003 FR-10:** the Linux button, the language and the notice actions.
- **ADR-018 point 3:** replaced by ADR-029 once ADR-029 is accepted.
- **ADR-024:** the notice action.

These records stay as written until the change that implements them.

## References

- [ADR-006](../decisions/006-share-runtime-catalogs-and-package-provider-setup-helpers.md), [ADR-018](../decisions/018-dictate-through-native-speech-helpers.md), [ADR-020](../decisions/020-send-the-owner-to-the-macos-system-settings-pane-a-permission-needs.md), [ADR-023](../decisions/023-persist-utility-windows-and-reset-bot-data-offline.md), [ADR-024](../decisions/024-show-composer-failures-as-one-composer-notice.md), [ADR-029](../decisions/029-dictate-on-linux-with-the-linux-stt-pack-and-choose-the-dictation-language.md)
- Platform [SPEC-145](https://github.com/cats-inc/cats-platform/blob/main/docs/specs/SPEC-145-feature-packs-and-linux-dictation.md), [SPEC-146](https://github.com/cats-inc/cats-platform/blob/main/docs/specs/SPEC-146-dictation-language-for-desktop-voice-input.md), [PLAN-138](https://github.com/cats-inc/cats-platform/blob/main/docs/plans/PLAN-138-feature-packs-linux-dictation-and-dictation-language.md)

---

*Created: 2026-11-16*
*Related Plan: [PLAN-016](../plans/PLAN-016-linux-dictation-pack-and-dictation-language.md)*
