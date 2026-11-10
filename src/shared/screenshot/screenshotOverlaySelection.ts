import type {
  DesktopScreenshotCssPoint,
  DesktopScreenshotCssRect,
  DesktopScreenshotDisplayGeometry,
  DesktopScreenshotPhysicalRect,
} from './screenshotGeometry.ts';
import {
  isPhysicalCropRectLargeEnough,
  mapCssSelectionToPhysicalCropRect,
  normalizeDesktopScreenshotCssRect,
} from './screenshotGeometry.ts';

export type DesktopScreenshotOverlaySelectionState =
  | {
      phase: 'idle';
    }
  | {
      phase: 'dragging';
      anchor: DesktopScreenshotCssPoint;
      current: DesktopScreenshotCssPoint;
    }
  | {
      phase: 'cancelled';
      reason: 'escape' | 'right_click' | 'too_small' | 'no_drag';
    }
  | {
      phase: 'selected';
      cssRect: DesktopScreenshotCssRect;
      cropRect: DesktopScreenshotPhysicalRect;
    };

export function createIdleScreenshotOverlaySelection(): DesktopScreenshotOverlaySelectionState {
  return { phase: 'idle' };
}

export function beginScreenshotOverlayDrag(
  point: DesktopScreenshotCssPoint,
): DesktopScreenshotOverlaySelectionState {
  return {
    phase: 'dragging',
    anchor: point,
    current: point,
  };
}

export function updateScreenshotOverlayDrag(
  state: DesktopScreenshotOverlaySelectionState,
  point: DesktopScreenshotCssPoint,
): DesktopScreenshotOverlaySelectionState {
  if (state.phase !== 'dragging') {
    return state;
  }

  return {
    ...state,
    current: point,
  };
}

export function cancelScreenshotOverlaySelection(
  reason: Extract<
    DesktopScreenshotOverlaySelectionState,
    { phase: 'cancelled' }
  >['reason'],
): DesktopScreenshotOverlaySelectionState {
  return {
    phase: 'cancelled',
    reason,
  };
}

export function completeScreenshotOverlaySelection(
  state: DesktopScreenshotOverlaySelectionState,
  point: DesktopScreenshotCssPoint,
  display: DesktopScreenshotDisplayGeometry,
): DesktopScreenshotOverlaySelectionState {
  if (state.phase !== 'dragging') {
    return cancelScreenshotOverlaySelection('no_drag');
  }

  const cssRect = normalizeDesktopScreenshotCssRect(state.anchor, point);
  const cropRect = mapCssSelectionToPhysicalCropRect(cssRect, display);
  if (!isPhysicalCropRectLargeEnough(cropRect)) {
    return cancelScreenshotOverlaySelection('too_small');
  }

  return {
    phase: 'selected',
    cssRect,
    cropRect,
  };
}
