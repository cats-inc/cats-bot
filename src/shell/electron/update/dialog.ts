import type { BotUpdateState } from '../../../shared/shellUpdate.ts';
import { translate, type Locale } from '../../../shared/language.ts';
import type { BotUpdateController } from './controller.ts';

// Adapted from cats-platform desktop/host/updateDialog.ts at 07a02f3a (MIT).
export interface UpdateDialog {
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  action: 'none' | 'update' | 'install' | 'release';
}
export function updateDialog(state: BotUpdateState, locale: Locale): UpdateDialog {
  const t = (message: string, values?: Record<string, unknown>) =>
    translate(locale, message, values);
  const result: UpdateDialog = {
    title: t('Check for Updates'),
    message: '',
    detail: t('You are running Cats Bot {version}.', { version: state.currentVersion }),
    buttons: [t('OK')],
    action: 'none',
  };
  const installDetail = t(
    'Cats Bot will download the update, stop this bot and install it. The current task will be interrupted. Quit other Cats Bot instances first.',
  );
  switch (state.phase) {
    case 'available':
      return {
        ...result,
        title: t('Update available'),
        message: t('Cats Bot {version} is available.', { version: state.version }),
        detail: state.canInstall ? installDetail : result.detail,
        buttons: [t(state.canInstall ? 'Update and Restart' : 'View release'), t('Later')],
        action: state.canInstall ? 'update' : 'release',
      };
    case 'downloaded':
      return {
        ...result,
        title: t('Update ready to install'),
        message: t('The update is downloaded and ready to install.'),
        detail: installDetail,
        buttons: [t('Install and Restart'), t('Later')],
        action: 'install',
      };
    case 'current':
      result.message = t('Cats Bot {version} is up to date.', { version: state.currentVersion });
      break;
    case 'checking':
      result.message = t('Checking for updates…');
      break;
    case 'downloading':
      result.message = t('Downloading update… {percent}%', {
        percent: Math.round(state.percent ?? 0),
      });
      break;
    case 'installing':
      result.message = t('Installing update…');
      break;
    case 'error':
      result.title = t('Update failed');
      result.message = state.error ?? result.title;
      break;
    case 'idle':
      result.message = t('Checking for updates…');
      break;
    default:
      result.title = t('Updates are unavailable');
      result.message = t(state.reason ?? 'Updates are unavailable');
  }
  return result;
}

/** One explicit tray click owns the dialog sequence; repeated clicks join it. */
export class TrayUpdateDialog {
  private active: Promise<void> | null = null;
  constructor(privateOptions: {
    controller: BotUpdateController;
    locale(): Locale;
    stopping(): boolean;
    show(dialog: UpdateDialog): Promise<number>;
  }) {
    this.options = privateOptions;
  }
  private readonly options: {
    controller: BotUpdateController;
    locale(): Locale;
    stopping(): boolean;
    show(dialog: UpdateDialog): Promise<number>;
  };
  open(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.run().finally(() => {
      this.active = null;
    });
    return this.active;
  }
  private async run(): Promise<void> {
    const { controller, stopping, show, locale } = this.options;
    let state = controller.snapshot();
    if (state.canCheck && ['idle', 'current', 'available', 'error'].includes(state.phase))
      state = await controller.check();
    if (stopping()) return;
    const spec = updateDialog(state, locale());
    if ((await show(spec)) !== 0 || stopping()) return;
    if (spec.action === 'none') return;
    if (spec.action === 'release') {
      await controller.openRelease();
      return;
    }
    if (spec.action === 'update') state = await controller.download();
    if (stopping()) return;
    if (state.phase === 'downloaded') state = await controller.install();
    if (!stopping() && state.phase === 'error') await show(updateDialog(state, locale()));
  }
}
