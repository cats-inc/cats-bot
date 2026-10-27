import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';

/**
 * SPEC-002 FR-3: what a settings page may offer as the bot's provider and
 * model. The provider list is the CLI providers cats-runtime 0.6.1 supports,
 * with the default command each one is launched by (copied from the runtime's
 * `config/providers.yaml.example`). Models come from the catalog the runtime
 * package ships (`config/curated-model-catalogs.generated.json`), read as data;
 * the running runtime's own catalog takes precedence for the bot's current
 * provider (see `BotCore.listModels`).
 */

export type { ModelCatalog, ModelOption, ProviderDefinition, ProviderInfo } from '../types.ts';
import type { ModelCatalog, ModelOption, ProviderDefinition, ProviderInfo } from '../types.ts';

export const CLI_PROVIDERS: readonly ProviderDefinition[] = [
  { id: 'claude', label: 'Claude Code', command: 'claude' },
  { id: 'codex', label: 'Codex', command: 'codex' },
  { id: 'antigravity', label: 'Antigravity', command: 'agy' },
  { id: 'copilot', label: 'GitHub Copilot', command: 'copilot' },
  { id: 'cursor', label: 'Cursor Agent', command: 'cursor-agent' },
  { id: 'grok', label: 'Grok', command: 'grok' },
  { id: 'opencode', label: 'OpenCode', command: 'opencode' },
  { id: 'kilo', label: 'Kilo', command: 'kilo' },
  { id: 'goose', label: 'Goose', command: 'goose' },
  { id: 'pi', label: 'Pi', command: 'pi' },
  { id: 'auggie', label: 'Auggie', command: 'auggie' },
  { id: 'junie', label: 'Junie', command: 'junie' },
  { id: 'kiro', label: 'Kiro', command: 'kiro-cli' },
  { id: 'cline', label: 'Cline', command: 'cline' },
  { id: 'muse', label: 'Muse', command: 'muse' },
];

/** The command the runtime launches for a provider; an unknown provider is its own command. */
export function defaultCommandFor(provider: string): string {
  return CLI_PROVIDERS.find((definition) => definition.id === provider)?.command ?? provider;
}

/** Finds an executable on PATH the way a shell would, honouring PATHEXT on Windows. */
export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | null {
  const path = env.PATH ?? env.Path ?? '';
  // PATHEXT is upper case; the lower-case spelling matters only on a case-sensitive file system.
  const extensions = platform === 'win32'
    ? ['', ...new Set((env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).flatMap((ext) => [ext, ext.toLowerCase()]))]
    : [''];
  for (const dir of path.split(platform === 'win32' ? ';' : delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = join(dir.replace(/^"(.*)"$/u, '$1'), `${command}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function listProviders(env: NodeJS.ProcessEnv = process.env): ProviderInfo[] {
  return CLI_PROVIDERS.map((definition) => ({ ...definition, installed: findOnPath(definition.command, env) !== null }));
}

interface PackagedCatalogDocument {
  document?: {
    catalogs?: Array<{
      provider?: unknown;
      backend?: unknown;
      models?: Array<{ id?: unknown; label?: unknown; default?: unknown }>;
    }>;
  };
}

let packagedCache: PackagedCatalogDocument | null | undefined;

function readPackagedDocument(): PackagedCatalogDocument | null {
  if (packagedCache !== undefined) return packagedCache;
  try {
    const require = createRequire(import.meta.url);
    const packageJson = require.resolve('@cats-inc/cats-runtime/package.json');
    const file = join(dirname(packageJson), 'config', 'curated-model-catalogs.generated.json');
    packagedCache = JSON.parse(readFileSync(file, 'utf8')) as PackagedCatalogDocument;
  } catch {
    packagedCache = null;
  }
  return packagedCache;
}

/** The CLI model catalog the runtime package ships for a provider. */
export function readPackagedModelCatalog(provider: string, document = readPackagedDocument()): ModelCatalog {
  const catalog = document?.document?.catalogs?.find((entry) => entry.provider === provider && entry.backend === 'cli');
  if (!catalog || !Array.isArray(catalog.models)) {
    return { provider, defaultModel: null, models: [], source: 'none' };
  }
  const models: ModelOption[] = [];
  for (const model of catalog.models) {
    if (typeof model.id !== 'string' || !model.id) continue;
    models.push({ id: model.id, label: typeof model.label === 'string' && model.label ? model.label : model.id, default: model.default === true });
  }
  return { provider, defaultModel: models.find((model) => model.default)?.id ?? null, models, source: 'packaged' };
}
