// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A plan's workflow (decision 0029): the one state a plan's chats share, kept by main in the plan's
// record. Every chat that made the plan, brought it or received its integration takes part in it,
// and each draws its decision, or what holds the plan now, from this view alone — never from the
// newest plan line of its own conversation, which is history.
//
//   ready          every participating chat decides on the latest complete version
//   reviewing      one reviewer reviews it; the others wait, or cancel the review
//   revising       one chat writes the next version; the others wait
//   implementing   one chat carries it out; the others go on with ordinary conversation
//   interrupted    that chat was stopped: its next prompt continues it, or the plan is discarded; once
//                  that chat is removed or Done, the plan is ready again in the chats left
//   implemented    carried out: the plan is then deleted, and each chat keeps a line that says so
//   cancelled      discarded: the plan is then deleted
//
// One operation at a time: a review, a revision or an implementation, held by one session and
// started only once main has reserved it. A request names the revision it was drawn from, so that a
// stale or competing one sends nothing.
//
// Renderer-safe, and provider-neutral. It imports `zod` and the plans contract, and nothing of Node,
// the page or main.
import { z } from 'zod';
import { PlanIdSchema } from './plans';

export const WORKFLOW_STATES = ['ready', 'reviewing', 'revising', 'implementing', 'interrupted', 'implemented', 'cancelled'] as const;
export type WorkflowState = (typeof WORKFLOW_STATES)[number];

/** What holds a plan between two ready states: a reviewer, a writer, or the chat that carries it out. */
export const WORKFLOW_OPERATIONS = ['review', 'revision', 'implementation'] as const;
export type WorkflowOperation = (typeof WORKFLOW_OPERATIONS)[number];

/** The states whose plan is still in play: a chat that takes part in one takes part in no other. */
export const isWorkflowActive = (state: WorkflowState): boolean => state !== 'implemented' && state !== 'cancelled';

/**
 * Work under way that the view must wait for: a review being made, a request being retired before
 * another chat carries the plan out or a newer version replaces it, or the plan being discarded.
 */
export const WORKFLOW_BUSY = ['starting', 'retiring', 'cancelling'] as const;
export type WorkflowBusy = (typeof WORKFLOW_BUSY)[number];

/** A plan's workflow as the page draws it. Names are those the records give, or null for a chat no longer listed. */
export interface WorkflowView {
  readonly planId: string;
  readonly state: WorkflowState;
  /** Counts each change: what a request names, so that one drawn from an older state is refused. */
  readonly revision: number;
  /** The latest complete version every decision stands on; null for a plan with none yet. */
  readonly version: number | null;
  readonly participants: readonly string[];
  /** The session that holds the operation, with its name; null in `ready`, and while a reviewer is being made. */
  readonly holder: { readonly sessionId: string; readonly chat: string | null } | null;
  readonly operation: WorkflowOperation | null;
  /** The review under way, for `reviewing`. */
  readonly reviewId: string | null;
  readonly busy: WorkflowBusy | null;
}

/** A chat's part in a plan's workflow: a participant, the reviewer, or the chat a finished plan leaves its line in. */
export type SessionWorkflow =
  | { readonly kind: 'plan'; readonly role: 'participant' | 'reviewer'; readonly workflow: WorkflowView }
  /** The plan was carried out and deleted. Its implementing chat hides the line after one later turn
   * ends; the underlying note remains until the chat takes part in another plan. */
  | { readonly kind: 'implemented'; readonly sessionId: string; readonly chat: string | null; readonly at: number };

/** A chat's part, as `plans:workflow` reads it. */
export const PlanWorkflowRequestSchema = z.strictObject({ sessionId: z.guid() });
export type PlanWorkflowRequest = z.infer<typeof PlanWorkflowRequestSchema>;
export type PlanWorkflowResult = { readonly status: 'read'; readonly workflow: SessionWorkflow | null } | { readonly status: 'refused'; readonly reason: 'unknown-session' | 'storage-failed' };

/** A workflow changed: the plan and every chat whose part in it may read otherwise now. Ids alone. */
export interface WorkflowPush {
  readonly planId: string;
  readonly sessionIds: readonly string[];
}
export const WorkflowPushSchema = z.strictObject({ planId: PlanIdSchema, sessionIds: z.array(z.guid()) });

/** fat-g's words for what holds a plan, in a chat that waits on it or goes on beside it. */
export const WORKFLOW_WORDS = {
  underReview: 'Plan under review',
  reviewSession: 'Review session',
  cancelReview: 'Cancel review',
  beingRevised: 'Plan being revised',
  writer: 'Writer',
  /** Each followed by the chat it names, a button that selects it. */
  implementingIn: 'Plan being implemented in',
  interruptedIn: 'Implementation interrupted in',
  implementedIn: 'Plan implemented in',
  /** The chat that carries it out was stopped: its composer continues it. */
  interruptedHere: 'Implementation interrupted in this chat: your next prompt continues it.',
  implementingHere: 'This chat is implementing the plan.',
  implementedHere: 'Plan implemented in this chat',
  cancelling: 'Cancelling…',
  starting: 'Starting the review…',
  retiring: 'Closing the plan’s earlier request…',
  discard: 'Discard plan',
  leave: 'Leave plan mode, keep plan',
  /** A chat no longer listed, or one with no name yet. */
  removedChat: 'a removed chat',
  unnamedChat: 'an unnamed chat',
} as const;

/** A chat named in a workflow's words: its name, or what stands for it. */
export function workflowChat(chat: string | null): string {
  return chat === null ? WORKFLOW_WORDS.removedChat : chat === '' ? WORKFLOW_WORDS.unnamedChat : chat;
}
