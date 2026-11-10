import type { SetupStep } from '../../../shared/providerSetup.ts';

/**
 * SPEC-010 FR-10: what a row says about a step, by provider and operating system.
 * This is product text about what the vendored helpers do. What a helper reports on
 * this computer (`SetupStep.planned`) is shown beside it, in its own words.
 */

export interface StepTag {
  text: string;
  values?: Record<string, string>;
  danger?: boolean;
}

export interface StepFacts {
  summary: string;
  summaryValues?: Record<string, string>;
  tags: StepTag[];
  /** A command for doing it by hand. */
  manual: string | null;
}

const NATIVE: Readonly<Record<string, { vendor: string; script: string }>> = {
  claude: { vendor: 'Anthropic', script: 'claude.ai/install' },
  antigravity: { vendor: 'Google', script: 'antigravity.google/cli/install' },
  grok: { vendor: 'xAI', script: 'x.ai/cli/install' },
  muse: { vendor: 'Meta', script: 'dev.meta.ai/install' },
};

/** Who makes each provider's CLI, for page 1. */
export const PROVIDER_VENDORS: Readonly<Record<string, string>> = {
  codex: 'OpenAI',
  claude: 'Anthropic',
  antigravity: 'Google',
  grok: 'xAI',
  muse: 'Meta',
};

const pathTag = (platform: string): StepTag => ({ text: platform === 'win32' ? 'Changes your user PATH' : 'Changes your shell profile' });

function nodeFacts(platform: string): StepFacts {
  if (platform === 'win32') {
    return {
      summary: 'Codex needs it to install and run. Installs the LTS version with winget, or from nodejs.org if that fails.',
      tags: [{ text: 'Needs administrator rights' }, { text: 'Downloads and installs' }, { text: "Accepts winget's agreements for you" }],
      manual: 'winget install --id OpenJS.NodeJS.LTS -e',
    };
  }
  return {
    summary: 'Codex needs it to install and run. Installs nvm in your home folder, then the LTS version, with no administrator rights.',
    tags: [{ text: 'Downloads and runs the nvm install script' }, pathTag(platform)],
    manual: 'nvm install --lts',
  };
}

function npmFacts(platform: string): StepFacts {
  return {
    summary: 'Installs global packages in your user folder, so they need no administrator rights.',
    tags: [{ text: 'Changes npm settings' }, pathTag(platform)],
    manual: platform === 'win32'
      ? 'npm config set prefix "%USERPROFILE%\\.npm-global" --location=user'
      : 'npm config set prefix "$HOME/.npm-global" --location=user',
  };
}

function nativeFacts(provider: string, step: SetupStep<string>, platform: string): StepFacts {
  // The state Install-ClaudeCode calls changes_required: an old npm shim hides the native CLI.
  if (provider === 'claude' && step.planned.includes('remove_legacy_npm_claude_shim') && !step.planned.includes('install_claude_code_native')) {
    return {
      summary: 'An old npm version of Claude Code hides the native one. This script removes it with npm uninstall -g.',
      tags: [{ text: 'Removes the npm version of Claude Code', danger: true }],
      manual: 'npm uninstall -g @anthropic-ai/claude-code',
    };
  }
  const known = NATIVE[provider];
  if (!known) return { summary: 'Installs this provider.', tags: [], manual: null };
  const url = `https://${known.script}.${platform === 'win32' ? 'ps1' : 'sh'}`;
  const tags: StepTag[] = [{ text: 'Downloads and runs {script}', values: { script: `${known.script}.${platform === 'win32' ? 'ps1' : 'sh'}` } }, pathTag(platform)];
  if (provider === 'claude' && platform === 'win32') tags.push({ text: "May use winget and accept its agreements" });
  if (step.planned.includes('remove_legacy_npm_claude_shim')) tags.push({ text: 'Removes the npm version of Claude Code', danger: true });
  return {
    summary: "Downloads and runs {vendor}'s install script, into your user folder.",
    summaryValues: { vendor: known.vendor },
    tags,
    manual: platform === 'win32' ? `irm ${url} | iex` : `curl -fsSL ${url} | bash`,
  };
}

/** A row's provider: a bot's chain calls it `provider`, and the Agent CLIs tab (SPEC-012) by its id. */
const providerOf = (step: SetupStep<string>, provider: string): string => (step.id === 'provider' ? provider : step.id);

export function stepFacts(step: SetupStep<string>, provider: string, platform: string): StepFacts {
  switch (step.id) {
    case 'node': return nodeFacts(platform);
    case 'npm': return npmFacts(platform);
    case 'shell':
      return {
        summary: 'Lets you run codex and npm in PowerShell. Cats Bot works without it; sign-in then opens in Command Prompt.',
        tags: [{ text: 'Changes your PowerShell execution policy' }],
        manual: 'Set-ExecutionPolicy -Scope CurrentUser RemoteSigned',
      };
    default:
      return providerOf(step, provider) === 'codex'
        ? { summary: 'Installs @openai/codex globally with npm.', tags: [{ text: 'Downloads from npm' }], manual: 'npm install -g @openai/codex' }
        : nativeFacts(providerOf(step, provider), step, platform);
  }
}

/**
 * SPEC-012 FR-8: what an update does. No helper can say read-only whether a newer release
 * exists, so the row offers the update and says that, when it is already the newest,
 * nothing changes.
 */
export const UPDATE_SUMMARY = 'Installs the newest release if there is one. If this is already the newest, nothing changes.';

export function updateFacts(step: SetupStep<string>, provider: string, platform: string): StepFacts {
  if (step.id === 'node') {
    return platform === 'win32'
      ? {
          summary: UPDATE_SUMMARY,
          tags: [{ text: 'Needs administrator rights' }, { text: 'Downloads and installs' }, { text: "Accepts winget's agreements for you" }],
          manual: 'winget upgrade --id OpenJS.NodeJS.LTS -e',
        }
      : { summary: UPDATE_SUMMARY, tags: [{ text: 'Downloads and installs' }], manual: 'nvm install --lts' };
  }
  const id = providerOf(step, provider);
  if (id === 'codex') {
    return {
      summary: UPDATE_SUMMARY,
      tags: [{ text: 'Downloads from npm' }, { text: 'Also updates npm to its newest release' }],
      manual: 'npm install -g @openai/codex@latest',
    };
  }
  const install = nativeFacts(id, { ...step, planned: [] }, platform);
  return { summary: UPDATE_SUMMARY, tags: install.tags, manual: install.manual };
}
