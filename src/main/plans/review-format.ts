// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A review's record, `plans/<plan id>/reviews/<review id>.json` (docs/planning/_archive/M22e.md, Design 2; C6, C24,
// C27, C29, C30, C49, C51; decision 0029): which version of which plan was reviewed, by whom, every
// turn started for it and what became of it, its rounds with their findings as checked, the live
// marks and notes, how it closed, and its integrations. The composed prompts are not
// here: the plan's text is the plan store's, and a prompt the conversation's (C24). Pure: the store
// reads and writes the file, and this says what it holds.
//
// Under the version envelope every stored format carries (decision 0005): a newer file is refused
// and left as it is, an older one too until the first release (decision 0014). Unknown fields are
// kept, the record's and each turn's, round's and integration's alike, so that a newer build's
// additions survive an older build's write.
//
// Version 2 (decision 0029): a review is a hard stop on its plan, closed for good when it is
// cancelled, concluded with no change or handed to an integration, and never hidden — `panel` is gone
// and `closed` says how it ended. A version-1 record is refused as older and left as it is.
import { isPlanId, PlanHashSchema } from '@shared/contracts/plans';
import {
  type Finding,
  FindingSchema,
  INTEGRATION_REASONS,
  INTEGRATION_ROUTES,
  INTEGRATION_STATES,
  type IntegrationReason,
  type IntegrationRoute,
  type IntegrationState,
  isFindingId,
  isReviewId,
  REVIEW_BOUNDS,
  REVIEW_CLOSURES,
  REVIEW_MARKS,
  REVIEW_REASONS,
  REVIEW_STATES,
  REVIEW_TURN_KINDS,
  REVIEW_TURN_OUTCOMES,
  type ReviewClosure,
  type ReviewMark,
  type ReviewReason,
  type ReviewState,
  type ReviewTurnKind,
  type ReviewTurnOutcome,
} from '@shared/contracts/review';
import { readEnvelope } from '../storage/envelope';

/** The format of a review's record: the reader this build is, and the oldest that may read and edit what it writes. */
export const REVIEW_SCHEMA_VERSION = 2;
export const REVIEW_MIN_READER_VERSION = 2;

export const reviewFile = (reviewId: string): string => `${reviewId}.json`;
export const REVIEW_FILE = /^([a-z0-9-]{1,64})\.json$/;

type Row = Record<string, unknown>;

/** A turn started for the review (C25, C49): its first prompt, a Send notes, or one a card's answer started to carry an asked one on. */
export interface ReviewTurnRecord {
  readonly turnId: string;
  /** Its prompt's item id; null for a turn a card's answer started, whose prompt is the answer's. */
  readonly promptId: string | null;
  readonly kind: ReviewTurnKind;
  readonly at: number;
  /** Its answer's item id, fat-g's own, resolved at its end (C43). */
  readonly answerId: string | null;
  readonly outcome: ReviewTurnOutcome;
  readonly reason: ReviewReason | null;
  /** The asked turn it carries on (C49). */
  readonly continues: string | null;
  /** The card an asked turn waits on (C49): what its answer, dismissal or pass is known by. */
  readonly card: string | null;
  /** The notes a `notes` turn sent, by finding id (C31). */
  readonly notes: Readonly<Record<string, string>> | null;
  readonly unknown: Readonly<Row>;
}

/** A round (C29): its turn, its answer, the findings as checked, and — once the next came — its marks and notes frozen as they stood. */
export interface ReviewRoundRecord {
  readonly turnId: string;
  readonly answerId: string;
  readonly appraisal: string;
  readonly findings: readonly Finding[];
  readonly revised: readonly string[];
  /** Null for the latest round, whose marks are the live ones. */
  readonly marks: Readonly<Record<string, ReviewMark>> | null;
  readonly notes: Readonly<Record<string, string>> | null;
  readonly unknown: Readonly<Row>;
}

/** A finding's live mark and note (C28, C30), and whether the latest round revised it (C29). */
export interface LiveMark {
  readonly mark: ReviewMark;
  readonly note: string;
  readonly revised: boolean;
}

