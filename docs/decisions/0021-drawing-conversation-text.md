# 0021 — Conversation text is drawn as elements, by fat-g's own renderer

> **Rule:** an assistant's message is read as Markdown and drawn as React elements from a fixed list — never an HTML string, and no code of fat-g's sets `innerHTML`. Nothing a text says is acted on by itself: no image is loaded, raw HTML is the text it is, and no element carries an address of the text's own. A link opens nothing unless the text is drawn with an opener; then a reference is a `button` that hands its address to it, and what happens to that address is [0022](0022-reading-project-files.md)'s. The parser is `marked`'s lexer, bundled into the page and imported by one file, behind a component that takes a text and nothing else.

- **Status:** Accepted by the maintainer with M19's final spec (C28–C37, C61, C62, C65–C67; maintainer decision 4, after spike K3). Implemented in M19. Amended with M19b (C16–C19, C41, C50, C57, C58, C64, C65): a reference as a control, a file's name in bold or in italics among them, the line the words beside one say, and each block's lines on its element.
- **Applies to:** `src/renderer/src/markdown/`, `src/shared/markdown/`, and every later place that draws text a provider or a file gave: the artifact pane (M19b), a plan (M20). Builds on [0004](0004-never-touch-credentials.md) (no network of fat-g's own), [0007](0007-packaged-build-contents.md) (what a package holds) and [0019](0019-conversation-store.md) (where the text is kept).

## Context

- An assistant's message is written in Markdown. Until M19 the chat drew it as plain text: its headings, lists, tables and code could not be told apart.
- The text is not fat-g's. It comes from a model, and through it from whatever the model read: a file, a web page, a tool's output. A text that could make the page load an address, run a handler or open a link would be a way for any of those to reach the user's machine and their attention.
- The page's content policy already refuses remote scripts, images and frames, and main cancels every request that is not the app's own ([0004](0004-never-touch-credentials.md)). Those are the second line. The first is that the page never makes an element that would ask.
- A message is drawn many times while it is written: at every update of a text that grows to 100,000 units. What reads it has to be fast on a text of that size, and what draws it has to leave alone what did not change.
- Spike K3 compared `react-markdown` with `remark-gfm` against `marked`'s lexer with a renderer of the spike's own, in the page under fat-g's policy, development and packaged (chat protocols (private research note)).

## Decision

1. **Elements, never HTML.** A text is lexed into tokens, and fat-g's own code turns the tokens into React elements. No `Parser`, no `Renderer`, no HTML string exists at any point, and a test finds neither `innerHTML` nor `dangerouslySetInnerHTML` in the page's source.
2. **A fixed list of elements.** A drawn text holds only the elements [`render.tsx`](../../src/renderer/src/markdown/render.tsx) lists: blocks, headings, lists, quotes, rules, `pre` and `code`, tables, emphasis, and fat-g's own `button`: the Copy button on a code block, and a reference's control (item 11). No `a`, `img`, `input`, `script`, `iframe`, `object`, `embed`, `form`, `svg`, `style` or `link` is ever made from a text.
3. **Nothing a text says is acted on by itself.**
   - A link is its text, with its address after it in muted text where the two differ. Where no opener is given it is not a control and opens nothing.
   - An image is its alternative text and its address, as text. Nothing is loaded.
   - Raw HTML, block or inline, is drawn as the text it is.
   - A task's box is a glyph, not a control. A footnote is a numbered mark and a numbered note, with no link between them.
   - No element carries a handler, or an attribute holding an address from the text.
4. **`marked`'s lexer is the parser.** One package, at an exact version, a devDependency bundled into the page, credited in the notices, and imported by [`parse.ts`](../../src/renderer/src/markdown/parse.ts) alone. Footnotes are read by tokenizer extensions of fat-g's own, and character references are decoded by fat-g's own code: `marked` reads neither.
5. **The component takes a text alone.** `MarkdownText({ text })` knows no message, turn or session, so a file and a plan are drawn by the same code under the same rules. The parser sits behind it: another could replace it in `parse.ts` without a change elsewhere.
6. **The text alone decides what is drawn.** The whole text is lexed again whenever it changes. A text that arrived in pieces draws exactly as the same text given whole: an unclosed fence is a code block to its end, and nothing is closed or guessed ahead of what is there.
7. **Only what changed is drawn again.** A block is drawn again when its source or what it names changed, and a table's row when its own text, its columns' alignment or what it names changed. Every other block keeps its elements.
8. **A text that cannot be drawn is drawn plain.** A lexer or a renderer that throws is caught at the text, which is then shown whole as plain text. The failure is counted, and the text is never logged.
9. **What is not Markdown stays text.** A user's prompt, a notice, a notice's detail and a question's lines are drawn as the plain text they are: a prompt read as Markdown would have its paths, underscores and pasted code reshaped.
10. **No colouring of code.** A code block is the monospace font and a label for its language. There is no syntax highlighter.
11. **With an opener, a reference is a control** (M19b). The component still takes a text alone: an opener reaches it through a context, one value for a session, so that no block is drawn again for it. With one, four things are a `button` that hands its address to the opener at a click, Enter or Space: a link whose address names a file or a site, a code span whose whole text reads as a path, a file's name in bold or in italics that reads as one by the same rule, and a bare `http:` or `https:` address. A file's name in plain prose stays text. A link to anything else — `javascript:`, `data:`, `mailto:`, a fragment alone — stays the text it was.
    - It is a `button` and never an anchor: it carries no address of its own, so nothing can be navigated to, dragged out or opened in a window from it. The address is in its tooltip, as text.
    - An external control keeps its address after its text, so the reader sees where a press leads before it opens.
    - What it holds draws no control of its own: a code span inside a link's text is code, and a press gives the link's one address.
    - A reference to a file that names no line takes the one the words beside it say, `at line 12` after it or `line 12 of` before it. The words stay the text they were, and nothing but that number is made of them.
    - It is a stop in the tab order by the rule its text is drawn under, as a Copy button is: in a chat, only in the current message.
    - A chat without a session is given no opener, and a prompt, a notice and a question's lines are not drawn as Markdown: nothing in them is a control.
12. **Each block carries the lines of its source** (M19b). The top element of a block holds the first and last line of its source, written after each reading and not by the block's own drawing, so a block whose lines shift is not drawn again. A line is found by them, in a message as in a file.

## Why not `react-markdown`

K3 measured both in the page. On a table that grows to 100,000 units, `react-markdown`'s update took 38 to 50 ms at the median and up to 134 ms, over the 50 ms budget in a third of its updates, however it was used: its parser alone takes 58 to 90 ms on a block of that size. `marked` lexes the same text in 4 to 5 ms, and with a table's rows drawn each for its own text the worst update was 16 ms packaged. `react-markdown` with `remark-gfm` also adds 71 packages and 160 KB to the page, against one package and 46 KB.

## Consequences

- Footnotes, character references, the reading of a link's address and every element's drawing are fat-g's code to keep right. The hostile corpus in `markdown/safety.test.tsx` and the smoke run's hostile message hold decisions 1 to 3.
- A new `marked` version is a deliberate change: the version is exact, and `markdown/pieces.test.tsx` compares a text given in pieces with the same text whole at every update.
- Without an opener, links do nothing. Since M19b a session's messages and a shown file are drawn with one (item 11), and what a press may open is [0022](0022-reading-project-files.md)'s: a file inside the project's trusted folders, read by main, or an `http:` or `https:` address handed to the system's browser. The hostile corpus is drawn with an opener too, and holds the same: no element outside the list, no address on any element, nothing opened by drawing.
- Showing an image is later work, and would amend this record: which addresses, by whose action, through which allowlisted call.
  The Markdown still loads nothing. Under a finished answer, fat-g's own component draws the image files its local references name, through main's checks and the media route by an id, never by an address the text gave ([0022](0022-reading-project-files.md), item 15).
- Syntax colouring would need a tokenizer per language in the page, or a package that brings them. Neither is in M19.
- The page's layout matters as much as the parser: the message list is sized from its frame and never from what it holds, or every update measures the whole list again (M19, Results).

## Revisit when

- An image is to show. (A link opens since M19b: item 11.)
- Code is to be coloured.
- `marked` changes how it reads a construct the pieces test covers, or stops being maintained.
- A text larger than a message's bound is drawn: a file in the artifact pane may be.
