#!/usr/bin/env node
/** Inspect a Bot note/settings window. Usage: node scripts/testing/bot-renderer-cdp.mjs <targets|info|screenshot|text|eval> [--target URL_FRAGMENT] [--port 9223] */
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { runRendererCdp, parseArgs as parse, selectPageTarget as select } from '../shared/renderer-cdp.mjs';
export { listTargets, openCdpSession } from '../shared/renderer-cdp.mjs';
export const profile = { name: 'Cats Bot', port: 9223, envKey: 'CATS_BOT_CDP_PORT', allowFile: true,
  preferred: ['note.html', 'settings.html'], script: 'bot-renderer-cdp.mjs', restartScript: 'restart-bot-with-cdp.sh' };
export const parseArgs = (argv, env) => parse(argv, env, profile);
export const selectPageTarget = (targets, filter) => select(targets, filter, profile);
export const runBotRendererCdp = (argv, options = {}) => runRendererCdp(argv, { ...options, profile,
  infoExpression: `({url:location.href,title:document.title,botBridge:typeof window.catsBot==='object'&&window.catsBot!==null,viewport:{width:innerWidth,height:innerHeight},devicePixelRatio,visibilityState:document.visibilityState})` });
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runBotRendererCdp(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