/** An integration (C24, C27, C45, C47, C51): what it sent and where, the turns it went by, and how it settled. */
export interface IntegrationRecord {
  readonly id: string;
  readonly version: number;
  readonly hash: string;
  /** The turn of the round whose findings it sent (C51). */
  readonly round: string;
  readonly accepted: readonly string[];
  /** The notes as sent, by finding id (C38). */
  readonly notes: Readonly<Record<string, string>>;
  readonly instruction: number;
  readonly sessionId: string;
  readonly route: IntegrationRoute;
  /** The plan's line whose decision it was, for the `decision` route. */
  readonly planItem: string | null;
  /** The turns it went by: the first, and each a card's answer started to carry it on (C49). */
  readonly turns: readonly string[];
  /** The card its last turn asked on and waits for (C49), or null. */
  readonly card: string | null;
  readonly state: IntegrationState;
  readonly reason: IntegrationReason | null;
  readonly produced: number | null;
  readonly at: number;
  readonly settledAt: number | null;
  readonly unknown: Readonly<Row>;
}

export interface ReviewRecord {
  readonly id: string;
  readonly planId: string;
  readonly version: number;
  readonly hash: string;
  /** The chat whose panel started it. */
  readonly startedFrom: string;
  readonly instruction: number;
  readonly reviewer: { readonly sessionId: string; readonly providerId: string; readonly instanceId: string; readonly model: string; readonly effort: string | null };
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly state: ReviewState;
  readonly failure: ReviewReason | null;
  /** The newer complete version that made it stale (C36, C52), or null. */
  readonly staleBy: number | null;
  /** How it closed, for a `closed` review; null for any other. */
  readonly closed: ReviewClosure | null;
  readonly turns: readonly ReviewTurnRecord[];
  readonly rounds: readonly ReviewRoundRecord[];
  /** By finding id of the latest round. */
  readonly marks: Readonly<Record<string, LiveMark>>;
  readonly integrations: readonly IntegrationRecord[];
  readonly unknown: Readonly<Row>;
}

export type ReviewFileReading =
  | { readonly kind: 'ok'; readonly review: ReviewRecord }
  /** Not a review's record, or one whose fields this build cannot take: left as it is, and listed nowhere. */
  | { readonly kind: 'corrupt' }
  /** Written by a newer reader, or an older one (decision 0014): left as it is, and listed nowhere. */
  | { readonly kind: 'refused' };

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);
const noControl = (value: string): boolean => !/\p{Cc}/u.test(value);
const text = (value: unknown, max = 128): string | null => (typeof value === 'string' && value.length > 0 && value.length <= max && noControl(value) ? value : null);
const count = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null);
const positive = (value: unknown): number | null => { const n = count(value); return n !== null && n >= 1 ? n : null; };
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | null => (typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : null);
/** A field that may be null: `undefined` where it is neither null nor what it should be. */
const nullable = <T>(value: unknown, read: (value: unknown) => T | null): T | null | undefined => (value === null || value === undefined ? null : read(value) ?? undefined);
const rest = (row: Row, known: ReadonlySet<string>): Row => Object.fromEntries(Object.entries(row).filter(([key]) => !known.has(key)));

/** Notes by finding id, each within its bound (C30). */
function readNotes(value: unknown): Record<string, string> | null {
  if (!isRow(value)) return null;
  const notes: Record<string, string> = {};
  for (const [id, note] of Object.entries(value)) {
    if (!isFindingId(id) || typeof note !== 'string' || note.length > REVIEW_BOUNDS.note) return null;
    notes[id] = note;
  }
  return notes;
}

function readMarks(value: unknown): Record<string, ReviewMark> | null {
  if (!isRow(value)) return null;
  const marks: Record<string, ReviewMark> = {};
  for (const [id, mark] of Object.entries(value)) {
    const one = oneOf(REVIEW_MARKS, mark);
    if (!isFindingId(id) || one === null) return null;
    marks[id] = one;
  }
  return marks;
}

function readIds(value: unknown, check: (value: unknown) => boolean): string[] | null {
  return Array.isArray(value) && value.every(check) ? [...(value as string[])] : null;
}

const TURN_KEYS = new Set(['turnId', 'promptId', 'kind', 'at', 'answerId', 'outcome', 'reason', 'continues', 'card', 'notes']);
function readTurn(value: unknown): ReviewTurnRecord | null {
  if (!isRow(value)) return null;
  const turnId = text(value['turnId']);
  const promptId = nullable(value['promptId'], text);
  const kind = oneOf(REVIEW_TURN_KINDS, value['kind']);
  const at = count(value['at']);
  const answerId = nullable(value['answerId'], text);
  const outcome = oneOf(REVIEW_TURN_OUTCOMES, value['outcome']);
  const reason = nullable(value['reason'], (raw) => oneOf(REVIEW_REASONS, raw));
  const continues = nullable(value['continues'], text);
  const card = nullable(value['card'], text);
  const notes = nullable(value['notes'], readNotes);
  if (turnId === null || promptId === undefined || kind === null || at === null || answerId === undefined || outcome === null || reason === undefined || continues === undefined || card === undefined || notes === undefined) return null;
  return { turnId, promptId, kind, at, answerId, outcome, reason, continues, card, notes, unknown: rest(value, TURN_KEYS) };
}

