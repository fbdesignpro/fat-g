// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Plan review (docs/planning/_archive/M22e.md, Design 3–7; C1–C12, C14, C16, C21, C23–C31, C33, C34, C36, C38, C39,
// C41, C43, C45–C55; decision 0029): a plan's version sent to a reviewer session under fat-g's fixed
// instruction, the answers of the turns started for it read into rounds, the user's marks and notes
// written into the review's record, Send notes, Explain on a finding, and the integration of the
// accepted findings by the route its target's delivery takes.
//
//   reviews:start  ─► checks ─► the reviewer made, named, under the reading mode ─► the record, running
//                   ─► the composed prompt, under a turn id written first
//   a turn's end   ─► one of the review's? ─► its `final` answer ─► a round, `asked`, or a failure
//   a card's answer, its dismissal, its pass ─► the asked turn carried on, or ended with no answer
//   reviews:send   ─► the turn written waiting with its notes ─► Send notes' prompt
//   reviews:integrate ─► checks, the route again ─► a new target made ─► the integration, `sent`
//                   ─► the decision's feedback, or a plan turn ─► settled by a complete version naming
//                      it, or ended with its reason
//
// The plan's workflow (decision 0029): a review is an operation its coordinator admits, reserved
// before its reviewer is made, and a hard stop on the plan until it is cancelled — from the reviewer
// or a chat of the plan — concluded with no change, or handed to an integration, each of which
// closes it for good and marks the reviewer Done, but a reviewer that integrates into itself, which
// takes part in the plan from then. A failed review closes it too. Nothing hides it meanwhile.
//
// Electron-free, and no provider is named here: the plan store — the one writer of `plans/`, the
// reviews in it — the conversation store, the session service and the runtime are handed in. Nothing
// runs without a press, and nothing is sent again by itself (C14, C27). Nothing of a review's text —
// a finding, an appraisal, a note, a title — is logged: kinds and counts alone (C16; 0024, item 9).
import type { AsideSource } from '@shared/contracts/aside';
import type { ChatAskResult, ChatSendResult, ChatSetModeResult } from '@shared/contracts/chat';
import { questionOf } from '@shared/contracts/interaction';
import { MAX_PLAN_TEXT, type PlanDecideResult, type PlanIntegration, planBlock, planToken } from '@shared/contracts/plans';
import type { ModelPreset } from '@shared/contracts/presets';
import {
  type AnchorPlace,
  carryRound,
  type Finding,
  findingExcerpt,
  findingQuestion,
  type IntegrationOffer,
  type IntegrationReason,
  type IntegrationRoute,
  integrationText,
  keepSetAside,
  readFindings,
  REVIEW_BOUNDS,
  REVIEW_INSTRUCTION_VERSION,
  type ReviewExplainRequest,
  type ReviewExplainResult,
  type ReviewIntegrateRequest,
  type ReviewIntegrateResult,
  type ReviewMark,
  type ReviewMarkRequest,
  type ReviewMarkResult,
  type ReviewNoteRequest,
  type ReviewNoteResult,
  type ReviewCloseRequest,
  type ReviewCloseResult,
  type ReviewPush,
  type ReviewReadRequest,
  type ReviewReadResult,
  type ReviewReason,
  reviewerName,
  reviewPrompt,
  type ReviewSendRequest,
  type ReviewSendResult,
  type ReviewStartRequest,
  type ReviewStartResult,
  type ReviewSummary,
  type ReviewView,
  sendNotesPrompt,
  type SetAside,
} from '@shared/contracts/review';
import type { SessionCreated, SessionRefusal, TurnOutcome } from '@shared/contracts/sessions';
import { normalizeName } from '@shared/contracts/names';
import type { ConversationStore } from '../conversations/store';
import type { PlanFileRecord } from '../plans/format';
import type { IntegrationRecord, LiveMark, ReviewRecord, ReviewRoundRecord, ReviewTurnRecord } from '../plans/review-format';
import type { PlanStore } from '../plans/store';
import type { SessionRecord } from '../records/format';
import type { PresetAdmission } from './preset-admission';
import type { ReviewHooks, SessionRuntime } from './runtime';
import type { WorkflowCoordinator, WorkflowReviews } from './workflow';

/** What the service asks of the sessions, the records and the runtime: handed in, so that it reaches none of them itself. */
export interface ReviewHost {
  /** A listed session's record. */
  record(sessionId: string): SessionRecord | undefined;
  /** A listed session's name; null where it has none, or is not listed. */
  name(sessionId: string): string | null;
  /** A turn of it, or its workers, run. */
  running(sessionId: string): boolean;
  /** fat-g is quitting. */
  quitting(): boolean;
  /** Whether a session of the project may start on the preset, as `sessions:create` checks one (decision 0016, item 2). */
  admit(projectId: string, preset: ModelPreset): PresetAdmission;
  /** A session of the project on the preset, made and selected as the New session popup makes one, named in the same write where a name is given (C26, C39). */
  create(projectId: string, preset: ModelPreset, name?: string): Promise<SessionCreated | SessionRefusal>;
  /** A session made for a review or an integration that never started, removed again (C47): nothing of the user's is in it. */
  remove(sessionId: string): Promise<unknown>;
  /** The project folder a listed session runs in, which the review prompt names (C2); null where it has none. */
  folder(record: SessionRecord): string | null;
  /** Marks a chat Done: a reviewer whose review closed (decision 0029). */
  complete(sessionId: string): Promise<unknown>;
  readonly runtime: Pick<SessionRuntime, 'sendComposed' | 'setMode' | 'decidePlan' | 'ask' | 'planLine' | 'planTurnWords' | 'readingMode' | 'reviewWaiting' | 'stop'> & {
    /** Resolves once the session runs nothing. */
    untilIdle(sessionId: string): Promise<void>;
  };
}

export interface ReviewServiceOptions {
  /** New findings ready for triage after the turn and its workers, never on recovery or edits. */
  readonly onRoundReady?: (reviewId: string, round: number) => void;
  /** The plan store: the one writer of `plans/`, a review's record among them. */
  readonly store: Pick<PlanStore, 'get' | 'read' | 'reviews' | 'allReviews' | 'review' | 'createReview' | 'updateReview'>;
  /** A turn's answer, and a card's outcome (C43, C49). */
  readonly conversations: Pick<ConversationStore, 'turnAnswer' | 'item'>;
  readonly host: ReviewHost;
  /** The plan's workflow (decision 0029): what admits a review and an integration, and what a review's end readies. */
  readonly workflow: Pick<WorkflowCoordinator, 'reserveReview' | 'reviewStarted' | 'release' | 'reserveHandOff' | 'handOff' | 'reviewEnded' | 'view'>;
  /** Ids alone (C44), to the Main window alone. */
  readonly push?: (push: ReviewPush) => void;
  readonly now?: () => number;
  readonly newId?: () => string;
  /** Twelve hex digits, for a block's token (M22b, C68). */
  readonly token?: () => string;
  /** Kinds and counts alone (C16). */
  readonly log?: Pick<Console, 'info' | 'warn'>;
}

