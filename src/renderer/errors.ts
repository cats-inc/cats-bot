/** An error from a bridge call as the owner should read it. */
export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Electron prefixes errors thrown in the main process.
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/u, '');
}
