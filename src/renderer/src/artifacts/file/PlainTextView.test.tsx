// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V12 (docs/planning/_archive/M19b.md; C53, C54): a text as plain text. The width a line wraps at is the
// stylesheet's, which tests/architecture/styles.test.ts holds; here, what is drawn.
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LINES_HOLDER, PlainTextView } from './PlainTextView';

afterEach(cleanup);

const lines = (root: Element) => [...(root.querySelector(`[${LINES_HOLDER}]`)?.children ?? [])];

describe('plain text (C53, C54)', () => {
  it('draws an element a line, in the text’s order, each line’s own spaces and tabs kept', () => {
    const { container } = render(<PlainTextView text={'def tide(n):\n\treturn n  *  2\n\nprint(tide(3))'} />);
    expect(lines(container).map((line) => line.textContent)).toEqual(['def tide(n):', '\treturn n  *  2', '', 'print(tide(3))']);
    expect(lines(container).every((line) => line.tagName === 'DIV' && line.children.length === 0)).toBe(true);
  });

  it('gives a text that ends in a line break no line after it, and takes CRLF as one break', () => {
    expect(lines(render(<PlainTextView text={'a\nb\n'} />).container).map((line) => line.textContent)).toEqual(['a', 'b']);
    cleanup();
    expect(lines(render(<PlainTextView text={'a\r\nb\r\n\r\nc'} />).container).map((line) => line.textContent)).toEqual(['a', 'b', '', 'c']);
  });

  it('draws an empty text as one empty line, and a text of one line as one', () => {
    expect(lines(render(<PlainTextView text="" />).container).map((line) => line.textContent)).toEqual(['']);
    cleanup();
    const long = 'x'.repeat(50_000);
    expect(lines(render(<PlainTextView text={long} />).container).map((line) => line.textContent?.length)).toEqual([50_000]);
  });

  it('colours nothing and makes no element of what a line says: its text is one text node', () => {
    const { container } = render(<PlainTextView text={'<script>alert(1)</script>\nconst a = "<b>x</b>"; // https://example.com `README.md`'} />);
    expect(container.querySelector('script, b, a, button, span')).toBeNull();
    expect(lines(container).map((line) => line.childNodes.length)).toEqual([1, 1]);
  });

  it('keeps every line’s element when it is drawn again with the same text', () => {
    const view = render(<PlainTextView text={'a\nb\nc'} />);
    const before = lines(view.container);
    view.rerender(<PlainTextView text={'a\nb\nc'} />);
    expect(lines(view.container)).toEqual(before);
  });
});
