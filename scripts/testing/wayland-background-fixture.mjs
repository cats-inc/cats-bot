// Started by bot-interaction-acceptance.mjs: a maximized native Wayland window
// behind the avatar, reporting each pointer press on stdout. An X11 window would
// not do, because the X server routes between its own windows by itself.
import { app, BrowserWindow } from 'electron';

const MAX_LIFETIME_MS = 180_000;
const page = '<body style="margin:0;background:#add8e6;width:100vw;height:100vh"><script>'
  + 'addEventListener("pointerdown",e=>console.log("fixture-click",e.screenX,e.screenY));</script></body>';

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const window = new BrowserWindow({ frame: false, backgroundColor: '#add8e6', title: 'Avatar background fixture', webPreferences: { sandbox: true } });
  window.webContents.on('console-message', (event) => {
    if (String(event.message).startsWith('fixture-click')) console.log(event.message);
  });
  await window.loadURL(`data:text/html,${encodeURIComponent(page)}`);
  window.maximize();
  console.log('fixture-ready');
  setTimeout(() => app.exit(0), MAX_LIFETIME_MS);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
