import type { BrowserWindow } from './note-windows-electron.ts';

export { BrowserWindow, shell } from './note-windows-electron.ts';

type Handler = (event: unknown, ...args: unknown[]) => unknown;
export const ipcMain = {
  handlers: new Map<string, Handler>(),
  handle(channel: string, handler: Handler): void {
    this.handlers.set(channel, handler);
  },
  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  },
  async invoke(window: BrowserWindow, channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`Missing handler: ${channel}`);
    return handler({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, ...args);
  },
};
