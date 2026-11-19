// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from 'react';
import type { ResolvedAvatar } from '@shared/contracts/avatars';
import { type CatalogState, findModel } from '@shared/contracts/catalog';
import type { SessionGrant } from '@shared/contracts/interaction';
import { actionStatus, type AgentView, attentionWords, capitalize, formatElapsed, orderAgents, type SessionEntry } from '@shared/contracts/sessions';
import { GRANT_WORDS } from '../../session-area/mode-words';
import { Avatar, useBarColor } from '../../sessions/Avatar';
import { useElapsed } from '../../sessions/session-clock';
import { useActionWords } from '../../sessions/useActionWords';
import { useAppState } from '../../state/store';
import { StatusStream, streamStyle, useProviderStream } from '../../ui/status-stream/StatusStream';
import streamStyles from '../../ui/status-stream/StatusStream.module.css';
import type { ChosenAgent } from './AgentsBody';
import { AgentThread } from './AgentThread';
import { GrantsList } from './GrantsList';
import { AGENTS_WORDS, completedText, numbered } from './words';
import styles from './Agents.module.css';

export interface AgentStackProps {
  readonly entry: SessionEntry;
  readonly grants: readonly SessionGrant[];
  readonly completedOpen: boolean;
  readonly grantsOpen: boolean;
  readonly chosen: ChosenAgent | null;
  readonly onChange: (next: { readonly completedOpen?: boolean; readonly grantsOpen?: boolean; readonly chosen?: ChosenAgent | null }) => void;
}

/** What a row's button is given by the stack: its place in the keyboard's one stop, and its press. */
interface RowButtonProps {
  readonly ref: (element: HTMLButtonElement | null) => void;
  readonly type: 'button';
  readonly 'data-row': string;
  readonly 'aria-expanded': boolean;
  readonly 'aria-controls': string | undefined;
  readonly 'aria-label': string;
  readonly tabIndex: number;
  readonly onFocus: () => void;
  readonly onMouseDown: (event: { preventDefault(): void }) => void;
  readonly onClick: () => void;
}

/** The model in a row's accessible name: the sub-agent's, else its session's, assumed. */
interface ShownModel {
  readonly name: string;
  readonly assumed: boolean;
}

/** The catalog's display name of a key within the session's instance, else the key as the CLI wrote it (C18). */
function modelName(catalog: CatalogState | undefined, entry: SessionEntry, key: string): string {
  const model = findModel(catalog, { providerId: entry.record.providerId, instanceId: entry.record.instanceId }, key);
  return model.origin === 'generic' ? key : model.name;
}

function shownModel(catalog: CatalogState | undefined, entry: SessionEntry, agent: AgentView): ShownModel {
  const name = modelName(catalog, entry, agent.model ?? entry.summary.model);
  return { name, assumed: agent.model === null };
}

/** What a row draws for its avatar (M106, C16, C17): its own model's, else its session's. */
function avatarOf(entry: SessionEntry, agent: AgentView): ResolvedAvatar | null {
  const map = entry.agentAvatars;
  return agent.model !== null && map !== undefined && agent.id in map ? map[agent.id] ?? null : entry.avatar;
}

/** A row's state in words, for its accessible name: its attention, its action, or how it ended (C12). */
function stateWords(agent: AgentView): string {
  if (agent.attention !== null) return capitalize(attentionWords(agent.attention));
  if (agent.state === 'running') return agent.action?.label ?? actionStatus('thinking');
  return agent.state === 'completed' ? AGENTS_WORDS.completed : AGENTS_WORDS.failed;
}

/** "Sub-agent 3, Count files: Reading, on Sonnet 5.5": what a row is called, the assumption said (C12, C16). */
const spoken = (agent: AgentView, model: ShownModel): string => `Sub-agent ${agent.number}, ${agent.label}: ${stateWords(agent)}, on ${model.name}${model.assumed ? `, ${AGENTS_WORDS.assumedSpoken}` : ''}`;

function Chevron({ open }: { readonly open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
      <path d={open ? 'M5 9L12 16L19 9' : 'M9 5L16 12L9 19'} stroke="currentColor" strokeWidth="2.5" fill="none" />
    </svg>
  );
}

