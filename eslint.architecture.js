// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Architecture rules: who may import whom, and which capabilities each layer may touch.
// Kept separate from eslint.config.js so tests/architecture can load these rules on their own
// (without type-aware parsing) and prove that an illegal import really fails.
//
// The layering and its reasoning are in docs/decisions/0002-single-package-layered-layout.md, the
// network ban's in 0004. Treat any `eslint-disable` of these rules as a red flag.
import { builtinModules } from 'node:module';
import boundaries from 'eslint-plugin-boundaries';
import tseslint from 'typescript-eslint';

const SOURCE_FILES = ['src/**/*.{ts,tsx}'];

const nodeBuiltins = [...builtinModules.filter((name) => !name.startsWith('_')), 'node:*'];

/** Modules that can open a network connection. Banned everywhere: decision 0004, rule 5. */
const NETWORK_MODULES = ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns'].flatMap((name) => [name, `node:${name}`]);
const NETWORK_PACKAGES = ['undici', 'axios', 'node-fetch', 'got', 'ws', 'socket.io-client'];

const networkPaths = [
  ...[...NETWORK_MODULES, ...NETWORK_PACKAGES].map((name) => ({
    name,
    message: 'The app makes no network calls of its own (docs/decisions/0004). The user’s CLI does the talking.',
  })),
  {
    name: 'electron',
    importNames: ['net', 'autoUpdater', 'crashReporter'],
    message: 'No network, auto-update or crash reporting from the app itself (docs/decisions/0004).',
  },
];

const PRELOAD_IS_A_PIPE =
  'The preload only forwards allowlisted channels; validation happens in main. Import types from the contract, not values (docs/planning/_archive/phase-1/phase-1-m2.md).';

/** fat-g ships no Anthropic library: Claude is reached through the user's own CLI (decision 0006). */
const NO_ANTHROPIC_PACKAGES = "fat-g runs no Anthropic SDK in its own process: the Claude provider speaks to the user's installed CLI (docs/decisions/0006). Dynamic imports are checked by tests/architecture.";

const ban = (names, message) => names.map((name) => ({ name, message }));
const banGroup = (group, message) => [{ group, message }];

/** @param {{files: string[], paths?: object[], patterns?: object[]}} options */
function restrictImports({ files, paths = [], patterns = [] }) {
  return {
    files,
    rules: { 'no-restricted-imports': ['error', { paths: [...networkPaths, ...paths], patterns: [...banGroup(['@anthropic-ai/*', '@anthropic-ai/**'], NO_ANTHROPIC_PACKAGES), ...patterns] }] },
  };
}

const PROVIDER_BANS = [
  ...ban(['electron'], 'Providers are Electron-free: they receive what they need through ProviderContext.'),
  ...ban(['child_process', 'node:child_process'], 'Providers spawn through ctx.processes so every child is tracked and cleaned up.'),
];

