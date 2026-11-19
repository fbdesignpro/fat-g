// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { type ClipboardEvent, type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ATTACHMENT_WORDS } from '@shared/contracts/attachments';
import { CHAT_LINES } from '@shared/contracts/chat';
import { MAX_MESSAGE_TEXT } from '@shared/contracts/agent-events';
import { type BusyEnter, COMPOSER_WORDS as BUSY_WORDS, type SendNowWithheld } from '@shared/contracts/composer';
import { useChatDrafts } from './chat-store';
import { AttachmentStrip } from './composer/AttachmentStrip';
import { changeQueue, chooseCommand, type ComposerInput, editDraft, editQueued, flushDraft, inputOf, inputTaken, queueDraft, removeAttachment, stageFiles, stagingSettled, useComposer } from './composer/composer-store';
import { CommandMenu, matching, menuOpenFor } from './composer/CommandMenu';
import { type CommandList, type CommandRow, MENU_WORDS } from '@shared/contracts/composer';
import { invoke } from '../ipc/client';
import { announce } from '../ui/Announcer';
import { QueueList } from './composer/QueueList';
import composerStyles from './composer/Composer.module.css';
import { useFootFocus } from './foot-focus';
import { promptFocusTaken, usePromptFocus } from './prompt-focus';
import { LaterButton } from './Toolbar';
import styles from './Chat.module.css';

export const COMPOSER_WORDS = {
  dictation: 'Dictation',
  /** The microphone's tooltip (M100, C41). */
  dictationLater: 'Dictation is planned for a future update.',
  /** A paste refused for its length (the maintainer): nothing of it went in. */
  tooLong: (over: number): string => `Nothing was pasted: it would make the message ${over.toLocaleString('en')} characters longer than the ${MAX_MESSAGE_TEXT.toLocaleString('en')} fat-g sends.`,
} as const;

function MicrophoneIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M12 3A3 3 0 0 0 9 6V12A3 3 0 0 0 15 12V6A3 3 0 0 0 12 3ZM5 11A7 7 0 0 0 19 11M12 18V21M8 21H16" stroke="currentColor" strokeWidth="2" fill="none" />
    </svg>
  );
}

export interface ComposerProps {
  readonly selectionKey?: string;
  readonly sessionId: string;
  readonly providerName: string;
  readonly presetName?: string | undefined;
  /** The session runs, a turn or its workers alone (C66, C99): the button is Stop. */
  readonly running: boolean;
  /** Its earlier messages are loading (C122): nothing is sent until they are in, and a line says so. */
  readonly loading: boolean;
  /** The chat's first read has answered: until it has, nothing is sent either. */
  readonly ready: boolean;
  /** Sends the composer's input (M23, C86); resolves with whether it was taken. */
  readonly onSend: (input: ComposerInput) => Promise<boolean>;
  readonly onStop: () => void;
  readonly onCancelNewSession?: (() => void) | undefined;
  /** A line under the input, in fat-g's words: why the last Send was refused. */
  readonly problem: string | null;
  /** What the send button reads: "Plan" while the next prompt is a plan turn (M22b, C1). */
  readonly sendLabel?: string;
  /** Sends the input into the running turn (M23, C36); resolves with whether it was taken. Left out, no Send now. */
  readonly onSendNow?: (input: ComposerInput) => Promise<boolean>;
  /** What Enter does while a turn runs (M23, C37, C80): the other is on Ctrl+Enter. */
  readonly busyEnter?: BusyEnter;
  /** Plan is pressed (M23, C88): nothing is sent now, and Queue stands alone. */
  readonly planPressed?: boolean;
}

/** The images a paste carries (C13): files of the clipboard's, whatever text comes with them. */
function pastedFiles(event: ClipboardEvent<HTMLTextAreaElement>): File[] {
  const items = [...event.clipboardData.items].filter((item) => item.kind === 'file');
  const files = items.map((item) => item.getAsFile()).filter((file): file is File => file !== null);
  return files.length > 0 ? files : [...event.clipboardData.files];
}