/**
 * A session's sub-agents as a stack (docs/planning/_archive/M106.md, Design 7; C5–C12, C30, C31, C40–C44): the
 * running ones as full rows, the most recently started on top and the longest-running at the bottom;
 * under them "n completed sub-agents", which unfolds the finished ones as thin rows, the most recently
 * finished first, and stays as the user set it across turns; under those "n grants", which unfolds
 * the grants fat-g sent. The order is `orderAgents`'. With none listed it says so.
 *
 * It is an accordion: each row is a button whose press unfolds its sub-agent's thread under it,
 * before the next row, the row and its thread framed as one box, and whose second press folds it; one
 * thread is unfolded at most. The rows are one stop for the keyboard: Up and Down move among the rows
 * drawn, Home and End to the ends, Enter or Space unfolds or folds; Tab goes from the unfolded row
 * into its thread, then on to the fold lines. A press of the pointer does the same and moves the focus
 * nowhere. A finished sub-agent whose thread is unfolded keeps the completed rows unfolded with it.
 */
export function AgentStack({ entry, grants, completedOpen, grantsOpen, chosen, onChange }: AgentStackProps) {
  const { summary } = entry;
  const sessionId = entry.record.id;
  const catalog = useAppState((state) => state.snapshot?.catalog);
  const base = useId();
  const { running, finished } = orderAgents(summary.agents);
  const chosenAgent = chosen === null ? undefined : summary.agents.find((agent) => agent.id === chosen.id);
  // One chosen from the chat that the list does not hold (C24); one that left the list is dropped by the body.
  const unlisted = chosen !== null && chosenAgent === undefined && chosen.listed !== true ? chosen : null;
  const finishedShown = finished.length > 0 && (completedOpen || (chosenAgent !== undefined && chosenAgent.state !== 'running'));
  const rows = [...running, ...(finishedShown ? finished : [])];
  const ids = rows.map((agent) => agent.id);
  // The row that last held the keyboard is the stack's one stop: the chosen one, else the first, until then.
  const [held, setHeld] = useState<string | null>(null);
  const stop = held !== null && ids.includes(held) ? held : chosen !== null && ids.includes(chosen.id) ? chosen.id : ids[0];
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const threadId = `${base}thread`;

  const choose = (id: string, label: string | null): void => {
    setHeld(id);
    onChange({ chosen: chosen?.id === id ? null : { id, label, listed: true } });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement;
    const at = ids.indexOf(target.getAttribute('data-row') ?? '');
    if (at === -1 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const move = event.key === 'ArrowUp' ? Math.max(0, at - 1) : event.key === 'ArrowDown' ? Math.min(ids.length - 1, at + 1) : event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : -1;
    if (move === -1) return;
    event.preventDefault();
    const next = ids[move];
    if (next !== undefined) buttons.current.get(next)?.focus();
  };

  const rowProps = (agent: AgentView, model: ShownModel): RowButtonProps => ({
    ref: (element: HTMLButtonElement | null) => { if (element === null) buttons.current.delete(agent.id); else buttons.current.set(agent.id, element); },
    type: 'button',
    'data-row': agent.id,
    'aria-expanded': chosen?.id === agent.id,
    'aria-controls': chosen?.id === agent.id ? threadId : undefined,
    'aria-label': spoken(agent, model),
    tabIndex: stop === agent.id ? 0 : -1,
    onFocus: () => setHeld(agent.id),
    // The pointer chooses and leaves the focus where it was (C43).
    onMouseDown: (event) => event.preventDefault(),
    onClick: () => choose(agent.id, agent.label),
  });

  const box = (agent: AgentView, row: ReactNode): ReactNode => {
    const open = chosen?.id === agent.id;
    return (
      <div key={agent.id} className={open ? `${styles.box} ${styles.open}` : styles.box} data-agent={agent.id} data-state={agent.state} data-open={open || undefined}>
        {row}
        {open && <AgentThread sessionId={sessionId} workerId={agent.id} id={threadId} label={agent.label} />}
      </div>
    );
  };

  const finishedChosen = chosenAgent !== undefined && chosenAgent.state !== 'running';
  return (
    <>
      <div className={styles.stack} role="group" aria-label={AGENTS_WORDS.title} data-agent-list="" onKeyDown={onKeyDown}>
        {unlisted !== null && (
          <div className={`${styles.box} ${styles.open}`} data-agent={unlisted.id} data-unlisted="" data-open="">
            <AgentThread sessionId={sessionId} workerId={unlisted.id} id={threadId} label={unlisted.label} onFold={() => onChange({ chosen: null })} />
          </div>
        )}
        {summary.agents.length === 0 && unlisted === null && <p className={styles.none}>{AGENTS_WORDS.none}</p>}
        {running.map((agent) => {
          const model = shownModel(catalog, entry, agent);
          return box(agent, <RunningRow agent={agent} entry={entry} {...rowProps(agent, model)} />);
        })}
        {finished.length > 0 && (
          <button
            type="button"
            className={styles.fold}
            aria-expanded={finishedShown}
            data-completed-fold=""
            // Folding the finished ones folds the thread of one of them with them.
            onClick={() => onChange(finishedShown ? { completedOpen: false, ...(finishedChosen ? { chosen: null } : {}) } : { completedOpen: true })}
          >
            <span>{completedText(finished.length)}</span>
            <Chevron open={finishedShown} />
          </button>
        )}
        {finishedShown && finished.map((agent) => {
          const model = shownModel(catalog, entry, agent);
          return box(agent, <ThinRow agent={agent} entry={entry} {...rowProps(agent, model)} />);
        })}
      </div>
      {grants.length > 0 && (
        <button type="button" className={styles.fold} aria-expanded={grantsOpen} data-grants-fold="" onClick={() => onChange({ grantsOpen: !grantsOpen })}>
          <span>{GRANT_WORDS.fold(grants.length)}</span>
          <Chevron open={grantsOpen} />
        </button>
      )}
      {grantsOpen && grants.length > 0 && <GrantsList entry={entry} grants={grants} />}
    </>
  );
}

interface RowProps extends RowButtonProps {
  readonly agent: AgentView;
  readonly entry: SessionEntry;
}

/**
 * A running sub-agent (C6–C8): a capsule's height, the avatar at its full height at the left, its
 * number and label on at most two lines, and under them the status row — its own action's status
 * words on its provider's colour, Thinking while it has none, or the attention block where a request
 * of its own waits on the user — with the time since it started at the bar's right edge.
 */
function RunningRow({ agent, entry, ...button }: RowProps) {
  const elapsed = useElapsed(agent.startedAt);
  const barColor = useBarColor(entry.record.providerId);
  const stream = useProviderStream(entry.record.providerId);
  const label = numbered(agent.number, agent.label);
  const actionWords = useActionWords(agent.action, agent.displayHold, agent.attention === null);
  return (
    <button className={styles.row} {...button}>
      <Avatar providerId={entry.record.providerId} avatar={avatarOf(entry, agent)} size="capsule" />
      <span className={styles.body}>
        <span className={styles.name} title={label}>{label}</span>
        <span
          className={`${styles.status} ${streamStyles.surface}`}
          data-capsule-status=""
          data-state="running"
          data-attention={agent.attention?.kind}
          data-acknowledged={agent.attention?.acknowledged || undefined}
          data-stream={stream === undefined ? undefined : ''}
          style={{ ...(barColor === undefined ? {} : { '--bar-color': barColor }), ...(stream === undefined ? {} : streamStyle(stream)) }}
        >
          <StatusStream active={agent.attention === null} waiting={agent.action?.kind === 'waiting'} available={stream !== undefined} immediate={agent.attention !== null} compact />
          <span className={styles.statusText}>
            {agent.attention !== null ? capitalize(attentionWords(agent.attention)) : actionWords}
          </span>
          <span className={styles.time} data-time="">{elapsed}</span>
        </span>
      </span>
    </button>
  );
}

/** A finished sub-agent (C9): half a capsule's height, the small avatar, its number and label on one line in the muted colour, then how it ended and its duration. */
function ThinRow({ agent, entry, ...button }: RowProps) {
  const label = numbered(agent.number, agent.label);
  const ended = agent.state === 'completed' ? AGENTS_WORDS.completed : AGENTS_WORDS.failed;
  const duration = agent.finishedAt === null ? null : formatElapsed(Math.max(0, agent.finishedAt - agent.startedAt));
  return (
    <button className={styles.thinRow} {...button}>
      <Avatar providerId={entry.record.providerId} avatar={avatarOf(entry, agent)} size="thin" />
      <span className={styles.thinName} title={label}>{label}</span>
      <span className={styles.thinState} data-time="">{duration === null ? ended : `${ended} ${duration}`}</span>
    </button>
  );
}
