// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type KeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { AsideSource } from '@shared/contracts/aside';
import { findModel } from '@shared/contracts/catalog';
import { askRefusalText, ASK_FAILED_TEXT, providerNameOf } from '../../chat/aside-actions';
import { WorkerOpenContext } from '../../chat/ActivityGroup';
import { showPassage } from '../../chat/aside-highlights';
import { useAsides } from '../../chat/asides-store';
import { LIST_MARK, MessageList } from '../../chat/MessageList';
import { SOURCE_KIND } from '../../chat/selection-report';
import { invoke } from '../../ipc/client';
import { OpenerContext } from '../../markdown/inert';
import { BLOCK_ATTRIBUTE, blockLines } from '../../markdown/selection';
import { useAppState } from '../../state/store';
import { ASIDE_KIND, createOpener, openAgent, openReference } from '../opener';
import type { TabBodyProps } from '../tab-kind';
import { ArtifactBar } from '../ArtifactBar';
import { tabId, takeHanded, useTabs } from '../tabs-store';
import { useAsideChat } from './useAsideChat';
import { askQuestion } from './ask';
import { ASIDE_REFUSALS, ASIDE_WORDS, sourceWords, tabTitle } from './words';
// The field is the chat's own input, by its one rule (C37, C68).
import chatStyles from '../../chat/Chat.module.css';
import styles from './Aside.module.css';

/** The attribute that marks an aside's list: the chat's own mark is the chat's alone. */
export const ASIDE_LIST_MARK = 'data-aside-list';

/**
 * What the pane keeps for an aside's tab between showings (C38): the follow-up being typed, and the
 * last naming of its field that asked for the focus, with the one it was given at.
 */
export interface AsideViewState {
  readonly draft?: string;
  readonly focus?: number;
  readonly focused?: number;
  readonly excerptExpanded?: boolean;
}

/**
 * Comes to what an aside's passage was taken from (C37): the passage in the chat, a sub-agent's thread (M106, C4),
 * or the file at its first line. In the chat it is the passage itself that is brought into view,
 * where it is painted — an answer may be many screens long, and its middle is not where the passage
 * is; else the block its lines begin in; else the message, from its start.
 */
function comeTo(sessionId: string, asideId: string, source: AsideSource): void {
  if (source.kind === 'file' && source.path !== null) {
    void openReference(sessionId, source.path, { local: true, ...(source.lines === null ? {} : { line: source.lines.first }) });
    return;
  }
  if (source.workerId !== null) { openAgent(sessionId, source.workerId, null); return; }
  if (source.itemId === null) return;
  // Where the chat holds it in its window: an item that an older page holds is not brought back for this.
  const marked = document.querySelector(`[${LIST_MARK}] [${SOURCE_KIND}][data-source-item="${CSS.escape(source.itemId)}"]`);
  if (marked === null || showPassage(marked, asideId)) return;
  const first = source.lines?.first;
  const block = first === undefined ? undefined : [...marked.querySelectorAll(`[${BLOCK_ATTRIBUTE}]`)].find((element) => {
    const lines = blockLines(element);
    return lines !== null && lines.first <= first && first <= lines.last;
  });
  if (block !== undefined) block.scrollIntoView?.({ block: 'center' });
  else (marked.closest('article') ?? marked).scrollIntoView?.({ block: 'start' });
}

/**
 * An aside's tab (decision 0025): an explanation keeps its source link visible above the folded
 * passage and the model's answer. The excerpt and the messages share the chat's scroll area. A free
 * side question keeps its questions in the list. Both have a follow-up field with Send or Stop.
 *
 * Its conversation is drawn by the chat's own list, with the session's opener: its questions, its
 * answers as Markdown, each labelled by the model that wrote it where its message says so, and what
 * a provider's side thread did, in the chat's groups. Its own answers are no sources: they offer no
 * Explain this and carry no marker (C40).
 *
 * It reads when it is shown, follows the pushes that name this aside while it is shown, and holds
 * nothing when it is not (C38). Its draft is the tab's own: kept while the tab is open, and dropped
 * with it. Explicitly closing the tab removes its saved conversation and stops its running answer.
 * Its tab has no separate Remove action.
 */
