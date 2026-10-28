import type { IpcMainInvokeEvent } from 'electron';
import type { BotUpdateAction } from '../../../shared/shellUpdate.ts';
import type { BotUpdateController } from './controller.ts';

export function isUpdateSender(event: IpcMainInvokeEvent, owns: (id: number) => boolean): boolean {
  return owns(event.sender.id) && event.senderFrame === event.sender.mainFrame;
}
export async function updateAction(controller: BotUpdateController, action: unknown, confirmInstall: () => Promise<boolean>) {
  if (!['check', 'download', 'install', 'release'].includes(action as string)) throw new Error('Unknown update action.');
  switch (action as BotUpdateAction) {
    case 'check': return controller.check();
    case 'download': return controller.download();
    case 'install':
      if (controller.snapshot().phase !== 'downloaded' || !await confirmInstall()) return controller.snapshot();
      return controller.install();
    case 'release': await controller.openRelease(); return controller.snapshot();
  }
}