/**
 * The input (docs/planning/_archive/M15.md, Design 14; C65–C67, C116, C122; M20b.md, Design 8; C68;
 * docs/planning/_archive/M100.md, Design 7; C40–C42): a box holding a text area sized by what it holds, over a
 * foot row with the microphone at its left and one button at its right. At its smallest the text
 * area holds two lines without clipping, and it grows to eight; a line that wraps counts as a line
 * break does, since the height is the style sheet's to work out from the content's own, never a
 * count of line breaks made here. A longer text scrolls within it. Enter sends, Shift+Enter breaks
 * the line, and Enter while an input method composes does neither. The focus stays in the text area
 * after a send.
 *
 * While the session runs the button is Stop, the text stays editable and Enter sends nothing. While
 * its earlier messages load, the button is disabled and a line says so under the box. The microphone
 * is drawn and not wired: no milestone gives it work yet, and its tooltip says so.
 *
 * Images (docs/planning/_archive/M23.md, Design 4; C13–C20): pasted, an image is staged at once and any text
 * pasted with it goes in at the caret; dropped on the chat column (useFileDrop.ts), each is staged in
 * order. The draft's images stand in a strip over the text area. A message may be images alone, and
 * Send waits for every image still being kept. Each refusal is a line under the input, the formats'
 * line after a refusal of the image's own.
 *
 * The draft (C31–C34, C86): the page's buffer, handed to main within 300 ms of each change and when
 * the chat goes, at a revision of the page's own numbering, so it survives a restart.
 *
 * While a turn runs (C35, C37, C80, C88): Send now and Queue stand in Send's place, the one the
 * preference gives Enter at Send's own place and the other as a secondary button to its left, on Ctrl+Enter, with Stop
 * beside them. Send now goes at the first opportunity — main holds it until the turn can take it, or
 * sends it as the next prompt once its workers are done — and Queue once the turn and its workers
 * are done; each tooltip says so. Queue stands alone with Plan pressed, with a skill chosen, and where
 * the CLI never takes a message during a turn, a line above it saying why for as long as that holds.
 * The queue's rows stand under the input (QueueList.tsx).
 */
