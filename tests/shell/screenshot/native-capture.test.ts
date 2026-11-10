// Ported from Cats Desktop tests/desktop-screenshot-native-capture.test.js (cats-platform 6a2a1b02); SPEC-003 FR-9.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  captureDesktopDisplaySnapshots,
  cropDesktopDisplaySnapshotSelection,
  matchDesktopSourceForDisplay,
  resolveDesktopCaptureThumbnailSize,
} from '../../../src/shell/electron/screenshot/screenshotNativeCapture.ts';

function createImage(width: number, height: number, bytes: number[] | Uint8Array) {
  return {
    getSize() {
      return { width, height };
    },
    toPNG() {
      return new Uint8Array(bytes);
    },
  };
}

test('desktop screenshot native capture plans thumbnail size from physical display pixels', () => {
  assert.deepEqual(
    resolveDesktopCaptureThumbnailSize([
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        scaleFactor: 1,
      },
      {
        id: 2,
        bounds: { x: -1440, y: 0, width: 1440, height: 900 },
        scaleFactor: 2,
      },
    ]),
    { width: 2880, height: 1800 },
  );
});

test('desktop screenshot native capture matches Electron sources by display id', () => {
  const source = {
    id: 'screen:2:0',
    display_id: '2',
    name: 'Display 2',
    thumbnail: createImage(1440, 900, [2]),
  };

  assert.equal(
    matchDesktopSourceForDisplay(
      {
        id: 2,
        bounds: { x: -1440, y: 0, width: 1440, height: 900 },
        scaleFactor: 1,
      },
      [
        {
          id: 'screen:1:0',
          display_id: '1',
          name: 'Display 1',
          thumbnail: createImage(1920, 1080, [1]),
        },
        source,
      ],
    ),
    source,
  );
});

test('desktop screenshot native capture builds per-display PNG snapshots', async () => {
  const calls: any[] = [];
  const snapshots = await captureDesktopDisplaySnapshots({
    getAllDisplays() {
      return [
        {
          id: 1,
          bounds: { x: 0, y: 0, width: 1000, height: 800 },
          scaleFactor: 2,
        },
        {
          id: 2,
          bounds: { x: -1280, y: 0, width: 1280, height: 720 },
          scaleFactor: 1,
        },
      ];
    },
    async getScreenSources(options) {
      calls.push(options);
      return [
        {
          id: 'screen:1:0',
          display_id: '1',
          name: 'Built-in display',
          thumbnail: createImage(2000, 1600, [1, 2, 3]),
        },
        {
          id: 'screen:2:0',
          display_id: '2',
          name: 'Left display',
          thumbnail: createImage(1280, 720, [4, 5, 6]),
        },
      ];
    },
  });

  assert.deepEqual(calls, [
    {
      types: ['screen'],
      thumbnailSize: { width: 2000, height: 1600 },
      fetchWindowIcons: false,
    },
  ]);
  assert.equal(snapshots.length, 2);
  assert.deepEqual(snapshots[0]?.geometry, {
    bounds: { x: 0, y: 0, width: 1000, height: 800 },
    imageSize: { width: 2000, height: 1600 },
    scaleFactor: 2,
  });
  assert.deepEqual(Array.from(snapshots[1]?.png ?? []), [4, 5, 6]);
  assert.equal((snapshots[1] as { captureCursor?: unknown } | undefined)?.captureCursor, undefined);
});

test('desktop screenshot native capture crops display snapshots to work areas', async () => {
  const calls: any[] = [];
  const cropCalls: any[] = [];
  const snapshots = await captureDesktopDisplaySnapshots({
    getAllDisplays() {
      return [
        {
          id: 1,
          bounds: { x: 0, y: 0, width: 1000, height: 800 },
          workArea: { x: 0, y: 24, width: 1000, height: 736 },
          scaleFactor: 2,
        },
      ];
    },
    cropPng(sourcePng, cropRect) {
      cropCalls.push({ sourcePng: Array.from(sourcePng), cropRect });
      return new Uint8Array([9, 9, 9]);
    },
    async getScreenSources(options) {
      calls.push(options);
      return [
        {
          id: 'screen:1:0',
          display_id: '1',
          name: 'Built-in display',
          thumbnail: createImage(2000, 1600, [1, 2, 3]),
        },
      ];
    },
  });

  assert.deepEqual(calls, [
    {
      types: ['screen'],
      thumbnailSize: { width: 2000, height: 1600 },
      fetchWindowIcons: false,
    },
  ]);
  assert.deepEqual(cropCalls, [
    {
      sourcePng: [1, 2, 3],
      cropRect: { x: 0, y: 48, width: 2000, height: 1472 },
    },
  ]);
  assert.deepEqual(snapshots, [
    {
      displayId: 1,
      sourceId: 'screen:1:0',
      sourceName: 'Built-in display',
      geometry: {
        bounds: { x: 0, y: 24, width: 1000, height: 736 },
        imageSize: { width: 2000, height: 1472 },
        scaleFactor: 2,
      },
      png: new Uint8Array([9, 9, 9]),
    },
  ]);
});

