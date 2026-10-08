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
  // Pre-bundle up front: a dependency discovered at runtime makes Vite reload every page,
  // which would interrupt a running output window in dev.
  optimizeDeps: {
    entries: ['control/index.html', 'output/index.html', '../data/parse.worker.ts', '../data/hierarchy.worker.ts'],
    include: ['three', 'tweakpane', 'papaparse', 'zod', 'd3-hierarchy', 'd3-scale-chromatic', 'troika-three-text'],
  },
  test: {
    root: import.meta.dirname,
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
