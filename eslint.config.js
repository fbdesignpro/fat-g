// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { architecture } from './eslint.architecture.js';

export default tseslint.config(
  // `spikes/` is throwaway experiment code (see spikes/README.md), deliberately outside the rules.
  { ignores: ['out/**', 'dist/**', 'release/**', 'coverage/**', 'node_modules/**', 'spikes/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      // Status unions (ProviderStatus, …) are the backbone of the UI: a missed case is a bug.
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  // Plain-JS config files are not part of a TypeScript project.
  { files: ['**/*.js', '**/*.mjs'], ...tseslint.configs.disableTypeChecked },
  { files: ['**/*.js', '**/*.mjs'], languageOptions: { globals: globals.node } },
  // Static files the renderer serves as they are (Vite's public folder): classic scripts in the page.
  { files: ['src/renderer/public/**/*.js'], languageOptions: { sourceType: 'script', globals: globals.browser } },

  { files: ['src/main/**', 'src/preload/**', '*.config.ts', 'tests/**'], languageOptions: { globals: globals.node } },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    ...reactHooks.configs.flat.recommended,
    languageOptions: { globals: globals.browser },
  },

  ...architecture,
);
