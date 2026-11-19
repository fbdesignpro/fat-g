// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V12 (docs/planning/_archive/M19.md; C28): character references, decoded by fat-g's own code since the
// bundled parser leaves the named ones to an HTML renderer, which fat-g has none of.
import { describe, expect, it } from 'vitest';
import { decodeReferences, NAMED_REFERENCES } from './entities';

describe('character references (C28)', () => {
  it('decodes a named reference, a decimal one and a hexadecimal one', () => {
    expect(decodeReferences('AT&amp;T &copy; 2026 &mdash; &lt;b&gt; &quot;x&quot; &apos;y&apos; &nbsp;|')).toBe('AT&T © 2026 — <b> "x" \'y\'  |');
    expect(decodeReferences('&#35; &#x23; &#X1F600; &#128512;')).toBe('# # 😀 😀');
    expect(decodeReferences('&alpha;&beta;&Omega; &le; &ne; &rarr; &hellip; &euro; &hearts;')).toBe('αβΩ ≤ ≠ → … € ♥');
  });

  it('knows HTML 4’s 252 names and `apos`, each a single character', () => {
    expect(NAMED_REFERENCES).toBe(253);
    for (const [name, character] of [['nbsp', ' '], ['yuml', 'ÿ'], ['Agrave', 'À'], ['szlig', 'ß'], ['divide', '÷'], ['OElig', 'Œ'], ['thetasym', 'ϑ'], ['diams', '♦'], ['lang', '〈']] as const) {
      expect(decodeReferences(`&${name};`), name).toBe(character);
    }
  });

  it('leaves what is no reference as it was written: an unknown name, a name with no semicolon, a lone ampersand', () => {
    for (const text of ['&bogus;', '&amp', 'a & b', '&;', '&#;', '&#x;', '&#12345678;', '&#xfffffff;', 'R&D;']) expect(decodeReferences(text), text).toBe(text);
    // Case matters, as it does in HTML: `&AMP;` is no name here.
    expect(decodeReferences('&AMP; &Amp;')).toBe('&AMP; &Amp;');
  });

  it('never reads what a reference decoded to again', () => {
    expect(decodeReferences('&amp;lt;')).toBe('&lt;');
    expect(decodeReferences('&amp;#35;')).toBe('&#35;');
    expect(decodeReferences('&#38;amp;')).toBe('&amp;');
  });

  it('answers the replacement character for a number that names none: zero, a surrogate, one past the last code point', () => {
    expect(decodeReferences('&#0; &#xD800; &#xDFFF; &#x110000;')).toBe('� � � �');
    expect(decodeReferences('&#x10FFFF;')).toBe('\u{10FFFF}');
  });

  it('returns a text with no ampersand as the same string', () => {
    const text = 'plain text, with nothing to decode';
    expect(decodeReferences(text)).toBe(text);
    expect(decodeReferences('')).toBe('');
  });
});
