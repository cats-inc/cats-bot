# PLAN-015: Kimi Code as the Sixth CLI

| Field | Value |
| --- | --- |
| Status | Implemented on `feat/kimi-sixth-cli`; native Bot acceptance pending |
| Decision | [ADR-025](../decisions/025-add-kimi-code-as-a-hosted-only-sixth-cli.md) |
| Runtime | cats-inc/cats-runtime#225 (hosted `kimi acp`, ADR-054 decision 11) |
| Created | 2026-11-16 |

## Slices

1. **Runtime pin.** Select the Runtime `main` commit that contains #225 with
   `node scripts/refresh-runtime-pin.mjs`. It carries #224 (the Kimi provider, catalog and native
   session management) and #225.
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
   - Applied in `createProfile`, `normalizeProfile` and `applyProfilePatch`.
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
    ACP fixture for Kimi as well.
  - The full `npm test` and `npm run build` run in CI.
- Native acceptance on Windows with a signed-in Kimi plan:
  - Create a Kimi bot. Ask for a screenshot of a test window.
  - Approve the card in the note and confirm the cell shown on it.
  - Decline once and confirm that nothing runs.
  - Not yet run in the Bot itself. The Runtime path was accepted end to end in Runtime #225.
