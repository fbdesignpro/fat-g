// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V13 (docs/planning/_archive/M19.md; C28, C31–C33, C61; decision 0021): a corpus of hostile texts through
// the component. Whatever a text says, what is drawn holds no element outside a fixed list, no
// `img`, no element that opens an address, no handler and no attribute that is loaded, and the
// page asks for nothing. tests/architecture/page-source.test.ts holds the source to the same rule.
//
// M19b (V10; C16, C17): the same corpus drawn with an opener. A reference is then a control, and the
// rule holds as it did: a control is a `button` that carries no address of its own, nothing is
// opened by drawing it, and no element navigates.
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Opener, OpenerContext } from './inert';
import { MarkdownText } from './MarkdownText';
import { MARKDOWN_ELEMENTS, MAX_DEPTH } from './render';

const HOSTILE: readonly (readonly [name: string, text: string])[] = [
  ['hard-break-separated passages with hostile markup', '**Content**\\\nC12. <script>alert(1)</script>\\\nC58. ![image](https://evil.test/pixel.png)'],
  ['a script element', '<script>alert(1)</script>\n\nAfter.'],
  ['a script inside a paragraph', 'Text <script>fetch("https://evil.test/x")</script> more text.'],
  ['an image with a handler', '<img src=x onerror=alert(1)> and <img src="https://evil.test/pixel.png">'],
  ['an svg with a handler', '<svg onload=alert(1)><circle r=10 /></svg>'],
  ['an iframe', '<iframe src="javascript:alert(1)"></iframe>\n\n<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
  ['an anchor with a script address', '<a href="javascript:alert(1)">click</a> and <a href="https://evil.test" target="_blank">out</a>'],
  ['a block with a handler', '<div onclick="alert(1)" onmouseover="alert(2)" style="position:fixed;inset:0">cover</div>'],
  ['a form and its controls', '<form action="https://evil.test"><input name=a value=b><button formaction="javascript:alert(1)">go</button><textarea>x</textarea><select><option>1</option></select></form>'],
  ['elements that load', '<link rel="stylesheet" href="https://evil.test/a.css">\n\n<style>body{display:none}</style>\n\n<object data="x.swf"></object><embed src="x.swf">\n\n<base href="https://evil.test/">\n\n<meta http-equiv="refresh" content="0;url=https://evil.test">'],
  ['media', '<video src="https://evil.test/a.mp4" autoplay onplay="alert(1)"></video><audio src=x onerror=alert(1)></audio><picture><source srcset="https://evil.test/a.png"></picture>'],
  ['details with a handler', '<details open ontoggle=alert(1)><summary>x</summary></details>'],
  ['a comment and a declaration', '<!-- <img src=x onerror=alert(1)> -->\n\n<!DOCTYPE html>\n\n<?php echo 1 ?>\n\n<![CDATA[ <script>alert(1)</script> ]]>'],
  ['a link to a script', '[click](javascript:alert(1)) and [again](JaVaScRiPt:alert(1)) and [vb](vbscript:msgbox(1))'],
  ['a link to data', '[page](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==) and [file](file:///C:/Windows/system.ini)'],
  ['an image in every form', '![a](https://evil.test/a.png) ![b](javascript:alert(1)) ![c](data:image/svg+xml,<svg onload=alert(1)>) ![d][ref] ![e](//evil.test/e.png "title")\n\n[ref]: https://evil.test/ref.png'],
  ['an image inside a link', '[![alt](https://evil.test/a.png)](https://evil.test/target)'],
  ['autolinks', '<javascript:alert(1)> <https://evil.test/x> https://evil.test/y www.evil.test mailto:a@evil.test a@evil.test'],
  ['hostile link definitions', '[a] and [b][] and [c][c]\n\n[a]: javascript:alert(1)\n[b]: data:text/html,<script>alert(1)</script>\n[c]: https://evil.test "<img src=x onerror=alert(1)>"'],
  ['hostile note definitions', 'A note[^x] and another[^y].\n\n[^x]: <img src=x onerror=alert(1)> and [link](javascript:alert(1))\n\n[^y]: ![img](https://evil.test/y.png)'],
  ['references as markup', '&lt;script&gt;alert(1)&lt;/script&gt; &#60;img src=x onerror=alert(1)&#62; &#x3C;iframe src=javascript:alert(1)&#x3E;'],
  ['a title with markup', '[x](https://evil.test "\\"><img src=x onerror=alert(1)>")'],
  ['a heading, a quote, a list and a table with markup', '# <img src=x onerror=alert(1)>\n\n> <script>alert(1)</script>\n\n- <a href="javascript:alert(1)">x</a>\n\n| <img src=x> | [y](javascript:alert(1)) |\n|--|--|\n| <b onclick=alert(1)>z</b> | ![i](https://evil.test/i.png) |'],
  ['a code block of markup', '```html\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n```\n\n    <iframe src="https://evil.test"></iframe>\n\n`<img src=x onerror=alert(1)>`'],
  ['a fence whose language is markup', '```"><img src=x onerror=alert(1)>\ncode\n```'],
  ['a task box with markup', '- [x] <input type="checkbox" checked onclick="alert(1)"> done\n- [ ] <button onclick="alert(1)">press</button>'],
  ['quotes nested very deep', `${Array.from({ length: 400 }, (_, depth) => `${'> '.repeat(depth + 1)}level ${depth + 1}`).join('\n')}\n\n<script>alert(1)</script>`],
  ['lists nested very deep', Array.from({ length: 200 }, (_, depth) => `${'  '.repeat(depth)}- <img src=x onerror=alert(1)> level ${depth + 1}`).join('\n')],
  ['brackets and emphasis without end', `${'['.repeat(2000)}x${']'.repeat(2000)}\n\n${'*'.repeat(3000)}\n\n${'<'.repeat(2000)}\n\n${'![]('.repeat(500)}`],
  ['a very long line of markup', `<img src=x onerror=alert(1)>`.repeat(2000)],
  ['control characters and a null', 'a\u0000b <scr\u0000ipt>alert(1)</scr\u0000ipt> \u202e<img src=x onerror=alert(1)>'],
  // M19b: what a reference could be made to carry.
  ['links to files, shares and other machines', '[a](C:/Windows/system.ini) [b](\\\\evil.test\\share\\x.md) [c](//evil.test/share/x.md) [d](file://evil.test/share/x.md) [e](../../../../etc/passwd) [f](/etc/shadow:1)'],
  ['code spans that read as paths', '`../../../etc/passwd` `C:\\Windows\\system.ini` `\\\\evil.test\\share\\x.md` `/etc/shadow` `~/.ssh/id_rsa.txt` `README.md` `<img src=x onerror=alert(1)>.md`'],
  ['a link whose text is a path and whose address is another', '[`src/harmless.md`](https://evil.test/collect?alert(1)) and [https://example.com](https://evil.test/other)'],
  ['addresses that are nearly external', '[a](https://user:secret@evil.test/) [b](HTTPS://EVIL.test/x) [c](https://evil.test/' + 'a'.repeat(9000) + ') <https://evil.test/\u202egnp.exe> [d](http://) [e](https:evil.test)'],
];

/** The cases whose hostile part is in a place that draws nothing: a link's title, and a fence's line after its language. */
const NOT_DRAWN: readonly string[] = ['a title with markup', 'a fence whose language is markup'];

/** Elements a text must never make, whatever the fixed list says. */
const NEVER = 'a, img, script, iframe, object, embed, link, style, form, input, textarea, select, option, svg, video, audio, source, picture, base, meta, details, summary, canvas, template, slot, b, i';
/**
 * The attributes fat-g's own elements carry. Nothing a text says becomes another. `data-md-lines`
 * is a block's lines (M19b, C41), and `data-md-line-offsets` a hard-break-separated passage's source
 * offsets; `data-reference` and `aria-hidden` are a control's own (C17, C24).
 */
const ATTRIBUTES = new Set(['class', 'data-md-block', 'data-md-lines', 'data-md-line-offsets', 'tabindex', 'aria-label', 'role', 'style', 'start', 'value', 'type', 'title', 'data-copy', 'data-reference', 'aria-hidden']);
/** Attributes that load, navigate or run something, by any element. */
const ACTIVE = ['href', 'src', 'srcset', 'action', 'formaction', 'srcdoc', 'data', 'ping', 'target', 'download', 'poster', 'background', 'xlink:href'];

let requests: string[];
let opened: string[];
const opener: Opener = { platform: 'win32', open: (address, kind) => { opened.push(`${kind} ${address}`); return Promise.resolve(null); }, show: () => Promise.resolve(null), copyPath: () => Promise.resolve(null) };
beforeEach(() => {
  requests = [];
  opened = [];
  vi.stubGlobal('fetch', (...args: unknown[]) => { requests.push(`fetch ${String(args[0])}`); return Promise.reject(new Error('no network')); });
  vi.spyOn(window, 'open').mockImplementation((url) => { requests.push(`open ${String(url)}`); return null; });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each([['with no opener', false], ['with an opener (M19b)', true]] as const)('a hostile text, %s (V13)', (_how, withOpener) => {
  it.each(HOSTILE)('%s: draws only elements of the fixed list, with no address, no handler and no request', (_name, text) => {
    const made: string[] = [];
    const create = document.createElement.bind(document);
    const creating = vi.spyOn(document, 'createElement').mockImplementation((tag: string, options?: ElementCreationOptions) => { made.push(tag.toLowerCase()); return create(tag, options); });
    const { container } = render(withOpener ? <OpenerContext value={opener}><MarkdownText text={text} /></OpenerContext> : <MarkdownText text={text} />);
    creating.mockRestore();

    const elements = [...container.querySelectorAll('*')];
    // Nothing outside the list was ever created, drawn or not (the first is testing-library's own container).
    expect([...new Set(made.slice(1))].filter((tag) => !(MARKDOWN_ELEMENTS as readonly string[]).includes(tag))).toEqual([]);
    expect([...new Set(elements.map((element) => element.tagName.toLowerCase()))].filter((tag) => !(MARKDOWN_ELEMENTS as readonly string[]).includes(tag))).toEqual([]);
    expect(container.querySelector(NEVER)).toBeNull();

    for (const element of elements) {
      const names = element.getAttributeNames();
      expect(names.filter((name) => !ATTRIBUTES.has(name)), element.tagName).toEqual([]);
      expect(names.filter((name) => name.startsWith('on') || ACTIVE.includes(name)), element.tagName).toEqual([]);
      // The one inline style is a table cell's alignment.
      if (names.includes('style')) expect(element.getAttribute('style')).toMatch(/^text-align: (left|right|center);$/);
      if (element.tagName !== 'BUTTON') continue;
      expect(element.getAttribute('type')).toBe('button');
      // The controls are fat-g's own: a code block's Copy button and, with an opener, a reference's.
      const reference = element.parentElement?.getAttribute('data-reference') ?? null;
      if (reference === null) expect(element.getAttribute('aria-label')).toBe('Copy code');
      else {
        expect(withOpener).toBe(true);
        expect(['external', 'local']).toContain(reference);
        // No control inside another (C57).
        expect(element.querySelector('button')).toBeNull();
      }
    }
    if (!withOpener) expect(container.querySelector('[data-reference]')).toBeNull();
    // Drawing opens nothing and asks for nothing: only a press hands an address over.
    expect(requests).toEqual([]);
    expect(opened).toEqual([]);
    // The text is still there to read: nothing of it was swallowed as markup. (A link's title and
    // the rest of a fence's first line are the two things a text holds that are not drawn at all.)
    if (text.includes('alert(1)') && !NOT_DRAWN.includes(_name)) expect(container.textContent).toContain('alert(1)');
  });

  it('draws quotes and lists as such no deeper than its bound, and what is nested past it as text', () => {
    const quotes = `${Array.from({ length: 400 }, (_, depth) => `${'> '.repeat(depth + 1)}level ${depth + 1}`).join('\n')}`;
    const { container } = render(<MarkdownText text={quotes} />);
    let depth = 0;
    for (let quote = container.querySelector('blockquote'); quote !== null; quote = quote.querySelector(':scope > blockquote')) depth += 1;
    expect(depth).toBeGreaterThan(10);
    expect(depth).toBeLessThanOrEqual(MAX_DEPTH);
    expect(container.textContent).toContain('level 400');
  });
});

describe('the fixed list', () => {
  it('is held to what a text needs: no anchor, no image and no input is on it', () => {
    for (const tag of ['a', 'img', 'input', 'script', 'iframe', 'object', 'embed', 'form', 'svg', 'style', 'link']) expect(MARKDOWN_ELEMENTS as readonly string[]).not.toContain(tag);
  });

  it('is the same with an opener as without: a control is a `button`, which a code block’s Copy button already is (M19b, C17)', () => {
    expect(MARKDOWN_ELEMENTS.filter((tag) => tag === 'button')).toHaveLength(1);
  });
});

describe('a hostile reference, pressed (M19b; C17, C57)', () => {
  it('hands the opener the address as it was written, and nothing else happens in the page', async () => {
    const { container } = render(
      <OpenerContext value={opener}>
        <MarkdownText text={'[`src/harmless.md`](https://evil.test/collect) and `../../etc/passwd` and [x](javascript:alert(1))'} />
      </OpenerContext>,
    );
    const buttons = [...container.querySelectorAll<HTMLButtonElement>('[data-reference] > button')];
    expect(buttons).toHaveLength(2);
    for (const button of buttons) button.click();
    await Promise.resolve();
    // The link's one address, whatever its text looks like; the code span's text as a local path; the script's never.
    expect(opened).toEqual(['external https://evil.test/collect', 'local ../../etc/passwd']);
    expect(requests).toEqual([]);
    expect(container.querySelector('a, [href]')).toBeNull();
  });
});