export interface ReviewService extends ReviewHooks, WorkflowReviews {
  start(request: ReviewStartRequest): Promise<ReviewStartResult>;
  mark(request: ReviewMarkRequest): ReviewMarkResult;
  note(request: ReviewNoteRequest): ReviewNoteResult;
  send(request: ReviewSendRequest): Promise<ReviewSendResult>;
  explain(request: ReviewExplainRequest): Promise<ReviewExplainResult>;
  integrate(request: ReviewIntegrateRequest): Promise<ReviewIntegrateResult>;
  /** Cancel review, from the reviewer or a chat of its plan; or concluded with no change (decision 0029). */
  close(request: ReviewCloseRequest): Promise<ReviewCloseResult>;
  read(request: ReviewReadRequest): ReviewReadResult;
  /** The integration a version made in this turn carries out (C11, C49): the plan service's chain asks. */
  integration(sessionId: string, turnId: string): (PlanIntegration & { readonly planId: string; readonly revises: number }) | null;
  /** A version completed (C27, C36): what it settles, and the reviews it made stale, are pushed. */
  versionMade(planId: string, version: number): void;
  /** Counts by kind (C16). */
  counts(): Readonly<Record<string, number>>;
  /** At a launch, once the runtime and the service are made: PLAN REVIEW on each reviewer whose triage panel stands. */
  launched(): void;
}

const hex = (): string => Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => byte.toString(16).padStart(2, '0')).join('');

/** What a send refused, as a review's refusal: the send's own reasons pass, a card's never come. */
type Refusal<R> = Extract<R, { status: 'refused' }>;

/** Words of fat-g's for an unavailable target (C9, C50). */
export const OFFER_WORDS = Object.freeze({
  otherDecision: 'A plan’s decision waits in that chat.',
  running: 'That chat is still working.',
  changeMode: 'Its mode is chosen in its header.',
  bringAgain: 'Integrate into another chat, or a new one.',
  notOffered: 'That chat is not one this review can be integrated into.',
});

