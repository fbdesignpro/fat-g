// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { MAX_SOURCE_TEXT } from './task';
import { TITLE_INSTRUCTIONS, TITLE_TASK } from './title';

const parse = (reply: string) => TITLE_TASK.parse(reply);

// The parse is every task's (task.ts), and is read here through the title's own.
describe('the title task (M26, Design 1)', () => {
  it('sends the first prompt under one line that says what it is, cut at 2,000 units on a code point', () => {
    expect(TITLE_TASK.instructions).toBe(TITLE_INSTRUCTIONS);
    expect(TITLE_TASK.input('  Fix the login form\n')).toBe('The first message of the session:\n\nFix the login form');
    const long = TITLE_TASK.input('a'.repeat(MAX_SOURCE_TEXT - 1) + '😀😀');
    const sent = long.slice('The first message of the session:\n\n'.length);
    expect(sent.length).toBe(MAX_SOURCE_TEXT - 1);
    expect(sent.endsWith('a')).toBe(true);
  });

  it.each([
    ['a plain title', 'Disable Submit Until Fields Filled', 'Disable Submit Until Fields Filled'],
    ['quotes around it', '"Login form validation test"', 'Login form validation test'],
    ['curly quotes and a full stop', '“Fix the flaky test.”', 'Fix the flaky test'],
    ['Markdown marks', '**Refactor the parser**', 'Refactor the parser'],
    ['a heading', '# Session naming', 'Session naming'],
    ['a label', 'Title: Port the tests to Vitest', 'Port the tests to Vitest'],
    ['a label inside quotes', '"Title: Port the tests"', 'Port the tests'],
    ['a question kept as one', 'Why does the build fail?', 'Why does the build fail?'],
    ['lines after the first', 'First line wins\nSecond line\n', 'First line wins'],
    ['blank lines before it', '\n\n  Spaced   out\ttitle  \n', 'Spaced out title'],
    ['control characters', 'Clean\u0007 title', 'Clean title'],
  ])('reads %s', (_name, reply, title) => {
    expect(parse(reply)).toBe(title);
  });

  it('cuts a title longer than a name at its last word that fits, with an ellipsis', () => {
    const descriptive = 'Disable the Submit button until both login fields are filled in, with a test for it';
    expect(parse(descriptive)).toBe(descriptive);
    const title = parse('word '.repeat(40));
    expect(title).toBe(`${'word '.repeat(30)}word…`);
    expect([...new Intl.Segmenter().segment(title ?? '')].length).toBeLessThanOrEqual(160);
    expect(parse('x'.repeat(180))).toBe(`${'x'.repeat(159)}…`);
  });

  it.each([['nothing', ''], ['blank lines', '\n \n'], ['dress alone', '"**"'], ['a full stop', '.']])('makes nothing of %s', (_name, reply) => {
    expect(parse(reply)).toBeNull();
  });
});
