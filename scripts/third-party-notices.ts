import type { Plugin } from 'vite';
import { collectRendererLicenses } from './shared/renderer-license-collector.ts';

/** Bot output adapter; dependency discovery and complete LICENSE/NOTICE collection are shared. */
export function thirdPartyNotices(fileName = 'THIRD-PARTY-NOTICES.txt'): Plugin {
  let included: string[] = [];
  return {
    name: 'cats-bot-third-party-notices', apply: 'build', enforce: 'post',
    generateBundle: { order: 'post', async handler(_options, bundle) {
      const ids = new Set(Object.values(bundle).flatMap(output => output.type === 'chunk' ? Object.keys(output.modules) : []));
      for (const id of this.getModuleIds()) if (/\.css(?:\?|$)/u.test(id) && this.getModuleInfo(id)?.isIncluded) ids.add(id);
      for (const id of this.getWatchFiles()) if (/\.(?:css|scss|sass|less|styl|stylus)(?:\?|$)/u.test(id)) ids.add(id);
      included = [...ids];
      const packages = await collectRendererLicenses(included);
      const sections = packages.map(info => `${info.name}@${info.version} (${typeof info.license === 'string' ? info.license : 'see the notice below'})\n\n${info.notices.map(notice => notice.text.trim()).join('\n\n')}`);
      this.emitFile({ type: 'asset', fileName,
        source: `Cats Bot renderer: third-party software bundled in this folder.\n\n${sections.join(`\n\n${'-'.repeat(72)}\n\n`)}\n` });
    } },
  };
}
