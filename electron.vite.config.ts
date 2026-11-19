// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

const alias = { '@shared': resolve(import.meta.dirname, 'src/shared') };

/**
 * Packaging only (scripts/package.mjs sets FATG_PACKAGE_STAGING): records which npm packages a
 * bundle actually contains, so the third-party notices also credit code bundled INTO the preload
 * and renderer, not only what ships under node_modules. Normal builds write nothing.
 */
function recordBundledPackages(target: 'preload' | 'renderer'): Plugin {
  return {
    name: 'fatg-record-bundled-packages',
    apply: 'build',
    generateBundle(_options, bundle) {
      const staging = process.env['FATG_PACKAGE_STAGING'];
      if (!staging) return;
      const names = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        for (const id of Object.keys(output.modules)) {
          const normalized = id.replaceAll('\\', '/');
          const at = normalized.lastIndexOf('/node_modules/');
          if (at === -1) continue;
          const [first, second] = normalized.slice(at + '/node_modules/'.length).split('/');
          if (first) names.add(first.startsWith('@') && second ? `${first}/${second}` : first);
        }
      }
      mkdirSync(staging, { recursive: true });
      writeFileSync(join(staging, `bundled-${target}.json`), `${JSON.stringify([...names].sort(), null, 2)}\n`);
    },
  };
}

/**
 * Build flags (src/main/build-flags.d.ts). Only scripts/package.mjs sets FATG_RELEASE_BUILD, for the
 * release flavor; it is read here, at build time, never by the app.
 */
const smokeHooks = process.env['FATG_RELEASE_BUILD'] !== '1';

export default defineConfig({
  main: {
    resolve: { alias },
    define: { __FATG_SMOKE_HOOKS__: JSON.stringify(smokeHooks) },
    build: {
      // ESM output: the Claude Agent SDK (M7) is ESM-only.
      rollupOptions: { output: { format: 'es', assetFileNames: 'assets/[name][extname]' } },
    },
  },
  preload: {
    resolve: { alias },
    build: {
      // A sandboxed preload can only `require('electron')` and a few builtins, so it must be
      // ONE self-contained CommonJS file: bundle all deps instead of externalizing them.
      // package.json is "type": "module", hence the explicit .cjs extension.
      //
      // Keep this to a SINGLE preload entry (Main and Pet windows share it). A second entry
      // would make Rollup emit a shared chunk the sandbox can't load; electron-vite's fix for
      // that (`isolatedEntries`) crashes on non-TTY stdout in 5.0.0, i.e. in CI.
      externalizeDeps: false,
      rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
    plugins: [recordBundledPackages('preload')],
  },
  renderer: {
    resolve: { alias },
    plugins: [react(), recordBundledPackages('renderer')],
    build: {
      rollupOptions: {
        // One page per window kind (RendererPage in src/main/app/origins.ts). Renderer chunks may be
        // shared between pages — unlike the preload, pages are ordinary ES-module documents.
        input: {
          index: resolve(import.meta.dirname, 'src/renderer/index.html'),
          pet: resolve(import.meta.dirname, 'src/renderer/pet.html'),
        },
      },
    },
  },
});