const ROUND_KEYS = new Set(['turnId', 'answerId', 'appraisal', 'findings', 'revised', 'marks', 'notes']);
function readRound(value: unknown): ReviewRoundRecord | null {
  if (!isRow(value)) return null;
  const turnId = text(value['turnId']);
  const answerId = text(value['answerId']);
  const appraisal = typeof value['appraisal'] === 'string' ? value['appraisal'] : null;
  const findings = Array.isArray(value['findings']) ? value['findings'].map((raw: unknown) => FindingSchema.safeParse(raw)) : null;
  const revised = readIds(value['revised'], isFindingId);
  const marks = nullable(value['marks'], readMarks);
  const notes = nullable(value['notes'], readNotes);
  if (turnId === null || answerId === null || appraisal === null || findings === null || !findings.every((one) => one.success) || revised === null || marks === undefined || notes === undefined) return null;
  return { turnId, answerId, appraisal, findings: findings.flatMap((one) => (one.success ? [one.data] : [])), revised, marks, notes, unknown: rest(value, ROUND_KEYS) };
}

function readLiveMarks(value: unknown): Record<string, LiveMark> | null {
  if (!isRow(value)) return null;
  const marks: Record<string, LiveMark> = {};
  for (const [id, raw] of Object.entries(value)) {
    if (!isFindingId(id) || !isRow(raw)) return null;
    const mark = oneOf(REVIEW_MARKS, raw['mark']);
    const note = typeof raw['note'] === 'string' && raw['note'].length <= REVIEW_BOUNDS.note ? raw['note'] : null;
    if (mark === null || note === null || typeof raw['revised'] !== 'boolean') return null;
    marks[id] = { mark, note, revised: raw['revised'] };
  }
  return marks;
}

const INTEGRATION_KEYS = new Set(['id', 'version', 'hash', 'round', 'accepted', 'notes', 'instruction', 'sessionId', 'route', 'planItem', 'turns', 'card', 'state', 'reason', 'produced', 'at', 'settledAt']);
function readIntegration(value: unknown): IntegrationRecord | null {
  if (!isRow(value)) return null;
  const id = isReviewId(value['id']) ? value['id'] : null;
  const version = positive(value['version']);
  const hash = PlanHashSchema.safeParse(value['hash']).success ? (value['hash'] as string) : null;
  const round = text(value['round']);
  const accepted = readIds(value['accepted'], isFindingId);
  const notes = readNotes(value['notes']);
  const instruction = positive(value['instruction']);
  const sessionId = text(value['sessionId']);
  const route = oneOf(INTEGRATION_ROUTES, value['route']);
  const planItem = nullable(value['planItem'], text);
  const turns = readIds(value['turns'], (one) => text(one) !== null);
  const card = nullable(value['card'], text);
  const state = oneOf(INTEGRATION_STATES, value['state']);
  const reason = nullable(value['reason'], (raw) => oneOf(INTEGRATION_REASONS, raw));
  const produced = nullable(value['produced'], positive);
  const at = count(value['at']);
  const settledAt = nullable(value['settledAt'], count);
  if (id === null || version === null || hash === null || round === null || accepted === null || notes === null || instruction === null || sessionId === null || route === null || planItem === undefined || turns === null || card === undefined || state === null || reason === undefined || produced === undefined || at === null || settledAt === undefined) return null;
  return { id, version, hash, round, accepted, notes, instruction, sessionId, route, planItem, turns, card, state, reason, produced, at, settledAt, unknown: rest(value, INTEGRATION_KEYS) };
}

