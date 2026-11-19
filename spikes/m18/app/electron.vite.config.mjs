// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The spike's main process, built as the app's is (electron.vite.config.ts): electron-vite, ES
// output, Node's own modules left as imports. Output goes to the ignored spikes/output/m18/app/.
//
// electron-vite runs a bundled copy of this file from the working folder, so the folder is taken
// from `import.meta.url`, which it rewrites, and not from `import.meta.dirname`.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'electron-vite';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');

export default defineConfig({
  main: {
    build: {
      outDir: resolve(root, 'spikes/output/m18/app/out/main'),
      emptyOutDir: true,
      rollupOptions: { input: { index: resolve(here, 'main.mjs') }, output: { format: 'es' } },
    },
  },
});
