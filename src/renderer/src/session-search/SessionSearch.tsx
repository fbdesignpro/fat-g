// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type KeyboardEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DEFAULT_SEARCH_FILTERS, MAX_SEARCH_QUERY, SEARCH_PAGE_SIZE, type SearchFilters, type SearchRange, type SessionSearchResult } from '@shared/contracts/session-search';
import { sessionLabel, statusWords } from '@shared/contracts/sessions';
import { showDetached } from '../chat/detached-store';
import { CHAT_MARK } from '../chat/foot-focus';
import { LIST_MARK } from '../chat/MessageList';
import { focusPrompt } from '../chat/prompt-focus';
import { CloseIcon } from '../control-bar/icons';
import { invoke } from '../ipc/client';
import { Avatar } from '../sessions/Avatar';
import { selectSession } from '../sessions/select';
import { useAppState } from '../state/store';
import { focusQuietly } from '../ui/focus';
import dialogStyles from '../ui/Dialog.module.css';
import styles from './SessionSearch.module.css';

function Highlight({ text, ranges }: { readonly text: string; readonly ranges: readonly SearchRange[] }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const range of ranges) {
    parts.push(text.slice(at, range.start), <mark key={range.start}>{text.slice(range.start, range.end)}</mark>);
    at = range.end;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}

/** Poll only while open, including during indexing; every query/filter change supersedes old replies. */
function useResults(query: string, filters: SearchFilters, pages: number) {
  const key = JSON.stringify({ query, filters, pages });
  const [held, setHeld] = useState<{ key: string; result: SessionSearchResult | null; failed: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const request = JSON.parse(key) as { query: string; filters: SearchFilters; pages: number };
    const read = async (): Promise<void> => {
      try {
        let result: SessionSearchResult | null = null;
        for (let page = 0; page < request.pages; page += 1) {
          const next = await invoke('sessions:search', { query: request.query, ...request.filters, offset: page * SEARCH_PAGE_SIZE });
          if (!live) return;
          result = result === null ? next : { ...next, hits: [...result.hits, ...next.hits] };
          if (!next.more) break;
        }
        if (live) setHeld({ key, result, failed: false });
      } catch {
        if (live) setHeld({ key, result: null, failed: true });
      } finally {
        if (live) timer = setTimeout(() => { void read(); }, 1000);
      }
    };
    timer = setTimeout(() => { void read(); }, 150);
    return () => { live = false; clearTimeout(timer); };
  }, [key]);
  return held?.key === key ? held : null;
}

interface DialogProps {
  readonly filters: SearchFilters;
  readonly setFilters: (filters: SearchFilters) => void;
  readonly onClose: (sessionId?: string) => void;
}

