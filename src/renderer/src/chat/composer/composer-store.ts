// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A session's composer in the page (docs/planning/_archive/M23.md, Design 4, 5, 7; C13–C20, C31–C34, C48,
// C86): what main holds of its draft and its queue, as the chat's read and pushes carry it, and the
// page's own edit buffer over it.
//
// The draft's text is typed here and handed to main, gathered for 300 ms, at a revision the page
// numbers from the last main gave it (C31, C86). A read or a push of main's draft is taken where its
// revision is at or past the page's, so a late answer never writes over newer typing, and a draft
// main changed — an Edit's swap, a clear — comes in. The text the input shows is chat-store.ts's
// draft, which stays the page's buffer.
//
// An image is staged from here (C14): the page reads its bytes with the File API and hands them over
// in the order they came, one at a time, a placeholder standing in the strip while it is kept. A file
// whose first bytes are no image's is refused here and never handed over; main's check is the
// authority for everything else. Each refusal is a line under the input, in fat-g's words.
//
// Held in the page's memory for the run. Nothing of it is written here: main writes the draft.
import { create } from 'zustand';
import { ATTACHMENT_WORDS, type AttachmentDescriptor, imageSignature, MAX_IMAGE_BYTES, refusalOfImage, SIGNATURE_BYTES, stageRefusalWords } from '@shared/contracts/attachments';
import { type ChatComposer, type CommandRow, COMPOSER_WORDS, DRAFT_SEND_MS, EMPTY_COMPOSER, NO_INTENT, type PromptIntent, type QueueRefusal } from '@shared/contracts/composer';
import { invoke, subscribe } from '../../ipc/client';
import { draftOf, setDraft } from '../chat-store';
import { setPromptType } from '../prompt-type-store';

/** An image being kept: its placeholder in the strip, by a key of the page's. */
export interface Staging {
  readonly key: number;
  readonly name: string | null;
}

/** A line under the input (C14, C20): fat-g's words, and whether the formats' line follows it. */
export interface ComposerProblem {
  readonly key: number;
  readonly text: string;
  readonly formats: boolean;
}

export interface SessionComposer {
  /** What main holds: the draft, the queue, and whether Send now is offered. */
  readonly main: ChatComposer;
  /** The chat revision main's state came at; -1 before any. */
  readonly seen: number;
  /** The text's revision as the page last numbered it, or took it from main. */
  readonly revision: number;
  /** The draft's intent as the page holds it: a plan turn, a chosen skill (C87). */
  readonly intent: PromptIntent;
  readonly staging: readonly Staging[];
  readonly problems: readonly ComposerProblem[];
}

const EMPTY: SessionComposer = { main: EMPTY_COMPOSER, seen: -1, revision: 0, intent: NO_INTENT, staging: [], problems: [] };

export interface ComposerState {
  readonly sessions: Readonly<Record<string, SessionComposer>>;
}

export const useComposerStore = create<ComposerState>()(() => ({ sessions: {} }));

export function composerOf(sessionId: string): SessionComposer {
  return useComposerStore.getState().sessions[sessionId] ?? EMPTY;
}

/** The session's composer, for a component. */
export function useComposer(sessionId: string): SessionComposer {
  return useComposerStore((state) => state.sessions[sessionId] ?? EMPTY);
}

function patch(sessionId: string, change: (held: SessionComposer) => SessionComposer): void {
  useComposerStore.setState((state) => {
    const held = state.sessions[sessionId] ?? EMPTY;
    const next = change(held);
    return next === held ? state : { sessions: { ...state.sessions, [sessionId]: next } };
  });
}

/** Text typed and not handed over yet, by session, with the timer that hands it over (C31). */
const unsent = new Map<string, ReturnType<typeof setTimeout>>();
/** Stagings under way, by session: what a Send waits for (C18). */
const stagings = new Map<string, Promise<unknown>>();
let keys = 0;

/**
 * Main's composer, as a read or a push carried it at a chat revision (C86): taken where newer than
 * what the page holds. Its draft's text comes into the input where its revision is at or past the
 * page's — main's own change, or text the page handed over — and never over newer typing.
 */
