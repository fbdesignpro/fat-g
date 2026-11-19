// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// K1's scratch app, built as fat-g is (electron.vite.config.ts): electron-vite, an ES main process,
// a React page with the `@shared` alias and fat-g's own public files (its fonts). Output goes to the
// ignored spikes/output/m19b/k1/app/.
//
// electron-vite runs a bundled copy of this file from the working folder, so the folder is taken
// from `import.meta.url`, which it rewrites, and not from `import.meta.dirname`.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const app = resolve(root, 'spikes/output/m19b/k1/app');
const alias = { '@shared': resolve(root, 'src/shared') };

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      outDir: resolve(app, 'out/main'),
      emptyOutDir: true,
      rollupOptions: { input: { index: resolve(here, 'app/main.mjs') }, output: { format: 'es' } },
    },
  },
  renderer: {
    root: resolve(here, 'page'),
    publicDir: resolve(root, 'src/renderer/public'),
    resolve: { alias },
    plugins: [react()],
    build: {
      outDir: resolve(app, 'out/renderer'),
      emptyOutDir: true,
      rollupOptions: { input: { index: resolve(here, 'page/index.html') } },
    },
  },
});
