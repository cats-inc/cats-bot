// Removes a bot-like folder that holds a junction (a symbolic link elsewhere) and a
// read-only file with the given module's `removeTree`, under whatever runtime runs this
// script, and reports whether the link's target survived.
// Usage: <node or ELECTRON_RUN_AS_NODE=1 electron> remove-tree-check.mjs <module URL> <temp dir>
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { removeTree } = await import(process.argv[2]);
const temp = process.argv[3];
const outside = join(temp, 'outside');
mkdirSync(join(outside, 'nested'), { recursive: true });
writeFileSync(join(outside, 'precious.txt'), 'keep');
writeFileSync(join(outside, 'nested', 'deep.txt'), 'keep');
const bot = join(temp, 'bot');
mkdirSync(join(bot, 'workspace', 'node_modules'), { recursive: true });
writeFileSync(join(bot, 'profile.json'), '{}');
symlinkSync(outside, join(bot, 'workspace', 'node_modules', 'linked'), 'junction');
const readOnly = join(bot, 'workspace', 'object');
writeFileSync(readOnly, 'x');
chmodSync(readOnly, 0o444);
removeTree(bot);
process.stdout.write(JSON.stringify({
  runtime: process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.versions.node}`,
  botRemoved: !existsSync(bot),
  outsideKept: existsSync(join(outside, 'precious.txt')) && existsSync(join(outside, 'nested', 'deep.txt')),
}));
