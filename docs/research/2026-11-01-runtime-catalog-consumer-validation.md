# 2026-11-01 Runtime catalog consumer validation

The owner requested refreshed catalogs in Runtime Playground, Platform selectors and Bot
selectors, with Bot offering only Codex, Claude, Antigravity, Grok and Muse. Its existing
five-provider menu already matches this requirement. Models and controls continue to come
from Runtime's public catalog module and active HTTP service; no independent table is added.

Runtime's candidate now offers 8 Codex, 12 Claude, 5 Antigravity, 4 Grok and 3 Muse entries.
GPT-6.1 Terra is new, with six effort values, Low default and context 500000. Cursor's new
DeepSeek row is outside Bot's provider menu. Copilot remains outside Bot's menu and its
Runtime refresh is blocked by account feature HTTP 403 after sign-in. Runtime's detailed
record is `docs/research/2026-11-01-seven-cli-catalog-refresh.md`.

## Candidate validation

- Installed existing lockfile dependencies in this isolated worktree; the main checkout had
  no node_modules. Baseline provider/settings tests passed (17).
- Built and packed the changed Runtime locally, without a version bump or publication. Installed
  it into this worktree's node_modules with `--no-save --package-lock=false --ignore-scripts`.
  Tracked dependency/lockfile/source pin remained unchanged during candidate validation.
- Candidate provider/settings tests plus fixture-backed Runtime process/HTTP integration passed
  (18). The package's generated sourceDigest matches Runtime's factory:
  `b9f8c46b2b9add026804082b219a0d3350ab17f264b2c481beb00dc3cfacff64`.
- Candidate TypeScript checks and production renderer/build passed with the new package.
- After rebasing onto the latest 0.4.3 main (including reply-language), the expanded focused
  provider/settings, Runtime process/HTTP and artifact contract checks passed 27 tests and
  TypeScript checking passed. The final source tarball is byte-identical to the tested candidate.
- Actual artifact identity validation and a clean offline lockfile installation passed. The
  installed public catalog export confirms the factory digest, all five provider counts and
  Terra's six controls/default Low.
- Independent review compared all 1,473 files in both archives: only the authored/generated
  catalog files differ; executable/package/assets/runtime-skills bytes are unchanged. Every
  new archive member matches the clean merged Runtime checkout/build. Hashes, actual pin
  validation and installed five-provider projections passed independently; no findings.
- All five model menus preserve every factory ID, label, per-model control/default and order.
  The cross-repository check also verified Platform's actual HTTP catalog projection and all
  Playground choices/custom input. Bot's provider menu stays exactly the five requested names.
- Tests used temporary state and fixture CLIs; no real Bot profile/conversation or provider
  inference was created. No full-suite or installed-Bot acceptance claim is made.

After the data, candidate and checks were ready, the owner authorized `cnr` (commit, push and
auto-merged PRs). Runtime PR #207 passed full hosted preflight and merged as
`c6e575b672ecaf3d6113c08260720b57c7d62765`. This change pins
`vendor/cats-runtime-0.6.2-c6e575b6.tgz` (1,790,301 bytes, SHA-256
`b26c51765a686a9f18ffb1381bce19b3984de3a9bf0180c4439049984fbc2b12`) in the manifest,
lockfile and immutable Runtime source record. The old artifact is replaced; no model table
or selector code changes. Bot 0.4.3 and Runtime 0.6.2 versions are unchanged. No release,
publication, installed-application replacement or personal catalog override is authorized.
