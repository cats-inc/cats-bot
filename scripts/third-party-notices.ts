import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';

import type { Plugin } from 'vite';

/**
 * ADR-003: the renderer bundles React, react-markdown and their dependencies
 * into `dist/renderer`, so their notices do not ship through node_modules.
 * This build plugin writes `THIRD-PARTY-NOTICES.txt` beside the pages: every
 * npm package with code in a chunk, its version, its declared license and the
 * text of its LICENSE/NOTICE files. A smaller take on cats-platform's
 * `scripts/renderer-license-plugin.ts` (MIT, same author).
 */

interface PackageInfo {
  directory: string;
  name: string;
  version: string;
  license: string;
}

const NOTICE_FILE = /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/iu;

async function packageOf(moduleId: string): Promise<PackageInfo | null> {
  // Vite's own helpers are virtual modules; their code ships with Vite's license.
  const file = /^\0vite\//u.test(moduleId)
    ? createRequire(import.meta.url).resolve('vite/package.json')
    : moduleId.replace(/^\0+/u, '').split('?')[0]!;
  if (!file.replaceAll('\\', '/').split('/').includes('node_modules')) return null;
  for (let directory = dirname(file); basename(directory) !== 'node_modules' && directory !== dirname(directory); directory = dirname(directory)) {
    let metadata: { name?: unknown; version?: unknown; license?: unknown };
    try {
      metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as typeof metadata;
    } catch {
      continue;
    }
    if (typeof metadata.name === 'string' && typeof metadata.version === 'string') {
      return {
        directory,
        name: metadata.name,
        version: metadata.version,
        license: typeof metadata.license === 'string' ? metadata.license : 'see the notice below',
      };
    }
  }
  throw new Error(`No package.json above bundled module ${moduleId}`);
}

export function thirdPartyNotices(fileName = 'THIRD-PARTY-NOTICES.txt'): Plugin {
  return {
    name: 'cats-bot-third-party-notices',
    apply: 'build',
    async generateBundle(_options, bundle) {
      const packages = new Map<string, PackageInfo>();
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        for (const id of Object.keys(output.modules)) {
          const info = await packageOf(id);
          if (info) packages.set(info.directory, info);
        }
      }
      const sections: string[] = [];
      for (const info of [...packages.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        const notices = (await readdir(info.directory)).filter((entry) => NOTICE_FILE.test(entry)).sort();
        const texts = await Promise.all(notices.map((entry) => readFile(join(info.directory, entry), 'utf8')));
        if (texts.length === 0) throw new Error(`${info.name}@${info.version} ships no LICENSE or NOTICE file`);
        sections.push(`${info.name}@${info.version} (${info.license})\n\n${texts.map((text) => text.trim()).join('\n\n')}`);
      }
      this.emitFile({
        type: 'asset',
        fileName,
        source: sections.length === 0
          ? 'Cats Bot renderer: no third-party code is bundled in this folder.\n'
          : `Cats Bot renderer: third-party software bundled in this folder.\n\n${sections.join(`\n\n${'-'.repeat(72)}\n\n`)}\n`,
      });
    },
  };
}