export function takeComposer(sessionId: string, revision: number, composer: ChatComposer): void {
  const held = composerOf(sessionId);
  if (revision < held.seen) return;
  const adopt = composer.draft.revision >= held.revision && !unsent.has(sessionId);
  if (adopt && draftOf(sessionId) !== composer.draft.text) setDraft(sessionId, composer.draft.text);
  // Plan as the draft holds it (C87): after a restart, as the user left it.
  if (adopt) setPromptType(sessionId, composer.draft.intent.plan ? 'plan' : null);
  patch(sessionId, (current) => ({ ...current, main: composer, seen: revision, ...(adopt ? { revision: composer.draft.revision, intent: composer.draft.intent } : {}) }));
}

/** The draft's text and intent handed to main now, where any is unsent (C31). Resolves once main has answered. */
export function flushDraft(sessionId: string): Promise<void> {
  const timer = unsent.get(sessionId);
  if (timer === undefined) return Promise.resolve();
  clearTimeout(timer);
  unsent.delete(sessionId);
  const { revision, intent } = composerOf(sessionId);
  return invoke('chat:draft', { sessionId, op: 'text', revision, prompt: draftOf(sessionId), intent }).then(() => undefined, () => undefined);
}

/** Whether the session has text typed and not handed over yet (C31). */
export function hasUnsentDraft(sessionId: string): boolean {
  return unsent.has(sessionId);
}

/** Every session's unsent text, handed over now: what the quit asks of the page (C31). */
export function flushAllDrafts(): Promise<void> {
  return Promise.all([...unsent.keys()].map((sessionId) => flushDraft(sessionId))).then(() => undefined);
}

/**
 * Main's ask before the page goes — its window closed, or fat-g quitting (C31): every unsent draft
 * handed over, then the ask answered. Subscribed once, by the Main page's entry.
 */
export function connectDrafts(): () => void {
  return subscribe('drafts:flush', ({ token }) => {
    void flushAllDrafts().then(() => invoke('drafts:flushed', { token })).catch(() => undefined);
  });
}

function schedule(sessionId: string): void {
  const timer = unsent.get(sessionId);
  if (timer !== undefined) clearTimeout(timer);
  unsent.set(sessionId, setTimeout(() => { void flushDraft(sessionId); }, DRAFT_SEND_MS));
}

/** The user's typing (C31): the input's text, at the next revision, handed over within 300 ms. */
export function editDraft(sessionId: string, text: string): void {
  setDraft(sessionId, text);
  // A chosen skill's name edited away from the draft's start lets go of the skill (C64, C87): what stays is text.
  patch(sessionId, (held) => {
    const skill = held.intent.skill;
    const kept = skill === null || text === `/${skill.name}` || text.startsWith(`/${skill.name} `);
    return { ...held, revision: Math.max(held.revision, held.main.draft.revision) + 1, ...(kept ? {} : { intent: { ...held.intent, skill: null } }) };
  });
  schedule(sessionId);
}

/**
 * A row of the menu chosen (C58, C64): `/name ` at the draft's start in place of what was typed of it,
 * the rest kept; a skill whose choice goes with the prompt is bound to the draft by main's selector,
 * and any other choice is text alone.
 */
export function chooseCommand(sessionId: string, row: CommandRow): void {
  const draft = draftOf(sessionId);
  const rest = draft.replace(/^\/\S*\s?/u, '');
  editDraft(sessionId, `/${row.name} ${rest}`);
  setDraftIntent(sessionId, { ...composerOf(sessionId).intent, skill: row.selector === null ? null : { name: row.name, selector: row.selector } });
}

/**
 * Plan pressed or released (M22b, C38; C87): the choice is the draft's, handed over with its text,
 * and kept through a switch, a Send and a restart. A successful Execute or Cancel releases it.
 */
export function choosePlan(sessionId: string, pressed: boolean): void {
  setPromptType(sessionId, pressed ? 'plan' : null);
  setDraftIntent(sessionId, { ...composerOf(sessionId).intent, plan: pressed });
}

/** The draft's intent changed by the user — Plan pressed or released, a skill chosen or let go (C87): handed over with the text. */
export function setDraftIntent(sessionId: string, intent: PromptIntent): void {
  patch(sessionId, (held) => ({ ...held, intent, revision: Math.max(held.revision, held.main.draft.revision) + 1 }));
  schedule(sessionId);
}

/**
 * What a Send, a Queue or an Edit carries (C86): the text as the input holds it, at a revision past
 * every update handed over, the intent, and the draft's images as main holds them. Unsent text goes
 * with it rather than ahead of it, so nothing late can follow it.
 */
