// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The chat channels (docs/planning/_archive/M15.md, Design 13; C54, C76; M18.md, Design 10; M20a.md, Design 7;
// C32, C34; M20b.md, Design 5; C33, C73; M21.md, Design 5; C31, C34). The page names a
// session and, for a Send, gives a prompt; everything else is the runtime's: why a prompt cannot be
// taken is worked out in main again, whatever the page showed (C105). A read names the window the
// page holds, or nothing for the newest page, and a page names an item as its cursor (M18, C20, C60).
//
// A worker's read names its session and the worker, and a cursor for an older page (M20a, C32). What
// main says of one is its outcome's kind, counted (C34): never an id, a text, a path or a command line.
//
// A question beside a session names the session and the aside, and gives the text typed or the
// selection it is about (M20b, C73). What main says of an ask, an aside's read, its Stop and its
// removal is, again, the outcome's kind, counted (C33): never a question, an excerpt or an answer.
//
// An answer names the session and the card's item, and gives one entry for each of its questions;
// a dismissal names the same two (M21, C31). What main says of either is its outcome's kind,
// counted (C34): never a question, an option or an answer — and a secret's answer passes through
// here to the runtime and the provider's session, and is written nowhere (C44).
//
// A change of a chat's mode names the session and a mode's id; a decision names the session, the
// card's item and one of its choices (docs/planning/_archive/M22.md, Design 9; C88). What main says of either
// is its outcome's kind, counted (C26): never a command, a path, a change's content or a grant.
//
// A change of a draft names the session and gives its text at a revision, an image's use to take out,
// a clear or a write now (docs/planning/_archive/M23.md, Design 5, 10; C86): what main says of it is nothing —
// the draft is conversation content, and its outcome is the page's to show.
//
// The fifteen are the Main window's only. A prompt and a message are the user's own conversation,
// and so is what a session and its workers did, what was asked beside it and what it asked leave
// for; the Pet shows on screen shares: it is refused each as `forbidden`, by the contract.
import type { SessionRuntime } from '../../sessions/runtime';
import type { InvokeHandlers } from '../dispatch';
import { createKindCounts, type KindCounts } from './counts';

type Channels = 'chat:read' | 'chat:page' | 'chat:readWorker' | 'chat:send' | 'chat:stop' | 'chat:loadHistory' | 'chat:ask' | 'chat:readAside' | 'chat:stopAside' | 'chat:removeAside' | 'chat:answer' | 'chat:dismiss' | 'chat:setMode' | 'chat:decide' | 'chat:draft' | 'chat:queue' | 'chat:unqueue' | 'chat:editQueued' | 'chat:resumeQueue' | 'chat:commands';

