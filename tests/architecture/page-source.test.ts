// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V13 (docs/planning/_archive/M19.md; C28, S7; decision 0021): source invariants of the page that the linter
// does not express. Conversation text is drawn as elements, never as an HTML string: nothing in the
// page's source sets HTML, and the bundled parser is imported in one file, for its lexer alone, and
// by nothing under src/main or src/shared.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');

function sources(folder: string): { readonly file: string; readonly text: string }[] {
  return readdirSync(path.join(ROOT, folder), { recursive: true, encoding: 'utf8' })
    .map((name) => name.replaceAll('\\', '/'))
    .filter((name) => /\.(ts|tsx|html|js|mjs)$/.test(name))
    .map((name) => ({ file: `${folder}/${name}`, text: readFileSync(path.join(ROOT, folder, name), 'utf8') }));
}
const isTest = (file: string): boolean => /\.test\.tsx?$/.test(file) || file.includes('/test/');
/** Comments say what is not done; only code can do it. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');

const page = sources('src/renderer');
const pageCode = page.filter(({ file }) => !isTest(file));
/** Every import of a module, by its specifier, type-only or not. */
const imports = (text: string, specifier: string): string[] => [...code(text).matchAll(new RegExp(`import\\s+(type\\s+)?[^;]*?from\\s+['"]${specifier}['"]|import\\(\\s*['"]${specifier}['"]\\s*\\)|require\\(\\s*['"]${specifier}['"]\\s*\\)`, 'g'))].map((match) => (match[1] === undefined ? 'value' : 'type'));

describe('the page’s source (V13)', () => {
  it('scans the real page', () => {
    expect(pageCode.map(({ file }) => file)).toEqual(expect.arrayContaining(['src/renderer/src/markdown/parse.ts', 'src/renderer/src/markdown/render.tsx', 'src/renderer/src/chat/Message.tsx', 'src/renderer/index.html']));
    expect(pageCode.length).toBeGreaterThan(80);
  });

  it('never sets HTML: no `innerHTML`, no `dangerouslySetInnerHTML`, and no other way to make elements from a string', () => {
    for (const forbidden of ['innerHTML', 'dangerouslySetInnerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'DOMParser', 'createContextualFragment', 'srcdoc', 'setHTMLUnsafe', 'parseFromString']) {
      expect(pageCode.filter(({ text }) => code(text).includes(forbidden)).map(({ file }) => file), forbidden).toEqual([]);
    }
  });

  it('makes no anchor and no image from a text: the Markdown module names neither element', () => {
    const markdown = pageCode.filter(({ file }) => file.startsWith('src/renderer/src/markdown/') && file.endsWith('.tsx'));
    expect(markdown.length).toBeGreaterThanOrEqual(3);
    for (const { file, text } of markdown) {
      expect(code(text), file).not.toMatch(/<a[\s>]|<img[\s>]|<input[\s>]|<iframe[\s>]|<script[\s>]|createElement\(/);
      expect(code(text), file).not.toMatch(/\bhref=|\bsrc=|\bsrcSet=|\bonClick=\{[^}]*(href|address)/);
    }
  });

  it('imports the parser in one file, for its lexer alone', () => {
    const importing = pageCode.filter(({ text }) => imports(text, 'marked').includes('value')).map(({ file }) => file);
    expect(importing).toEqual(['src/renderer/src/markdown/parse.ts']);
    const parser = code(pageCode.find(({ file }) => file === 'src/renderer/src/markdown/parse.ts')?.text ?? '');
    const named = /import\s*\{([^}]*)\}\s*from\s*'marked'/.exec(parser)?.[1]?.split(',').map((name) => name.trim()).filter((name) => !name.startsWith('type ')) ?? [];
    expect(named.sort()).toEqual(['Lexer', 'Marked']);
    // Its parser and its renderer make HTML strings: neither is named, and nothing is parsed to one.
    expect(parser).not.toMatch(/\bParser\b|\bRenderer\b|\.parse\(|\.parseInline\(|\bmarked\(/);
    // Type-only imports are erased: they are allowed inside the Markdown module, and nowhere else.
    const typed = pageCode.filter(({ text }) => imports(text, 'marked').length > 0).map(({ file }) => file);
    expect(typed.every((file) => file.startsWith('src/renderer/src/markdown/'))).toBe(true);
  });

  it('keeps the parser out of the main process and the shared code (S7)', () => {
    for (const folder of ['src/main', 'src/shared', 'src/preload']) {
      expect(sources(folder).filter(({ text }) => imports(text, 'marked').length > 0).map(({ file }) => file), folder).toEqual([]);
    }
    const manifest = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    // Bundled into the page as React is: a devDependency, at an exact version.
    expect(Object.keys(manifest.dependencies)).not.toContain('marked');
    expect(manifest.devDependencies['marked']).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('keeps the pure Markdown helpers free of every package', () => {
    const shared = sources('src/shared/markdown').filter(({ file }) => !isTest(file));
    expect(shared.map(({ file }) => file).sort()).toEqual(['src/shared/markdown/blocks.ts', 'src/shared/markdown/entities.ts', 'src/shared/markdown/notes.ts']);
    for (const { file, text } of shared) {
      const specifiers = [...code(text).matchAll(/from\s+'([^']+)'/g)].map((match) => match[1] ?? '');
      expect(specifiers.filter((specifier) => !specifier.startsWith('./')), file).toEqual([]);
    }
  });
});
