// The fake runtime, started after `CATS_BOT_TEST_RUNTIME_DELAY_MS`, so a core is still
// starting its Runtime when a host sends or stops it (review of PR #65).
await new Promise((resolve) => setTimeout(resolve, Number(process.env.CATS_BOT_TEST_RUNTIME_DELAY_MS ?? '3000')));
await import(new URL('./fake-runtime.mjs', import.meta.url).href);
