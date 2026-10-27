import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { thirdPartyNotices } from './scripts/third-party-notices.ts';

/**
 * ADR-003: the renderer pages (note, settings and first-run, floating cat)
 * are built from `src/renderer` into `dist/renderer`, which the shell loads
 * over file:// with relative URLs. The page names and their query strings
 * (`?conversation=`, `?mode=setup`, `?tab=`) are the shell's contract.
 */

const root = fileURLToPath(new URL('src/renderer/', import.meta.url));

export default defineConfig({
  root,
  base: './',
  plugins: [react(), thirdPartyNotices()],
  build: {
    outDir: fileURLToPath(new URL('dist/renderer/', import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
    // Chromium preloads modules natively; the polyfill would only add code.
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        note: `${root}note.html`,
        settings: `${root}settings.html`,
        floating: `${root}floating.html`,
      },
      output: {
        // React and markdown in one chunk the note and settings share; the floating cat loads none of it.
        manualChunks: (id) => (id.includes('node_modules') ? 'vendor' : undefined),
      },
    },
  },
});
