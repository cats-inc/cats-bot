import { isBotDataResetRequest, type BotDataResetRequest } from '../../shared/dataReset.ts';

/** Keep Electron/profile flags, but a reset always returns to interactive setup. */
export function dataResetRelaunchArgs(args: string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (/^--(?:id|provider|model|name)=/u.test(arg)) continue;
    if (['--id', '--provider', '--model', '--name'].includes(arg)) { index += 1; continue; }
    result.push(arg);
  }
  return result;
}

/** The only reset entry is the Hub Settings main frame. No bot/tool/CLI entry. */
export function createDataResetHandler<Event>(options: {
  owns(event: Event): boolean;
  busy(): boolean;
  drain(): Promise<void>;
  prepare(request: BotDataResetRequest): void;
  restart(): void;
  recover(): void;
}): (event: Event, request: unknown) => Promise<null> {
  let running = false;
  return async (event, request) => {
    if (!options.owns(event)) throw new Error('Data can be reset only from Cats Bot Settings.');
    if (!isBotDataResetRequest(request)) throw new Error('Type RESET to confirm the selected data reset.');
    if (running || options.busy()) throw new Error('Finish the current setup or update before resetting data.');
    running = true;
    try {
      await options.drain();
      options.prepare(request);
    } catch (error) {
      running = false;
      options.recover();
      throw error;
    }
    // Once consent is durable, a failure to launch still requires startup to
    // finish that reset. Never return the current process to normal writes.
    options.restart();
    return null;
  };
}
