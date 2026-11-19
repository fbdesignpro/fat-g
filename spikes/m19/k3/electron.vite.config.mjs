// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// K3's scratch app, built as fat-g is (electron.vite.config.ts): electron-vite, an ES main process,
// a React page. Output goes to the ignored spikes/output/m19/k3/app/.
//
// electron-vite runs a bundled copy of this file from the working folder, so the folder is taken
// from `import.meta.url`, which it rewrites, and not from `import.meta.dirname`.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const app = resolve(root, 'spikes/output/m19/k3/app');

export default defineConfig({
  main: {
    build: {
      outDir: resolve(app, 'out/main'),
      emptyOutDir: true,
      rollupOptions: { input: { index: resolve(here, 'app/main.mjs') }, output: { format: 'es' } },
    },
  },
  renderer: {
    root: resolve(here, 'page'),
    plugins: [react()],
    build: {
      outDir: resolve(app, 'out/renderer'),
      emptyOutDir: true,
      rollupOptions: { input: { index: resolve(here, 'page/index.html') } },
    },
  },
});