test('desktop screenshot native capture crops selected display snapshots', () => {
  const cropCalls: any[] = [];
  const result = cropDesktopDisplaySnapshotSelection(
    {
      displayId: 2,
      sourceId: 'screen:2:0',
      sourceName: 'Left display',
      geometry: {
        bounds: { x: -1280, y: 0, width: 1280, height: 720 },
        imageSize: { width: 2560, height: 1440 },
        scaleFactor: 2,
      },
      png: new Uint8Array([9, 9, 9]),
    },
    { x: -1180, y: 20, width: 200, height: 100 },
    {
      cropPng(sourcePng, cropRect) {
        cropCalls.push({ sourcePng: Array.from(sourcePng), cropRect });
        return new Uint8Array([7, 8, 9]);
      },
      resizePng() {
        throw new Error('bounded crop should not be resized');
      },
    },
  );

  assert.deepEqual(cropCalls, [
    {
      sourcePng: [9, 9, 9],
      cropRect: { x: 200, y: 40, width: 400, height: 200 },
    },
  ]);
  assert.deepEqual(result, {
    displayId: 2,
    sourceId: 'screen:2:0',
    width: 400,
    height: 200,
    cropRect: { x: 200, y: 40, width: 400, height: 200 },
    png: new Uint8Array([7, 8, 9]),
  });
});

test('desktop screenshot native capture downscales oversized crop dimensions', () => {
  const resizeCalls: any[] = [];
  const result = cropDesktopDisplaySnapshotSelection(
    {
      displayId: 1,
      sourceId: 'screen:1:0',
      sourceName: 'Built-in display',
      geometry: {
        bounds: { x: 0, y: 0, width: 9000, height: 4500 },
        imageSize: { width: 9000, height: 4500 },
        scaleFactor: 1,
      },
      png: new Uint8Array([1]),
    },
    { x: 0, y: 0, width: 9000, height: 4500 },
    {
      cropPng() {
        return new Uint8Array([9, 9, 9]);
      },
      resizePng(sourcePng, size) {
        resizeCalls.push({ sourcePng: Array.from(sourcePng), size });
        return new Uint8Array([8, 8]);
      },
    },
  );

  assert.deepEqual(resizeCalls, [
    {
      sourcePng: [9, 9, 9],
      size: { width: 8000, height: 4000 },
    },
  ]);
  assert.deepEqual(result, {
    displayId: 1,
    sourceId: 'screen:1:0',
    width: 8000,
    height: 4000,
    cropRect: { x: 0, y: 0, width: 9000, height: 4500 },
    png: new Uint8Array([8, 8]),
  });
});

test('desktop screenshot native capture downscales oversized encoded PNG bytes', () => {
  const resizeCalls: any[] = [];
  const result = cropDesktopDisplaySnapshotSelection(
    {
      displayId: 1,
      sourceId: 'screen:1:0',
      sourceName: 'Built-in display',
      geometry: {
        bounds: { x: 0, y: 0, width: 4000, height: 2000 },
        imageSize: { width: 4000, height: 2000 },
        scaleFactor: 1,
      },
      png: new Uint8Array([1]),
    },
    { x: 0, y: 0, width: 4000, height: 2000 },
    {
      cropPng() {
        return new Uint8Array(10 * 1024 * 1024 + 1);
      },
      resizePng(_sourcePng, size) {
        resizeCalls.push(size);
        return new Uint8Array([7]);
      },
    },
  );

  assert.deepEqual(resizeCalls, [
    { width: 3400, height: 1700 },
  ]);
  assert.equal(result?.width, 3400);
  assert.equal(result?.height, 1700);
  assert.deepEqual(result?.png, new Uint8Array([7]));
});

test('desktop screenshot native capture treats tiny crop selections as cancellation', () => {
  const result = cropDesktopDisplaySnapshotSelection(
    {
      displayId: 1,
      sourceId: 'screen:1:0',
      sourceName: 'Built-in display',
      geometry: {
        bounds: { x: 0, y: 0, width: 100, height: 100 },
        imageSize: { width: 100, height: 100 },
        scaleFactor: 1,
      },
      png: new Uint8Array([1]),
    },
    { x: 0, y: 0, width: 7, height: 8 },
    {
      cropPng() {
        throw new Error('tiny selections should not be cropped');
      },
      resizePng() {
        throw new Error('tiny selections should not be resized');
      },
    },
  );

  assert.equal(result, null);
});