export function chatHandlers(
  runtime: Pick<SessionRuntime, 'read' | 'page' | 'readWorker' | 'send' | 'stop' | 'loadHistory' | 'ask' | 'readAside' | 'stopAside' | 'removeAside' | 'answer' | 'dismiss' | 'setMode' | 'decide' | 'draft' | 'queue' | 'unqueue' | 'editQueued' | 'resumeQueue' | 'commands'>,
  workerReads: KindCounts = createKindCounts(),
  /** What main says of the asides (M20b, C33): each channel's outcomes, by kind. */
  asides: KindCounts = createKindCounts(),
  /** What main says of an answer and a dismissal (M21, C34): each outcome, by kind. */
  answers: KindCounts = createKindCounts(),
  /** What main says of a change of mode and a decision (M22, C26): each outcome, by kind. */
  permissions: KindCounts = createKindCounts(),
): Pick<InvokeHandlers, Channels> {
  /** An outcome's kind: what it did, or why it did not. */
  const said = (what: string, answer: { readonly status: string; readonly reason?: string }): void => asides.add(answer.status === 'refused' ? `${what}:refused:${answer.reason ?? ''}` : `${what}:${answer.status}`);
  return {
    async 'chat:ask'(request) {
      const answer = await runtime.ask(request);
      // Which way in it was, and what became of it: never the question, nor the passage.
      said('source' in request ? 'explain' : 'question', answer);
      return answer;
    },
    'chat:readAside'({ sessionId, asideId, before }) {
      const answer = runtime.readAside(sessionId, asideId, before);
      said(before === undefined ? 'read' : 'page', answer);
      return answer;
    },
    'chat:stopAside'({ sessionId, asideId }) {
      const answer = runtime.stopAside(sessionId, asideId);
      said('stop', answer);
      return answer;
    },
    'chat:removeAside'({ sessionId, asideId }) {
      const answer = runtime.removeAside(sessionId, asideId);
      said('remove', answer);
      return answer;
    },
    async 'chat:answer'({ sessionId, itemId, answers: entries }) {
      const answer = await runtime.answer(sessionId, itemId, entries);
      // What became of it, and never what was asked or answered: a secret's text is among the entries.
      answers.add(answer.status === 'refused' ? `answer:refused:${answer.reason}` : `answer:${answer.status}`);
      return answer;
    },
    'chat:dismiss'({ sessionId, itemId }) {
      const answer = runtime.dismiss(sessionId, itemId);
      answers.add(answer.status === 'refused' ? `dismiss:refused:${answer.reason}` : `dismiss:${answer.status}`);
      return answer;
    },
    async 'chat:setMode'({ sessionId, mode }) {
      const answer = await runtime.setMode(sessionId, mode);
      // What became of it: never the mode, which is the user's choice for their own chat.
      permissions.add(answer.status === 'refused' ? `mode:refused:${answer.reason}` : `mode:${answer.status}`);
      return answer;
    },
    'chat:decide'({ sessionId, itemId, choice }) {
      const answer = runtime.decide(sessionId, itemId, choice);
      // Which choice, and what became of it: never what it was a decision on.
      permissions.add(answer.status === 'refused' ? `decide:refused:${answer.reason}` : `decide:${choice}`);
      return answer;
    },
    'chat:read': (request) => runtime.read(request.sessionId, 'from' in request ? { from: request.from, keep: request.keep } : undefined),
    'chat:page': ({ sessionId, before }) => runtime.page(sessionId, before),
    'chat:readWorker'({ sessionId, workerId, before }) {
      const answer = runtime.readWorker(sessionId, workerId, before);
      workerReads.add(answer.status === 'read' ? (before === undefined ? 'read:window' : 'read:page') : `refused:${answer.reason}`);
      return answer;
    },
    // A plan turn is the prompt's own mode (M22b, C1): the chat's mode is not changed for it.
    // The draft it is (M23, C86): its revision, its images by their uses' ids and its intent, which main checks against the draft.
    'chat:send': ({ sessionId, prompt, mode, revision, attachments, skill, plan, when }) => {
      const input = revision === undefined ? undefined : { revision, attachmentIds: attachments ?? [], intent: { plan: plan ?? mode === 'plan', skill: skill ?? null } };
      // Into the running turn (M23, C36): main chooses and checks the route.
      const now = when === 'now' ? { now: true } : {};
      if (mode === 'plan') return runtime.send(sessionId, prompt, { plan: true, ...(input === undefined ? {} : { input }), ...now });
      return input === undefined && when !== 'now' ? runtime.send(sessionId, prompt) : runtime.send(sessionId, prompt, { ...(input === undefined ? {} : { input }), ...now });
    },
    'chat:stop': ({ sessionId }) => runtime.stop(sessionId),
    'chat:draft': (request) => runtime.draft(request),
    // The queue (M23, C47–C51, C89): main holds it, and checks every id against the session's own entries.
    'chat:queue': (request) => runtime.queue(request),
    'chat:unqueue': ({ sessionId, entryId }) => runtime.unqueue(sessionId, entryId),
    'chat:editQueued': (request) => runtime.editQueued(request),
    'chat:resumeQueue': ({ sessionId }) => runtime.resumeQueue(sessionId),
    'chat:commands': ({ sessionId }) => runtime.commands(sessionId),
    'chat:loadHistory': ({ sessionId }) => runtime.loadHistory(sessionId),
  };
}
