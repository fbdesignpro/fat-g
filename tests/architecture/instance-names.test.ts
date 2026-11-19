// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V2 (docs/planning/_archive/M14b.md; C5): no shared code names a provider or a variable. What a provider's
// CLI calls its configuration folder, and what an added account must not inherit, is declared by
// its module and read from the definition. So outside the provider modules, the list of built-ins
// and the smoke modules, what ships under src/ holds no declared variable, no withheld name and no
// provider id as a string.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { builtInProviders } from '../../src/main/providers';

const ROOT = path.resolve(import.meta.dirname, '../..');
const definitions = builtInProviders('0.0.0');
const ids = definitions.map((definition) => definition.descriptor.id);
/** Every declared variable, withheld name and withheld prefix: none may appear, even in a comment. */
const names = [...new Set(definitions.flatMap((definition) => {
  const support = definition.instances;
  return support === undefined ? [] : [support.variable, ...support.withhold.names, ...support.withhold.prefixes];
}))];

// Where a provider may be named.
const MODULES = ids.map((id) => `src/main/providers/${id}/`);
const BUILT_INS = 'src/main/providers/index.ts';
// The smoke modules of tests/architecture/smoke-gating.test.ts: they drive the built-ins by id, and
// no release holds them (decision 0007).
const SMOKE_MODULES = ['src/main/app/smoke.ts', 'src/main/app/smoke-providers.ts', 'src/main/app/smoke-dialogs.ts', 'src/main/app/process-smoke.ts', 'src/main/app/smoke-live.ts'];
/** Tests and their support files name providers on purpose, and none ships. */
const isTestFile = (file: string): boolean => /\.test\.tsx?$/.test(file) || /-test-support\.ts$/.test(file) || file.startsWith('src/renderer/src/test/');
const mayName = (file: string): boolean => MODULES.some((folder) => file.startsWith(folder)) || file === BUILT_INS || SMOKE_MODULES.includes(file);

function sources(directory = 'src'): string[] {
  return readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return sources(relative);
    return /\.(ts|tsx)$/.test(entry.name) ? [relative] : [];
  });
}

/** The declared names found anywhere in a file's text. */
function namesIn(text: string): string[] {
  return names.filter((name) => text.includes(name));
}

/** The provider ids a file holds as a string of its own: a literal, never a comment or an identifier. */
function idsIn(file: string, text: string): string[] {
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) && ids.includes(node.text)) found.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS));
  return ids.filter((id) => found.has(id));
}

describe('provider names stay in the provider modules (M14b, C5)', () => {
  it('has something to look for: both built-ins declare a variable and what an added account does not inherit', () => {
    expect(ids).toEqual(['claude', 'codex']);
    expect(names).toEqual(expect.arrayContaining(['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'ANTHROPIC_', 'OPENAI_']));
    for (const name of names) expect(name.length).toBeGreaterThanOrEqual(6);
    for (const folder of MODULES) expect(existsSync(path.join(ROOT, folder)), folder).toBe(true);
    for (const file of [BUILT_INS, ...SMOKE_MODULES]) expect(existsSync(path.join(ROOT, file)), file).toBe(true);
  });

  it('finds a name in code and in a comment, and an id only as a string', () => {
    expect(namesIn("delete additions['CODEX_HOME']; // and ANTHROPIC_BASE_URL")).toEqual(expect.arrayContaining(['CODEX_HOME', 'ANTHROPIC_']));
    expect(idsIn('x.ts', "const claude = 1; /* e.g. `codex` */ export const id = 'codex'; export const other = `claude-like`;")).toEqual(['codex']);
    expect(idsIn('x.tsx', 'export const X = () => <b title="claude">codex</b>;')).toEqual(['claude']);
  });

  it('holds no declared variable, no withheld name and no provider id outside the modules, the built-ins and the smoke modules', () => {
    const offenders = sources()
      .filter((file) => !isTestFile(file) && !mayName(file))
      .flatMap((file) => {
        const text = readFileSync(path.join(ROOT, file), 'utf8');
        const found = [...namesIn(text), ...idsIn(file, text)];
        return found.length > 0 ? [{ file, found }] : [];
      });
    expect(offenders).toEqual([]);
  });
});