export interface ComposerInput {
  readonly prompt: string;
  readonly revision: number;
  readonly intent: PromptIntent;
  readonly attachments: readonly string[];
}

export function inputOf(sessionId: string): ComposerInput {
  const timer = unsent.get(sessionId);
  if (timer !== undefined) { clearTimeout(timer); unsent.delete(sessionId); }
  const held = composerOf(sessionId);
  const revision = Math.max(held.revision, held.main.draft.revision) + 1;
  patch(sessionId, (current) => ({ ...current, revision }));
  return { prompt: draftOf(sessionId), revision, intent: held.intent, attachments: held.main.draft.attachments.map((attachment) => attachment.id) };
}

/** An input main accepted (C86): what it took is gone from the input, and text typed since stays. */
export function inputTaken(sessionId: string, taken: { readonly prompt: string; readonly revision: number }): void {
  const held = composerOf(sessionId);
  if (held.revision === taken.revision && draftOf(sessionId) === taken.prompt) setDraft(sessionId, '');
  else if (draftOf(sessionId).startsWith(taken.prompt)) {
    // Typed after the press: kept, as the next draft's start.
    editDraft(sessionId, draftOf(sessionId).slice(taken.prompt.length).replace(/^\s+/, ''));
  }
  // The message took its skill; Plan stays as pressed, for the next (C87), until Execute or Cancel releases it.
  patch(sessionId, (current) => ({ ...current, intent: { ...NO_INTENT, plan: current.intent.plan }, main: { ...current.main, draft: { ...current.main.draft, attachments: [] } } }));
}

function say(sessionId: string, text: string, formats: boolean): void {
  keys += 1;
  const key = keys;
  patch(sessionId, (held) => ({ ...held, problems: [...held.problems, { key, text, formats }] }));
}

/** The lines under the input go: a new staging, a Send, a removal. */
export function clearProblems(sessionId: string): void {
  patch(sessionId, (held) => (held.problems.length === 0 ? held : { ...held, problems: [] }));
}

/** A dropped folder (C15): refused without a look inside. */
export function refuseFolder(sessionId: string, name: string | null): void {
  say(sessionId, ATTACHMENT_WORDS.folder(name), false);
}

/** One file, staged: its first bytes looked at, then all of it handed over. Its placeholder goes when it is answered. */
async function stageOne(sessionId: string, file: File, key: number, pasted: boolean): Promise<void> {
  const name = pasted || file.name === '' ? null : file.name;
  try {
    if (file.size > MAX_IMAGE_BYTES) { say(sessionId, stageRefusalWords('too-large', name, file.size), true); return; }
    const head = new Uint8Array(await file.slice(0, SIGNATURE_BYTES).arrayBuffer());
    if (imageSignature(head) === null) { say(sessionId, ATTACHMENT_WORDS.notImage(name), true); return; }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const answer = await invoke('attachments:stage', { sessionId, bytes, ...(name === null ? {} : { name }) });
    if (answer.status === 'refused') { say(sessionId, stageRefusalWords(answer.reason, name, file.size), refusalOfImage(answer.reason)); return; }
    // The push that carries the draft has come before this answer; this is for a page that missed it.
    const staged: AttachmentDescriptor = answer.attachment;
    patch(sessionId, (held) => (held.main.draft.attachments.some((attachment) => attachment.id === staged.id) ? held : { ...held, main: { ...held.main, draft: { ...held.main.draft, attachments: [...held.main.draft.attachments, staged] } } }));
  } catch {
    say(sessionId, stageRefusalWords('storage-failed', name), false);
  } finally {
    patch(sessionId, (held) => ({ ...held, staging: held.staging.filter((entry) => entry.key !== key) }));
  }
}

/**
 * Images pasted or dropped (C13–C15): each staged in the order given, a placeholder standing for each
 * meanwhile. The lines a former staging left go first — unless `keepProblems`, for a drop whose folders were
 * just refused in the same gesture.
 */
export function stageFiles(sessionId: string, files: readonly File[], { keepProblems = false, pasted = false }: { readonly keepProblems?: boolean; readonly pasted?: boolean } = {}): Promise<void> {
  if (!keepProblems) clearProblems(sessionId);
  if (files.length === 0) return Promise.resolve();
  const keyed = files.map((file) => { keys += 1; return { file, key: keys }; });
  patch(sessionId, (held) => ({ ...held, staging: [...held.staging, ...keyed.map(({ file, key }) => ({ key, name: pasted ? 'Pasted image' : file.name === '' ? null : file.name }))] }));
  const before = stagings.get(sessionId) ?? Promise.resolve();
  const run = keyed.reduce<Promise<void>>((chain, { file, key }) => chain.then(() => stageOne(sessionId, file, key, pasted)), before.then(() => undefined, () => undefined));
  stagings.set(sessionId, run);
  void run.finally(() => { if (stagings.get(sessionId) === run) stagings.delete(sessionId); });
  return run;
}