export function createReviewService(options: ReviewServiceOptions): ReviewService {
  const { store, conversations, host, workflow } = options;
  const now = options.now ?? Date.now;
  const newId = options.newId ?? (() => crypto.randomUUID());
  const token = options.token ?? hex;
  const log = options.log ?? console;
  const tally = new Map<string, number>();
  /** The sessions a start is under way from (C1): one at a time each. */
  const starting = new Set<string>();
  /** The reviews an integration is under way for, from its checks to its send's answer (C47). */
  const integrating = new Set<string>();
  /** The turns whose send has not answered yet: a process lost meanwhile has not ended them. */
  const sending = new Set<string>();
  /** A reviewed version's text, read once for the run's anchors (C41). */
  const texts = new Map<string, string | null>();
  /** The reviews being closed: one close at a time each. */
  const closing = new Set<string>();

  function count(what: string): void {
    const total = (tally.get(what) ?? 0) + 1;
    tally.set(what, total);
    if (/^10*$/.test(String(total))) log.info(`[reviews] ${what}, ${total} so far`);
  }

  const pushOf = (review: ReviewRecord): void => { options.push?.({ reviewId: review.id, planId: review.planId, sessionId: review.reviewer.sessionId }); };

  /** One change of a review, written whole and pushed (C6); null where the write failed, which is said by its kind. */
  function change(review: ReviewRecord, recipe: (held: ReviewRecord) => ReviewRecord | null): ReviewRecord | null {
    let written: ReviewRecord;
    try { written = store.updateReview(review.planId, review.id, recipe); } catch { count('review not written (storage)'); return null; }
    if (written !== review) {
      pushOf(written);
      triage(written);
      if (options.onRoundReady !== undefined && written.rounds.length > review.rounds.length) {
        const round = written.rounds.at(-1);
        const notify = (): void => {
          try {
            const current = store.review(written.planId, written.id);
            if (!host.quitting() && current !== null && current.rounds.at(-1)?.turnId === round?.turnId && standing(current)) options.onRoundReady?.(current.id, current.rounds.length);
          } catch { count('notification not read (storage)'); }
        };
        if (host.running(written.reviewer.sessionId)) void host.runtime.untilIdle(written.reviewer.sessionId).then(notify, () => undefined);
        else notify();
      }
      // A review that failed, or closed with no hand-off, no longer holds its plan (decision 0029).
      if ((written.state === 'failed' || (written.state === 'closed' && written.closed !== 'handed')) && review.state !== written.state) workflow.reviewEnded(written.planId, written.id);
    }
    return written;
  }

  /**
   * PLAN REVIEW (M22e; the maintainer's V6 review): while a review's triage panel stands — its latest
   * round live, its panel shown, and no turn of it running or asking — the reviewer's chat says so in
   * READY's place; anything else lets go of it. Kinds alone reach the summary (C16).
   */
  function triage(review: ReviewRecord): void {
    host.runtime.reviewWaiting(review.reviewer.sessionId, standing(review));
  }
  const standing = (review: ReviewRecord): boolean => live(review) && waitingTurn(review) === undefined && pendingAsk(review) === undefined;

  const findReview = (reviewId: string): ReviewRecord | undefined => store.allReviews().find((review) => review.id === reviewId);
  const reviewsOf = (sessionId: string): ReviewRecord[] => store.allReviews().filter((review) => review.reviewer.sessionId === sessionId);
  const latestRound = (review: ReviewRecord): ReviewRoundRecord | null => review.rounds.at(-1) ?? null;
  const sentIntegration = (review: ReviewRecord): IntegrationRecord | undefined => review.integrations.find((one) => one.state === 'sent');
  /** Its marks, notes and rounds can change (C8): open, not stale, nothing of it sent to integrate, and a round to mark. */
  const live = (review: ReviewRecord): boolean => review.state !== 'closed' && review.state !== 'failed' && review.staleBy === null && sentIntegration(review) === undefined && review.rounds.length > 0;
  /** It holds its plan still: neither closed nor failed. */
  const open = (review: ReviewRecord): boolean => review.state === 'running' || review.state === 'findings';
  /** Concluding it changes nothing of the plan: its latest round found nothing, or every finding is refused. */
  const concludable = (review: ReviewRecord): boolean => live(review) && waitingTurn(review) === undefined && pendingAsk(review) === undefined && Object.values(review.marks).every((one) => one.mark === 'rejected');
  const waitingTurn = (review: ReviewRecord): ReviewTurnRecord | undefined => review.turns.find((turn) => turn.outcome === 'waiting');
  /** A turn that asked, whose card no answer has carried on yet (C49). */
  const pendingAsk = (review: ReviewRecord): ReviewTurnRecord | undefined => review.turns.find((turn) => turn.outcome === 'asked' && turn.card !== null && !review.turns.some((other) => other.continues === turn.turnId));
  const markOf = (marks: Readonly<Record<string, LiveMark>>): Record<string, ReviewMark> => Object.fromEntries(Object.entries(marks).map(([id, one]) => [id, one.mark]));
  const notesOf = (marks: Readonly<Record<string, LiveMark>>): Record<string, string> => Object.fromEntries(Object.entries(marks).flatMap(([id, one]) => (one.note === '' ? [] : [[id, one.note]])));
  const newestComplete = (plan: PlanFileRecord): PlanFileRecord['versions'][number] | undefined => [...plan.versions].reverse().find((version) => version.state === 'complete');

  /** The notes a turn sent, following an answer's turn back to the one that asked (C31, C49). */
  function sentNotes(review: ReviewRecord, turn: ReviewTurnRecord): Readonly<Record<string, string>> {
    let at: ReviewTurnRecord | undefined = turn;
    for (let hops = 0; at !== undefined && hops < review.turns.length; hops += 1) {
      if (at.notes !== null) return at.notes;
      const from: string | null = at.continues;
      at = from === null ? undefined : review.turns.find((other) => other.turnId === from);
    }
    return {};
  }

  /** The text Integrate sends now (C10, C38): the latest round's findings, the marks, and the notes standing in their fields. */
  function integrationTextOf(review: ReviewRecord, plan: PlanFileRecord): string {
    const round = latestRound(review);
    return integrationText({ title: plan.title, version: review.version, findings: round?.findings ?? [], marks: markOf(review.marks), notes: notesOf(review.marks) });
  }

  // ── A review's turns (Design 4; C5, C25, C43, C49, C55) ─────────────────────────────────────

  const withTurn = (review: ReviewRecord, turn: ReviewTurnRecord, patch: Partial<ReviewTurnRecord>): ReviewRecord => ({ ...review, turns: review.turns.map((one) => (one.turnId === turn.turnId ? { ...one, ...patch } : one)) });

  /** A turn that brought no round: the first ends the review `failed` with the reason; a later one leaves the latest round standing (C5, C25). */
  function failTurn(review: ReviewRecord, turn: ReviewTurnRecord, reason: ReviewReason, answerId: string | null): ReviewRecord {
    if (turn.kind === 'review') {
      count(`review failed (${reason})`);
      return { ...withTurn(review, turn, { outcome: 'failed', reason, answerId, card: null }), state: 'failed', failure: reason, endedAt: now() };
    }
    count(`no round (${reason})`);
    return withTurn(review, turn, { outcome: 'no-round', reason, answerId, card: null });
  }

  /**
   * A round arrived (C29): appended, the marks before frozen into the round they stood on, the live ones
   * carried. A finding its answer set aside that the round before held stands as it was there (the
   * maintainer).
   */
  function withRound(review: ReviewRecord, turn: ReviewTurnRecord, answerId: string, read: readonly Finding[], setAside: readonly SetAside[], appraisal: string): ReviewRecord {
    const before = latestRound(review);
    if (setAside.length > 0) count(`findings set aside (${setAside.length})`);
    const issues = keepSetAside(before?.findings ?? [], read, setAside);
    const { carried } = carryRound(before?.findings ?? [], issues, markOf(review.marks), notesOf(review.marks));
    const frozen = before === null ? review.rounds : review.rounds.map((round) => (round === before ? { ...round, marks: markOf(review.marks), notes: { ...sentNotes(review, turn), ...notesOf(review.marks) } } : round));
    const round: ReviewRoundRecord = { turnId: turn.turnId, answerId, appraisal, findings: issues, revised: carried.filter((one) => one.revised).map((one) => one.id), marks: null, notes: null, unknown: {} };
    const marks = Object.fromEntries(carried.map((one) => [one.id, { mark: one.mark, note: one.note, revised: one.revised }]));
    const first = review.state === 'running';
    count('round');
    return {
      ...withTurn(review, turn, { outcome: 'round', reason: null, answerId, card: null }),
      rounds: [...frozen, round],
      marks,
      ...(first ? { state: 'findings' as const, endedAt: now() } : {}),
    };
  }

  /** A turn of the review's ended (C25, C43, C49): read by its `final` answer once the end is written. */
  function readTurn(review: ReviewRecord, turn: ReviewTurnRecord, outcome: TurnOutcome): ReviewRecord {
    if (outcome !== 'completed') return failTurn(review, turn, outcome === 'failed' ? 'turn-failed' : 'stopped', null);
    let read: ReturnType<ConversationStore['turnAnswer']>;
    try { read = conversations.turnAnswer(review.reviewer.sessionId, turn.turnId); } catch { read = null; }
    // A card's questions (C49): the review waits on its answer.
    if (read?.card != null) { count('turn asked'); return withTurn(review, turn, { outcome: 'asked', card: read.card, answerId: read.answer?.itemId ?? null }); }
    const answer = read?.answer ?? null;
    if (answer === null) return failTurn(review, turn, 'no-answer', null);
    const findings = readFindings(answer.text, review.instruction);
    if (findings.verdict !== 'findings') return failTurn(review, turn, findings.verdict, answer.itemId);
    return withRound(review, turn, answer.itemId, findings.block.issues, findings.setAside, findings.block.appraisal);
  }

  /** An asked turn whose card was dismissed, passed or lost (C49): ended as one with no answer. */
  const endAsked = (review: ReviewRecord, turn: ReviewTurnRecord): ReviewRecord => failTurn(review, turn, 'no-answer', turn.answerId);

  // ── An integration's ends (Design 7; C27, C45, C49) ─────────────────────────────────────────

  function settleIntegration(review: ReviewRecord, integrationId: string, patch: Partial<IntegrationRecord>): ReviewRecord {
    return { ...review, integrations: review.integrations.map((one) => (one.id === integrationId ? { ...one, ...patch } : one)) };
  }

  function endIntegration(review: ReviewRecord, integrationId: string, reason: IntegrationReason): ReviewRecord | null {
    count(`integration ended (${reason})`);
    return change(review, (held) => {
      const one = held.integrations.find((candidate) => candidate.id === integrationId);
      return one === undefined || one.state !== 'sent' ? null : settleIntegration(held, integrationId, { state: 'ended', reason, settledAt: now(), card: null });
    });
  }

  /** The sent integrations whose target is the session, with their review. */
  function sentTo(sessionId: string): { readonly review: ReviewRecord; readonly integration: IntegrationRecord }[] {
    return store.allReviews().flatMap((review) => review.integrations.filter((one) => one.state === 'sent' && one.sessionId === sessionId).map((integration) => ({ review, integration })));
  }

  /** A card's outcome as the store holds it: `open` while it can still be answered. */
  function cardOpen(sessionId: string, itemId: string): boolean {
    try {
      const stored = conversations.item(sessionId, itemId);
      return stored !== null && questionOf(stored.item)?.outcome === 'open';
    } catch { return true; }
  }

  // ── Offers (Design 7; C9, C50) ──────────────────────────────────────────────────────────────

  function presetOf(review: ReviewRecord): ModelPreset {
    // The review file keeps no speed tier: the reviewer's own record says it while it is held, else standard.
    return { providerId: review.reviewer.providerId, instanceId: review.reviewer.instanceId, model: review.reviewer.model, effort: review.reviewer.effort, speed: host.record(review.reviewer.sessionId)?.speed ?? null };
  }

  /** A listed chat's route for this review, or why it has none (C9, C50). No mode is changed for it. */
  function routeOf(review: ReviewRecord, sessionId: string): { readonly route: IntegrationRoute; readonly reason: null } | { readonly route: null; readonly reason: string } {
    const record = host.record(sessionId);
    if (record === undefined) return { route: null, reason: OFFER_WORDS.notOffered };
    const line = host.runtime.planLine(sessionId);
    if (line !== null && line.planId === review.planId && line.version === review.version) {
      // A request's line takes the feedback under the mode its turn runs in; any other's feedback is a plan turn (M22b, C65; C50).
      if (line.request) return { route: 'decision', reason: null };
      const words = host.runtime.planTurnWords(record);
      return words === null ? { route: 'decision', reason: null } : { route: null, reason: `${words} ${OFFER_WORDS.bringAgain}` };
    }
    if (line !== null) return { route: null, reason: OFFER_WORDS.otherDecision };
    if (host.running(sessionId)) return { route: null, reason: OFFER_WORDS.running };
    const words = host.runtime.planTurnWords(record);
    return words === null ? { route: 'plan-turn', reason: null } : { route: null, reason: `${words} ${OFFER_WORDS.changeMode}` };
  }

  /**
   * Integrate's targets (C9): the plan's own session, the chat that started the review, every other
   * chat taking part in the plan (decision 0029), the reviewer's, and a new one — each once.
   */
  function offersOf(review: ReviewRecord, plan: PlanFileRecord, preset: ModelPreset = presetOf(review)): IntegrationOffer[] {
    const roles = new Map<string, ('own' | 'started' | 'participant' | 'reviewer')[]>();
    const add = (sessionId: string, role: 'own' | 'started' | 'participant' | 'reviewer'): void => {
      const record = host.record(sessionId);
      if (record === undefined || record.projectId !== plan.projectId) return;
      roles.set(sessionId, [...(roles.get(sessionId) ?? []), role]);
    };
    const own = plan.versions.find((version) => version.version === review.version)?.sessionId;
    if (own !== undefined) add(own, 'own');
    add(review.startedFrom, 'started');
    for (const sessionId of plan.workflow.participants) if (!roles.has(sessionId)) add(sessionId, 'participant');
    add(review.reviewer.sessionId, 'reviewer');
    const offers: IntegrationOffer[] = [...roles].map(([sessionId, held]) => ({ target: { sessionId }, name: host.name(sessionId), roles: held, ...routeOf(review, sessionId) }));
    const words = host.runtime.planTurnWords({ id: '', projectId: plan.projectId, providerId: preset.providerId, instanceId: preset.instanceId }, true);
    // A new session's mode is the hierarchy's (0027, item 7): its words alone, with no header yet to choose in.
    offers.push({ target: 'new', name: null, roles: ['new'], route: words === null ? 'plan-turn' : null, reason: words });
    return offers;
  }

  // ── Anchors (Design 5; C33, C41) ────────────────────────────────────────────────────────────

  function versionText(planId: string, version: number): string | null {
    const key = `${planId}/${version}`;
    if (!texts.has(key)) {
      const read = store.read(planId, version, 0, MAX_PLAN_TEXT);
      texts.set(key, read === null || read.state !== 'complete' ? null : read.text);
    }
    return texts.get(key) ?? null;
  }

  const fold = (value: string): string => value.replace(/\s+/gu, ' ').trim();
  /** A heading's words, Markdown's marks dropped, as a plan's title drops them (C41). */
  const headingWords = (value: string): string => normalizeName(value.replace(/^ {0,3}#{1,6}[ \t]+/, '').replace(/[ \t#]+$/, '').replace(/[`*_~]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')).toLowerCase();

  /** Where an anchor stands in the reviewed version's text (C41): its heading's line, then the first line at or under it holding the quote. */
  function anchorOf(text: string, anchor: NonNullable<Finding['anchor']>): AnchorPlace {
    const lines = text.split('\n');
    const wanted = headingWords(anchor.heading);
    const heading = wanted === '' ? -1 : lines.findIndex((line) => /^ {0,3}#{1,6}[ \t]+/.test(line) && headingWords(line) === wanted);
    const quote = fold(anchor.quote);
    const from = heading === -1 ? 0 : heading;
    if (quote === '') return heading === -1 ? null : { line: heading + 1 };
    for (const match of [(line: string) => fold(line).includes(quote), (line: string) => fold(line).toLowerCase().includes(quote.toLowerCase())]) {
      for (let at = from; at < lines.length; at += 1) if (match(lines[at] ?? '')) return { line: at + 1 };
    }
    return null;
  }

  // ── Views (C7, C12, C24) ────────────────────────────────────────────────────────────────────

  function view(review: ReviewRecord): ReviewView {
    const plan = store.get(review.planId);
    const isLive = live(review);
    const last = review.rounds.length - 1;
    const rounds = review.rounds.map((round, n) => ({
      turnId: round.turnId, answerId: round.answerId, appraisal: round.appraisal, findings: round.findings,
      marks: n === last ? markOf(review.marks) : round.marks ?? {},
      notes: n === last ? notesOf(review.marks) : round.notes ?? {},
      revised: n === last ? Object.entries(review.marks).flatMap(([id, one]) => (one.revised ? [id] : [])) : round.revised,
      live: n === last && isLive,
    }));
    const latest = latestRound(review);
    const text = latest === null ? null : versionText(review.planId, review.version);
    const anchors: Record<string, AnchorPlace> = {};
    for (const finding of latest?.findings ?? []) if (finding.anchor !== undefined) anchors[finding.id] = text === null ? null : anchorOf(text, finding.anchor);
    return {
      reviewId: review.id, planId: review.planId, version: review.version,
      reviewer: { sessionId: review.reviewer.sessionId, providerId: review.reviewer.providerId, instanceId: review.reviewer.instanceId, model: review.reviewer.model, effort: review.reviewer.effort, chat: host.record(review.reviewer.sessionId) === undefined ? null : host.name(review.reviewer.sessionId) ?? '' },
      startedFrom: review.startedFrom, startedAt: review.startedAt, endedAt: review.endedAt,
      state: review.state, failure: review.failure, staleBy: review.staleBy, closed: review.closed, instruction: review.instruction,
      turns: review.turns.map((turn) => ({ turnId: turn.turnId, promptId: turn.promptId, kind: turn.kind, outcome: turn.outcome, reason: turn.reason, answerId: turn.answerId, continues: turn.continues })),
      rounds,
      integrations: review.integrations.map((one) => ({
        integrationId: one.id, sessionId: one.sessionId, chat: host.record(one.sessionId) === undefined ? null : host.name(one.sessionId) ?? '',
        route: one.route, state: one.state, reason: one.reason, accepted: one.accepted, produced: one.produced, at: one.at,
      })),
      live: isLive,
      concludable: concludable(review),
      offers: isLive && plan !== null ? offersOf(review, plan) : [],
      anchors,
      integrationUnits: plan === null ? 0 : integrationTextOf(review, plan).length,
    };
  }

  function summary(review: ReviewRecord): ReviewSummary {
    const marks = Object.values(review.marks);
    return {
      reviewId: review.id, version: review.version, state: review.state, staleBy: review.staleBy, closed: review.closed,
      accepted: marks.filter((one) => one.mark === 'accepted').length, waiting: marks.filter((one) => one.mark === 'open').length,
      findings: latestRound(review)?.findings.length ?? 0,
      integrating: sentIntegration(review) !== undefined,
      reviewer: { sessionId: review.reviewer.sessionId, chat: host.record(review.reviewer.sessionId) === undefined ? null : host.name(review.reviewer.sessionId) ?? '' },
      startedAt: review.startedAt,
    };
  }

  // ── Writes of the user's (Design 5, 6; C28, C30, C44) ───────────────────────────────────────

  function writable(reviewId: string, findingId: string | null): { readonly review: ReviewRecord } | { readonly status: 'refused'; readonly reason: 'unknown-review' | 'unknown-finding' | 'not-live' } {
    const review = findReview(reviewId);
    if (review === undefined) return { status: 'refused', reason: 'unknown-review' };
    if (!live(review)) return { status: 'refused', reason: 'not-live' };
    if (findingId !== null && review.marks[findingId] === undefined) return { status: 'refused', reason: 'unknown-finding' };
    return { review };
  }

  return {
    // ── Starting (Design 3; C1, C2, C23, C26, C39, C52, C53) ───────────────────────────────────
    async start({ sessionId, planId, version, revision, preset: chosen }) {
      const record = host.record(sessionId);
      if (record === undefined) return { status: 'refused', reason: 'unknown-session' };
      // The reviewer's preset is the user's choice, of any account the project is offered to, checked as a new chat's is.
      const admitted = host.admit(record.projectId, chosen);
      if (!admitted.ok) return { status: 'refused', reason: admitted.reason === 'unknown-project' ? 'unknown-session' : admitted.reason };
      const preset = admitted.preset;
      const plan = store.get(planId);
      const held = plan?.versions.find((one) => one.version === version);
      if (plan === null || held === undefined || held.state !== 'complete') return { status: 'refused', reason: 'not-complete' };
      // A version its plan has a newer complete one than is no review's (C52).
      if (newestComplete(plan)?.version !== version) return { status: 'refused', reason: 'stale' };
      const reading = host.runtime.readingMode(preset);
      if ('refused' in reading) return { status: 'refused', reason: reading.refused };
      if (host.quitting() || starting.has(sessionId)) return { status: 'refused', reason: 'busy' };
      const read = store.read(planId, version, 0, MAX_PLAN_TEXT);
      if (read === null || read.state !== 'complete') return { status: 'refused', reason: 'storage-failed' };
      // Reserved in the plan's workflow before anything is made (decision 0029): one operation at a time.
      const reservation = workflow.reserveReview(planId, sessionId, revision, version);
      if (typeof reservation === 'string') return { status: 'refused', reason: reservation };
      starting.add(sessionId);
      try {
        // The reviewer: made on the chosen preset and selected as a new chat is, named in that write (C2, C26, C39).
        const made = await host.create(record.projectId, preset, reviewerName(plan.title, version));
        if (made.status !== 'saved') return { status: 'refused', reason: made.reason === 'records-refused' ? 'records-refused' : 'storage-failed' };
        const reviewerId = made.id;
        // Under the reading mode, whatever the defaults say (C2): with no process yet, saved at once.
        const mode = await host.runtime.setMode(reviewerId, reading.mode);
        if (mode.status !== 'set' && mode.reason !== 'same') {
          await host.remove(reviewerId);
          count('review not started (mode)');
          return { status: 'refused', reason: modeRefusal(mode) };
        }
        const reviewer = host.record(reviewerId);
        const turnId = newId();
        const messageId = newId();
        const at = now();
        let review: ReviewRecord;
        try {
          review = store.createReview({
            id: newId(), planId, version, hash: held.hash, startedFrom: sessionId, instruction: REVIEW_INSTRUCTION_VERSION,
            reviewer: { sessionId: reviewerId, providerId: preset.providerId, instanceId: preset.instanceId, model: preset.model, effort: preset.effort },
            startedAt: at, endedAt: null, state: 'running', failure: null, staleBy: null, closed: null,
            turns: [{ turnId, promptId: messageId, kind: 'review', at, answerId: null, outcome: 'waiting', reason: null, continues: null, card: null, notes: null, unknown: {} }],
            rounds: [], marks: {}, integrations: [], unknown: {},
          });
        } catch {
          await host.remove(reviewerId);
          count('review not started (storage)');
          return { status: 'refused', reason: 'storage-failed' };
        }
        // The plan under review from here, held by its reviewer.
        if (!workflow.reviewStarted(reservation, review.id, reviewerId)) {
          change(review, (held) => ({ ...held, state: 'closed', closed: 'cancelled', endedAt: now(), turns: held.turns.map((turn) => (turn.outcome === 'waiting' ? { ...turn, outcome: 'failed' as const, reason: 'refused' as const } : turn)) }));
          await host.remove(reviewerId);
          return { status: 'refused', reason: 'storage-failed' };
        }
        pushOf(review);
        count('review started');
        const prompt = reviewPrompt({ title: plan.title, planId, version, text: read.text, token: planToken(read.text, token), folder: reviewer === undefined ? '' : host.folder(reviewer) ?? '' });
        sending.add(turnId);
        let sent: ChatSendResult;
        try {
          // Naming nothing, asking no secretary, and folded by its fields (C26, C53).
          sent = await host.runtime.sendComposed(reviewerId, { prompt, turnId, messageId, plan: false, fields: { planId, version, intent: 'review' }, names: false });
        } finally { sending.delete(turnId); }
        if (sent.status !== 'accepted') {
          // The review ends `failed`, `refused`, and the start says the send's reason (C2).
          const current = store.review(planId, review.id) ?? review;
          change(current, (held) => { const turn = held.turns.find((one) => one.turnId === turnId && one.outcome === 'waiting'); return turn === undefined ? null : failTurn(held, turn, 'refused', null); });
          return sent;
        }
        return { status: 'started', reviewId: review.id, sessionId: reviewerId };
      } finally {
        starting.delete(sessionId);
        workflow.release(reservation);
      }
    },

    // ── Marks, notes and the panel (Design 5, 6; C28, C30, C44) ───────────────────────────────
    mark(request) {
      const findingId = 'findingId' in request ? request.findingId : null;
      const found = writable(request.reviewId, findingId);
      if (!('review' in found)) return found;
      const { review } = found;
      const ids = findingId !== null ? [findingId] : Object.keys(review.marks).filter((id) => Number(id.charAt(1)) === ('tier' in request ? request.tier : 0));
      if (ids.length === 0) return { status: 'refused', reason: 'unknown-finding' };
      const written = change(review, (held) => ({ ...held, marks: { ...held.marks, ...Object.fromEntries(ids.flatMap((id) => { const one = held.marks[id]; return one === undefined ? [] : [[id, { ...one, mark: request.mark }]]; })) } }));
      if (written === null) return { status: 'refused', reason: 'storage-failed' };
      count(`marked (${request.mark})`);
      return { status: 'saved', marks: markOf(written.marks) };
    },

    note({ reviewId, findingId, note }) {
      const found = writable(reviewId, findingId);
      if (!('review' in found)) return found;
      const written = change(found.review, (held) => {
        const one = held.marks[findingId];
        return one === undefined || one.note === note ? null : { ...held, marks: { ...held.marks, [findingId]: { ...one, note } } };
      });
      return written === null ? { status: 'refused', reason: 'storage-failed' } : { status: 'saved' };
    },

    close: (request) => closeReview(request.reviewId, request.as, true),

    cancelFor: async (planId, reviewId) => { if (store.review(planId, reviewId) !== null) await closeReview(reviewId, 'cancel', false); },

    // ── Send notes (Design 6; C29, C31, C49) ───────────────────────────────────────────────────
    async send({ reviewId }) {
      const review = findReview(reviewId);
      if (review === undefined) return { status: 'refused', reason: 'unknown-review' };
      const round = latestRound(review);
      if (!live(review) || round === null) return { status: 'refused', reason: 'not-live' };
      if (Object.values(review.marks).every((one) => one.mark !== 'open')) return { status: 'refused', reason: 'all-decided' };
      const notes = notesOf(review.marks);
      if (Object.keys(notes).length === 0) return { status: 'refused', reason: 'no-note' };
      if (waitingTurn(review) !== undefined || pendingAsk(review) !== undefined) return { status: 'refused', reason: 'turn-waiting' };
      const turnId = newId();
      const messageId = newId();
      const prompt = sendNotesPrompt({ findings: round.findings, marks: markOf(review.marks), notes, instruction: review.instruction });
      // The turn written waiting with the notes it sends, and the fields emptied, in one write (C30, C31).
      const emptied = Object.fromEntries(Object.entries(review.marks).map(([id, one]) => [id, { ...one, note: '' }]));
      const turn: ReviewTurnRecord = { turnId, promptId: messageId, kind: 'notes', at: now(), answerId: null, outcome: 'waiting', reason: null, continues: null, card: null, notes, unknown: {} };
      const waiting = change(review, (held) => ({ ...held, turns: [...held.turns, turn], marks: emptied }));
      if (waiting === null) return { status: 'refused', reason: 'storage-failed' };
      sending.add(turnId);
      let sent: ChatSendResult;
      try { sent = await host.runtime.sendComposed(review.reviewer.sessionId, { prompt, turnId, messageId, plan: false, fields: null, names: false }); } finally { sending.delete(turnId); }
      if (sent.status === 'accepted') { count('notes sent'); return { status: 'sent' }; }
      // Refused: the turn goes, and the notes stand in their fields again (C31).
      change(waiting, (held) => ({
        ...held,
        turns: held.turns.filter((one) => one.turnId !== turnId),
        marks: Object.fromEntries(Object.entries(held.marks).map(([id, one]) => [id, notes[id] === undefined || one.note !== '' ? one : { ...one, note: notes[id] }])),
      }));
      return sent;
    },

    // ── Explain (Design 5; C34, C54) ───────────────────────────────────────────────────────────
    async explain({ reviewId, findingId, place }) {
      const review = findReview(reviewId);
      if (review === undefined) return { status: 'refused', reason: 'unknown-review' };
      const round = latestRound(review);
      const finding = round?.findings.find((one) => one.id === findingId);
      if (round === null || finding === undefined) return { status: 'refused', reason: 'unknown-finding' };
      const source: AsideSource = { kind: 'message', itemId: round.answerId, role: 'assistant', part: null, workerId: null, path: null, lines: null, range: place.range, digest: place.digest, excerpt: findingExcerpt(finding), cut: false };
      const asked: ChatAskResult = await host.runtime.ask({ sessionId: review.reviewer.sessionId, asideId: newId(), source, question: findingQuestion(finding) });
      count(asked.status === 'accepted' ? 'explained' : `explain refused (${asked.reason})`);
      return asked;
    },

    // ── Integration (Design 7; C9–C11, C24, C27, C38, C47, C49–C51) ───────────────────────────
    async integrate({ reviewId, target }) {
      const review = findReview(reviewId);
      if (review === undefined) return { status: 'refused', reason: 'unknown-review' };
      if (review.staleBy !== null) return { status: 'refused', reason: 'stale' };
      if (sentIntegration(review) !== undefined) return { status: 'refused', reason: 'integrating' };
      if (!open(review)) return { status: 'refused', reason: 'not-live' };
      const round = latestRound(review);
      if (round === null) return { status: 'refused', reason: 'not-live' };
      const marks = Object.values(review.marks);
      if (marks.some((one) => one.mark === 'open')) return { status: 'refused', reason: 'undecided' };
      if (!marks.some((one) => one.mark === 'accepted')) return { status: 'refused', reason: 'none-accepted' };
      const plan = store.get(review.planId);
      const newest = plan === null ? undefined : newestComplete(plan);
      if (plan === null || newest === undefined || newest.version !== review.version || newest.hash !== review.hash) return { status: 'refused', reason: 'stale' };
      const text = integrationTextOf(review, plan);
      if (text.length > REVIEW_BOUNDS.integration) return { status: 'refused', reason: 'too-long', excess: text.length - REVIEW_BOUNDS.integration };
      if (waitingTurn(review) !== undefined || pendingAsk(review) !== undefined) return { status: 'refused', reason: 'turn-waiting' };
      if (integrating.has(reviewId) || closing.has(reviewId) || host.quitting()) return { status: 'refused', reason: 'busy' };
      // A new target's preset is the user's choice, checked as a new chat's is.
      let fresh: ModelPreset | null = null;
      if ('preset' in target) {
        const admitted = host.admit(plan.projectId, target.preset);
        if (!admitted.ok) return { status: 'refused', reason: admitted.reason === 'unknown-project' ? 'unavailable' : admitted.reason, ...(admitted.reason === 'unknown-project' ? { words: OFFER_WORDS.notOffered } : {}) };
        fresh = admitted.preset;
      }
      // The route, worked out again at the press (C9, C50), a new target's for its own preset.
      const offer = offersOf(review, plan, fresh ?? undefined).find((one) => (one.target === 'new' ? fresh !== null : 'sessionId' in target && one.target.sessionId === target.sessionId));
      if (offer === undefined) return { status: 'refused', reason: 'unavailable', words: OFFER_WORDS.notOffered };
      if (offer.route === null) return { status: 'refused', reason: 'unavailable', words: offer.reason ?? OFFER_WORDS.notOffered };
      const route = offer.route;
      // Reserved in the plan's workflow before a new target is made (decision 0029).
      const reservation = workflow.reserveHandOff(review.planId, reviewId);
      if (reservation === 'locked') return { status: 'refused', reason: 'busy' };
      integrating.add(reviewId);
      let turnId: string | null = null;
      try {
        // A new target is made before anything names it (C47).
        let sessionId: string;
        const made = fresh !== null;
        if (fresh !== null) {
          const created = await host.create(plan.projectId, fresh);
          if (created.status !== 'saved') return { status: 'refused', reason: created.reason === 'records-refused' ? 'records-refused' : 'storage-failed' };
          sessionId = created.id;
        } else if ('sessionId' in target) sessionId = target.sessionId;
        else return { status: 'refused', reason: 'unavailable', words: OFFER_WORDS.notOffered };
        const line = route === 'decision' ? host.runtime.planLine(sessionId) : null;
        if (route === 'decision' && (line === null || line.planId !== review.planId || line.version !== review.version)) return { status: 'refused', reason: 'unavailable', words: OFFER_WORDS.notOffered };
        // A request's turn is the one its feedback carries on; any other turn is the integration's own.
        const own = line?.request === true ? line.turnId : newId();
        turnId = own;
        const messageId = newId();
        const current = store.review(review.planId, review.id) ?? review;
        const sentNotesMap = Object.fromEntries(Object.entries(current.marks).flatMap(([id, one]) => (one.note !== '' && one.mark !== 'open' ? [[id, one.note]] : [])));
        const integration: IntegrationRecord = {
          id: newId(), version: review.version, hash: review.hash, round: round.turnId,
          accepted: Object.entries(current.marks).flatMap(([id, one]) => (one.mark === 'accepted' ? [id] : [])), notes: sentNotesMap, instruction: review.instruction,
          sessionId, route, planItem: line?.itemId ?? null, turns: [own], state: 'sent', reason: null, produced: null, at: now(), settledAt: null, card: null, unknown: {},
        };
        // Written before anything is sent (C24), the review closed by it for good, and the plan handed to
        // its target to revise (decision 0029).
        const written = change(current, (held) => ({ ...held, integrations: [...held.integrations, integration], state: 'closed', closed: 'handed', endedAt: now() }));
        if (written === null) {
          if (made) await host.remove(sessionId);
          return { status: 'refused', reason: 'storage-failed' };
        }
        if (!workflow.handOff(reservation, sessionId, own)) {
          endIntegration(written, integration.id, 'refused');
          workflow.reviewEnded(review.planId, review.id);
          if (made) await host.remove(sessionId);
          return { status: 'refused', reason: 'storage-failed' };
        }
        count(`integration sent (${route})`);
        sending.add(own);
        let answer: PlanDecideResult | ChatSendResult;
        if (route === 'decision' && line !== null) {
          answer = await host.runtime.decidePlan(sessionId, line.itemId, 'feedback', text, line.request ? undefined : own);
        } else {
          const read = store.read(review.planId, review.version, 0, MAX_PLAN_TEXT);
          if (read === null || read.state !== 'complete') answer = { status: 'refused', reason: 'storage-failed' };
          else {
            const prompt = `${text}\n\n${planBlock(review.planId, review.version, read.text, planToken(read.text, token))}`;
            answer = await host.runtime.sendComposed(sessionId, { prompt, turnId: own, messageId, plan: true, fields: { planId: review.planId, version: review.version, intent: 'revise' }, names: made });
          }
        }
        if (answer.status === 'decided' || answer.status === 'accepted') {
          // The destination took it: the reviewer is Done, but where it integrates into itself (decision 0029).
          if (sessionId !== review.reviewer.sessionId) await host.complete(review.reviewer.sessionId).catch(() => undefined);
          return { status: 'sent', integrationId: integration.id, sessionId };
        }
        // Refused by the send's own checks (C27, C47): ended at once, an unstarted new session removed
        // again, and the plan ready on its version, the review staying closed (decision 0029).
        const held = store.review(review.planId, review.id);
        if (held !== null) endIntegration(held, integration.id, line?.request === true ? lineEnd(sessionId, line.itemId) : 'refused');
        workflow.reviewEnded(review.planId, review.id);
        if (made) await host.remove(sessionId);
        return { status: 'refused', reason: integrateRefusal(answer) };
      } finally {
        integrating.delete(reviewId);
        workflow.release(reservation);
        if (turnId !== null) sending.delete(turnId);
      }
    },

    // ── Reads (C7, C12, C44) ──────────────────────────────────────────────────────────────────
    read(request) {
      try {
        if ('reviewId' in request) {
          const review = findReview(request.reviewId);
          return review === undefined ? { status: 'refused', reason: 'unknown-review' } : { status: 'read', review: view(review) };
        }
        if ('planId' in request) return { status: 'listed', reviews: store.reviews(request.planId).map(summary).reverse() };
        const own = reviewsOf(request.sessionId).at(-1);
        return { status: 'session', review: own === undefined ? null : view(own) };
      } catch {
        return { status: 'refused', reason: 'storage-failed' };
      }
    },

    // ── The runtime's hooks (Design 4, 7; C25, C27, C43, C45, C49) ─────────────────────────────
    turnEnded(sessionId, turnId, outcome) {
      for (const review of reviewsOf(sessionId)) {
        const turn = review.turns.find((one) => one.turnId === turnId && one.outcome === 'waiting');
        if (turn !== undefined) change(review, (held) => { const now_ = held.turns.find((one) => one.turnId === turnId && one.outcome === 'waiting'); return now_ === undefined ? null : readTurn(held, now_, outcome); });
      }
      for (const { review, integration } of sentTo(sessionId)) {
        if (integration.card !== null || integration.turns.at(-1) !== turnId) continue;
        // A turn that ends by asking waits on its card (C49); any other end with no version naming it is `no-plan` (C27, C45).
        let card: string | null = null;
        if (outcome === 'completed') { try { card = conversations.turnAnswer(sessionId, turnId)?.card ?? null; } catch { card = null; } }
        if (card !== null) change(review, (held) => settleIntegration(held, integration.id, { card }));
        else endIntegration(review, integration.id, 'no-plan');
      }
    },

    accepted(sessionId, turnId, answered) {
      for (const review of reviewsOf(sessionId)) {
        const asked = pendingAsk(review);
        if (asked === undefined || asked.turnId === turnId || review.turns.some((one) => one.turnId === turnId)) continue;
        if (answered !== null && answered === asked.card) {
          // The card's answer carries the asked turn on, written before anything is sent (C49).
          const turn: ReviewTurnRecord = { turnId, promptId: null, kind: asked.kind, at: now(), answerId: null, outcome: 'waiting', reason: null, continues: asked.turnId, card: null, notes: null, unknown: {} };
          change(review, (held) => ({ ...held, turns: [...held.turns, turn] }));
        } else if (asked.card !== null && !cardOpen(sessionId, asked.card)) {
          // Any other prompt passed it (0026, item 11).
          change(review, (held) => endAsked(held, asked));
        }
      }
      for (const { review, integration } of sentTo(sessionId)) {
        if (integration.card === null || integration.turns.includes(turnId)) continue;
        if (answered !== null && answered === integration.card) change(review, (held) => settleIntegration(held, integration.id, { turns: [...integration.turns, turnId], card: null }));
        else if (!cardOpen(sessionId, integration.card)) endIntegration(review, integration.id, 'no-plan');
      }
    },

    dismissed(sessionId, itemId) {
      for (const review of reviewsOf(sessionId)) {
        const asked = pendingAsk(review);
        if (asked !== undefined && asked.card === itemId) change(review, (held) => endAsked(held, asked));
      }
      for (const { review, integration } of sentTo(sessionId)) if (integration.card === itemId) endIntegration(review, integration.id, 'no-plan');
    },

    lost(sessionId) {
      // A turn that was still running is over with its process; one whose send has not answered yet is the send's to settle.
      for (const review of reviewsOf(sessionId)) {
        const turn = waitingTurn(review);
        if (turn !== undefined && !sending.has(turn.turnId)) change(review, (held) => failTurn(held, turn, 'turn-failed', null));
      }
      for (const { review, integration } of sentTo(sessionId)) {
        const last = integration.turns.at(-1);
        if (integration.card === null && last !== undefined && !sending.has(last)) endIntegration(review, integration.id, 'dropped');
      }
    },

    forget(sessionId) {
      // Its review ends `stopped` where it ran (C2), and one still open is cancelled, readying its plan
      // (decision 0029); its reviews stay with their plan (M22b, C18).
      for (const review of reviewsOf(sessionId)) {
        change(review, (held) => {
          let next = held;
          for (const turn of held.turns) if (turn.outcome === 'waiting' || (turn.outcome === 'asked' && turn === pendingAsk(held))) next = failTurn(next, turn, 'stopped', turn.answerId);
          if (open(next)) next = { ...next, state: 'closed', closed: 'cancelled', endedAt: now() };
          return next === held ? null : next;
        });
      }
      for (const { review, integration } of sentTo(sessionId)) endIntegration(review, integration.id, 'removed');
    },

    launched() {
      // The reviews whose triage panel a restart finds standing read PLAN REVIEW, as they did before it (the maintainer's word).
      for (const review of store.allReviews()) if (standing(review)) triage(review);
    },

    doing(sessionId, turnId) {
      if (reviewsOf(sessionId).some((review) => review.turns.some((turn) => turn.turnId === turnId))) return 'review';
      return sentTo(sessionId).some(({ integration }) => integration.turns.includes(turnId)) ? 'integration' : null;
    },

    // ── The plan service's (C11, C27, C36) ─────────────────────────────────────────────────────
    integration(sessionId, turnId) {
      for (const { review, integration } of sentTo(sessionId)) {
        if (integration.turns.includes(turnId)) return { reviewId: review.id, integrationId: integration.id, findings: integration.accepted, planId: review.planId, revises: integration.version };
      }
      return null;
    },

    versionMade(planId, version) {
      const plan = store.get(planId);
      const made = plan?.versions.find((one) => one.version === version);
      const named = made?.state === 'complete' ? made.integration : null;
      if (named !== null && named !== undefined) {
        const review = store.review(planId, named.reviewId);
        if (review !== null) {
          const one = review.integrations.find((candidate) => candidate.id === named.integrationId);
          if (one !== undefined && one.state === 'sent') {
            change(review, (held) => settleIntegration(held, one.id, { state: 'integrated', produced: version, settledAt: now(), card: null }));
            count('integrated');
          }
        }
      }
      // The older reviews it made stale (C36): their records were written by the plan store at the commit.
      for (const review of store.reviews(planId)) if (review.staleBy === version) { pushOf(review); triage(review); }
    },

    counts: () => Object.fromEntries(tally),
  };

  /**
   * Cancel review, or concluded with no change (decision 0029): a turn of it that runs is stopped and its
   * end awaited, the review written closed, the plan ready again on its version, and the reviewer Done
   * where `done` — not when its removal, shelving or completion is what closes it.
   */
  async function closeReview(reviewId: string, as: 'cancel' | 'conclude', done: boolean): Promise<ReviewCloseResult> {
    const review = findReview(reviewId);
    if (review === undefined) return { status: 'refused', reason: 'unknown-review' };
    const held = workflow.view(review.planId);
    if (!open(review) || held === null || held.reviewId !== reviewId) return { status: 'refused', reason: 'not-open' };
    if (as === 'conclude' && !concludable(review)) return { status: 'refused', reason: 'not-concludable' };
    if (closing.has(reviewId) || integrating.has(reviewId) || host.quitting()) return { status: 'refused', reason: 'busy' };
    closing.add(reviewId);
    try {
      const reviewer = review.reviewer.sessionId;
      if (host.running(reviewer)) {
        host.runtime.stop(reviewer);
        await host.runtime.untilIdle(reviewer);
      }
      const current = store.review(review.planId, reviewId) ?? review;
      const written = change(current, (one) => {
        // A first turn this close stopped failed the review meanwhile: it is the close's still.
        if (!open(one) && !(one.state === 'failed' && one.failure === 'stopped')) return null;
        let next = one;
        for (const turn of one.turns) if (turn.outcome === 'waiting' || (turn.outcome === 'asked' && turn === pendingAsk(one))) next = { ...withTurn(next, turn, { outcome: 'failed', reason: 'stopped', card: null }) };
        return { ...next, state: 'closed', closed: as === 'cancel' ? 'cancelled' : 'concluded', endedAt: now() };
      });
      if (written === null) return { status: 'refused', reason: 'storage-failed' };
      count(`review closed (${as})`);
      if (done) await host.complete(reviewer).catch(() => undefined);
      return { status: 'closed' };
    } finally {
      closing.delete(reviewId);
    }
  }

  /** What became of a request's line, where its feedback was refused: withdrawn or dropped, or refused (C27). */
  function lineEnd(sessionId: string, itemId: string): IntegrationReason {
    try {
      const stored = conversations.item(sessionId, itemId);
      const outcome = stored?.item.interaction?.outcome;
      return outcome === 'withdrawn' ? 'withdrawn' : outcome === 'dropped' ? 'dropped' : 'refused';
    } catch { return 'refused'; }
  }
}

/** The reasons a change of mode at a review's start is refused for that the start says as they are (C2): any other is the mode's being unavailable. */
const MODE_REFUSALS_KEPT: ReadonlySet<string> = new Set(['unknown-session', 'busy', 'unconfirmed', 'storage-failed', 'changing-mode', 'setting-up', 'running', 'records-refused', 'conversations-refused', 'not-connected', 'signed-out']);

/** A change of mode refused at a review's start (C2), as the start's own reason. */
function modeRefusal(answer: Refusal<ChatSetModeResult>): Refusal<ReviewStartResult>['reason'] {
  return MODE_REFUSALS_KEPT.has(answer.reason) ? (answer.reason as Refusal<ReviewStartResult>['reason']) : 'mode-unavailable';
}

/** A decision's own refusals, which say the target's line is no longer the one offered. */
const LINE_GONE: ReadonlySet<string> = new Set(['unknown-item', 'not-pending', 'reads-only']);

/** A delivery refused (C27), as Integrate's own reason: the send's pass, a decision's own are the target's being unavailable. */
function integrateRefusal(answer: Refusal<PlanDecideResult | ChatSendResult>): Refusal<ReviewIntegrateResult>['reason'] {
  return LINE_GONE.has(answer.reason) ? 'unavailable' : (answer.reason as Refusal<ReviewIntegrateResult>['reason']);
}