export function AsideBody({ sessionId, reference, viewState, setViewState, setTitle }: TabBodyProps<string, AsideViewState>) {
  const id = tabId(ASIDE_KIND, reference);
  const handed = useTabs((state) => state.sessions[sessionId]?.tabs.find((tab) => tab.id === id)?.handed);
  const chat = useAsideChat(sessionId, reference);
  const { view, aside, refused, gone } = chat;
  const asking = useAsides((state) => (state.sessionId === sessionId ? state.asking : 'none'));
  const entry = useAppState((state) => state.snapshot?.sessions?.sessions.find((candidate) => candidate.record.id === sessionId));
  const catalog = useAppState((state) => state.snapshot?.catalog);
  const providerName = providerNameOf(sessionId);
  const input = useRef<HTMLTextAreaElement>(null);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const excerptId = useId();
  const latest = useRef(viewState);
  useEffect(() => { latest.current = viewState; }, [viewState]);

  // The title it was opened with titles it at once; it is the page's now, and is taken once.
  useEffect(() => {
    if (handed === undefined) return;
    if (typeof handed === 'string') setTitle(tabTitle(handed));
    takeHanded(sessionId, id);
  }, [handed, id, sessionId, setTitle]);
  // Then the one its own read says.
  const title = aside?.title;
  useEffect(() => { if (title !== undefined) setTitle(tabTitle(title)); }, [title, setTitle]);

  // A new side question's field takes the focus, once for each naming of it (C41, C53).
  const focus = viewState?.focus;
  const focused = viewState?.focused;
  useEffect(() => {
    if (focus === undefined || focus === focused) return;
    input.current?.focus({ preventScroll: true });
    setViewState({ ...latest.current, focused: focus });
  }, [focus, focused, setViewState]);

  const ref = useMemo(() => (entry === undefined ? null : { providerId: entry.record.providerId, instanceId: entry.record.instanceId }), [entry]);
  // The session's model, as the chat labels its answers; an answer that names another is labelled by that one's name (C7, C37).
  const modelName = ref === null || entry === undefined ? '' : findModel(catalog, ref, entry.summary.model).name;
  const nameModel = useCallback((key: string): string => (ref === null ? key : findModel(catalog, ref, key).name), [catalog, ref]);
  const opener = useMemo(() => createOpener(sessionId), [sessionId]);
  const onOpenWorker = useCallback((workerId: string, label: string): void => { openAgent(sessionId, workerId, label); }, [sessionId]);

  const turns = view === null ? [] : [...view.turns.values()];
  const live = turns.find((turn) => turn.state === 'running') ?? null;
  // By the window's own turns, which each push keeps: what the read said of it is only as new as the read.
  const running = view === null ? aside?.running === true : live !== null;

  const draft = viewState?.draft ?? '';
  const setDraft = (text: string): void => setViewState({ ...latest.current, draft: text });
  const closed = asking === 'none' || refused !== null || gone;
  const canSend = !closed && !running && !sending && draft.trim() !== '';

  const send = (): void => {
    if (!canSend) return;
    const text = draft;
    setSending(true);
    setProblem(null);
    askQuestion(sessionId, reference, text).then(
      (answer) => {
        if (answer.status !== 'accepted') { setProblem(askRefusalText(answer.reason, providerName)); return; }
        // Only the question that went: a draft changed meanwhile stays.
        if ((latest.current?.draft ?? '') === text) setViewState({ ...latest.current, draft: '' });
      },
      () => setProblem(ASK_FAILED_TEXT),
    ).finally(() => {
      setSending(false);
      input.current?.focus({ preventScroll: true });
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    // An input method's Enter picks its candidate: it is not the user's.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    send();
  };

  const source = aside?.source ?? null;
  const expanded = viewState?.excerptExpanded === true;
  // The source card replaces the generated opening question in presentation alone. Only a window
  // holding the very start can omit it; a later page's first user message is a real follow-up.
  const messages = useMemo(() => {
    if (view === null || source === null || view.older !== null) return view;
    const [first, ...rest] = view.items;
    return first?.kind === 'message' && first.role === 'user' ? { ...view, items: rest } : view;
  }, [view, source]);
  const excerpt = source === null ? undefined : (
    <section className={styles.passage} role="group" aria-label={ASIDE_WORDS.head}>
      <div className={`${chatStyles.qHeader} ${styles.excerptHeader}`} data-foldable="" data-folded={expanded ? undefined : ''}>
        <button type="button" className={`${chatStyles.disclosure} ${chatStyles.qFold}`} aria-label={expanded ? ASIDE_WORDS.hideExcerpt : ASIDE_WORDS.showExcerpt} aria-expanded={expanded} aria-controls={excerptId} onClick={() => setViewState({ ...latest.current, excerptExpanded: !expanded })}>
          <span className={chatStyles.chevronMark} data-open={expanded ? '' : undefined} aria-hidden="true" />
        </button>
        {ASIDE_WORDS.excerptTitle}
      </div>
      <div id={excerptId} hidden={!expanded}>
        <blockquote className={styles.excerpt} aria-label={ASIDE_WORDS.excerpt}>{source.excerpt}</blockquote>
        {source.cut && <p className={styles.note}>{ASIDE_WORDS.cut}</p>}
      </div>
    </section>
  );

  return (
    <div className={styles.aside} data-aside={reference} data-aside-running={running ? '' : undefined}>
      <ArtifactBar label={source === null ? 'Aside' : 'Explanation'} />
      {source !== null && (
        <button type="button" className={styles.source} title={source.kind === 'file' ? source.path ?? undefined : undefined} onClick={() => comeTo(sessionId, reference, source)}>
          {sourceWords(source)}
        </button>
      )}
      {refused !== null && <p className={styles.state}>{ASIDE_REFUSALS[refused]}</p>}
      {gone && <p className={styles.state}>{ASIDE_WORDS.gone}</p>}
      <div className={styles.items}>
        {view !== null && (
          <OpenerContext value={opener}>
            <WorkerOpenContext value={onOpenWorker}>
              <MessageList
                view={messages}
                sessionId={sessionId}
                copySource={{ kind: 'aside', sessionId, asideId: reference }}
                providerId={entry?.record.providerId ?? ''}
                modelKey={entry?.summary.model ?? modelName}
                busy={chat.busy}
                modelName={modelName}
                providerName={providerName}
                onShowEarlier={chat.showEarlier}
                onShowLatest={() => void chat.showLatest()}
                label={ASIDE_WORDS.list}
                mark={ASIDE_LIST_MARK}
                nameModel={nameModel}
                head={excerpt}
              />
            </WorkerOpenContext>
          </OpenerContext>
        )}
      </div>
      <div className={styles.composer}>
        <div className={styles.inputRow}>
          <div className={styles.field}>
            <textarea
              ref={input}
              className={chatStyles.input}
              value={draft}
              aria-label={ASIDE_WORDS.field}
              placeholder={aside === null ? ASIDE_WORDS.firstPlaceholder : ASIDE_WORDS.placeholder}
              disabled={closed}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
            />
          </div>
          {running ? (
            <button type="button" className={styles.button} onClick={() => void invoke('chat:stopAside', { sessionId, asideId: reference }).catch(() => undefined)}>{ASIDE_WORDS.stop}</button>
          ) : (
            <button type="button" className={styles.button} data-primary="" disabled={!canSend} onClick={send}>{ASIDE_WORDS.send}</button>
          )}
        </div>
        {problem !== null && <p className={styles.problem} role="status">{problem}</p>}
      </div>
    </div>
  );
}