/** Resolves once every staging of the session has been answered (C18): what a Send waits for. */
export function stagingSettled(sessionId: string): Promise<void> {
  return (stagings.get(sessionId) ?? Promise.resolve()).then(() => undefined, () => undefined);
}

/** An image taken out of the draft (C16): main answers the draft as it now is. */
export function removeAttachment(sessionId: string, attachmentId: string): Promise<void> {
  return invoke('chat:draft', { sessionId, op: 'remove', attachmentId }).then(
    (answer) => {
      if (answer.status === 'saved') patch(sessionId, (held) => ({ ...held, main: { ...held.main, draft: { ...held.main.draft, attachments: answer.draft.attachments } } }));
    },
    () => undefined,
  );
}

/** Why a queue's change was refused, in fat-g's words (C47, C50, C54); null where nothing needs saying. */
export function queueRefusalWords(reason: QueueRefusal): string | null {
  switch (reason) {
    case 'full': return COMPOSER_WORDS.full;
    case 'empty': return null;
    case 'sending': return 'That message is being sent, so it cannot be changed now.';
    case 'draft-changed': return 'The message changed while it was being queued, so nothing was queued. Queue it again.';
    case 'unknown-entry': return 'That message is no longer queued.';
    case 'not-paused': return null;
    case 'busy': return 'This session is being removed or completed, or fat-g is closing, so nothing was queued.';
    case 'unknown-session': return 'This session is no longer listed.';
    case 'conversations-refused':
    case 'storage-failed': return 'fat-g could not save the queue, so nothing changed.';
  }
}

/**
 * Queue next (C47, C48): the draft as it stands, once every image is kept, appended to the session's
 * queue; what was queued leaves the input, and text typed meanwhile stays (C86). Resolves with the
 * refusal's words, or null.
 */
export async function queueDraft(sessionId: string): Promise<string | null> {
  await stagingSettled(sessionId);
  const taking = inputOf(sessionId);
  if (taking.prompt.trim() === '' && taking.attachments.length === 0) return null;
  try {
    const answer = await invoke('chat:queue', { sessionId, op: 'append', prompt: taking.prompt, revision: taking.revision, attachments: [...taking.attachments], intent: taking.intent });
    if (answer.status === 'saved') { inputTaken(sessionId, taking); return null; }
    return queueRefusalWords(answer.reason);
  } catch {
    return queueRefusalWords('storage-failed');
  }
}

/** Edit (C50): the entry's input comes into the composer, and the draft as it stands takes its place. */
export async function editQueued(sessionId: string, entryId: string): Promise<string | null> {
  await stagingSettled(sessionId);
  const taking = inputOf(sessionId);
  try {
    const answer = await invoke('chat:editQueued', { sessionId, entryId, prompt: taking.prompt, revision: taking.revision, attachments: [...taking.attachments], intent: taking.intent });
    return answer.status === 'saved' ? null : queueRefusalWords(answer.reason);
  } catch {
    return queueRefusalWords('storage-failed');
  }
}

/** A queued message removed (C50), or the queue put in a new order (C51), or resumed (C89): main's answer, in words where it refused. */
export async function changeQueue(sessionId: string, change: { readonly remove: string } | { readonly order: readonly string[] } | { readonly resume: true }): Promise<string | null> {
  try {
    const answer = 'remove' in change
      ? await invoke('chat:unqueue', { sessionId, entryId: change.remove })
      : 'order' in change ? await invoke('chat:queue', { sessionId, op: 'reorder', ids: [...change.order] })
        : await invoke('chat:resumeQueue', { sessionId });
    return answer.status === 'saved' ? null : queueRefusalWords(answer.reason);
  } catch {
    return queueRefusalWords('storage-failed');
  }
}

/** For tests: nothing held. */
export function resetComposers(): void {
  for (const timer of unsent.values()) clearTimeout(timer);
  unsent.clear();
  stagings.clear();
  useComposerStore.setState({ sessions: {} });
}
