// SPEC-003 FR-9: the bridge of a region-screenshot overlay window, one per
// display, ported from Cats Desktop (`desktop/host/screenshotOverlayPreload.cts`
// at cats-platform 6a2a1b02). The overlay reads its display's frozen picture
// and reports the owner's selection or cancellation; nothing else. Plain
// CommonJS on purpose: sandboxed preload scripts cannot be ES modules.
const { contextBridge, ipcRenderer } = require('electron');

const GET_SNAPSHOT = 'cats-host:screenshot-overlay:get-snapshot';
const COMPLETE = 'cats-host:screenshot-overlay:complete-selection';
const CANCEL = 'cats-host:screenshot-overlay:cancel';

function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid screenshot overlay ${label}: ${String(value)}`);
  return value;
}

function rect(value, label) {
  if (typeof value !== 'object' || value === null) throw new Error(`Invalid screenshot overlay ${label} rect.`);
  return {
    x: finite(value.x, `${label}.x`),
    y: finite(value.y, `${label}.y`),
    width: finite(value.width, `${label}.width`),
    height: finite(value.height, `${label}.height`),
  };
}

contextBridge.exposeInMainWorld('catsScreenshotOverlay', {
  getSnapshot(displayId) {
    return ipcRenderer.invoke(GET_SNAPSHOT, finite(displayId, 'displayId'));
  },
  async completeSelection(result) {
    if (typeof result !== 'object' || result === null) throw new Error('Invalid screenshot overlay selection result.');
    await ipcRenderer.invoke(COMPLETE, {
      displayId: finite(result.displayId, 'displayId'),
      cssRect: rect(result.cssRect, 'cssRect'),
      cropRect: rect(result.cropRect, 'cropRect'),
    });
  },
  async cancel(reason) {
    if (typeof reason !== 'string' || reason.trim().length === 0) throw new Error('Invalid screenshot overlay cancellation reason.');
    await ipcRenderer.invoke(CANCEL, reason);
  },
});
