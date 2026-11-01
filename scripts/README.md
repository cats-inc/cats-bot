# Scripts

> Project automation scripts live here.

## Layout

```
scripts/
├── windows/   # PowerShell (.ps1)
├── linux/     # Bash (.sh)
├── macos/     # Bash (.sh)
└── testing/   # Test helpers (shared)
```

## Standards

Follow `docs/SCRIPT-STANDARDS.md` for naming and documentation rules.

`testing/bot-interaction-acceptance.mjs` exercises real Electron waiting controls
with a fake Runtime and an isolated temporary profile. Its optional `--native-drag`
mode uses Linux `xdotool` input for avatar dragging, click-through and bubbles;
see [the testing guide](../docs/testing.md#shell-tests) before running it.