/** Each element of a list read, or null where any cannot be: one this build cannot take makes the record one it cannot write back whole. */
function readAll<T>(value: unknown, read: (value: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const out: T[] = [];
  for (const raw of value) {
    const one = read(raw);
    if (one === null) return null;
    out.push(one);
  }
  return out;
}

const REVIEW_KEYS = new Set(['schemaVersion', 'minReaderVersion', 'id', 'planId', 'version', 'hash', 'startedFrom', 'instruction', 'reviewer', 'startedAt', 'endedAt', 'state', 'failure', 'staleBy', 'closed', 'turns', 'rounds', 'marks', 'integrations']);

/** What this build reads of a review's record: refused by its envelope, corrupt, or the review with what it did not know kept. */
export function readReviewFile(document: unknown): ReviewFileReading {
  const envelope = readEnvelope(document, REVIEW_SCHEMA_VERSION);
  if (envelope.kind === 'corrupt') return { kind: 'corrupt' };
  if (envelope.kind !== 'ok' || !isRow(document)) return { kind: 'refused' };
  const id = isReviewId(document['id']) ? document['id'] : null;
  const planId = isPlanId(document['planId']) ? document['planId'] : null;
  const version = positive(document['version']);
  const hash = PlanHashSchema.safeParse(document['hash']).success ? (document['hash'] as string) : null;
  const startedFrom = text(document['startedFrom']);
  const instruction = positive(document['instruction']);
  const reviewerRow = isRow(document['reviewer']) ? document['reviewer'] : null;
  const reviewer = reviewerRow === null ? null : {
    sessionId: text(reviewerRow['sessionId']), providerId: text(reviewerRow['providerId']), instanceId: text(reviewerRow['instanceId']), model: text(reviewerRow['model'], 256), effort: nullable(reviewerRow['effort'], (raw) => text(raw, 256)),
  };
  const startedAt = count(document['startedAt']);
  const endedAt = nullable(document['endedAt'], count);
  const state = oneOf(REVIEW_STATES, document['state']);
  const failure = nullable(document['failure'], (raw) => oneOf(REVIEW_REASONS, raw));
  const staleBy = nullable(document['staleBy'], positive);
  const closed = nullable(document['closed'], (raw) => oneOf(REVIEW_CLOSURES, raw));
  const turns = readAll(document['turns'], readTurn);
  const rounds = readAll(document['rounds'], readRound);
  const marks = readLiveMarks(document['marks']);
  const integrations = readAll(document['integrations'], readIntegration);
  if (id === null || planId === null || version === null || hash === null || startedFrom === null || instruction === null || reviewer === null || startedAt === null || endedAt === undefined || state === null || failure === undefined || staleBy === undefined || closed === undefined || (closed === null) === (state === 'closed') || turns === null || rounds === null || marks === null || integrations === null) return { kind: 'corrupt' };
  const { sessionId, providerId, instanceId, model, effort } = reviewer;
  if (sessionId === null || providerId === null || instanceId === null || model === null || effort === undefined) return { kind: 'corrupt' };
  return {
    kind: 'ok',
    review: {
      id, planId, version, hash, startedFrom, instruction, reviewer: { sessionId, providerId, instanceId, model, effort }, startedAt, endedAt, state, failure, staleBy, closed, turns, rounds, marks, integrations,
      unknown: rest(document, REVIEW_KEYS),
    },
  };
}

const turnDocument = (turn: ReviewTurnRecord): Row => ({ ...turn.unknown, turnId: turn.turnId, promptId: turn.promptId, kind: turn.kind, at: turn.at, answerId: turn.answerId, outcome: turn.outcome, reason: turn.reason, continues: turn.continues, card: turn.card, notes: turn.notes });
const roundDocument = (round: ReviewRoundRecord): Row => ({ ...round.unknown, turnId: round.turnId, answerId: round.answerId, appraisal: round.appraisal, findings: round.findings, revised: round.revised, marks: round.marks, notes: round.notes });
const integrationDocument = (one: IntegrationRecord): Row => ({
  ...one.unknown, id: one.id, version: one.version, hash: one.hash, round: one.round, accepted: one.accepted, notes: one.notes, instruction: one.instruction, sessionId: one.sessionId, route: one.route, planItem: one.planItem,
  turns: one.turns, card: one.card, state: one.state, reason: one.reason, produced: one.produced, at: one.at, settledAt: one.settledAt,
});

/** The document a review's record is written as: its unknown fields first, then what this build knows. */
export function reviewDocument(review: ReviewRecord): Row {
  return {
    ...review.unknown,
    schemaVersion: REVIEW_SCHEMA_VERSION,
    minReaderVersion: REVIEW_MIN_READER_VERSION,
    id: review.id,
    planId: review.planId,
    version: review.version,
    hash: review.hash,
    startedFrom: review.startedFrom,
    instruction: review.instruction,
    reviewer: { ...review.reviewer },
    startedAt: review.startedAt,
    endedAt: review.endedAt,
    state: review.state,
    failure: review.failure,
    staleBy: review.staleBy,
    closed: review.closed,
    turns: review.turns.map(turnDocument),
    rounds: review.rounds.map(roundDocument),
    marks: review.marks,
    integrations: review.integrations.map(integrationDocument),
  };
}
