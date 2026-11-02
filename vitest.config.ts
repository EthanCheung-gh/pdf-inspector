import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // `server/` is the Electron-free HTTP backend; its tests exercise the
    // document/diff endpoints with a stubbed sidecar.
    include: ['src/**/*.test.ts', 'server/**/*.test.ts'],
  },
});
