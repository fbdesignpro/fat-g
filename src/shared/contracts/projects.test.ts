// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V6: the project contract (docs/planning/_archive/M12.md, C13, C17, C18, C20–C22) and its request schemas.
import { describe, expect, it } from 'vitest';
import {
  isProjectColor,
  PROJECT_COLORS,
  PROJECT_COLOR_NAMES,
  ProjectAddRequestSchema,
  ProjectMoveRequestSchema,
  ProjectPickFolderRequestSchema,
  ProjectUpdateRequestSchema,
  proposeColor,
} from './projects';

const ID = '3f0c5c2e-8d4a-4b8e-9a51-2f7d1c0e6b19';
const root = { path: 'D:\\Code\\fat-g', trust: 'trusted' };
const add = { name: 'fat-g', color: 'teal', roots: [root], providers: ['codex'] };

describe('the colours (C18)', () => {
  it('are eight ids in a fixed order, each with a name', () => {
    expect(PROJECT_COLORS).toEqual(['red', 'orange', 'green', 'teal', 'blue', 'purple', 'pink', 'grey']);
    expect(Object.keys(PROJECT_COLOR_NAMES)).toEqual([...PROJECT_COLORS]);
    expect(PROJECT_COLOR_NAMES.teal).toBe('Teal');
  });

  it('know their own ids and nothing else', () => {
    expect(isProjectColor('teal')).toBe(true);
    for (const value of ['Teal', '#00796b', 'gold', null, 3]) expect(isProjectColor(value)).toBe(false);
  });
});

describe('proposeColor (C20)', () => {
  it('gives the first colour no project uses', () => {
    expect(proposeColor([])).toBe('red');
    expect(proposeColor(['red', 'green'])).toBe('orange');
    expect(proposeColor(['red', 'orange', null, 'gold'])).toBe('green');
  });

  it('gives the first of the set once every colour is taken', () => {
    expect(proposeColor([...PROJECT_COLORS])).toBe('red');
  });
});

describe('the request schemas (C21, C22, C53)', () => {
  it('accept a project with one root and one provider', () => {
    expect(ProjectAddRequestSchema.safeParse(add).success).toBe(true);
    expect(ProjectUpdateRequestSchema.safeParse({ ...add, id: ID }).success).toBe(true);
    // Left out, the stored colour stays (C12).
    const { color: _color, ...withoutColor } = add;
    expect(ProjectUpdateRequestSchema.safeParse({ ...withoutColor, id: ID }).success).toBe(true);
  });

  it.each([
    ['no root', { ...add, roots: [] }],
    ['33 roots', { ...add, roots: Array.from({ length: 33 }, (_, index) => ({ ...root, path: `D:\\r${index}` })) }],
    ['a root with no trust answer', { ...add, roots: [{ path: 'D:\\x' }] }],
    ['an unknown trust answer', { ...add, roots: [{ path: 'D:\\x', trust: 'maybe' }] }],
    ['a colour value', { ...add, color: '#00796b' }],
    ['17 providers', { ...add, providers: Array.from({ length: 17 }, (_, index) => `p${index}`) }],
    ['a name over the input limit', { ...add, name: 'x'.repeat(1001) }],
    ['a path over the limit', { ...add, roots: [{ ...root, path: `D:\\${'x'.repeat(4096)}` }] }],
    ['an extra field', { ...add, position: 3 }],
    ['an extra field in a root', { ...add, roots: [{ ...root, answeredAt: 'now' }] }],
  ])('refuse %s', (_name, request) => {
    expect(ProjectAddRequestSchema.safeParse(request).success).toBe(false);
  });

  it('take ids and keys as UUIDs only', () => {
    expect(ProjectMoveRequestSchema.safeParse({ id: ID, hidden: false, before: null }).success).toBe(true);
    expect(ProjectMoveRequestSchema.safeParse({ id: 'fat-g', hidden: false, before: null }).success).toBe(false);
    expect(ProjectMoveRequestSchema.safeParse({ id: ID, hidden: false, before: '../x' }).success).toBe(false);
  });

  it('let the picker compare with at most 32 draft roots', () => {
    expect(ProjectPickFolderRequestSchema.safeParse({ projectId: null, roots: [] }).success).toBe(true);
    expect(ProjectPickFolderRequestSchema.safeParse({ projectId: null, roots: Array.from({ length: 33 }, () => 'D:\\x') }).success).toBe(false);
  });
});
