import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';
import { readCatalogFactory, readLocalCatalogProjection } from '@cats-inc/cats-runtime/catalogs';

/**
 * SPEC-002 FR-3: what a settings page may offer as the bot's provider and
 * model. The product exposes five CLI providers. Runtime's public catalogs
 * API supplies factory data, local overrides, revision and model controls;
 * the running Runtime's advanced catalog is authoritative for the active
 * provider (see `BotCore.listModels`). No Platform application is imported.
 */

export type { ModelCatalog, ModelOption, ProviderDefinition, ProviderInfo } from '../types.ts';
import type {
  ModelCatalog,
  ModelControl,
  ModelOption,
  ProviderDefinition,
  ProviderInfo,
} from '../types.ts';

export const CLI_PROVIDERS: readonly ProviderDefinition[] = [
  { id: 'codex', label: 'Codex', command: 'codex' },
  { id: 'claude', label: 'Claude', command: 'claude' },
  { id: 'antigravity', label: 'Antigravity', command: 'agy' },
  { id: 'grok', label: 'Grok', command: 'grok' },
  { id: 'muse', label: 'Muse', command: 'muse' },
];

/** The command the runtime launches for a provider; an unknown provider is its own command. */
export function defaultCommandFor(provider: string): string {
  return (
    CLI_PROVIDERS.find((definition) => definition.id === provider)?.command ??
    ({ cursor: 'cursor-agent', kiro: 'kiro-cli' } as Record<string, string>)[provider] ??
    provider
  );
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
  catalogRevision?: string;
  document?: {
    catalogs?: Array<{
      provider?: unknown;
      backend?: unknown;
      shared_controls?: ModelControl[];
      models?: Array<{
        id?: unknown;
        label?: unknown;
        default?: unknown
        controls?: ModelControl[];
      }>;
    }>;
  };
}

function readPackagedDocument(runtimeRoot?: string): PackagedCatalogDocument | null {
  const packageRoot = dirname(
    createRequire(import.meta.url).resolve('@cats-inc/cats-runtime/package.json'),
  );
  const paths = { packageRoot, runtimeRoot: runtimeRoot ?? packageRoot };
  // Runtime's public read-only data API shares Desktop's factory, local overrides
  // and last-accepted fallback without starting a service or probing a CLI.
  if (runtimeRoot) {
    const projection = readLocalCatalogProjection(paths);
    if (!projection.snapshot)
      throw new Error(projection.diagnostics.join('\n') || 'Model catalog unavailable');
    return {
      document: projection.snapshot.document,
      catalogRevision: projection.snapshot.catalogRevision,
    };
  }
  return { document: readCatalogFactory(paths).document };
}

export function readLocalModelCatalog(provider: string, runtimeRoot: string): ModelCatalog {
  return readPackagedModelCatalog(provider, readPackagedDocument(runtimeRoot));
}

/** The CLI model catalog the runtime package ships for a provider. */
export function readPackagedModelCatalog(
  provider: string,
  document = readPackagedDocument(),
): ModelCatalog {
  const catalog = document?.document?.catalogs?.find((entry) => entry.provider === provider && entry.backend === 'cli');
  if (!catalog || !Array.isArray(catalog.models)) {
    return { provider, defaultModel: null, models: [], source: 'none' };
  }
  const models: ModelOption[] = [];
  for (const model of catalog.models) {
    if (typeof model.id !== 'string' || !model.id) continue;
    models.push({ id: model.id, label: typeof model.label === 'string' && model.label ? model.label : model.id, default: model.default === true });
    if (model.controls) {
      models.at(-1)!.controls = model.controls;
      models.at(-1)!.controlDefaults = Object.fromEntries(
        model.controls
          .filter((control) => control.default !== undefined)
          .map((control) => [control.key, control.default!]),
      );
    }
  }
  return {
    provider,
    defaultModel: models.find((model) => model.default)?.id ?? null,
    models,
    source: 'packaged',
    ...(document?.catalogRevision ? { catalogRevision: document.catalogRevision } : {}),
    ...(catalog.shared_controls ? { controls: catalog.shared_controls } : {}),
  };
}
