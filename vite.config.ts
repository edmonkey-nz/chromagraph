import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

const root = resolve(import.meta.dirname, 'src/client');

export default defineConfig({
  root,
  appType: 'mpa',
  publicDir: false,
  build: {
    outDir: resolve(import.meta.dirname, 'dist/client'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        control: resolve(root, 'control/index.html'),
        output: resolve(root, 'output/index.html'),
      },
    },
  },
  worker: { format: 'es' },
  test: {
    root: import.meta.dirname,
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
