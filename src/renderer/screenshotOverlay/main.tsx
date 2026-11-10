/**
 * SPEC-003 FR-9: one display's region-screenshot overlay, ported from Cats
 * Desktop (`desktop/overlay/main.tsx` at cats-platform 6a2a1b02): the frozen
 * picture of the display, a drag to select, Escape to cancel.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactDOM from 'react-dom/client';

import type {
  DesktopScreenshotOverlaySnapshotPayload,
} from '../../shared/screenshot/screenshotOverlayTypes.ts';
import type {
  DesktopScreenshotOverlayBridge,
} from '../../shared/screenshot/screenshotOverlayIpc.ts';
import type {
  DesktopScreenshotOverlaySelectionState,
} from '../../shared/screenshot/screenshotOverlaySelection.ts';
import {
  beginScreenshotOverlayDrag,
  cancelScreenshotOverlaySelection,
  completeScreenshotOverlaySelection,
  createIdleScreenshotOverlaySelection,
  updateScreenshotOverlayDrag,
} from '../../shared/screenshot/screenshotOverlaySelection.ts';
import {
  mapCssSelectionToPhysicalCropRect,
  normalizeDesktopScreenshotCssRect,
  type DesktopScreenshotCssRect,
} from '../../shared/screenshot/screenshotGeometry.ts';
import './styles.css';

declare global {
  interface Window {
    catsScreenshotOverlay?: DesktopScreenshotOverlayBridge;
  }
}

function toGlobalPoint(
  event: Pick<PointerEvent, 'clientX' | 'clientY'>,
  payload: DesktopScreenshotOverlaySnapshotPayload,
) {
  return {
    x: payload.bounds.x + event.clientX,
    y: payload.bounds.y + event.clientY,
  };
}

interface ScreenshotOverlayClientPoint {
  clientX: number;
  clientY: number;
}

function toClientPoint(
  event: Pick<PointerEvent, 'clientX' | 'clientY'>,
): ScreenshotOverlayClientPoint {
  return {
    clientX: event.clientX,
    clientY: event.clientY,
  };
}

function clientPointToGlobalPoint(
  point: ScreenshotOverlayClientPoint,
  payload: DesktopScreenshotOverlaySnapshotPayload,
) {
  return {
    x: payload.bounds.x + point.clientX,
    y: payload.bounds.y + point.clientY,
  };
}

function resolveSelectionRect(
  state: DesktopScreenshotOverlaySelectionState,
  payload: DesktopScreenshotOverlaySnapshotPayload,
) {
  if (state.phase === 'dragging') {
    const cssRect = normalizeDesktopScreenshotCssRect(state.anchor, state.current);
    return {
      cssRect,
      cropRect: mapCssSelectionToPhysicalCropRect(cssRect, {
        bounds: payload.bounds,
        imageSize: payload.imageSize,
        scaleFactor: payload.scaleFactor,
      }),
    };
  }

  if (state.phase === 'selected') {
    return {
      cssRect: state.cssRect,
      cropRect: state.cropRect,
    };
  }

  return null;
}

function relativeRectStyle(
  cssRect: DesktopScreenshotCssRect,
  payload: DesktopScreenshotOverlaySnapshotPayload,
): React.CSSProperties {
  return {
    left: cssRect.x - payload.bounds.x,
    top: cssRect.y - payload.bounds.y,
    width: cssRect.width,
    height: cssRect.height,
  };
}

interface PendingScreenshotOverlayDrag {
  anchor: ScreenshotOverlayClientPoint;
  current: ScreenshotOverlayClientPoint;
  released: ScreenshotOverlayClientPoint | null;
}

function pendingDragToSelection(
  pending: PendingScreenshotOverlayDrag,
  payload: DesktopScreenshotOverlaySnapshotPayload,
): DesktopScreenshotOverlaySelectionState {
  return updateScreenshotOverlayDrag(
    beginScreenshotOverlayDrag(clientPointToGlobalPoint(pending.anchor, payload)),
    clientPointToGlobalPoint(pending.current, payload),
  );
}

function completePendingDragSelection(
  pending: PendingScreenshotOverlayDrag,
  releasePoint: ScreenshotOverlayClientPoint,
  payload: DesktopScreenshotOverlaySnapshotPayload,
): DesktopScreenshotOverlaySelectionState {
  return completeScreenshotOverlaySelection(
    beginScreenshotOverlayDrag(clientPointToGlobalPoint(pending.anchor, payload)),
    clientPointToGlobalPoint(releasePoint, payload),
    {
      bounds: payload.bounds,
      imageSize: payload.imageSize,
      scaleFactor: payload.scaleFactor,
    },
  );
}

function submitScreenshotOverlaySelection(
  bridge: DesktopScreenshotOverlayBridge | undefined,
  payload: DesktopScreenshotOverlaySnapshotPayload,
  nextSelection: DesktopScreenshotOverlaySelectionState,
): void {
  if (nextSelection.phase === 'selected') {
    void bridge?.completeSelection({
      displayId: payload.displayId,
      cssRect: nextSelection.cssRect,
      cropRect: nextSelection.cropRect,
    });
    return;
  }
  if (nextSelection.phase === 'cancelled') {
    void bridge?.cancel(nextSelection.reason);
  }
}

function shouldRetryAfterBufferedTinySelection(
  selection: DesktopScreenshotOverlaySelectionState,
): boolean {
  return selection.phase === 'cancelled' && selection.reason === 'too_small';
}

function ScreenshotOverlay() {
  const [payload, setPayload] = useState<DesktopScreenshotOverlaySnapshotPayload | null>(null);
  const [selection, setSelection] = useState<DesktopScreenshotOverlaySelectionState>(
    createIdleScreenshotOverlaySelection(),
  );
  // Buffer a drag that starts before the snapshot payload has arrived so the
  // user's first drag is replayed, even if they release before the PNG paints.
  const pendingDragRef = useRef<PendingScreenshotOverlayDrag | null>(null);
  const selectionRef = useRef<DesktopScreenshotOverlaySelectionState>(selection);
  const bridge = window.catsScreenshotOverlay;
  const displayId = useMemo(() => {
    const rawDisplayId = new URLSearchParams(window.location.search).get('displayId');
    const parsed = Number.parseInt(rawDisplayId ?? '', 10);
    return Number.isFinite(parsed) ? parsed : null;
  }, []);
  const applySelection = (nextSelection: DesktopScreenshotOverlaySelectionState): void => {
    selectionRef.current = nextSelection;
    setSelection(nextSelection);
  };

  useEffect(() => {
    let cancelled = false;
    if (displayId === null) {
      return () => {
        cancelled = true;
      };
    }
    void bridge?.getSnapshot(displayId).then((nextPayload) => {
      if (!cancelled) {
        setPayload(nextPayload);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [bridge, displayId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        pendingDragRef.current = null;
        applySelection(cancelScreenshotOverlaySelection('escape'));
        void bridge?.cancel('escape');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [bridge]);

  // Promote any buffered pre-payload drag once the snapshot is available, then
  // clear the ref so normal pointermove/up paths own the active drag.
  useEffect(() => {
    if (!payload) {
      return;
    }
    const pending = pendingDragRef.current;
    if (!pending) {
      return;
    }
    if (pending.released) {
      pendingDragRef.current = null;
      const nextSelection = completePendingDragSelection(pending, pending.released, payload);
      if (shouldRetryAfterBufferedTinySelection(nextSelection)) {
        applySelection(createIdleScreenshotOverlaySelection());
        return;
      }
      applySelection(nextSelection);
      submitScreenshotOverlaySelection(bridge, payload, nextSelection);
      return;
    }
    pendingDragRef.current = null;
    applySelection(pendingDragToSelection(pending, payload));
  }, [bridge, payload]);

  const activeSelection = useMemo(
    () => payload ? resolveSelectionRect(selection, payload) : null,
    [payload, selection],
  );
  // Hold the multi-MB data URL string outside the per-render inline style so
  // pointermove re-renders don't rebuild and re-diff it on every drag tick.
  const overlayBackgroundStyle = useMemo<React.CSSProperties | undefined>(() => {
    if (!payload) {
      return undefined;
    }
    return {
      backgroundImage: `url("${payload.imageDataUrl}")`,
      backgroundSize: `${payload.bounds.width}px ${payload.bounds.height}px`,
    };
  }, [payload]);

  return (
    <div
      className="screenshotOverlay"
      style={overlayBackgroundStyle}
      onContextMenu={(event) => {
        event.preventDefault();
        pendingDragRef.current = null;
        if (payload) {
          applySelection(cancelScreenshotOverlaySelection('right_click'));
        }
        void bridge?.cancel('right_click');
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) {
          pendingDragRef.current = null;
          if (payload) {
            applySelection(cancelScreenshotOverlaySelection('right_click'));
          }
          void bridge?.cancel('right_click');
          return;
        }
        event.currentTarget.setPointerCapture(event.pointerId);
        if (!payload) {
          const anchor = toClientPoint(event.nativeEvent);
          pendingDragRef.current = { anchor, current: { ...anchor }, released: null };
          return;
        }
        pendingDragRef.current = null;
        applySelection(beginScreenshotOverlayDrag(toGlobalPoint(event.nativeEvent, payload)));
      }}
      onPointerMove={(event) => {
        const pending = pendingDragRef.current;
        if (pending) {
          pending.current = toClientPoint(event.nativeEvent);
          if (payload) {
            applySelection(pendingDragToSelection(pending, payload));
          }
          return;
        }
        if (!payload) {
          return;
        }
        applySelection(updateScreenshotOverlayDrag(
          selectionRef.current,
          toGlobalPoint(event.nativeEvent, payload),
        ));
      }}
      onPointerUp={(event) => {
        const pending = pendingDragRef.current;
        if (pending) {
          const releasePoint = toClientPoint(event.nativeEvent);
          pending.released = releasePoint;
          if (!payload) {
            return;
          }
          pendingDragRef.current = null;
          const nextSelection = completePendingDragSelection(pending, releasePoint, payload);
          if (shouldRetryAfterBufferedTinySelection(nextSelection)) {
            applySelection(createIdleScreenshotOverlaySelection());
            return;
          }
          applySelection(nextSelection);
          submitScreenshotOverlaySelection(bridge, payload, nextSelection);
          return;
        }
        if (!payload) {
          return;
        }
        const nextSelection = completeScreenshotOverlaySelection(
          selectionRef.current,
          toGlobalPoint(event.nativeEvent, payload),
          {
            bounds: payload.bounds,
            imageSize: payload.imageSize,
            scaleFactor: payload.scaleFactor,
          },
        );
        applySelection(nextSelection);
        submitScreenshotOverlaySelection(bridge, payload, nextSelection);
      }}
      onPointerCancel={() => {
        // Pointer cancellation aborts only the active gesture. Keep the
        // overlay session open so users can start a fresh drag.
        pendingDragRef.current = null;
        applySelection(createIdleScreenshotOverlaySelection());
      }}
    >
      {payload && activeSelection ? (
        <>
          <div
            className="screenshotSelectionRect"
            style={relativeRectStyle(activeSelection.cssRect, payload)}
          />
          <div
            className="screenshotSelectionSize"
            style={{
              left: activeSelection.cssRect.x - payload.bounds.x + activeSelection.cssRect.width,
              top: activeSelection.cssRect.y - payload.bounds.y + activeSelection.cssRect.height,
            }}
          >
            {`${activeSelection.cropRect.width}x${activeSelection.cropRect.height}`}
          </div>
        </>
      ) : null}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ScreenshotOverlay />
  </React.StrictMode>,
);