export const architecture = [
  {
    // Parser only — no type information — so these rules also work on in-memory test snippets.
    files: SOURCE_FILES,
    languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
  },

  // ── Layer → layer ───────────────────────────────────────────────────────────────────────
  {
    files: SOURCE_FILES,
    plugins: { boundaries },
    settings: {
      'boundaries/include': ['src/**/*'],
      // First match wins, so the most specific folders come first.
      'boundaries/elements': [
        { type: 'provider', pattern: 'src/main/providers/*', capture: ['provider'] },
        { type: 'process', pattern: 'src/main/process' },
        { type: 'main', pattern: 'src/main' },
        { type: 'preload', pattern: 'src/preload' },
        { type: 'renderer', pattern: 'src/renderer' },
        { type: 'provider-kit', pattern: 'src/shared/provider-kit' },
        { type: 'shared', pattern: 'src/shared' },
      ],
      // Resolves the `@shared/*` alias; the root tsconfig references both projects.
      'import/resolver': { typescript: { project: 'tsconfig.json' } },
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          // Imports *within* one element are always fine; everything across elements must be
          // listed here. Each provider folder is its own element, so provider → other provider
          // is denied by default.
          default: 'disallow',
          policies: [
            { from: { element: { type: 'shared' } }, allow: { to: { element: { type: 'shared' } } } },
            { from: { element: { type: 'provider-kit' } }, allow: { to: { element: { types: { anyOf: ['shared', 'provider-kit'] } } } } },
            { from: { element: { type: 'renderer' } }, allow: { to: { element: { type: 'shared' } } } },
            { from: { element: { type: 'preload' } }, allow: { to: { element: { type: 'shared' } } } },
            { from: { element: { type: 'provider' } }, allow: { to: { element: { types: { anyOf: ['shared', 'provider-kit'] } } } } },
            { from: { element: { type: 'process' } }, allow: { to: { element: { types: { anyOf: ['shared', 'provider-kit'] } } } } },
            {
              from: { element: { type: 'main' } },
              allow: { to: { element: { types: { anyOf: ['main', 'process', 'provider', 'shared', 'provider-kit'] } } } },
            },
          ],
        },
      ],
    },
  },

  // ── Layer → capability (external modules) ───────────────────────────────────────────────
  // A later block for the same file REPLACES `no-restricted-imports`, so every block below
  // re-includes the network ban via restrictImports().
  restrictImports({ files: SOURCE_FILES }),
  restrictImports({
    files: ['src/shared/**/*.{ts,tsx}'],
    paths: [
      ...ban(['electron', 'react', 'react-dom'], 'src/shared is contracts only: it must load in the main process, the preload AND the renderer.'),
      ...ban(nodeBuiltins.filter((name) => name !== 'node:*'), 'src/shared must stay renderer-safe: no Node built-ins.'),
    ],
    patterns: banGroup(['node:*'], 'src/shared must stay renderer-safe: no Node built-ins.'),
  }),
  restrictImports({
    files: ['src/renderer/**/*.{ts,tsx}'],
    paths: [
      ...ban(['electron'], 'The renderer is sandboxed. Talk to the main process through window.fatg (src/shared/ipc).'),
      ...ban(nodeBuiltins.filter((name) => name !== 'node:*'), 'The renderer is sandboxed: no Node built-ins.'),
    ],
    patterns: banGroup(['node:*'], 'The renderer is sandboxed: no Node built-ins.'),
  }),
  restrictImports({
    files: ['src/main/process/**/*.ts'],
    paths: ban(['electron'], 'src/main/process stays Electron-free so it is testable in plain Node and extractable later.'),
  }),
  // The stored files (M12, C1): both stores take their folder, clock and file system as options, so
  // their tests run in plain Node without starting the app. The catalog's merge and override reader
  // follow the same rule (M13, C10), and so do the session service, its summaries and its sources
  // (M14, C25), the conversation store (M18) and the reader of a project's files (M19b), whose file
  // system is a parameter too — and the images' files and the media route's sources (M23, B12, B3),
  // and the one image header reader and the avatars, whose file system is a parameter (M102, C21).
  restrictImports({
    files: ['src/main/storage/**/*.ts', 'src/main/prefs/**/*.ts', 'src/main/records/**/*.ts', 'src/main/catalog/**/*.ts', 'src/main/sessions/**/*.ts', 'src/main/conversations/**/*.ts', 'src/main/files/**/*.ts', 'src/main/plans/**/*.ts', 'src/main/attachments/**/*.ts', 'src/main/media/**/*.ts', 'src/main/images/**/*.ts', 'src/main/avatars/**/*.ts', 'src/main/audio/**/*.ts'],
    paths: ban(['electron'], 'The stores, the catalog, the sessions and the file reader stay Electron-free: main passes them their folder and clock (docs/planning/_archive/M12.md, C1; M13.md, C10; M14.md, C25; M18.md, Design 2; M19b.md, Design 7).'),
  }),
  restrictImports({ files: ['src/main/providers/*/**/*.ts'], paths: PROVIDER_BANS }),
  // An account's folder holds its CLI's login (M14b, S6). The code that deals with one asks only
  // for its real path and whether it is there, through the lookups it is handed. It imports no
  // file-system module, so it cannot open, list or write a folder, and no Electron.
  restrictImports({
    files: ['src/main/instances/**/*.ts'],
    paths: [
      ...ban(['electron'], 'src/main/instances stays Electron-free: main passes it the folders and the lookups (docs/planning/_archive/M14b.md, Design 5).'),
      ...ban(['fs', 'node:fs', 'fs/promises', 'node:fs/promises'], 'fat-g never reads, lists or writes inside an account’s folder: ask the lookups for a real path or whether the folder is there (docs/planning/_archive/M14b.md, S6).'),
    ],
  }),

  // ── The preload is a dumb pipe ──────────────────────────────────────────────────────────
  // It forwards allowlisted channel names (src/shared/ipc/channels.ts) and nothing else. Payloads
  // are validated in main, behind the trust boundary; validating in the preload would prove
  // nothing, because the page is untrusted. Type imports from the contract are fine — values would
  // drag zod and the contracts into the bundle every window loads.
  //
  // This is the typescript-eslint rule (it understands `import type`), a DIFFERENT rule from the
  // `no-restricted-imports` above — so, unlike the blocks above, it does not replace the network ban.
  {
    files: ['src/preload/**/*.ts'],
    // Registered here as well as in eslint.config.js, so tests/architecture can load this file alone.
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'zod', allowTypeImports: true, message: PRELOAD_IS_A_PIPE }],
          patterns: [{ group: ['**/ipc/contract', '**/contracts/*'], allowTypeImports: true, message: PRELOAD_IS_A_PIPE }],
        },
      ],
    },
  },

  // ── Globals and forbidden APIs ──────────────────────────────────────────────────────────
  {
    files: SOURCE_FILES,
    rules: {
      'no-restricted-globals': [
        'error',
        ...['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'].map((name) => ({
          name,
          message: 'The app makes no network calls of its own (docs/decisions/0004).',
        })),
      ],
      'no-restricted-properties': [
        'error',
        { object: 'navigator', property: 'sendBeacon', message: 'No network calls (docs/decisions/0004).' },
      ],
    },
  },
];
