import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import fs from 'node:fs';
import path from 'node:path';

function copyPdfWorker() {
  return {
    name: 'copy-pdfjs-worker',
    closeBundle() {
      const source = path.resolve(__dirname, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs');
      const destinationDir = path.resolve(__dirname, 'dist/assets');
      fs.mkdirSync(destinationDir, { recursive: true });
      fs.copyFileSync(source, path.join(destinationDir, 'pdf.worker.min.mjs'));
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: 'src/main/index.ts',
        onstart(args) { args.startup(); },
        vite: {
          build: {
            outDir: 'dist/main',
            rollupOptions: {
              external: ['electron']
            }
          }
        }
      },
      {
        entry: 'src/preload/index.ts',
        onstart(args) { args.reload(); },
        vite: {
          build: {
            outDir: 'dist/preload',
            rollupOptions: {
              external: ['electron']
            }
          }
        }
      }
    ]),
    copyPdfWorker(),
  ],
  resolve: {
    alias: {
      '@main': path.resolve(__dirname, 'src/main'),
      '@preload': path.resolve(__dirname, 'src/preload'),
      '@renderer': path.resolve(__dirname, 'src/renderer'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    }
  },
  root: '.',
  base: './'
});