function SearchDialog({ filters, setFilters, onClose }: DialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const selecting = useRef(false);
  const [query, setQuery] = useState('');
  const [pages, setPages] = useState(1);
  const [active, setActive] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const held = useResults(query, filters, pages);
  const sessions = useAppState((state) => state.snapshot?.sessions?.sessions);
  const projects = useAppState((state) => state.snapshot?.records?.projects);
  const selected = useAppState((state) => state.snapshot?.sessions?.selectedId);
  const titleId = useId();
  const listId = useId();
  const noticeId = useId();
  const sessionMap = new Map((sessions ?? []).map((entry) => [entry.record.id, entry]));
  const hits = [...new Map((held?.result?.hits ?? []).filter((hit) => sessionMap.has(hit.sessionId)).map((hit) => [hit.sessionId, hit])).values()];
  const activeId = hits.some((hit) => hit.sessionId === active) ? active : hits[0]?.sessionId ?? null;
  const projectList = (projects ?? []).filter((project) => project.kind === 'project');

  useLayoutEffect(() => {
    mounted.current = true;
    const element = dialog.current;
    // Let Chromium dismiss a backdrop click while preserving clicks and text selection inside.
    if (element !== null) element.closedBy = 'any';
    element?.showModal();
    input.current?.focus();
    return () => {
      mounted.current = false;
      element?.close();
      void invoke('sessions:closeSearch', null).catch(() => undefined);
    };
  }, []);

  useLayoutEffect(() => {
    dialog.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [activeId]);

  const changed = (): void => { setPages(1); setActive(null); setOpenFailed(false); };
  const filter = (patch: Partial<SearchFilters>): void => { changed(); setFilters({ ...filters, ...patch }); };
  async function pick(id: string): Promise<void> {
    if (selecting.current) return;
    selecting.current = true;
    setOpening(true); setOpenFailed(false);
    try {
      const answer = await selectSession(id);
      if (!mounted.current) return;
      if (answer.status === 'saved') { showDetached(null); onClose(id); }
      else setOpenFailed(true);
    } catch { if (mounted.current) setOpenFailed(true); }
    finally { selecting.current = false; if (mounted.current) setOpening(false); }
  }

  function move(event: KeyboardEvent<HTMLElement>): void {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const at = hits.findIndex((hit) => hit.sessionId === activeId);
      setActive(hits[Math.max(0, Math.min(hits.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))]?.sessionId ?? null);
    } else if (event.key === 'Enter' && activeId !== null) {
      event.preventDefault();
      void pick(activeId);
    }
  }

  const status = held?.result?.status;
  const notice = held === null ? 'Searching…' : held.failed ? 'Search could not be completed. Try again.'
    : status === 'records-unavailable' ? 'Sessions are unavailable while the records store cannot be read.'
    : status === 'messages-unavailable' ? 'Saved messages are unavailable. Session names can still be searched.'
    : status === 'indexing' ? 'Searching saved messages… Session names are available now.'
    : `${held.result?.total ?? 0} ${(held.result?.total ?? 0) === 1 ? 'session' : 'sessions'}`;

  return createPortal(
    <dialog ref={dialog} className={`${dialogStyles.dialog} ${styles.dialog}`} aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClose={(event) => {
        event.stopPropagation();
        // Dev effect replay reopens before Chromium delivers the cleanup's queued close event.
        if (mounted.current && !event.currentTarget.open) onClose();
      }}>
      <header className={dialogStyles.header}>
        <h2 id={titleId} className={dialogStyles.title}>Search sessions</h2>
        <button type="button" className={dialogStyles.closeButton} aria-label="Close search" onClick={() => onClose()}><CloseIcon /></button>
      </header>
      <div className={styles.controls}>
        <input ref={input} className={styles.input} type="search" role="combobox" aria-label="Search session names and messages" aria-autocomplete="list" aria-expanded="true" aria-controls={listId}
          aria-activedescendant={activeId === null ? undefined : `${listId}-${activeId}`} aria-describedby={noticeId}
          placeholder="Search session names and messages…" autoComplete="off" spellCheck={false} maxLength={MAX_SEARCH_QUERY} value={query}
          onChange={(event) => { changed(); setQuery(event.target.value); }} onKeyDown={move} />
        <div className={styles.filters}>
          <label>Sort<select value={filters.sort} onChange={(event) => filter({ sort: event.target.value as SearchFilters['sort'] })}><option value="match">Best match</option><option value="recent">Most recent</option></select></label>
          <label>Project<select value={filters.projectId ?? ''} onChange={(event) => filter({ projectId: event.target.value || null })}><option value="">All projects</option>{projectList.map((project) => <option key={project.id} value={project.id}>{project.name}{project.hidden ? ' (hidden)' : ''}</option>)}</select></label>
          <label>Sessions<select value={filters.state} onChange={(event) => filter({ state: event.target.value as SearchFilters['state'] })}><option value="all">All</option><option value="active">Active</option><option value="done">Done</option><option value="shelved">Shelved</option></select></label>
          <label>Search in<select value={filters.scope} onChange={(event) => filter({ scope: event.target.value as SearchFilters['scope'] })}><option value="all">Names and messages</option><option value="names">Names</option><option value="messages">Messages</option></select></label>
          <label className={styles.check}><input type="checkbox" checked={filters.fuzzy} onChange={(event) => filter({ fuzzy: event.target.checked })} />Allow typos</label>
        </div>
        <p id={noticeId} className={styles.notice} role="status">{notice}</p>
        {openFailed && <p className={dialogStyles.error} role="alert">This session could not be opened. Try again.</p>}
      </div>
      <div className={styles.results}>
        <div id={listId} role="listbox" aria-label="Matching sessions" aria-busy={opening} tabIndex={0} aria-activedescendant={activeId === null ? undefined : `${listId}-${activeId}`} onKeyDown={move}>
          {hits.map((hit) => {
            const entry = sessionMap.get(hit.sessionId);
            if (entry === undefined) return null;
            const project = projectList.find((candidate) => candidate.id === entry.record.projectId);
            const lifecycle = entry.record.completedAt !== null ? 'Done' : entry.record.shelvedAt !== null ? 'Shelved' : statusWords(entry.summary);
            return <div key={hit.sessionId} id={`${listId}-${hit.sessionId}`} role="option" aria-selected={hit.sessionId === activeId} aria-current={hit.sessionId === selected ? 'true' : undefined}
              className={styles.row} onClick={() => { void pick(hit.sessionId); }}>
              <Avatar providerId={entry.record.providerId} avatar={entry.avatar} size="thin" />
              <div className={styles.text}>
                <span className={styles.name}><Highlight text={sessionLabel(entry)} ranges={hit.titleRanges} /></span>
                <span className={styles.meta}>{project?.name ?? ''}{project?.hidden ? ' (hidden)' : ''} · {lifecycle} · <time dateTime={new Date(entry.record.lastActiveAt).toISOString()}>{new Date(entry.record.lastActiveAt).toLocaleString()}</time></span>
                {hit.excerpt !== null && <span className={styles.excerpt}>{hit.excerpt.role === 'user' ? 'You' : 'Assistant'}: <Highlight text={hit.excerpt.text} ranges={hit.excerpt.ranges} /></span>}
              </div>
            </div>;
          })}
        </div>
        {hits.length === 0 && status === 'ready' && <p className={styles.empty}>No matching sessions.</p>}
        {held?.result?.more === true && <button type="button" className={dialogStyles.button} onClick={() => setPages((count) => count + 1)}>Show more</button>}
      </div>
      <footer className={dialogStyles.footer}><span className={styles.notice}>↑ ↓ to choose · Enter to open · Esc to close</span></footer>
    </dialog>, document.body,
  );
}

