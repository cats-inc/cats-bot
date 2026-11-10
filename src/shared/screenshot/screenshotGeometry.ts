export interface DesktopScreenshotDisplayGeometry {
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  imageSize: {
    width: number;
    height: number;
  };
  scaleFactor: number;
}

export interface DesktopScreenshotCssPoint {
  x: number;
  y: number;
}

export interface DesktopScreenshotCssRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopScreenshotPhysicalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MIN_SCREENSHOT_SELECTION_PHYSICAL_PIXELS = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resolveAxisScale(cssLength: number, imageLength: number, fallbackScale: number): number {
  if (cssLength > 0 && imageLength > 0) {
    return imageLength / cssLength;
  }
  return fallbackScale > 0 ? fallbackScale : 1;
}

export function normalizeDesktopScreenshotCssRect(
  start: DesktopScreenshotCssPoint,
  end: DesktopScreenshotCssPoint,
): DesktopScreenshotCssRect {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return {
    x,
    y,
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

export function mapCssSelectionToPhysicalCropRect(
  selection: DesktopScreenshotCssRect,
  display: DesktopScreenshotDisplayGeometry,
): DesktopScreenshotPhysicalRect {
  const relativeLeft = clamp(
    selection.x - display.bounds.x,
    0,
    display.bounds.width,
  );
  const relativeTop = clamp(
    selection.y - display.bounds.y,
    0,
    display.bounds.height,
  );
  const relativeRight = clamp(
    selection.x + selection.width - display.bounds.x,
    0,
    display.bounds.width,
  );
  const relativeBottom = clamp(
    selection.y + selection.height - display.bounds.y,
    0,
    display.bounds.height,
  );
  const scaleX = resolveAxisScale(
    display.bounds.width,
    display.imageSize.width,
    display.scaleFactor,
  );
  const scaleY = resolveAxisScale(
    display.bounds.height,
    display.imageSize.height,
    display.scaleFactor,
  );
  const left = Math.round(Math.min(relativeLeft, relativeRight) * scaleX);
  const top = Math.round(Math.min(relativeTop, relativeBottom) * scaleY);
  const right = Math.round(Math.max(relativeLeft, relativeRight) * scaleX);
  const bottom = Math.round(Math.max(relativeTop, relativeBottom) * scaleY);

  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

export function isPhysicalCropRectLargeEnough(
  rect: DesktopScreenshotPhysicalRect,
  minPixels = MIN_SCREENSHOT_SELECTION_PHYSICAL_PIXELS,
): boolean {
  return rect.width >= minPixels && rect.height >= minPixels;
}
