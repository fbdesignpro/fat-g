// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type CSSProperties, useRef } from 'react';
import { notStarted, type ContextReading, type SessionEntry } from '@shared/contracts/sessions';
import { useAppState } from '../state/store';
import { Tooltip, useTooltip } from '../ui/Tooltip';
import { CONTEXT_CELLS, contextCells, contextPercent, contextSections } from './context-view';
import { CONTEXT_WORDS, formatTokens } from './context-words';
import { sessionAccount, useReportsContext, useSessionCatalog } from './selected';
import styles from './ContextMeter.module.css';

/**
 * How full the chat's context window is (decision 0033), beside the mode control: a black strip
 * of two rows of cells, filled a column at a time from the left in the
 * provider's colour, the cells from the CLI's compaction line onward on a dark red ground. Its
 * tooltip holds the detail the CLI gave. With no reading yet — the CLIs start their process at a
 * turn — the cells stand empty and the tooltip says when one comes. A provider that reports none
 * draws no meter. A new chat shows no meter until its first turn starts.
 */
export function ContextMeter({ entry }: { readonly entry: SessionEntry }) {
  const reports = useReportsContext(entry.record.providerId);
  const { presentation } = useSessionCatalog(entry);
  const providerName = sessionAccount(useAppState((state) => state.snapshot?.providers), entry.record).name;
  const anchor = useRef<HTMLDivElement>(null);
  const tooltip = useTooltip();
  if (!reports || notStarted(entry)) return null;
  const reading = entry.summary.context;
  const { filled, compactFrom } = contextCells(reading);
  const color = presentation === undefined ? undefined : ({ '--bar-color': presentation.barColor } as CSSProperties);
  return (
    <div className={styles.context} data-context-meter="" data-unavailable={reading === undefined ? '' : undefined} style={color}>
      <div
        ref={anchor}
        className={styles.meter}
        role="meter"
        tabIndex={0}
        aria-label={CONTEXT_WORDS.meterName}
        aria-valuemin={0}
        aria-valuemax={reading?.window ?? 1}
        aria-valuenow={reading === undefined ? 0 : Math.min(reading.used, reading.window)}
        aria-valuetext={reading === undefined ? CONTEXT_WORDS.none : CONTEXT_WORDS.valueText(reading.used, reading.window, contextPercent(reading))}
        data-filled-cells={filled}
        data-compact-from={compactFrom ?? undefined}
        {...tooltip.targetProps}
      >
        {Array.from({ length: CONTEXT_CELLS }, (_unused, at) => (
          <span key={at} className={styles.cell} data-filled={at < filled ? '' : undefined} data-compact={compactFrom !== null && at >= compactFrom ? '' : undefined} />
        ))}
      </div>
      {/* Above: the meter stands at the foot of the chat, where a table below would leave the window. */}
      <Tooltip id={tooltip.id} open={tooltip.open} anchor={anchor} side="above" className={styles.tooltip}>
        <ContextTip reading={reading} providerName={providerName} color={color} />
      </Tooltip>
    </div>
  );
}

/** The compaction line: where the CLI compacts by itself, that it will not, or that it does not say. */
function compactLine(reading: ContextReading, providerName: string): string {
  const { compactAt } = reading;
  if (compactAt === null) return CONTEXT_WORDS.compactOff;
  if (compactAt === undefined) return CONTEXT_WORDS.notReported(providerName);
  return CONTEXT_WORDS.compactAt(compactAt, Math.round((compactAt / reading.window) * 100));
}

/**
 * The tooltip's content: the header with the count, the window and the share, the compaction line,
 * then one table — a section a group the CLI counted, a row a part, each with its count and a bar
 * of its share of the section's largest — and the unit's line. Portalled with the tooltip, it sets
 * the provider's colour again, since it inherits nothing of the meter's.
 */
export function ContextTip({ reading, providerName, color }: { readonly reading: ContextReading | undefined; readonly providerName: string; readonly color?: CSSProperties | undefined }) {
  if (reading === undefined) return <p className={styles.none}>{CONTEXT_WORDS.none}</p>;
  const sections = contextSections(reading);
  return (
    <div className={styles.tip} style={color} data-context-tip="">
      <p className={styles.head}>
        <span>{CONTEXT_WORDS.label}</span>
        <span data-context-total="">{CONTEXT_WORDS.header(reading.used, reading.window, contextPercent(reading))}</span>
      </p>
      <p className={styles.line} data-context-compaction="">{compactLine(reading, providerName)}</p>
      {sections.length > 0 && (
        <table className={styles.table}>
          <thead>
            <tr>
              <td />
              <th scope="col" className={styles.unit}>{CONTEXT_WORDS.unit}</th>
              <td />
            </tr>
          </thead>
          {sections.map((section) => (
            <tbody key={section.key} data-context-section={section.key}>
              <tr>
                <th scope="colgroup" colSpan={3} className={styles.section}>{section.title}</th>
              </tr>
              {section.rows.map((row) => (
                <tr key={row.key} data-context-row={row.key}>
                  <th scope="row" className={styles.label}>{row.label}</th>
                  <td className={styles.tokens}>{formatTokens(row.tokens)}</td>
                  <td className={styles.bar}>
                    <span className={styles.track}>
                      {row.tokens > 0 && <span className={styles.fill} data-share={row.share} style={{ '--context-share': row.share } as CSSProperties} />}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      )}
      <p className={styles.footer}>{CONTEXT_WORDS.footer}</p>
    </div>
  );
}
