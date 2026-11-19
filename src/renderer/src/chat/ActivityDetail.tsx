// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type ReactNode, useContext, useMemo, useRef } from 'react';
import type { ActivityBody } from '@shared/contracts/activity';
import type { ConversationItem } from '@shared/contracts/conversation';
import { CodeText } from '../markdown/CodeText';
import { PathReference } from '../markdown/controls';
import { useTabStop } from '../markdown/inert';
import { formatDateTime } from '../ui/format';
import { ACTIVITY_LABELS, CHANGE_WORDS, CUT_WORDS, STEP_WORDS } from './activity-words';
import { useSourceMarkers } from './asides-store';
import { AsideMarkerButton, AsideSourceContext, useAsidePassages } from './ExplainControl';
import { activitySource, sourceAttributes } from './selection-report';
import styles from './Chat.module.css';

/**
 * An activity's input or its output (M20b, C45, C47, C74): the text it is, in the monospace font,
 * marked as what a selection in it came from where it is a source. It has no Explain this control
 * of its own: its asides' marker stands in its head row, beside Copy, and their passages are
 * painted in it.
 */
function PartText({ item, part, drawn, title, copyLabel, text, children }: { readonly item: ConversationItem; readonly part: 'input' | 'output'; readonly drawn: string; readonly title: string; readonly copyLabel: string; readonly text: () => string; readonly children: ReactNode }) {
  const scope = useContext(AsideSourceContext);
  const stop = useTabStop();
  const element = useRef<HTMLPreElement | null>(null);
  const { id, workerId } = item;
  const source = useMemo(() => (scope === null ? null : activitySource(id, part, workerId)), [scope, id, part, workerId]);
  const markers = useSourceMarkers(scope?.sessionId ?? null, source);
  useAsidePassages(element, scope?.sessionId ?? null, source, markers, drawn);
  return (
    <CodeText
      title={title}
      copyLabel={copyLabel}
      text={text}
      textRef={element}
      {...(source === null ? {} : { attributes: sourceAttributes(source) })}
      {...(scope !== null && markers.length > 0 ? { beside: <AsideMarkerButton sessionId={scope.sessionId} markers={markers} tabIndex={stop} /> } : {})}
    >
      {children}
    </CodeText>
  );
}

/** An output as the row shows it and as Copy takes it: whole, or its two halves with fat-g's line where the cut is (C5, C37). */
function outputParts(body: ActivityBody): { readonly head: string; readonly line: string | null; readonly tail: string } {
  const output = body.output ?? '';
  const cut = body.cut?.output ?? null;
  if (cut === null) return { head: output, line: null, tail: '' };
  return { head: output.slice(0, cut.at), line: CUT_WORDS.output(cut.omitted), tail: output.slice(cut.at) };
}

/**
 * What a row opens to (docs/planning/_archive/M20a.md, Design 8; C8, C10, C37–C41): the files the item names,
 * each a control through the opener; a checklist's steps with their state; an edit's changes, under
 * a line that says when they were reported; and its input and its output, each in the monospace
 * font with a Copy button of its own, scrolling sideways within itself as a code block does.
 *
 * Where something was cut, a line of fat-g's says so where the cut is. The input and output texts
 * draw no control: they are text, whatever they hold.
 *
 * Drawn only once its row is opened (C44).
 */
export function ActivityDetail({ item, body }: { readonly item: ConversationItem; readonly body: ActivityBody }) {
  const cut = body.cut;
  const gone = (field: 'input' | 'output'): boolean => cut !== null && cut.fields.includes(field) && (body[field] ?? '') === '';
  const output = outputParts(body);
  // What a worker reported; a launch that failed has its error, which is an output as any tool's is (C23).
  const worker = body.type === 'worker' && body.workerId !== null;
  // An edit's input says again what its changes show: the changes stand for it.
  const showInput = body.type !== 'edit' && (body.input ?? '') !== '';
  const reportedAt = item.time.receivedAt ?? item.time.providerAt;
  return (
    <>
      {body.files.length > 0 && (
        <ul className={styles.activityFiles} aria-label={ACTIVITY_LABELS.files}>
          {body.files.map((file, index) => (
            <li key={index}>
              <PathReference path={file.path} line={file.line}>{file.line === null ? file.path : `${file.path}:${file.line}`}</PathReference>
            </li>
          ))}
        </ul>
      )}
      {cut !== null && cut.files > 0 && <p className={styles.line} data-item-line="cut">{CUT_WORDS.files(cut.files)}</p>}
      {body.steps.length > 0 && (
        <ul className={styles.activitySteps}>
          {body.steps.map((step, index) => (
            <li key={index} data-step={step.state}>
              <span className={styles.stepState}>{STEP_WORDS[step.state]}</span> {step.text}
            </li>
          ))}
        </ul>
      )}
      {cut !== null && cut.steps > 0 && <p className={styles.line} data-item-line="cut">{CUT_WORDS.steps(cut.steps)}</p>}
      {body.changes.length > 0 && <p className={styles.line}>{ACTIVITY_LABELS.reported(reportedAt === null ? null : formatDateTime(reportedAt))}</p>}
      {body.changes.map((change, index) => (change.text === null ? (
        <p key={index} className={styles.activityChange}>{change.path} — {CHANGE_WORDS[change.kind]}</p>
      ) : (
        <CodeText key={index} title={`${change.path} — ${CHANGE_WORDS[change.kind]}`} copyLabel={ACTIVITY_LABELS.copyChange} text={() => change.text ?? ''}>
          <code>{change.text}</code>
        </CodeText>
      )))}
      {cut !== null && cut.changes > 0 && <p className={styles.line} data-item-line="cut">{CUT_WORDS.changes(cut.changes)}</p>}
      {cut !== null && cut.fields.includes('changes') && cut.changes === 0 && body.changes.length > 0 && <p className={styles.line} data-item-line="cut">{CUT_WORDS.changesCut}</p>}
      {showInput && (
        <PartText item={item} part="input" drawn={body.input ?? ''} title={ACTIVITY_LABELS.input} copyLabel={ACTIVITY_LABELS.copyInput} text={() => body.input ?? ''}>
          <code>{body.input}</code>
        </PartText>
      )}
      {showInput && cut !== null && cut.fields.includes('input') && <p className={styles.line} data-item-line="cut">{CUT_WORDS.input}</p>}
      {gone('input') && <p className={styles.line} data-item-line="cut">{CUT_WORDS.inputGone}</p>}
      {(body.output ?? '') !== '' && (
        <PartText
          item={item}
          part="output"
          drawn={body.output ?? ''}
          title={worker ? ACTIVITY_LABELS.report : ACTIVITY_LABELS.output}
          copyLabel={worker ? ACTIVITY_LABELS.copyReport : ACTIVITY_LABELS.copyOutput}
          text={() => (output.line === null ? output.head : `${output.head}\n${output.line}\n${output.tail}`)}
        >
          <code>{output.head}</code>
          {output.line !== null && (
            <>
              <span className={styles.cutLine} data-item-line="cut">{output.line}</span>
              <code>{output.tail}</code>
            </>
          )}
        </PartText>
      )}
      {gone('output') && <p className={styles.line} data-item-line="cut">{CUT_WORDS.outputGone}</p>}
    </>
  );
}