export function SessionSearch() {
  const available = useAppState((state) => state.snapshot?.records !== undefined);
  const [open, setOpen] = useState(false);
  const [filters, setFilters] = useState<SearchFilters>(DEFAULT_SEARCH_FILTERS);
  const button = useRef<HTMLButtonElement>(null);
  function openSearch(): void {
    const snapshot = useAppState.getState().snapshot;
    const projectId = snapshot?.sessions?.sessions.find((entry) => entry.record.id === snapshot.sessions?.selectedId)?.record.projectId;
    const hasProject = snapshot?.records?.projects.some((entry) => entry.kind === 'project' && entry.id === projectId);
    setFilters((current) => ({ ...current, projectId: hasProject ? projectId ?? null : null }));
    setOpen(true);
  }
  function close(sessionId?: string): void {
    setOpen(false);
    requestAnimationFrame(() => {
      if (sessionId === undefined) { button.current?.focus(); return; }
      focusPrompt(sessionId);
      const chat = document.querySelector<HTMLElement>(`[${CHAT_MARK}="${sessionId}"]`);
      const prompt = chat?.querySelector<HTMLTextAreaElement>('[data-prompt-area] textarea');
      if (prompt != null) prompt.focus({ preventScroll: true });
      else focusQuietly(chat?.querySelector<HTMLElement>(`[${LIST_MARK}]`) ?? null);
    });
  }
  if (!available) return null;
  return <>
    <button ref={button} type="button" className={styles.trigger} onClick={openSearch} aria-haspopup="dialog" aria-label="Search"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5L21 21" /></svg>Search</button>
    {open && <SearchDialog filters={filters} setFilters={setFilters} onClose={close} />}
  </>;
}
