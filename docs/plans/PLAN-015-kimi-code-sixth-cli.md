# PLAN-015: Kimi Code as the Sixth CLI

| Field | Value |
| --- | --- |
| Status | Implemented; headless native acceptance passed; GUI note acceptance pending |
| Decision | [ADR-025](../decisions/025-add-kimi-code-as-a-hosted-only-sixth-cli.md) |
| Runtime | `b9819a6c`: cats-inc/cats-runtime#225 (hosted `kimi acp`, ADR-054 decision 11) and #226 (45 s start-up, typed cards) |
| Created | 2026-11-16 |

## Slices

1. **Runtime pin.** Select Runtime `main` at `b9819a6c` with
   `node scripts/refresh-runtime-pin.mjs --ref b9819a6c`. It carries:
   - #224: the Kimi provider, its catalog and native session management.
   - #225: hosted `kimi acp`.
   - #226: the 45 s start-up and command and file cards.
2. **Provider lists.** Add Kimi in every place the Bot lists providers:
   - `CLI_PROVIDERS`, `SETUP_PROVIDER_IDS` and `SetupHelperId`
   - the settings picker, the wizard's native-installer group and the Agent CLIs rows
   - vendor facts (Moonshot AI, `code.kimi.ai/kimi-code/install`) and the sign-in command
     `kimi login`
3. **Helpers.** Add the three Kimi helpers to `assets/setup/provenance.json` and refresh from
   Platform `d808080c` with `node scripts/sync-shared-tools.mjs --refresh`. Map `kimi` in
   `Invoke-SetupHelper.ps1`.
4. **Hosted only.**
   - `HOSTED_ONLY_PROVIDERS`, `HOSTED_PROVIDER_POLICY` and `requiredProviderPolicy` in
     `src/shared/providerTools.ts`.
   - Applied in `createProfile`, `normalizeProfile` and `applyProfilePatch`. The optional
     `providerPolicyAuto` marks a filled-in policy; leaving Kimi drops only that one.
     `createProfile` refuses Kimi with a read-only filespace or an allowlist.
   - Settings hides the legacy choice for Kimi and shows the computer-use setup hint.
5. **Strings.** zh-TW for the hint and for the helper's sign-in and Git Bash messages.
6. **Docs.** ADR-025, this plan, [provider interactions](../provider-interactions.md), the setup
   guide and the README provider list.

## Validation

- Typecheck: `tsc -p tsconfig.test.json` and `tsc -p tsconfig.renderer.json`.
- Focused tests:
  - settings, agent CLIs, computer setup, provider setup, setup and setup terminal
  - native provider tools, including the new hosted-only profile test
- After the Runtime repin:
  - `tests/integration/nativeProviderTools.test.ts` runs the packed Runtime against the scripted
    ACP fixture for Kimi as well, covering session MCP, Boss Cat tools and accept/decline cards.
  - Local results on Windows: typecheck passed; `npm test` 932 tests, 922 passed, 10 skipped,
    0 failed; `npm run build` passed.
- Headless native acceptance, 2026-11-16, Windows 11. Setup: the Bot core from this branch on the
  packed Runtime `b9819a6c`, real Kimi Code 2.6.0 on a real plan with `kimi-cu-win`, and an
  isolated `CATS_BOT_HOME`.
  - `cats-bot init --provider kimi` saved the hosted policy. `capabilities home` reported it
    `verified` in Default mode, and `computer_use` as `available`.
  - Approved owner message: `interactions home` showed one `tool_approval` card with the JS cell
    and only "Approve once". `respond` with accept ran the tool, and the turn completed with its
    output.
  - Declined owner message: no tool ran, and the bot said it was declined.
  - Kimi's session was deleted afterwards. No desktop input was sent.
  - A second run on merged main (`f21836d`) approved a real `@kimi/cu` observation cell,
    `kimiCU.list_windows()`, which returned 14 windows. A Runtime-started Kimi therefore
    reaches the Kimi Computer Use runtime. The declined card again ran nothing.
  - A print-mode `kimi -p` turn outside Cats ran the plugin's `js` tool with no approval.
    This is why a Kimi bot is hosted only.
- Still to do on a real desktop:
  - The same cards in the note window.
  - A screenshot of a test window.
