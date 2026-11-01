import type {
  BaseWindowConstructorOptions,
  MessageBoxOptions,
  MessageBoxReturnValue,
} from 'electron';
// Adapted from cats-platform desktop/host/updateDialogPresenter.ts at 21bb92b2 (MIT).
import type { UpdateDialog as DesktopUpdateDialog } from './dialog.ts';

/** How long macOS gets to make Cats Bot active before the alert opens regardless. */
export const DESKTOP_UPDATE_DIALOG_ACTIVATION_TIMEOUT_MS = 1_000;

interface DesktopUpdateDialogActivationWindow {
  show(): void;
  focus(): void;
  once(event: 'focus', listener: () => void): unknown;
  removeListener(event: 'focus', listener: () => void): unknown;
  isDestroyed(): boolean;
  destroy(): void;
}

/** Presents an explicitly requested tray result without revealing any bot window. */
export async function showDesktopUpdateMessageBox<
  TWindow extends DesktopUpdateDialogActivationWindow,
>(input: {
  platform: NodeJS.Platform | string;
  dialogSpec: DesktopUpdateDialog;
  createActivationWindow: (options: BaseWindowConstructorOptions) => TWindow;
  focusApp: () => void;
  isShuttingDown: () => boolean;
  showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>;
  activationTimeoutMs?: number;
}): Promise<number> {
  const { dialogSpec } = input;
  const cancelId = dialogSpec.buttons.length - 1;
  const options: MessageBoxOptions = {
    type: dialogSpec.action === 'none' ? 'info' : 'question',
    title: dialogSpec.title,
    message: dialogSpec.message,
    detail: dialogSpec.detail,
    buttons: dialogSpec.buttons,
    defaultId: 0,
    cancelId,
    noLink: true,
  };

  if (input.platform === 'darwin') {
    await activateThroughTransientWindow(input);
  } else {
    input.focusApp();
  }
  // The caller checked before calling, but quitting can begin while macOS
  // activates Cats Bot. Answer with the dismissal rather than open the alert
  // over a hub that is shutting down.
  if (input.isShuttingDown()) {
    return cancelId;
  }
  return (await input.showMessageBox(options)).response;
}

/**
 * macOS brings an app forward only through a window that becomes key. With
 * every bot window hidden or unfocused, `app.focus()` alone leaves Cats Bot
 * inactive and its alert opens behind the frontmost app. A transparent 1x1
 * window is made key just long enough to activate Cats Bot and is destroyed
 * before the standard alert opens, so macOS places the alert itself and no
 * window stays behind it. Attaching the alert to that window as a sheet would
 * hang it from the window's top edge, below the middle of the screen. If
 * activation never arrives, the alert opens after the timeout anyway: possibly
 * behind the frontmost app.
 */
async function activateThroughTransientWindow<
  TWindow extends DesktopUpdateDialogActivationWindow,
>(input: {
  createActivationWindow: (options: BaseWindowConstructorOptions) => TWindow;
  focusApp: () => void;
  activationTimeoutMs?: number;
}): Promise<void> {
  const window = input.createActivationWindow({
    width: 1,
    height: 1,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    fullscreenable: false,
    skipTaskbar: true,
  });
  let settle = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const focused = new Promise<void>((resolve) => {
      settle = resolve;
    });
    // The window's focus event fires once Cats Bot is active, including when
    // it already was, so it is the signal for both cases.
    window.once('focus', settle);
    timer = setTimeout(
      settle,
      input.activationTimeoutMs ?? DESKTOP_UPDATE_DIALOG_ACTIVATION_TIMEOUT_MS,
    );
    window.show();
    input.focusApp();
    window.focus();
    await focused;
  } finally {
    clearTimeout(timer);
    if (!window.isDestroyed()) {
      window.removeListener('focus', settle);
      window.destroy();
    }
  }
}
