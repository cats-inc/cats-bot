interface CommandLine { getSwitchValue(name: string): string; }

/** The backend is initialized before main JS; changing commandLine is too late. */
export function linuxWindowingRelaunchArgs(commandLine: CommandLine, platform = process.platform, env = process.env, argv = process.argv): string[] | null {
  if (platform !== 'linux' || !env.DISPLAY) return null;
  const requested = commandLine.getSwitchValue('ozone-platform');
  if (requested === 'x11') return null;
  if (argv.some(arg => arg === '--ozone-platform' || arg.startsWith('--ozone-platform=')) && requested !== 'auto') return null;
  if (requested !== 'wayland' && requested !== 'auto' && env.XDG_SESSION_TYPE !== 'wayland') return null;
  const args: string[] = [];
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '--ozone-platform') { index++; continue; }
    if (!arg.startsWith('--ozone-platform=')) args.push(arg);
  }
  return [...args, '--ozone-platform=x11'];
}

export function relaunchForLinuxWindowing(app: { commandLine: CommandLine; relaunch(options: { args: string[] }): void; exit(code: number): void }): boolean {
  const args = linuxWindowingRelaunchArgs(app.commandLine);
  if (!args) return false;
  app.relaunch({ args });
  app.exit(0);
  return true;
}
