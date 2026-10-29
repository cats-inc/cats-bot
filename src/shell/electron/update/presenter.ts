import type {
  BaseWindowConstructorOptions,
  MessageBoxOptions,
  MessageBoxReturnValue,
} from 'electron';
// Adapted from cats-platform desktop/host/updateDialogPresenter.ts at 07a02f3a (MIT).
import type { UpdateDialog as DesktopUpdateDialog } from './dialog.ts';

interface DesktopUpdateDialogOwner {
  show(): void;
  focus(): void;
  isDestroyed(): boolean;
  destroy(): void;
}

/** Presents an explicitly requested tray result without revealing the main window. */
export async function showDesktopUpdateMessageBox<TWindow extends DesktopUpdateDialogOwner>(input: {
  platform: NodeJS.Platform | string;
  dialogSpec: DesktopUpdateDialog;
  createOwner: (options: BaseWindowConstructorOptions) => TWindow;
  focusApp: () => void;
  showMessageBox: (options: MessageBoxOptions, owner?: TWindow) => Promise<MessageBoxReturnValue>;
}): Promise<number> {
  const { dialogSpec } = input;
  const options: MessageBoxOptions = {
    type: dialogSpec.action === 'none' ? 'info' : 'question',
    title: dialogSpec.title,
    message: dialogSpec.message,
    detail: dialogSpec.detail,
    buttons: dialogSpec.buttons,
    defaultId: 0,
    cancelId: dialogSpec.buttons.length - 1,
    noLink: true,
  };

  if (input.platform !== 'darwin') {
    input.focusApp();
    return (await input.showMessageBox(options)).response;
  }

  // A parentless NSAlert runs synchronously even through showMessageBox's
  // Promise API. Give it a visible native owner so it is an asynchronous sheet,
  // then activate/focus it after the sheet exists. BaseWindow needs no renderer;
  // its transparent owner is only an anchor and never reveals the main window.
  const owner = input.createOwner({
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
  try {
    owner.show();
    const result = input.showMessageBox(options, owner);
    input.focusApp();
    owner.focus();
    return (await result).response;
  } finally {
    if (!owner.isDestroyed()) owner.destroy();
  }
}
