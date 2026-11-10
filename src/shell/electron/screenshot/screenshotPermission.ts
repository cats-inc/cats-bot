import type {
  DesktopScreenshotCaptureResult,
} from '../../../shared/screenshot/contracts.ts';

export type DesktopScreenshotMediaAccessStatus =
  | 'not-determined'
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'unknown';

const MACOS_SCREEN_RECORDING_PERMISSION_MESSAGE =
  'Screen Recording permission is required to capture a screenshot. Turn on Cats Bot in System Settings > Privacy & Security > Screen & System Audio Recording (add it with + if it is not listed), then restart Cats Bot.';

export function resolveDesktopScreenshotPermissionResult(input: {
  platform: NodeJS.Platform;
  mediaAccessStatus: DesktopScreenshotMediaAccessStatus;
}): DesktopScreenshotCaptureResult | null {
  if (input.platform !== 'darwin') {
    return null;
  }

  if (input.mediaAccessStatus === 'granted') {
    return null;
  }

  if (
    input.mediaAccessStatus === 'not-determined'
    || input.mediaAccessStatus === 'denied'
    || input.mediaAccessStatus === 'restricted'
  ) {
    return {
      outcome: 'permission_denied',
      message: MACOS_SCREEN_RECORDING_PERMISSION_MESSAGE,
    };
  }

  return {
    outcome: 'error',
    message: `Screen Recording permission status is unknown: ${input.mediaAccessStatus}`,
  };
}
