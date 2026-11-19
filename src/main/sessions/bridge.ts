// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The bridge (docs/planning/_archive/M15.md, Design 9; C47, C113; M18.md, Design 4; M19.md, Design 1; M20a.md,
// Design 2; C13, C20; M21.md, Design 2): one normalized agent event in, M14's source events and the chat's changes out. It names no provider and reads no frame: an adapter
// knows neither the summary nor the chat, and what a session is doing reaches both through here.
//
// Conversation text has one route, to the chat (C10). The summary gets ids, kinds and labels; the
// one conversation text that becomes a label, an action's line, is cut to what M14's events take,
// and M14 then shortens it as it always did.
//
// What a session does between its messages is conversation content too (M20a, C30): an activity's
// start and end go to the chat alone, and nothing of them to the summary. So does everything that
// names a worker as its owner: a worker's message is never the session's answer, its action line or
// its name (C20), and what the agent list shows of a worker stays what the worker events say.
//
// A question asked beside the session is none of the session's (M20b, C4, C33): an event that
// names an aside goes to the chat alone, under the aside, and nothing of it reaches the summary,
// the record or the Pet — not its turn's start, not its end, not a line of it.
import type { ActivityEnd, ActivityStart } from '@shared/contracts/activity';
import { type AgentEvent, type AgentQuestion, cutLine, type MessagePhase, type NoticeKind, type RefusedBound, type StartStep } from '@shared/contracts/agent-events';
import { catalogId } from '@shared/contracts/catalog';
import type { SessionEvent } from '@shared/contracts/sessions';

/** What an event asks of the chat. The runtime holds the store, and the words. `workerId`: whose item it is, or null for the session's own. */
export type ChatChange =
  | { readonly kind: 'assistant'; readonly turnId: string; readonly itemId: string; readonly workerId: string | null; readonly phase: MessagePhase | null; readonly text: string; readonly cut: boolean; readonly questions: readonly AgentQuestion[]; /** The model that wrote it, where the provider named one (M20b, C25). */ readonly model: string | null }
  /** More of an assistant's message as it is written (M19, C3): the first one for an item id opens it. */
  | { readonly kind: 'delta'; readonly turnId: string; readonly itemId: string; readonly workerId: string | null; readonly phase: MessagePhase | null; readonly text: string }
  /** Something the session, or a worker of it, does began (M20a, C59): or, for an item that is open, what its start said is replaced. */
  | { readonly kind: 'activity-started'; readonly turnId: string; readonly itemId: string; readonly workerId: string | null; readonly start: ActivityStart; readonly providerAt: number | null }
  /** It ended, as the provider reports it. `durationMs`: the provider's own, or null where it gave none. `untimed`: none of fat-g's own is measured for it (C7). */
  | { readonly kind: 'activity-ended'; readonly turnId: string; readonly itemId: string; readonly workerId: string | null; readonly end: Omit<ActivityEnd, 'duration'>; readonly providerAt: number | null; readonly durationMs: number | null; readonly untimed: boolean }
  /** The provider's echo of the user's own message: it adds none, and gives the accepted one its id (C56). */
  | { readonly kind: 'echo'; readonly itemId: string; readonly clientId: string | null }
  /** `turnId`: the turn it belongs to, or null for one with none. `bound` and `size` (M22, C9, C67, C71): what a refusal for a size, or a line too long, names. */
  | { readonly kind: 'notice'; readonly turnId: string | null; readonly notice: NoticeKind; readonly step: StartStep | null; readonly detail: string | null; readonly bound: RefusedBound | null; readonly size: number | null };

export interface Bridged {
  /** For the session service, in order. */
  readonly session: readonly SessionEvent[];
  readonly chat: readonly ChatChange[];
  /** The provider's session exists: what the runtime keeps until the record holds it (C108). */
  readonly reference: { readonly reference: string; readonly folder: string } | null;
  /** The provider took the prompt, and named the turn by its own id where it has one (M18, C47). */
  readonly taken: { readonly turnId: string; readonly providerTurnId: string | null } | null;
  /**
   * The turn this event ended, with how. `reported`: the provider itself said so; otherwise the
   * adapter ended it, and the end is the session's alone (M18, C59). `answerItemId`: the provider's
   * id of the message that is the turn's answer, passed on only for an end that is reported and
   * completed (M16, C74).
   */
  readonly ended: { readonly turnId: string; readonly outcome: 'completed' | 'interrupted' | 'failed'; readonly failure: string | null; readonly reported: boolean; readonly answerItemId: string | null } | null;
  /**
   * The aside whose event it was (M20b, C25), or null for the session's own: `chat`, `taken` and
   * `ended` are then that aside's conversation's, and `session` is empty.
   */
  readonly asideId: string | null;
}