export function Composer({ sessionId, providerName, presetName, running, loading, ready, onSend, onStop, onCancelNewSession, problem, sendLabel = 'Send', onSendNow, busyEnter = 'send-now', planPressed = false, selectionKey }: ComposerProps) {
  const draft = useChatDrafts((state) => state.drafts[sessionId] ?? '');
  const composer = useComposer(sessionId);
  const attachments = composer.main.draft.attachments;
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const focusEnd = (): void => {
    const area = input.current;
    if (area === null) return;
    area.focus({ preventScroll: true });
    area.setSelectionRange(area.value.length, area.value.length);
    area.scrollTop = area.scrollHeight;
  };
  // Let the browser own typing: a controlled textarea changes defaultValue on every key, which
  // splits Chromium's native undo groups. Only replace text when an outside draft change differs.
  useLayoutEffect(() => {
    const area = input.current;
    if (area !== null && area.value !== draft) area.value = draft;
  }, [draft]);
  const foot = useFootFocus();
  // The focus asked for this session's prompt (M100b, C61): taken as soon as the text area stands, then forgotten.
  const asked = usePromptFocus((state) => (state.sessionId === sessionId ? state.serial : 0));
  useEffect(() => {
    if (asked === 0 || input.current === null) return;
    input.current.focus({ preventScroll: true });
    if (usePromptFocus.getState().atEnd) focusEnd();
    promptFocusTaken(asked);
  }, [asked]);
  // The chat goes — another session, or none: what was typed is handed to main at once (C31).
  useEffect(() => () => { void flushDraft(sessionId); }, [sessionId]);
  const staging = composer.staging.length > 0;
  const holds = draft.trim() !== '' || attachments.length > 0 || staging;
  const canSend = ready && !running && !loading && !sending && holds;
  // While a turn runs (C35, C88): Send now but where something rules it out, said above Queue; Queue always.
  const withheld: SendNowWithheld | null = !running || onSendNow === undefined ? null
    : planPressed ? 'plan'
    : composer.intent.skill !== null ? 'skill'
    : composer.main.steer === 'unsupported' ? 'unsupported'
    : null;
  const nowOffered = running && onSendNow !== undefined && withheld === null;
  const withheldId = useId();
  const canBusy = ready && running && !sending && holds;
  const nowFirst = nowOffered && busyEnter === 'send-now';
  const [queueProblem, setQueueProblem] = useState<string | null>(null);
  /** A paste refused for its length (the maintainer): said until the next change of the draft. */
  const [pasteProblem, setPasteProblem] = useState<string | null>(null);
  // The command menu (C58, C66, C67): open while the draft's first word is a `/` being typed; closed by
  // Escape or a blur for the draft as it then stood, and open again at the next change.
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const [commands, setCommands] = useState<CommandList | null>(null);
  const commandOwner = useRef(selectionKey);
  useEffect(() => {
    if (commandOwner.current === selectionKey) return;
    commandOwner.current = selectionKey;
    setCommands(null);
    setClosedFor(draft);
  }, [selectionKey, draft]);
  const [picked, setPicked] = useState<{ readonly prefix: string; readonly index: number } | null>(null);
  const prefix = closedFor === draft ? null : menuOpenFor(draft);
  const menuRows = prefix === null || commands === null ? [] : matching(commands.rows, prefix);
  const active = picked !== null && picked.prefix === prefix ? Math.min(picked.index, Math.max(0, menuRows.length - 1)) : 0;
  const listId = `commands-${sessionId}`;
  /** The rows read from main as the menu opens (C60): the CLI's list may have changed since. Its count said once (C67). */
  const loadCommands = (): void => {
    const owner = commandOwner.current;
    setCommands(null);
    void invoke('chat:commands', { sessionId }).then((answer) => {
      if (commandOwner.current !== owner) return;
      const list = answer.status === 'read' ? { rows: answer.rows, note: answer.note } : { rows: [], note: null };
      setCommands(list);
      announce(MENU_WORDS.count(list.rows.length));
    }, () => { if (commandOwner.current === owner) setCommands({ rows: [], note: null }); });
  };
  const choose = (row: CommandRow): void => {
    chooseCommand(sessionId, row);
    input.current?.focus();
  };

  const send = (): void => {
    if (!canSend) return;
    setSending(true);
    // Send waits for every image still being kept (C18); then the draft as it stands goes, and only
    // what was taken leaves the input: text typed meanwhile stays (C86).
    stagingSettled(sessionId).then(async () => {
      const taking = inputOf(sessionId);
      if (taking.prompt.trim() === '' && taking.attachments.length === 0) return;
      if (await onSend(taking)) inputTaken(sessionId, taking);
    }).catch(() => undefined).finally(() => {
      setSending(false);
      input.current?.focus();
    });
  };

  /** A message sent into the running turn (C36): as a Send, its taking leaving the input. */
  const sendNow = (): void => {
    if (!canBusy || !nowOffered || onSendNow === undefined) return;
    setSending(true);
    setQueueProblem(null);
    stagingSettled(sessionId).then(async () => {
      const taking = inputOf(sessionId);
      if (taking.prompt.trim() === '' && taking.attachments.length === 0) return;
      if (await onSendNow(taking)) inputTaken(sessionId, taking);
    }).catch(() => undefined).finally(() => {
      setSending(false);
      input.current?.focus();
    });
  };

  /** Queue next (C47, C48): the draft appended to the session's queue. */
  const queue = (): void => {
    if (!canBusy && !(ready && !running && holds)) return;
    setSending(true);
    setQueueProblem(null);
    queueDraft(sessionId).then(setQueueProblem, () => undefined).finally(() => {
      setSending(false);
      input.current?.focus();
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // An input method's keys pick its candidate: none of them is the user's.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    // The menu takes Up, Down, Escape, and Enter while a row is there to choose (C58, C67).
    if (prefix !== null) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (menuRows.length === 0) return;
        event.preventDefault();
        setPicked({ prefix, index: (active + (event.key === 'ArrowDown' ? 1 : menuRows.length - 1)) % menuRows.length });
        return;
      }
      if (event.key === 'Escape') { event.preventDefault(); setClosedFor(draft); return; }
      const row = menuRows[active];
      if (event.key === 'Enter' && !event.shiftKey && row !== undefined) { event.preventDefault(); choose(row); return; }
    }
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    if (!running) { send(); return; }
    // While a turn runs (C37): Enter the preference's action, Ctrl+Enter the other; no key steers where Send now is not offered.
    const other = event.ctrlKey || event.metaKey;
    if (!nowOffered) { if (!other) queue(); return; }
    if (nowFirst !== other) sendNow();
    else queue();
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = pastedFiles(event);
    const text = event.clipboardData.getData('text/plain');
    const area = event.currentTarget;
    const start = area.selectionStart;
    const end = area.selectionEnd;
    // A paste that would take the message past what one holds is refused whole, and said: the text
    // area's own bound would cut it where nothing shows (the maintainer). The draft is kept
    // as it is typed, within that bound, so nothing longer is let in. Counted as it will stand: a text
    // area keeps a CRLF as one line break.
    const over = area.value.length - (end - start) + text.replace(/\r\n?/g, '\n').length - MAX_MESSAGE_TEXT;
    if (over > 0) {
      event.preventDefault();
      setPasteProblem(COMPOSER_WORDS.tooLong(over));
      return;
    }
    setPasteProblem(null);
    // A paste of text alone is the text area's own: a path or an address pasted is text, never opened (C13).
    if (files.length === 0) return;
    event.preventDefault();
    void stageFiles(sessionId, files, { pasted: true });
    if (text === '') return;
    // Its text, once, where the selection stood.
    const next = `${area.value.slice(0, start)}${text}${area.value.slice(end)}`;
    editDraft(sessionId, next);
    const caret = Math.min(start + text.length, next.length);
    requestAnimationFrame(() => { if (input.current !== null) input.current.setSelectionRange(caret, caret); });
  };

  return (
    <div className={styles.composer} ref={foot}>
      {prefix !== null && <CommandMenu list={commands} rows={menuRows} listId={listId} active={active} onChoose={choose} />}
      <div className={styles.inputBox}>
        <AttachmentStrip attachments={attachments} staging={composer.staging} onRemove={(id) => { void removeAttachment(sessionId, id); input.current?.focus(); }} />
        {presetName !== undefined && <div className={composerStyles.presetName}>Preset: {presetName}</div>}
        <textarea
          ref={input}
          className={styles.input}
          maxLength={MAX_MESSAGE_TEXT}
          aria-label={`Message to ${providerName}`}
          aria-controls={prefix !== null ? listId : undefined}
          aria-activedescendant={prefix !== null && menuRows[active] !== undefined ? `${listId}-${active}` : undefined}
          onBlur={() => setClosedFor(draft)}
          onFocus={() => { if (menuOpenFor(draft) !== null) { setClosedFor(null); loadCommands(); } }}
          placeholder={`Ask ${providerName}…`}
          onChange={(event) => {
            const next = event.target.value;
            // The menu opens with a `/` at the draft's start: its rows are read then (C58, C60).
            if (menuOpenFor(next) !== null && (menuOpenFor(draft) === null || closedFor === draft)) loadCommands();
            setPasteProblem(null);
            editDraft(sessionId, next);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <div className={styles.inputFoot} onClick={(event) => { if (event.target === event.currentTarget) focusEnd(); }}>
          <LaterButton className={styles.iconButton} words={COMPOSER_WORDS.dictationLater} label={COMPOSER_WORDS.dictation} onClick={focusEnd}>
            <MicrophoneIcon />
          </LaterButton>
          {running ? (
            <div className={composerStyles.busyActions}>
              {withheld !== null && <p id={withheldId} className={composerStyles.withheld} data-withheld={withheld}>{BUSY_WORDS.withheld(withheld, providerName)}</p>}
              <div className={composerStyles.busyRow}>
                {nowOffered && (
                  <span className={composerStyles.secondaryAction}>
                    <button type="button" className={styles.button} disabled={!canBusy} aria-keyshortcuts="Control+Enter" title={nowFirst ? BUSY_WORDS.queueKey(false) : BUSY_WORDS.sendNowKey(false)} onClick={nowFirst ? queue : sendNow}>
                      {nowFirst ? BUSY_WORDS.queue : BUSY_WORDS.sendNow}
                    </button>
                    <small className={composerStyles.shortcutHint} aria-hidden="true">ctrl-enter</small>
                  </span>
                )}
                <button type="button" className={styles.button} data-primary="" disabled={!canBusy} title={nowFirst ? BUSY_WORDS.sendNowKey(true) : BUSY_WORDS.queueKey(true)} aria-describedby={withheld === null ? undefined : withheldId} onClick={nowFirst ? sendNow : queue}>
                  {nowFirst ? BUSY_WORDS.sendNow : BUSY_WORDS.queue}
                </button>
                <button type="button" className={styles.button} onClick={onStop}>
                  Stop
                </button>
              </div>
            </div>
          ) : (
            <div className={composerStyles.busyRow}>
              {onCancelNewSession !== undefined && <button type="button" className={styles.button} aria-label="Cancel new session" disabled={sending} onClick={onCancelNewSession}>Cancel</button>}
              <button type="button" className={styles.button} data-primary="" disabled={!canSend} onClick={send}>
                {sendLabel}
              </button>
            </div>
          )}
        </div>
      </div>
      <QueueList
        queue={composer.main.queue}
        providerName={providerName}
        onEdit={(entryId) => { void editQueued(sessionId, entryId).then(setQueueProblem); input.current?.focus(); }}
        onRemove={(entryId) => { void changeQueue(sessionId, { remove: entryId }).then(setQueueProblem); }}
        onReorder={(order) => { void changeQueue(sessionId, { order }).then(setQueueProblem); }}
        onResume={() => { void changeQueue(sessionId, { resume: true }).then(setQueueProblem); }}
      />
      {loading && <p className={styles.status} role="status">{CHAT_LINES.loading}</p>}
      {pasteProblem !== null && <p className={styles.problem} role="status" data-paste-refused="">{pasteProblem}</p>}
      {queueProblem !== null && <p className={styles.problem} role="status">{queueProblem}</p>}
      {composer.problems.map((entry) => (
        <div key={entry.key} role="status">
          <p className={styles.problem}>{entry.text}</p>
          {entry.formats && <p className={composerStyles.formats}>{ATTACHMENT_WORDS.formats}</p>}
        </div>
      ))}
      {problem !== null && <p className={styles.problem} role="status">{problem}</p>}
    </div>
  );
}
