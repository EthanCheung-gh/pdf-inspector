/**
 * Browser build of the renderer.
 *
 * Identical aliases to `vite.config.ts` but without the Electron plugin: the
 * output (`dist-web/index.html` + hashed assets) is served by the Node HTTP
 * backend (`server/web-server.ts`), and `window.pdfInspector` is provided by
 * `src/web/ipc-adapter.ts` instead of a preload script.
 */
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * Emit `dist-web/index.html` from the `index.web.html` entry.
 *
 * Vite names HTML outputs after the source file (relative to `root`), not after
 * the rollup input key, so a plain `input: { index: 'index.web.html' }` would
 * produce `dist-web/index.web.html`. The HTTP server serves `index.html` for
 * `/`, so the asset is renamed inside the bundle.
 */
function indexHtmlOutput(): Plugin {
  return {
    name: 'pdf-inspector:web-index-html',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const asset = bundle['index.web.html'];
      if (!asset) return;
      delete bundle['index.web.html'];
      asset.fileName = 'index.html';
      bundle[asset.fileName] = asset;
    },
  };
}

export default defineConfig({
  plugins: [react(), indexHtmlOutput()],
  resolve: {
    alias: {
      '@main': path.resolve(__dirname, 'src/main'),
      '@preload': path.resolve(__dirname, 'src/preload'),
      '@renderer': path.resolve(__dirname, 'src/renderer'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  root: '.',
  base: './',
  build: {
    outDir: 'dist-web',
    emptyOutDir: true,
    rollupOptions: {
      // Relative to `root`; the entry name keeps the emitted HTML at
      // `dist-web/index.html` even though the source file is `index.web.html`.
      input: { index: 'index.web.html' },
    },
  },
});
