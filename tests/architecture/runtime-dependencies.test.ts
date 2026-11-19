// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// `dependencies` means "shipped in the packaged app's node_modules" (docs/planning/_archive/phase-1/phase-1-m9.md).
// electron-vite externalizes `dependencies` for the main process, which loads them at runtime; the
// renderer and preload bundle everything they import. So `dependencies` must equal exactly the npm
// packages that main and shared code import at runtime:
//   • one missing → dev, tests and CI pass, then the packaged app fails to start (the M2 zod lesson);
//   • one extra (e.g. react) → an unused second copy ships inside every installer.
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };

function sources(directory: string): string[] {
  return readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return sources(relative);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [relative] : [];
  });
}

/** Package names imported at runtime: static and dynamic imports and re-exports, never `import type`. */
export function runtimePackages(text: string): string[] {
  const specifiers = [
    ...[...text.matchAll(/(?:^|[\n;])\s*(?:import|export)\s+(?!type\b)[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g)].map((match) => match[1]!),
    ...[...text.matchAll(/(?:^|[\n;])\s*import\s*['"]([^'"]+)['"]/g)].map((match) => match[1]!),
    ...[...text.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]!),
  ];
  const builtins = new Set(builtinModules);
  return specifiers
    .filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('node:') && !specifier.startsWith('@shared/') && specifier !== 'electron' && !builtins.has(specifier))
    .map((specifier) => specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!);
}

describe('runtime dependencies', () => {
  it('reads runtime imports only', () => {
    const text = [
      `import { z } from 'zod';`, `import type { X } from 'typed-only';`, `import crossSpawn from 'cross-spawn';`,
      `export { y } from '@scope/pkg/sub';`, `import 'side-effect';`, `const m = await import('lazy/deep');`,
      `import path from 'node:path';`, `import fs from 'fs';`, `import { app } from 'electron';`, `import { a } from '@shared/x';`, `import { b } from './local';`,
      `import {\n  multi,\n  line,\n} from 'multi-line';`,
    ].join('\n');
    expect(runtimePackages(text).sort()).toEqual(['@scope/pkg', 'cross-spawn', 'lazy', 'multi-line', 'side-effect', 'zod']);
  });

  it('equal exactly what main and shared code import — nothing missing, nothing extra', () => {
    const imported = new Set([...sources('src/main'), ...sources('src/shared')].flatMap((file) => runtimePackages(readFileSync(path.join(ROOT, file), 'utf8'))));
    expect([...imported].sort(), 'main externalizes `dependencies`; the renderer bundles everything (see this file\'s header)').toEqual(Object.keys(packageJson.dependencies ?? {}).sort());
  });
});
