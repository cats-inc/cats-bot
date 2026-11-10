import { Socket } from 'node:net';

/**
 * Node 24.21 and 24.22 bundle an undici that sets every HTTP/1 socket's type of service before
 * writing a request and lets the error escape. On macOS a socket whose peer has just gone (the
 * runtime restarting) fails that with `setTypeOfService EINVAL`, thrown from a socket event
 * handler, so it is uncaught and ends the process. Node 26's undici ignores the error; this does
 * the same, so the request then fails like any other lost connection. The headless core runs on
 * the system's Node (Electron 41's Node has no such call; there `setTypeOfService` is absent).
 */
const GUARDED = Symbol.for('cats-bot.setTypeOfService.guarded');

interface TypeOfServiceTarget {
  setTypeOfService?: (this: unknown, typeOfService: number) => unknown;
  [GUARDED]?: true;
}

/** Wraps `target.setTypeOfService` so a failure is ignored; once, and only where the method exists. */
export function ignoreTypeOfServiceErrors(target: TypeOfServiceTarget = Socket.prototype as unknown as TypeOfServiceTarget): void {
  const original = target.setTypeOfService;
  if (typeof original !== 'function' || target[GUARDED]) return;
  target.setTypeOfService = function setTypeOfService(this: unknown, typeOfService: number) {
    try {
      return original.call(this, typeOfService);
    } catch {
      return this;
    }
  };
  target[GUARDED] = true;
}
