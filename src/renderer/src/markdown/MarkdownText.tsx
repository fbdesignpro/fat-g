// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { Component, Fragment, memo, type ReactNode, useContext, useId, useLayoutEffect, useMemo, useRef } from 'react';
import { BlockControlContext, CONTROL_ATTRIBUTE } from './inert';
import { NOTE_DEFINITION_TOKEN, parse, type Parsed } from './parse';
import { Block, Notes } from './render';
import { BLOCK_ATTRIBUTE, LINES_ATTRIBUTE } from './selection';
import styles from './Markdown.module.css';

let failures = 0;
/** How many times a text could not be drawn as Markdown, and was drawn plain (C37): a count, and never the text. */
export const markdownFailures = (): number => failures;

/** A text as text: its line breaks and spaces kept, long words wrapped, as a message was drawn before M19. */
export function PlainText({ text }: { readonly text: string }) {
  return <p className={styles.plain}>{text}</p>;
}

interface FallbackProps { readonly text: string; readonly children: ReactNode }
interface FallbackState { readonly text: string; readonly failed: boolean }

/** Catches a renderer that throws (C37): the text it threw on is drawn plain, whole, until the text changes. */
class Fallback extends Component<FallbackProps, FallbackState> {
  override state: FallbackState = { text: this.props.text, failed: false };

  /** Another text is another try. */
  static getDerivedStateFromProps(props: FallbackProps, state: FallbackState): FallbackState | null {
    return props.text === state.text ? null : { text: props.text, failed: false };
  }

  static getDerivedStateFromError(): Partial<FallbackState> {
    return { failed: true };
  }

  override componentDidCatch(): void {
    // Counted, and nothing of the text is said of it.
    failures += 1;
  }

  override render(): ReactNode {
    return this.state.failed ? <PlainText text={this.props.text} /> : this.props.children;
  }
}

/** The text read as Markdown, or null when the lexer threw. */
function read(text: string): Parsed | null {
  try {
    return parse(text);
  } catch {
    failures += 1;
    return null;
  }
}

/**
 * A text drawn as Markdown (docs/planning/_archive/M19.md, Design 6; C28–C37, C61, C62, C65–C67; decision
 * 0021). It takes a text and nothing else: it knows no message, turn or session, so a file in the
 * artifact pane and a plan are drawn by the same component, under the same rules.
 *
 * What is drawn depends on the text alone (C66): the whole text is lexed again whenever it changes,
 * so a text that arrived in pieces draws exactly as the same text given whole — an unclosed fence a
 * code block to its end, nothing closed or guessed ahead of what is there (C36). What is kept from
 * one text to the next is the drawing: each block by its place, drawn again only when its source
 * or what it names changed (C65, C67).
 *
 * Nothing a text says is acted on by itself (C31–C33): no image loads, raw HTML is the text it is,
 * and no element carries an address of the text's own. With no opener no link opens; where one is
 * given through its context, a reference is a control that hands its address to it (M19b, C16). A
 * text that cannot be drawn is drawn plain, whole (C37).
 *
 * Each top-level block's element carries the first and last line of its source (M19b, C41). They are
 * written here after each reading, and not by a block's own drawing: when an earlier block gains a
 * line, every later block's lines shift while its source is as it was, and it is not drawn again.
 *
 * Where the text is given something to draw beside its blocks (M20b, C46), each block that draws
 * anything has it directly before its element, in the margin: a sibling that holds no text of the
 * text's own, so a selection and a copy are as they are without it.
 */
/** The blocks that draw nothing: no control stands beside one. */
const DRAWS_NOTHING: readonly string[] = ['space', 'def', NOTE_DEFINITION_TOKEN];

export const MarkdownText = memo(function MarkdownText({ text }: { readonly text: string }) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const control = useContext(BlockControlContext);
  const parsed = useMemo(() => read(text), [text]);
  useLayoutEffect(() => {
    if (root.current === null || parsed === null) return;
    const lines = new Map(parsed.blocks.map((block) => [`${id}${block.index}`, `${block.firstLine}-${block.lastLine}`]));
    // A block's element is a child of the text's own: a block that draws nothing has none.
    for (const element of root.current.children) {
      const held = lines.get(element.getAttribute(BLOCK_ATTRIBUTE) ?? '');
      if (held !== undefined && element.getAttribute(LINES_ATTRIBUTE) !== held) element.setAttribute(LINES_ATTRIBUTE, held);
    }
  }, [id, parsed]);
  if (parsed === null) return <PlainText text={text} />;
  const firstBeside = control === null ? -1 : parsed.blocks.find((block) => !DRAWS_NOTHING.includes(block.token.type))?.index ?? -1;
  return (
    <Fallback text={text}>
      <div ref={root} className={styles.markdown}>
        {parsed.blocks.map((block) => (
          // A block keeps its place whether or not something stands beside it: it is not drawn again when that changes.
          <Fragment key={block.index}>
            {control !== null && !DRAWS_NOTHING.includes(block.token.type) && (
              <span className={styles.blockControl} {...{ [CONTROL_ATTRIBUTE]: `${id}${block.index}` }}>
                {control({ index: block.index, id: `${id}${block.index}`, firstLine: block.firstLine, lastLine: block.lastLine, first: block.index === firstBeside })}
              </span>
            )}
            <Block id={`${id}${block.index}`} block={block} />
          </Fragment>
        ))}
        {parsed.notes.length > 0 && <Notes notes={parsed.notes} signature={parsed.notesSignature} named={parsed.named} />}
      </div>
    </Fallback>
  );
});
