// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { DRAFT_INSTRUCTIONS, DRAFT_TASK } from './draft';
import { MAX_SOURCE_TEXT } from './task';
import { TITLE_TASK } from './title';

describe('the draft task (M26, round 2)', () => {
  it('sends the unsent text under one line that says what it is, cut at 2,000 units on a code point', () => {
    expect(DRAFT_TASK.instructions).toBe(DRAFT_INSTRUCTIONS);
    expect(DRAFT_TASK.input('  Set up the login form\n')).toBe('The text the user has typed but not sent:\n\nSet up the login form');
    const long = DRAFT_TASK.input('a'.repeat(MAX_SOURCE_TEXT - 1) + '😀😀');
    const sent = long.slice('The text the user has typed but not sent:\n\n'.length);
    expect(sent.length).toBe(MAX_SOURCE_TEXT - 1);
    expect(sent.endsWith('a')).toBe(true);
  });

  it('says what it wants and forbids acting, and says the text is unfinished', () => {
    expect(DRAFT_INSTRUCTIONS).toMatch(/not yet sent/);
    expect(DRAFT_INSTRUCTIONS).toMatch(/two to five words/);
    expect(DRAFT_INSTRUCTIONS).toMatch(/run nothing, read nothing and ask nothing/);
  });

  it('reads a reply by the same parse as a title, and the phrase alone', () => {
    expect(DRAFT_TASK.parse('"setting things up."')).toBe('setting things up');
    expect(DRAFT_TASK.parse('setting things up\nand more')).toBe('setting things up');
    expect(DRAFT_TASK.parse('\n \n')).toBeNull();
    expect(DRAFT_TASK.parse).toBe(TITLE_TASK.parse);
  });
});
