let lastDesktopScreenshotFilenameSecond = '';
let desktopScreenshotFilenameCounter = 0;

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

export function createDesktopScreenshotFilename(now = new Date()): string {
  const second = [
    now.getFullYear(),
    pad(now.getMonth() + 1, 2),
    pad(now.getDate(), 2),
    '-',
    pad(now.getHours(), 2),
    pad(now.getMinutes(), 2),
    pad(now.getSeconds(), 2),
  ].join('');

  desktopScreenshotFilenameCounter = second === lastDesktopScreenshotFilenameSecond
    ? desktopScreenshotFilenameCounter + 1
    : 1;
  lastDesktopScreenshotFilenameSecond = second;

  return `cats-screenshot-${second}-${pad(desktopScreenshotFilenameCounter, 3)}.png`;
}
