import { shell, type WebContents } from 'electron';

import { externalUrl } from './navigationPolicy.ts';

/**
 * SPEC-003 FR-3: a page never opens a window or navigates away (a link in a
 * reply, a dropped file). http(s) targets go to the system browser instead;
 * anything else is dropped.
 */
export function guardNavigation(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    const target = externalUrl(url);
    if (target) void shell.openExternal(target);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    event.preventDefault();
    const target = externalUrl(url);
    if (target) void shell.openExternal(target);
  });
}
