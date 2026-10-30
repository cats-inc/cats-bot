import type { BrowserWindow } from 'electron';

/**
 * SPEC-008 FR-17: on Windows each window of a bot carries the AUMID
 * `io.catsinc.catsbot.<botId>`, so the taskbar groups a bot's windows apart
 * from another bot's. In a packaged build a window pinned to the taskbar
 * relaunches the hub on that bot.
 */
export interface WindowIdentity {
  appId: string;
  relaunch?: { command: string; displayName: string; icon: string };
}

export function botWindowIdentity(options: {
  appId: string;
  botId: string;
  botName: string;
  executable: string;
  packaged: boolean;
}): WindowIdentity {
  return {
    appId: `${options.appId}.${options.botId}`,
    ...(options.packaged
      ? { relaunch: { command: `"${options.executable}" --id ${options.botId}`, displayName: `Cats Bot - ${options.botName}`, icon: options.executable } }
      : {}),
  };
}

export function applyWindowIdentity(window: BrowserWindow, identity: WindowIdentity | undefined, platform = process.platform): void {
  if (platform !== 'win32' || !identity) return;
  window.setAppDetails({
    appId: identity.appId,
    ...(identity.relaunch
      ? { relaunchCommand: identity.relaunch.command, relaunchDisplayName: identity.relaunch.displayName, appIconPath: identity.relaunch.icon }
      : {}),
  });
}
