/**
 * Environment knobs every host honours (the CLI and the Electron shell):
 * which bot to open and, for development without a real provider CLI, which
 * command and discovery directory stand in for the provider. Production
 * ignores the overrides because the variables are unset.
 */

export interface ProviderOverrides {
  providerCommand?: string;
  providerLaunchArgs?: string[];
  instanceExtras?: Record<string, string>;
}

export function readProviderOverrides(env: NodeJS.ProcessEnv = process.env): ProviderOverrides {
  const command = env.CATS_BOT_PROVIDER_COMMAND?.trim();
  const launchArgs = env.CATS_BOT_PROVIDER_LAUNCH_ARGS?.trim();
  const projectsDir = env.CATS_BOT_PROVIDER_PROJECTS_DIR?.trim();
  return {
    ...(command ? { providerCommand: command } : {}),
    ...(launchArgs ? { providerLaunchArgs: launchArgs.split('\n').map((arg) => arg.trim()).filter(Boolean) } : {}),
    ...(projectsDir ? { instanceExtras: { projects_dir: projectsDir } } : {}),
  };
}

export function readBotIdFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const id = env.CATS_BOT_ID?.trim();
  return id || undefined;
}