const NONE: Bridged = { session: [], chat: [], reference: null, taken: null, ended: null, asideId: null };

/** The first line of the first accepted prompt, cut to what a name's event takes (C46, C113). */
export function firstPromptName(prompt: string): string {
  return cutLine(prompt);
}

/** One event, as the session's own would be bridged — and, where it names an aside, with nothing for the session (M20b, C4, C33). */
export function bridge(sessionId: string, event: AgentEvent): Bridged {
  const bridged = bridgeEvent(sessionId, event);
  const asideId = 'asideId' in event ? event.asideId ?? null : null;
  return asideId === null ? bridged : { ...bridged, session: [], reference: null, asideId };
}

function bridgeEvent(sessionId: string, event: AgentEvent): Bridged {
  switch (event.type) {
    case 'image-returned':
      // Main's image receiver owns bytes; the summary and renderer bridge receive none.
      return NONE;
    case 'session-started':
      return { ...NONE, session: [{ type: 'reference-set', sessionId, reference: event.reference, folder: event.folder }], reference: { reference: event.reference, folder: event.folder } };
    case 'turn-started':
      // The turn began for fat-g when the prompt was accepted (C86): this says the provider took it.
      return { ...NONE, taken: { turnId: event.turnId, providerTurnId: event.providerTurnId ?? null } };
    case 'message':
      if (event.role === 'user') {
        // A worker's instruction is no message of the conversation, and no echo of the user's own (M20a, C18).
        if (event.workerId !== undefined) return NONE;
        return { ...NONE, chat: [{ kind: 'echo', itemId: event.itemId, clientId: event.clientId ?? null }] };
      }
      return { ...NONE, chat: [{ kind: 'assistant', turnId: event.turnId, itemId: event.itemId, workerId: event.workerId ?? null, phase: event.phase, text: event.text, cut: event.cut === true, questions: event.questions ?? [], model: event.model ?? null }] };
    case 'message-delta':
      // Conversation text, as a message's is: to the chat alone, and nothing of it to the summary (M19, C23).
      return { ...NONE, chat: [{ kind: 'delta', turnId: event.turnId, itemId: event.itemId, workerId: event.workerId ?? null, phase: event.phase, text: event.text }] };
    case 'activity-started':
      return {
        ...NONE,
        chat: [{
          kind: 'activity-started', turnId: event.turnId, itemId: event.itemId, workerId: event.workerId ?? null, providerAt: event.providerAt ?? null,
          start: {
            type: event.activityType, name: event.name, summary: event.summary,
            ...(event.input === undefined ? {} : { input: event.input }),
            ...(event.files === undefined ? {} : { files: event.files }),
            ...(event.changes === undefined ? {} : { changes: event.changes }),
            ...(event.steps === undefined ? {} : { steps: event.steps }),
            ...(event.thinking === undefined ? {} : { thinking: event.thinking }),
            ...(event.pairedWorkerId === undefined ? {} : { workerId: event.pairedWorkerId }),
            ...(event.cut === undefined ? {} : { cut: event.cut }),
            // A worker item's model and agent definition (M106, C19, C20): a model only where it is a key.
            ...(event.model === undefined || catalogId(event.model) === null ? {} : { model: event.model }),
            ...(event.agentType === undefined ? {} : { agentType: event.agentType }),
          },
        }],
      };
    case 'activity-ended':
      return {
        ...NONE,
        chat: [{
          kind: 'activity-ended', turnId: event.turnId, itemId: event.itemId, workerId: event.workerId ?? null, providerAt: event.providerAt ?? null, durationMs: event.durationMs ?? null, untimed: event.untimed === true,
          end: {
            status: event.status,
            ...(event.output === undefined ? {} : { output: event.output }),
            ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
            ...(event.declinedBy === undefined ? {} : { declinedBy: event.declinedBy }),
            ...(event.files === undefined ? {} : { files: event.files }),
            ...(event.changes === undefined ? {} : { changes: event.changes }),
            ...(event.steps === undefined ? {} : { steps: event.steps }),
            ...(event.thinking === undefined ? {} : { thinking: event.thinking }),
            ...(event.cut === undefined ? {} : { cut: event.cut }),
          },
        }],
      };
    case 'action-changed':
      return { ...NONE, session: [{ type: 'action-changed', sessionId, turnId: event.turnId, kind: event.kind, ...(event.wait === undefined ? {} : { wait: event.wait }), ...(event.tool === undefined ? {} : { tool: event.tool }), ...(event.line === undefined ? {} : { line: cutLine(event.line) }), ...(event.file === undefined ? {} : { file: cutLine(event.file) }) }] };
    case 'worker-started': {
      // Its model and agent definition (M106, C14, C20): a model the summary could not take as a key names nothing, and loses no worker.
      const model = event.model === undefined ? null : catalogId(event.model);
      return {
        ...NONE,
        session: [{
          type: 'worker-started', sessionId, workerId: event.workerId,
          ...(event.description === undefined ? {} : { description: cutLine(event.description) }),
          ...(model === null ? {} : { model }),
          ...(event.agentType === undefined ? {} : { agentType: cutLine(event.agentType) }),
        }],
      };
    }
    case 'worker-model': {
      const model = catalogId(event.model);
      return model === null ? NONE : { ...NONE, session: [{ type: 'worker-model', sessionId, workerId: event.workerId, model }] };
    }
    case 'worker-progressed':
      return { ...NONE, session: [{ type: 'worker-progressed', sessionId, workerId: event.workerId, kind: event.kind, ...(event.wait === undefined ? {} : { wait: event.wait }), ...(event.tool === undefined ? {} : { tool: event.tool }), ...(event.line === undefined ? {} : { line: cutLine(event.line) }), ...(event.file === undefined ? {} : { file: cutLine(event.file) }) }] };
    case 'worker-ended':
      return { ...NONE, session: [{ type: 'worker-ended', sessionId, workerId: event.workerId, outcome: event.outcome }] };
    case 'in-force':
      // The mode a process confirmed is the runtime's to take (M22, C2, C75): it knows which process
      // said so, and tells the summary itself. What a turn runs with goes on as before.
      if (event.model === undefined && event.effort === undefined && event.served === undefined) return NONE;
      return { ...NONE, session: [{ type: 'in-force', sessionId, ...(event.model === undefined ? {} : { model: event.model }), ...(event.effort === undefined ? {} : { effort: event.effort }), ...(event.served === undefined ? {} : { served: event.served, servedReason: event.servedReason ?? null }) }] };
    case 'notice':
      return { ...NONE, chat: [{ kind: 'notice', turnId: event.turnId ?? null, notice: event.kind, step: event.step ?? null, detail: event.detail ?? null, bound: event.bound ?? null, size: event.size ?? null }] };
    case 'turn-ended':
      // The summary and the record take every end alike, as M15 has them; the store is told whose it is.
      return {
        ...NONE,
        session: [{ type: 'turn-ended', sessionId, turnId: event.turnId, outcome: event.outcome }],
        ended: { turnId: event.turnId, outcome: event.outcome, failure: event.failure ?? null, reported: event.reported, answerItemId: event.reported && event.outcome === 'completed' ? event.answerItemId ?? null : null },
      };
    case 'question-raised':
    case 'question-resolved':
    case 'approval-raised':
    case 'approval-resolved':
    case 'plan-raised':
    case 'plan-resolved':
    case 'plan-delta':
    case 'plan-completed':
      // A question asked as a request is the request registry's (M21, C10, C20), and so is an action
      // asked leave for (M22, C10) and a plan a request holds (M22b, C10): the runtime hands it each
      // event before any reaches here, and the bridge raises no request and resolves none. A plan being
      // written is the plan store's and its line's (M22b, C14, C59), which the runtime writes itself.
      return NONE;
    case 'delivery':
    case 'held-turn-started':
      // What became of a message sent into a running turn (M23, C38, C42) is the runtime's: it holds
      // what it handed, and writes the message's state and its move to the next turn itself.
      return NONE;
    case 'steer-changed':
      // Whether a message can go into the turn is the runtime's to ask again.
      return NONE;
    case 'context':
      // How full the context window is (decision 0033): the summary's alone, never the chat's.
      return { ...NONE, session: [{ type: 'context', sessionId, reading: event.reading }] };
  }
}
