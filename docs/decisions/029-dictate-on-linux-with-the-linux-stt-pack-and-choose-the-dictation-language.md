# ADR-029: Dictate on Linux with the `linux-stt` pack and choose the dictation language

## Status

Proposed — 2026-11-16, at the owner's request. Documentation only. The owner
delegated D1–D3 the same day; see [Resolved decisions](#resolved-decisions).

Everything this ADR builds on is Proposed or Draft. No `linux-stt` release
exists, and Desktop has not implemented SPEC-145 or SPEC-146.

If accepted, this ADR:

- replaces ADR-018 point 3 ("Linux is not built yet");
- extends ADR-018's Neutral note that "no language is passed";
- adds a kind of action to ADR-024's composer notice.

Those records stay as written until then.

## Context

- **Bot dictation today.** Bot ported Cats Desktop's dictation unchanged
  (ADR-018): the macOS and Windows helpers and the host controller.
  - The note offers dictation only where a helper exists, so Linux, Bot's
    `.deb` for x64 and arm64, shows no microphone.
  - No language is passed, so each helper uses the operating system's.
- **Platform's decisions.**
  - Platform [ADR-154](https://github.com/cats-inc/cats-platform/blob/main/docs/decisions/154-deliver-optional-native-dependencies-as-host-managed-feature-packs.md)
    introduces feature packs: native files that host code downloads on demand
    and verifies by SHA-256.
  - [SPEC-145](https://github.com/cats-inc/cats-platform/blob/main/docs/specs/SPEC-145-feature-packs-and-linux-dictation.md)
    specifies the shared contract and Desktop's Linux dictation with the
    `linux-stt` pack.
  - [SPEC-146](https://github.com/cats-inc/cats-platform/blob/main/docs/specs/SPEC-146-dictation-language-for-desktop-voice-input.md)
    adds one dictation language setting for every platform.
  - cats-plugins [SPEC-002](https://github.com/cats-inc/cats-plugins/blob/main/docs/specs/SPEC-002-linux-stt-pack-producer.md)
    builds the pack.
  - ADR-154 §4 says Bot adopts the same pack, lock entry and protocol through
    its own ADR, and must not wait for `@cats-inc/platform-host`.
- **Bot constraints.**
  - Bot does not import cats-platform. It reuses Platform source only as
    vendored files with recorded provenance (ADR-006:
    `scripts/sync-shared-tools.mjs`, `assets/setup/provenance.json`), or
    through the packed `platform-ui-web` entries.
  - Bot has its own data root (ADR-007). One shell process holds Electron's
    single-instance lock.
  - Composer failures are a composer notice, not a toast (ADR-024).
  - The Hub Settings General tab already holds the UI language and the reply
    language.
  - Bot's data reset deletes only an allowlist (ADR-023): the `bots`,
    `archive`, `trash`, `boss-cat` and `logs` directories, `hub-state.json`
    (which holds Hub preferences) and a few other files.
- **A difference from Desktop: dictation runs in several notes.**
  - The shell ends a note's session when the note hides or another note starts
    dictating.
  - With the pack's batch recognition, a recording is transcribed after `stop`.
    Cancelling then would throw away what the owner already said.

## Decision

1. **Adopt Platform's contract unchanged.**
   - This covers SPEC-145 §A (lock entry, `.catspack`, manifest, helper
     protocol 1), FR-D2–FR-D8 for Linux dictation, and SPEC-146 FR-1–FR-5 for
     the dictation language.
   - Bot pins the same pack artifacts in its own lock: the same URLs and
     digests that Desktop pins, changed only in a Bot release.
   - Shared voice types gain `pack_required`, `limit_warning` and
     `processing`, as Platform's do.
2. **Reuse Platform's code by vendoring it.**
   - These parts come through ADR-006's synchronizer, with each file's Platform
     commit and SHA-256 recorded:
     - SPEC-145's Node-only pack manager (FR-B9);
     - the voice controller changes;
     - the macOS and Windows helpers' `--list-languages` (SPEC-146 FR-3).
   - Bot does not write its own pack manager.
   - When `@cats-inc/platform-host` publishes the manager (SPEC-134), Bot
     depends on that package and deletes its vendored copy.
3. **Storage.**
   - Packs live once per Hub, in `<bot root>/feature-packs/`, with SPEC-145
     FR-B1's layout. Every bot's notes use the same pack.
   - The shell process is the only writer.
   - Packs are never shared with Desktop's `~/.cats/platform/feature-packs/`
     (ADR-154 §3). A machine with both products keeps two copies.
4. **Reset.**
   - `feature-packs/` stays outside ADR-023's allowlist, so a reset keeps
     downloaded packs (ADR-154 D5). The reset disclosure lists it.
   - The dictation language is a Hub preference, so a reset returns it to
     Automatic. Desktop keeps its own (D3).
5. **Where the owner sees it.**
   - **The note.** On Linux, the microphone appears when Bot's lock has an
     entry for the machine's architecture. The shell decides this and tells
     preload; preload reads no files.
   - **Problems in the note.** A `pack_required` status, and a
     `language_not_supported` while a language is set, show as the composer
     notice. They carry SPEC-145 FR-C1's message for the status and an **Open
     Settings** action. The action opens that bot's Settings window at the Hub
     General tab.
   - **Settings.** The Hub General tab gains a **Voice input** group, which
     holds:
     - the dictation language select (SPEC-146 FR-6's labels and options);
     - on Linux, the offline speech recognition row with SPEC-145 FR-C2's
       statuses and actions, including pause and resume.
   - Bot's existing Settings feedback conventions apply.
   - Bot already shows no voice button where no helper exists, so SPEC-145
     FR-D1's no-Web-Speech rule needs no Bot change.
6. **Transcribing is not cancelled by switching notes.**
   - Once `processing` starts, hiding the note no longer ends the session. The
     transcript is inserted into that note's draft.
   - Another note's dictation start is refused, with a composer notice in
     that note, until the session ends.
   - Escape, the composer becoming busy, and destroying the note still cancel,
     as before.
7. **Two parts that can land separately.**
   - **The dictation language** on macOS and Windows needs no pack. It lands
     once the helpers' `--list-languages` exists on Platform `main`.
   - **Linux dictation** lands with the pack manager. Its lock stays empty until
     the first authorized `linux-stt` release, so Linux shows no microphone
     until then.
8. **Details belong to a Bot SPEC**, which also amends SPEC-003 FR-10: file
   paths, the lock file location, bridge shapes, the notice's action type,
   strings and tests.

### Compatibility

- New data: a `feature-packs/` directory, and one optional Hub preference that
  defaults to Automatic when it is missing. Existing profiles and state need no
  migration.
- The change is additive within Bot's current minor line.

## Consequences

### Positive

- Bot on Linux gets on-device dictation, which is the gap that started this
  work.
- On every platform, the owner can dictate in a language other than the
  operating system's.
- One pack artifact and one contract serve Desktop and Bot.

### Negative

- Until `@cats-inc/platform-host` exists, Bot carries vendored copies that each
  Platform change must re-sync.
- A machine with both products downloads the pack twice.
- Bot follows Desktop's implementation, so its timing depends on Desktop's (D1).
- Bot's notice action and its multi-note rules add behavior that Desktop does
  not have.

### Neutral

- Bot's reset clears the dictation language while Desktop's keeps it; each
  follows its own reset policy.

## Alternatives Considered

### Alternative 1: Bot implements the pack manager first

- **Pros**: Bot could ship Linux dictation without waiting for Desktop.
- **Cons**: The first implementation would live in Bot, while ADR-154 places
  the mechanism in Platform. Desktop would vendor from Bot, or the two would
  diverge.
- **Why rejected**: See D1.

### Alternative 2: Share Desktop's pack directory

- **Pros**: One copy on disk.
- **Cons**: It crosses ADR-007's separate data roots. Each product's removal,
  reset and update would affect the other.
- **Why rejected**: ADR-154 §3 keeps packs per product.

### Alternative 3: A dictation language per bot

- **Pros**: Different bots could dictate in different languages.
- **Cons**: It departs from SPEC-146's single setting and from the Hub-level
  reply language.
- **Why rejected**: See D2.

### Alternative 4: Keep cancelling a session when its note hides

- **Pros**: The rule stays unchanged.
- **Cons**: Batch recognition would throw away a finished recording.
- **Why rejected**: Point 6.

## Resolved Decisions

The owner delegated D1–D3 on 2026-11-16.

- **D1 — Order: Desktop first, then Bot vendors it.**
  - Bot vendors Desktop's implementation once it lands on Platform `main` and
    passes its acceptance.
  - One implementation, owned where ADR-154 places it, avoids two diverging
    pack managers. Bot's later start is the accepted cost.
  - Implementing in Bot first (Alternative 1) was rejected.
- **D2 — Scope: one dictation language per Hub.**
  - This follows the Hub-level reply language and SPEC-146's single setting.
  - A per-bot setting (Alternative 3) was rejected.
- **D3 — Reset: clears the dictation language.**
  - A reset clears it with the other Hub preferences, as ADR-023 does for all
    of them, and keeps downloaded packs.
  - Keeping it, as Desktop does, was rejected, because Bot's reset already
    returns every preference to its default.

## References

- [ADR-006](006-share-runtime-catalogs-and-package-provider-setup-helpers.md), [ADR-007](007-give-cats-bot-its-own-identity-and-data-root.md), [ADR-018](018-dictate-through-native-speech-helpers.md), [ADR-023](023-persist-utility-windows-and-reset-bot-data-offline.md), [ADR-024](024-show-composer-failures-as-one-composer-notice.md)
- [SPEC-003](../specs/SPEC-003-note-reading-and-the-react-renderer.md) FR-10
- Platform [ADR-154](https://github.com/cats-inc/cats-platform/blob/main/docs/decisions/154-deliver-optional-native-dependencies-as-host-managed-feature-packs.md), [SPEC-145](https://github.com/cats-inc/cats-platform/blob/main/docs/specs/SPEC-145-feature-packs-and-linux-dictation.md), [SPEC-146](https://github.com/cats-inc/cats-platform/blob/main/docs/specs/SPEC-146-dictation-language-for-desktop-voice-input.md), [SPEC-134](https://github.com/cats-inc/cats-platform/blob/main/docs/specs/SPEC-134-reusable-platform-packages-and-consumer-boundaries.md)
- cats-plugins [ADR-002](https://github.com/cats-inc/cats-plugins/blob/main/docs/decisions/002-produce-native-feature-packs-beside-plugin-content.md), [SPEC-002](https://github.com/cats-inc/cats-plugins/blob/main/docs/specs/SPEC-002-linux-stt-pack-producer.md)

---

*Proposed: 2026-11-16*
*Decision makers: Owner (pending)*
