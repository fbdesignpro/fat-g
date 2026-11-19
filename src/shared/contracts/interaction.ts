// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A question a session asks (docs/planning/_archive/M21.md, Design 1; C4–C9, C30, C39, C60, C78; decision
// 0026): Claude's question tool, Codex's blocking request, or the question Codex asks in a message.
// Each is an item of the conversation of kind `interaction`, and this is its body: its questions,
// bounded, the answers given, and what became of it. It is conversation content, kept in the
// conversation store alone; the summary, a log and the Pet get kinds and counts.
//
// And an action a session asks leave for (docs/planning/_archive/M22.md, Design 4, 5; C8–C14, C48, C56, C57,
// C77, C91, C92; decision 0027): a command, a file change or a tool's use, under a mode that asks.
// It is an item of the same kind, its body told from a question's by `kind`: the request as its
// adapter read it, bounded, what was decided, whether the decision reached the CLI, and the grant
// that went with it. The store adds no item kind for it, and a body that names no kind is a
// question's, as every one written before there were approvals is.
//
// Renderer-safe, and provider-neutral: a question's key — its whole text on one provider, its id on
// another — is no part of the item. Answers are keyed by the question's place, a chosen option by
// its place among the question's options, and each adapter puts its provider's key and the whole
// label at encoding, from the request it holds as it came (C8, C59).
//
// It imports `zod`, the one cut, the activity contract's change kinds and stored bounds and a mode's
// id, and nothing of Node, the page or main. The three bounds a message's questions share with it
// are defined here and exported by the agent events as before, since the events' schemas read this file.
import { z } from 'zod';
import { CHANGE_KINDS, type ChangeKind, MAX_ACTIVITY_INPUT, MAX_CHANGE_TEXT, MAX_CHANGES } from './activity';
import { cutTo } from './cut';
import { ModeIdSchema } from './permissions';
import { isPlanId, PLAN_ORIGINS, PLAN_OUTCOME_WORDS, PLAN_OUTCOMES, type PlanOrigin, type PlanOutcome } from './plans';

// ── Modes, outcomes and the capability (C5, C9, C30) ──────────────────────────────────────────

/**
 * `blocking`: the CLI made a request and holds the turn until it is answered or withdrawn, and the
 * session's attention is raised. `async`: the CLI asked in a message and went on, or ended the turn.
 */
export const INTERACTION_MODES = ['blocking', 'async'] as const;
export type InteractionMode = (typeof INTERACTION_MODES)[number];

/**
 * A closed list, none inferred from time (C9). `pending`: a blocking question not yet answered, its
 * request live on this run. `open`: an async question nothing has answered or passed. `answered`.
 * `dismissed`: a card the user declined — an async one with the CLI told nothing, a blocking one with
 * the request declined to the CLI (M100b, C31, C34). `passed`: an async question
 * a later prompt went by, or that its model went on past in a turn that has ended. `withdrawn`: a request the CLI took back, or whose owner ended without an
 * answer. `dropped`: a request pending when its process was lost, fat-g quit or started again, or
 * one answered whose answer its process could not take. There is no `expired`.
 */
export const INTERACTION_OUTCOMES = ['pending', 'open', 'answered', 'dismissed', 'passed', 'withdrawn', 'dropped'] as const;
export type InteractionOutcome = (typeof INTERACTION_OUTCOMES)[number];

/**
 * Which end withdrew a request: the CLI took it back while its turn went on; its turn's or its
 * worker's end did; or it came again under its id with another payload, and its adapter refused it
 * and let the first go (M22, C91).
 */
export const WITHDRAWN_BY = ['request', 'turn', 'changed'] as const;
export type WithdrawnBy = (typeof WITHDRAWN_BY)[number];

/**
 * Whether a provider's sessions ask questions, and how (C30). Its sessions take `answer` exactly
 * when this is `blocking` or `both`; a message's questions make a card exactly when it is `async`
 * or `both`, and are the plain lines they were otherwise.
 */
export const QUESTION_CAPABILITIES = ['none', 'blocking', 'async', 'both'] as const;
export type QuestionCapability = (typeof QUESTION_CAPABILITIES)[number];

export const asksBlocking = (capability: QuestionCapability): boolean => capability === 'blocking' || capability === 'both';
export const asksAsync = (capability: QuestionCapability): boolean => capability === 'async' || capability === 'both';

// ── Bounds (C7, C8), in UTF-16 units ──────────────────────────────────────────────────────────

export const MAX_QUESTIONS = 16;
export const MAX_OPTIONS = 8;
/** A question's text, its header, and each option's label. */
export const MAX_QUESTION_TEXT = 500;
export const MAX_OPTION_DESCRIPTION = 2_000;
/** A typed answer: past it the field takes no more and the channel's schema refuses, never cut (C8). */
export const MAX_ANSWER_TEXT = 10_000;

// ── The body ──────────────────────────────────────────────────────────────────────────────────

export interface InteractionOption {
  readonly label: string;
  readonly description: string | null;
}

export interface InteractionQuestion {
  readonly text: string;
  /** A short header, where the provider gives one. */
  readonly header: string | null;
  readonly options: readonly InteractionOption[];
  /** Several options may be chosen. */
  readonly multiple: boolean;
  /** A text is taken beside or instead of an option. */
  readonly freeText: boolean;
  /** The answer is typed masked and never kept (C44): its options are not drawn. */
  readonly secret: boolean;
}

/** A question as an adapter read it, before any bound: the same shape, its texts as they came. */
export type RawQuestion = InteractionQuestion;

/** An answer as it is kept (C8): the chosen options by their place, and the text; a secret's is the fact alone. */
export interface InteractionAnswer {
  readonly options: readonly number[];
  /** Null where none was typed, and for a secret's. */
  readonly text: string | null;
  /** A secret answer was given. */
  readonly secret: boolean;
}

/**
 * An answer as it is given: by the card to main, and by main to the provider's session. A secret's
 * text is here and nowhere else (C44).
 */
export interface GivenAnswer {
  readonly options: readonly number[];
  readonly text: string | null;
}

export interface QuestionBody {
  /** What tells it from an approval's body (M22, C77). A stored body that names none is a question's. */
  readonly kind: 'question';
  readonly mode: InteractionMode;
  readonly questions: readonly InteractionQuestion[];
  /** One place per question once answered; null at a place the user left unanswered. */
  readonly answers: readonly (InteractionAnswer | null)[] | null;
  readonly outcome: InteractionOutcome;
  /** fat-g's wall clock at the outcome. */
  readonly settledAt: number | null;
  /** The CLI confirmed it took the answer (C62); an async one's, at its answering turn's acknowledgement (C68). */
  readonly confirmedAt: number | null;
  /** An async answer's turn: the id of the turn its prompt started (C26, C68). */
  readonly answeredBy: string | null;
  readonly withdrawnBy: WithdrawnBy | null;
  /** A text, a header, a label or a description was shortened, or questions or options were left out (C46). */
  readonly cut: boolean;
}

/** An interaction's body (M22, C77): a question's, an approval's, or a plan's line (M22b, C17), by its kind. */
export type InteractionBody = QuestionBody | ApprovalBody | PlanBody;

/** The question an item holds, or null: for an item that is none, and for an approval's. */
export function questionOf(item: { readonly interaction: InteractionBody | null }): QuestionBody | null {
  return item.interaction?.kind === 'question' ? item.interaction : null;
}

/** The approval an item holds, or null. */
export function approvalOf(item: { readonly interaction: InteractionBody | null }): ApprovalBody | null {
  return item.interaction?.kind === 'approval' ? item.interaction : null;
}

/**
 * Its pending state is a live request's (M21, C76; M22b, C56): an approval, a blocking question, or a
 * plan's line a request holds. Such a body is pending on this run alone, as its registry says.
 */
export function heldByRequest(body: InteractionBody): boolean {
  if (body.kind === 'approval') return true;
  return body.kind === 'question' ? body.mode === 'blocking' : body.request;
}

/** The plan's line an item holds, or null (M22b, C17, C23). */
export function planOf(item: { readonly interaction: InteractionBody | null }): PlanBody | null {
  return item.interaction?.kind === 'plan' ? item.interaction : null;
}

// ── Schemas: what an event and a channel may carry ────────────────────────────────────────────
// A string that is only too long never fails an event's schema: the adapter bounds it first.

const questionText = z.string().max(MAX_QUESTION_TEXT);

export const InteractionQuestionSchema = z.strictObject({
  text: questionText,
  header: questionText.nullable(),
  options: z.array(z.strictObject({ label: questionText, description: z.string().max(MAX_OPTION_DESCRIPTION).nullable() })).max(MAX_OPTIONS),
  multiple: z.boolean(),
  freeText: z.boolean(),
  secret: z.boolean(),
});
/** A request's questions: one at least. */
export const InteractionQuestionsSchema = z.array(InteractionQuestionSchema).min(1).max(MAX_QUESTIONS);
/** A question as an event carries it: `InteractionQuestion`, in lists of its own that an event takes as they are. */
export type BoundQuestion = z.infer<typeof InteractionQuestionSchema>;

const place = z.number().int().min(0).max(MAX_QUESTIONS - 1);
/** One question's answer as the card sends it (C31): its question's place, the places of its chosen options, and its text. */
export const AnswerEntrySchema = z.strictObject({
  question: place,
  options: z.array(z.number().int().min(0).max(MAX_OPTIONS - 1)).max(MAX_OPTIONS),
  text: z.string().max(MAX_ANSWER_TEXT).nullable(),
});
export const AnswerEntriesSchema = z.array(AnswerEntrySchema).min(1).max(MAX_QUESTIONS);
export type AnswerEntry = z.infer<typeof AnswerEntrySchema>;

// ── The cut (C7, C46, C60) ────────────────────────────────────────────────────────────────────

const orNull = (value: string | null): string | null => (value === null || value.trim() === '' ? null : value);

/**
 * Questions within their bounds, for what the card draws and the store keeps (C7): each text cut,
 * the first 16 questions and the first 8 options kept, and `cut` set where anything went. An answer
 * is never encoded from these: the adapter holds the request as it came (C59).
 */
export function boundQuestions(raw: readonly RawQuestion[]): { readonly questions: BoundQuestion[]; readonly cut: boolean } {
  let cut = raw.length > MAX_QUESTIONS;
  const take = (value: string, max: number): string => {
    const taken = cutTo(value, max);
    cut ||= taken.cut;
    return taken.text;
  };
  const questions = raw.slice(0, MAX_QUESTIONS).map((question): BoundQuestion => {
    const header = orNull(question.header);
    cut ||= question.options.length > MAX_OPTIONS;
    return {
      text: take(question.text, MAX_QUESTION_TEXT),
      header: header === null ? null : take(header, MAX_QUESTION_TEXT),
      options: question.options.slice(0, MAX_OPTIONS).map((option) => {
        const description = orNull(option.description);
        return { label: take(option.label, MAX_QUESTION_TEXT), description: description === null ? null : take(description, MAX_OPTION_DESCRIPTION) };
      }),
      multiple: question.multiple,
      freeText: question.freeText,
      secret: question.secret,
    };
  });
  return { questions, cut };
}

/** A question takes a typed text: where its provider says so, and always for a secret, whose field is all there is of it (C78). */
export const takesText = (question: Pick<InteractionQuestion, 'freeText' | 'secret'>): boolean => question.freeText || question.secret;

/**
 * Whether a blocking request can be drawn whole and answered (C60, C78): one question at least and
 * 16 at most; no question with more than 8 options that takes no text, since the ones left out
 * could not be chosen; and no question with no option that takes no text, which nothing could
 * answer. A request that cannot is refused by its adapter before any event, never cut.
 */
export function canShow(raw: readonly Pick<RawQuestion, 'options' | 'freeText' | 'secret'>[]): boolean {
  if (raw.length === 0 || raw.length > MAX_QUESTIONS) return false;
  return raw.every((question) => takesText(question) || (question.options.length > 0 && question.options.length <= MAX_OPTIONS));
}

// ── Answers (C8, C45, C78) ────────────────────────────────────────────────────────────────────

const hasText = (text: string | null): text is string => text !== null && text.trim() !== '';

/** Whether an answer says anything: an option chosen, or a text that is not blank. */
export function isAnswered(answer: GivenAnswer | null): answer is GivenAnswer {
  return answer !== null && (answer.options.length > 0 || hasText(answer.text));
}

/**
 * The card's entries as one place per question (C31): null at a place whose entry says nothing.
 * Null for entries that are not one for each question — more, fewer, one named twice or past the
 * questions — which main refuses as a mismatch (C78).
 */
export function placeAnswers(count: number, entries: readonly AnswerEntry[]): (GivenAnswer | null)[] | null {
  if (entries.length !== count) return null;
  const placed: (GivenAnswer | null | undefined)[] = Array.from({ length: count }, () => undefined);
  for (const entry of entries) {
    if (entry.question >= count || placed[entry.question] !== undefined) return null;
    const given: GivenAnswer = { options: entry.options, text: hasText(entry.text) ? entry.text : null };
    placed[entry.question] = isAnswered(given) ? given : null;
  }
  return placed.map((answer) => answer ?? null);
}

/**
 * Whether an answer fits its questions (C78): one place per question; each chosen option within the
 * question's options and chosen once; several only where several may be chosen; a text only where
 * one is taken; and for a secret no option, its options not being drawn. Main refuses one that does
 * not, before any write, in both modes; the card never produces one.
 */
export function fits(questions: readonly InteractionQuestion[], answers: readonly (GivenAnswer | null)[]): boolean {
  if (answers.length !== questions.length) return false;
  return questions.every((question, index) => {
    const answer = answers[index] ?? null;
    if (answer === null) return true;
    const { options, text } = answer;
    if (new Set(options).size !== options.length) return false;
    if (options.some((option) => !Number.isInteger(option) || option < 0 || option >= question.options.length)) return false;
    if (options.length > 1 && !question.multiple) return false;
    if (question.secret && options.length > 0) return false;
    if (text !== null && text.length > MAX_ANSWER_TEXT) return false;
    return !hasText(text) || takesText(question);
  });
}

/** Whether no question of a card was answered (M100b, C30): what a Submit is refused for, Skip standing for none. */
export function noneAnswered(answers: readonly (GivenAnswer | null)[]): boolean {
  return answers.every((answer) => !isAnswered(answer));
}

/**
 * What a question left with nothing chosen and nothing typed is sent as (M100b, C30): these words,
 * by each provider's route, so that no CLI is relied on to take a partial answer and the model reads
 * which question went unanswered. A settled card shows the same words; the item keeps a null.
 */
export const NO_ANSWER = 'No answer';

/** A blocking answer as it is given to the session (M100b, C30): each unanswered place as the text "No answer". */
export function sentAnswers(answers: readonly (GivenAnswer | null)[]): GivenAnswer[] {
  return answers.map((answer) => (isAnswered(answer) ? answer : { options: [], text: NO_ANSWER }));
}

/** A given answer as it is kept (C8, C44): a secret's as the fact that one was given, and never its text. */
export function keptAnswers(questions: readonly InteractionQuestion[], answers: readonly (GivenAnswer | null)[]): (InteractionAnswer | null)[] {
  return questions.map((question, index) => {
    const answer = answers[index] ?? null;
    if (!isAnswered(answer)) return null;
    return question.secret ? { options: [], text: null, secret: true } : { options: [...answer.options], text: hasText(answer.text) ? answer.text : null, secret: false };
  });
}

/**
 * An async question's answer, as the prompt it is sent as (C26), in fat-g's words from the card:
 * each question's text on a line and its answer on the next — the chosen option, the typed text, or
 * the option and then the text on a line of its own, and "No answer" for one left so (M100b, C30) —
 * questions separated by a blank line.
 */
export function answerPrompt(questions: readonly InteractionQuestion[], answers: readonly (GivenAnswer | null)[]): string {
  const parts: string[] = [];
  for (const [index, question] of questions.entries()) {
    const answer = answers[index] ?? null;
    if (!isAnswered(answer)) { parts.push([question.text, NO_ANSWER].join('\n')); continue; }
    const labels = answer.options.flatMap((option) => { const label = question.options[option]?.label; return label === undefined ? [] : [label]; });
    const lines = [question.text, ...(labels.length === 0 ? [] : [labels.join(', ')]), ...(hasText(answer.text) ? [answer.text] : [])];
    parts.push(lines.join('\n'));
  }
  return parts.join('\n\n');
}

/**
 * A message's questions as a card's (C7, C28): a title and its options alone, so one choice, free
 * text taken, no header and no description. `messageCut`: the message says its text or its
 * questions were cut to their bounds (M15, C113); the card says so where a question stands at one.
 */
export function fromMessageQuestions(questions: readonly { readonly title: string; readonly options: readonly string[] }[], messageCut = false): { readonly questions: BoundQuestion[]; readonly cut: boolean } {
  const atBound = questions.length >= MAX_QUESTIONS || questions.some((question) => question.title.length >= MAX_QUESTION_TEXT || question.options.length >= MAX_OPTIONS || question.options.some((option) => option.length >= MAX_QUESTION_TEXT));
  const bound = boundQuestions(questions.map((question) => ({ text: question.title, header: null, options: question.options.map((label) => ({ label, description: null })), multiple: false, freeText: true, secret: false })));
  return { questions: bound.questions, cut: bound.cut || (messageCut && atBound) };
}

// ── A body, made and read ─────────────────────────────────────────────────────────────────────

/** A body at its raising: `pending` for a blocking question, `open` for an async one. */
export function raisedBody(mode: InteractionMode, questions: readonly InteractionQuestion[], cut: boolean): QuestionBody {
  return { kind: 'question', mode, questions, answers: null, outcome: mode === 'blocking' ? 'pending' : 'open', settledAt: null, confirmedAt: null, answeredBy: null, withdrawnBy: null, cut };
}

/** Whether nothing more can become of it by an answer or a decision: every outcome but the two it waits in, and a plan's while it is written (M22b, C74). */
export function isSettled(outcome: InteractionOutcome | ApprovalOutcome | PlanOutcome): boolean {
  return outcome !== 'pending' && outcome !== 'open' && outcome !== 'writing';
}

const units = (value: string | null): number => value?.length ?? 0;

/** A body's size, in UTF-16 units of its strings: what the page's and the window's bounds count (C36). An approval's is its request's (M22, C48). */
export function interactionUnits(body: Pick<QuestionBody, 'questions' | 'answers'> | ApprovalBody | PlanBody): number {
  // A plan's line holds no text: the plan store has it (M22b, C17).
  if ('planId' in body) return 0;
  if ('request' in body) return approvalUnits(body.request) + (body.grant?.covers.length ?? 0);
  const questions = body.questions.reduce((sum, question) => sum + question.text.length + units(question.header) + question.options.reduce((inner, option) => inner + option.label.length + units(option.description), 0), 0);
  const answers = (body.answers ?? []).reduce((sum, answer) => sum + units(answer?.text ?? null), 0);
  return questions + answers;
}

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) ? value : null);
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | null => (typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : null);

function readQuestion(value: unknown): InteractionQuestion[] {
  if (!isRow(value) || typeof value['text'] !== 'string') return [];
  const options = Array.isArray(value['options']) ? value['options'].flatMap((option: unknown): InteractionOption[] => (isRow(option) && typeof option['label'] === 'string' ? [{ label: option['label'], description: text(option['description']) }] : [])) : [];
  return [{ text: value['text'], header: text(value['header']), options, multiple: value['multiple'] === true, freeText: value['freeText'] === true, secret: value['secret'] === true }];
}

function readAnswer(value: unknown): InteractionAnswer | null {
  if (!isRow(value)) return null;
  const options = Array.isArray(value['options']) ? value['options'].flatMap((option: unknown) => { const at = whole(option); return at === null || at < 0 ? [] : [at]; }) : [];
  return { options, text: text(value['text']), secret: value['secret'] === true };
}

/**
 * A plan's line (M22b, C17, C56, C74): which plan and which version it stands for, how it came, and
 * the decision — no text, which the plan store holds. A decision held by a provider's request
 * (`request`, Claude's alone) lives as that request does: one an earlier run left pending reads
 * `dropped`, and one with no request behind it stays pending across a restart (C27).
 */
export interface PlanBody {
  readonly kind: 'plan';
  readonly planId: string;
  /** The version the line opened, which its decision is of (C24). */
  readonly version: number;
  readonly came: PlanOrigin;
  readonly request: boolean;
  readonly outcome: PlanOutcome;
  /** fat-g's wall clock at the user's decision. */
  readonly decidedAt: number | null;
  /** fat-g's wall clock at any other end: withdrawn, dropped, unfinished. */
  readonly settledAt: number | null;
  /** The CLI's word that it took the decision, where a request held it (C11). */
  readonly confirmedAt: number | null;
  readonly withdrawnBy: WithdrawnBy | null;
}

/** A line as it opens: `writing` while a Codex plan is written (C74), `pending` once its decision opens. */
export function raisedPlan(fields: Pick<PlanBody, 'planId' | 'version' | 'came' | 'request'> & { readonly writing?: boolean }): PlanBody {
  return { kind: 'plan', planId: fields.planId, version: fields.version, came: fields.came, request: fields.request, outcome: fields.writing === true ? 'writing' : 'pending', decidedAt: null, settledAt: null, confirmedAt: null, withdrawnBy: null };
}

/**
 * What this build reads of a stored line's body: the keys it knows, each checked. Null where the plan
 * or its version cannot be read, which no line can stand for. An outcome it does not know reads
 * `dropped`, which claims nothing and offers no control.
 */
function readPlanLine(value: Row): PlanBody | null {
  if (!isPlanId(value['planId'])) return null;
  const version = whole(value['version']);
  if (version === null || version < 1) return null;
  return {
    kind: 'plan',
    planId: value['planId'],
    version,
    came: oneOf(PLAN_ORIGINS, value['came']) ?? 'made',
    request: value['request'] === true,
    outcome: oneOf(PLAN_OUTCOMES, value['outcome']) ?? 'dropped',
    decidedAt: whole(value['decidedAt']),
    settledAt: whole(value['settledAt']),
    confirmedAt: whole(value['confirmedAt']),
    withdrawnBy: oneOf(WITHDRAWN_BY, value['withdrawnBy']),
  };
}

/**
 * What this build reads of a stored interaction: the keys it knows, each checked, and nothing
 * failing for a key it does not. Null for what is no interaction at all. It is read by its kind
 * (M22, C77), and a body that names none, or one this build does not know, is a question's. An
 * outcome this build does not know reads `dropped`, which claims nothing and offers no control; a
 * mode it does not know reads `blocking`, which nothing of an earlier run can answer.
 */
export function readInteraction(value: unknown): InteractionBody | null {
  if (!isRow(value)) return null;
  if (value['kind'] === 'approval') return readApproval(value);
  // A plan's line (M22b, C17): one whose plan or version cannot be read is no line.
  if (value['kind'] === 'plan') return readPlanLine(value);
  return {
    kind: 'question',
    mode: oneOf(INTERACTION_MODES, value['mode']) ?? 'blocking',
    questions: Array.isArray(value['questions']) ? value['questions'].flatMap(readQuestion) : [],
    answers: Array.isArray(value['answers']) ? value['answers'].map(readAnswer) : null,
    outcome: oneOf(INTERACTION_OUTCOMES, value['outcome']) ?? 'dropped',
    settledAt: whole(value['settledAt']),
    confirmedAt: whole(value['confirmedAt']),
    answeredBy: text(value['answeredBy']),
    withdrawnBy: oneOf(WITHDRAWN_BY, value['withdrawnBy']),
    cut: value['cut'] === true,
  };
}

// ── fat-g's words for an outcome (C39) ────────────────────────────────────────────────────────

export const OUTCOME_WORDS = {
  answered: 'Answered',
  unconfirmed: 'Answered; the model did not confirm it',
  withdrawnByRequest: 'Withdrawn: the model went on without an answer',
  withdrawnByTurn: 'Withdrawn: the reply ended',
  /** The request came again under its id with another payload (M22, C91). */
  withdrawnByChange: 'Withdrawn: the request changed under its id and was refused',
  dropped: 'Not answered: the session’s process ended',
  /** A card the user declined (M100b, C42): an async one, folded away with the CLI told nothing. */
  dismissed: 'Declined; the model was not told',
  /** A blocking one, its request declined to the CLI (M100b, C31, C42). */
  declined: 'Declined: the model was told',
  passed: 'Passed over: the conversation went on without an answer',
} as const;

/**
 * What a settled card says became of it, or null for one that still waits. `unconfirmed`: an
 * answered item without its mark, once what carries its answer is no longer running (C68, C79) —
 * the caller's to say, since only it knows what runs.
 */
export function outcomeWords(body: (Pick<QuestionBody, 'outcome' | 'withdrawnBy'> & Partial<Pick<QuestionBody, 'mode'>>) | Pick<ApprovalBody, 'outcome' | 'withdrawnBy' | 'delivered'> | Pick<PlanBody, 'kind' | 'outcome' | 'withdrawnBy'>, unconfirmed: boolean): string | null {
  // A plan's line (M22b, C23): its decision in its own words.
  if ('kind' in body && body.kind === 'plan') return PLAN_OUTCOME_WORDS[body.outcome];
  switch (body.outcome) {
    case 'pending':
    case 'open':
      return null;
    case 'approved':
    case 'approved-session':
    case 'denied':
      // An approval's decision (M22): its own words, by the same rule for one the CLI never confirmed.
      return approvalWords({ outcome: body.outcome, withdrawnBy: body.withdrawnBy, delivered: 'delivered' in body ? body.delivered : null }, unconfirmed);
    case 'answered':
      return unconfirmed ? OUTCOME_WORDS.unconfirmed : OUTCOME_WORDS.answered;
    case 'withdrawn':
      return withdrawnWords(body.withdrawnBy);
    case 'dropped':
      return OUTCOME_WORDS.dropped;
    case 'dismissed':
      return 'mode' in body && body.mode === 'blocking' ? OUTCOME_WORDS.declined : OUTCOME_WORDS.dismissed;
    case 'passed':
      return OUTCOME_WORDS.passed;
    // A plan's own: its line said so above.
    case 'writing':
    case 'feedback':
    case 'executed':
    case 'cancelled':
    case 'unfinished':
    case 'superseded':
    case 'elsewhere':
    case 'left':
    case 'retired':
      return PLAN_OUTCOME_WORDS[body.outcome];
  }
}

function withdrawnWords(by: WithdrawnBy | null): string {
  return by === 'request' ? OUTCOME_WORDS.withdrawnByRequest : by === 'changed' ? OUTCOME_WORDS.withdrawnByChange : OUTCOME_WORDS.withdrawnByTurn;
}

// ── An approval: the request (M22, Design 4; C8, C9, C48, C56, C68) ───────────────────────────

export const APPROVAL_KINDS = ['command', 'file-change', 'tool'] as const;
export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

/**
 * What a card can be answered with. `approve-session` is the CLI's own session grant, offered only
 * where the request makes it eligible (C68). Stop is the session's own, and no choice of a request's.
 */
export const APPROVAL_CHOICES = ['approve', 'approve-session', 'deny'] as const;
export type ApprovalChoice = (typeof APPROVAL_CHOICES)[number];

/** What a CLI's own offers would grant beyond this one action (C8, C56): a kind, said in fat-g's words, and never passed back. */
export const AUTHORITY_KINDS = ['mode', 'folder', 'saved-rule', 'network', 'other'] as const;
export type AuthorityKind = (typeof AUTHORITY_KINDS)[number];

export interface ApprovalAuthority {
  readonly kind: AuthorityKind;
  /** For `mode`: the id of the provider's mode the CLI would change to, where it is one the provider lists. */
  readonly mode: string | null;
}

// Bounds (C9, C48), in UTF-16 units. A request past `MAX_APPROVAL_TARGETS`, `MAX_APPROVAL_CHOICES`
// or its detail's bound is refused by its adapter, never shown cut.
export const MAX_APPROVAL_TOOL = 256;
/** One line. */
export const MAX_APPROVAL_SUMMARY = 2_000;
export const MAX_APPROVAL_TARGETS = 32;
export const MAX_APPROVAL_PATH = 2_048;
/** The model's own words. */
export const MAX_APPROVAL_REASON = 2_000;
export const MAX_APPROVAL_AUTHORITY = 16;
export const MAX_APPROVAL_CHOICES = 16;
/** A command, and a tool's input as JSON text. */
export const MAX_APPROVAL_DETAIL = 65_536;
/** A file change's content, its parts counted together: each change's text and what it replaces (C48). */
export const MAX_APPROVAL_CHANGE_UNITS = 1_048_576;
/** What a grant covers, in the CLI's own words: its rule's text, or the file's path. */
export const MAX_GRANT_COVERS = 2_048;

/**
 * One file of a change as its request has it (C9). `text`: the content, the new text of an edit by
 * match, or the diff. `replace`: for an edit by match, the text it replaces. `all`: for an edit by
 * match, whether every matching passage is replaced or the first alone — null where the change is
 * no edit by match — so that two edits of opposite scope never read alike.
 */
export interface ApprovalChange {
  readonly path: string;
  readonly kind: ChangeKind;
  readonly text: string | null;
  readonly replace: string | null;
  readonly all: boolean | null;
}

/** The whole action (C9, C48): what is drawn behind the card's disclosure, and never read from a file. */
export type ApprovalDetail =
  | { readonly kind: 'command'; readonly command: string }
  | { readonly kind: 'changes'; readonly changes: readonly ApprovalChange[] }
  | { readonly kind: 'input'; readonly text: string };

/**
 * A request for leave to act, as its adapter read it (C8): bounded, provider-neutral, and all the
 * page and main know of it — the adapter keeps the request as it came, and answers from that.
 */
export interface ApprovalRequest {
  readonly kind: ApprovalKind;
  /** The CLI's name for what asks: a tool's, an MCP tool's, an item's type. */
  readonly tool: string;
  /** One line: the command's first line, the file's name, the tool's name. */
  readonly summary: string;
  /** The working folder the request names, or null where it names none. */
  readonly folder: string | null;
  /** The paths the action names. */
  readonly targets: readonly string[];
  /** The CLI said a target is outside the folders the session was given. */
  readonly outside: boolean;
  /** The model's own words for why, labelled so wherever they are shown. */
  readonly reason: string | null;
  /** What the CLI's own offers would grant beyond this action: said, and never sent back (C22, C56). */
  readonly authority: readonly ApprovalAuthority[];
  readonly detail: ApprovalDetail;
  /** `approve-session` exactly where `grant` is set. */
  readonly choices: readonly ApprovalChoice[];
  /** The session grant this request is eligible for, in the CLI's own words for what it covers (C56, C68); null where it is eligible for none. */
  readonly grant: { readonly covers: string } | null;
  /** The id of the mode that would stop this question, where a change of mode is the CLI's only offer (C56). The card names it, and changes none. */
  readonly modeThatWouldStop: string | null;
  /** The detail was shortened: true of a stored request alone, and never of one a live card shows (C48, C79). */
  readonly cut: boolean;
}

const approvalPath = z.string().min(1).max(MAX_APPROVAL_PATH);
const ApprovalChangeSchema = z.strictObject({
  path: approvalPath,
  kind: z.enum(CHANGE_KINDS),
  text: z.string().max(MAX_APPROVAL_CHANGE_UNITS).nullable(),
  replace: z.string().max(MAX_APPROVAL_CHANGE_UNITS).nullable(),
  all: z.boolean().nullable(),
});

/** How much a change's content is, its parts counted together (C48). */
export function changeUnits(changes: readonly Pick<ApprovalChange, 'text' | 'replace'>[]): number {
  return changes.reduce((sum, change) => sum + (change.text?.length ?? 0) + (change.replace?.length ?? 0), 0);
}

/**
 * What an `approval-raised` event may carry (C8, C48): the request whole, within every bound. A
 * string that is only too long for a label never fails it — the adapter cuts those first — and a
 * request past a bound that cannot be cut never reaches it: its adapter refuses that one (C9).
 */
export const ApprovalRequestSchema = z
  .strictObject({
    kind: z.enum(APPROVAL_KINDS),
    tool: z.string().min(1).max(MAX_APPROVAL_TOOL),
    summary: z.string().max(MAX_APPROVAL_SUMMARY),
    folder: z.string().min(1).max(MAX_APPROVAL_PATH).nullable(),
    targets: z.array(approvalPath).max(MAX_APPROVAL_TARGETS),
    outside: z.boolean(),
    reason: z.string().max(MAX_APPROVAL_REASON).nullable(),
    authority: z.array(z.strictObject({ kind: z.enum(AUTHORITY_KINDS), mode: ModeIdSchema.nullable() })).max(MAX_APPROVAL_AUTHORITY),
    detail: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('command'), command: z.string().max(MAX_APPROVAL_DETAIL) }),
      z.strictObject({ kind: z.literal('changes'), changes: z.array(ApprovalChangeSchema).min(1).max(MAX_APPROVAL_TARGETS) }),
      z.strictObject({ kind: z.literal('input'), text: z.string().max(MAX_APPROVAL_DETAIL) }),
    ]),
    choices: z.array(z.enum(APPROVAL_CHOICES)).min(1).max(MAX_APPROVAL_CHOICES),
    grant: z.strictObject({ covers: z.string().min(1).max(MAX_GRANT_COVERS) }).nullable(),
    modeThatWouldStop: ModeIdSchema.nullable(),
    cut: z.literal(false),
  })
  .refine((request) => request.detail.kind !== 'changes' || changeUnits(request.detail.changes) <= MAX_APPROVAL_CHANGE_UNITS, 'a change over its bound')
  .refine((request) => new Set(request.choices).size === request.choices.length && request.choices.includes('approve') && request.choices.includes('deny'), 'choices')
  .refine((request) => request.choices.includes('approve-session') === (request.grant !== null), 'a grant with no choice, or a choice with no grant');

/** A request as an event carries it: `ApprovalRequest`, whole and never said cut, in lists of its own that an event takes as they are. */
export type RaisedApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

/** Which bound a request is past (C9, C48), with its size: what its adapter's refusal names. */
export interface ApprovalOverBound {
  readonly bound: 'targets' | 'choices' | 'detail' | 'path';
  readonly size: number;
}

/**
 * Whether a request can be shown whole (C9, C48): what an adapter asks before it raises one, so
 * that both refuse by one rule. Null for one that can. Its labels — the tool's name, the summary,
 * the reason — are cut by the adapter and are no part of this; a path is, since a cut path would
 * name another file.
 */
export function approvalOverBound(request: Pick<ApprovalRequest, 'targets' | 'choices' | 'detail' | 'folder'>): ApprovalOverBound | null {
  if (request.targets.length > MAX_APPROVAL_TARGETS) return { bound: 'targets', size: request.targets.length };
  if (request.choices.length > MAX_APPROVAL_CHOICES) return { bound: 'choices', size: request.choices.length };
  const { detail } = request;
  if (detail.kind === 'changes') {
    if (detail.changes.length > MAX_APPROVAL_TARGETS) return { bound: 'targets', size: detail.changes.length };
    const size = changeUnits(detail.changes);
    if (size > MAX_APPROVAL_CHANGE_UNITS) return { bound: 'detail', size };
  } else {
    const size = detail.kind === 'command' ? detail.command.length : detail.text.length;
    if (size > MAX_APPROVAL_DETAIL) return { bound: 'detail', size };
  }
  const paths = [...request.targets, ...(request.folder === null ? [] : [request.folder]), ...(detail.kind === 'changes' ? detail.changes.map((change) => change.path) : [])];
  const long = paths.find((path) => path.length > MAX_APPROVAL_PATH);
  return long === undefined ? null : { bound: 'path', size: long.length };
}

/**
 * A request as the store keeps it (C48, C77): its detail cut as an activity's is — a command and an
 * input at 10,000 units, a change's each text at 20,000 and the first 20 changes — and `cut` set
 * where anything went. The live card shows the request whole, from the registry (C79).
 */
export function storedRequest(request: ApprovalRequest): ApprovalRequest {
  let cut = request.cut;
  const take = (value: string, max: number): string => {
    const taken = cutTo(value, max);
    cut ||= taken.cut;
    return taken.text;
  };
  const { detail } = request;
  let stored: ApprovalDetail;
  if (detail.kind === 'command') stored = { kind: 'command', command: take(detail.command, MAX_ACTIVITY_INPUT) };
  else if (detail.kind === 'input') stored = { kind: 'input', text: take(detail.text, MAX_ACTIVITY_INPUT) };
  else {
    cut ||= detail.changes.length > MAX_CHANGES;
    stored = { kind: 'changes', changes: detail.changes.slice(0, MAX_CHANGES).map((change) => ({ ...change, text: change.text === null ? null : take(change.text, MAX_CHANGE_TEXT), replace: change.replace === null ? null : take(change.replace, MAX_CHANGE_TEXT) })) };
  }
  return { ...request, detail: stored, cut };
}

/** A request's size, in UTF-16 units of its strings (C36, C48): the stored one's is what a page counts. */
export function approvalUnits(request: ApprovalRequest): number {
  const { detail } = request;
  const whole = detail.kind === 'command' ? detail.command.length : detail.kind === 'input' ? detail.text.length : detail.changes.reduce((sum, change) => sum + change.path.length, 0) + changeUnits(detail.changes);
  return request.tool.length + request.summary.length + (request.folder?.length ?? 0) + request.targets.reduce((sum, target) => sum + target.length, 0) + (request.reason?.length ?? 0) + (request.grant?.covers.length ?? 0) + whole;
}

// ── An approval: the body (M22, Design 4, 5; C12, C57, C77, C81, C92) ─────────────────────────

/**
 * A closed list (C13). `pending`: its request is live on this run. `approved`: once.
 * `approved-session`: with the CLI's own session grant. `denied`. `withdrawn`: the CLI took it
 * back, its owner ended, or it changed under its id. `dropped`: its process was lost, fat-g quit or
 * started again with it pending, or the process could not take the decision.
 */
export const APPROVAL_OUTCOMES = ['pending', 'approved', 'approved-session', 'denied', 'withdrawn', 'dropped'] as const;
export type ApprovalOutcome = (typeof APPROVAL_OUTCOMES)[number];
export type ApprovalDecision = 'approved' | 'approved-session' | 'denied';

/** The outcome each choice writes. */
export const CHOICE_OUTCOMES = { approve: 'approved', 'approve-session': 'approved-session', deny: 'denied' } as const satisfies Record<ApprovalChoice, ApprovalDecision>;

/**
 * The session grant a decision sent (C57, C81): what it covered, in the CLI's own words, and the
 * key of the process the decision was written for. `live` is never stored: it is laid over at each
 * read and push — true while that key is the session's current process's — and false as the store
 * reads it, so that every stored grant is ended after a restart.
 */
export interface ApprovalGrant {
  readonly covers: string;
  readonly processKey: string;
  readonly live: boolean;
}

export interface ApprovalBody {
  readonly kind: 'approval';
  /** As the store keeps it, its detail cut (C48); on a live card, laid over whole from the registry (C79). */
  readonly request: ApprovalRequest;
  readonly outcome: ApprovalOutcome;
  /** fat-g's wall clock at the user's decision. */
  readonly decidedAt: number | null;
  /** fat-g's wall clock at an outcome no decision made: a withdrawal, a drop. */
  readonly settledAt: number | null;
  /** The decision's write to the process went (C12): false where the process refused it, null until one of the two is known. */
  readonly delivered: boolean | null;
  /** The CLI's word that it took the decision (C12). It says nothing of the action's success, which is its activity's. */
  readonly confirmedAt: number | null;
  readonly withdrawnBy: WithdrawnBy | null;
  /** Set exactly for `approved-session`. */
  readonly grant: ApprovalGrant | null;
}

/** A body at its raising: pending, with the request as the store keeps it. */
export function raisedApproval(request: ApprovalRequest): ApprovalBody {
  return { kind: 'approval', request: storedRequest(request), outcome: 'pending', decidedAt: null, settledAt: null, delivered: null, confirmedAt: null, withdrawnBy: null, grant: null };
}

/** Whether a decision was taken: the three outcomes a choice writes. */
export function isDecided(outcome: ApprovalOutcome): outcome is ApprovalDecision {
  return outcome === 'approved' || outcome === 'approved-session' || outcome === 'denied';
}

/** A grant fat-g sent (C92): one whose decision's reply was delivered. Neither the write of the decision nor the process key stands for that. */
export function grantSent(body: Pick<ApprovalBody, 'grant' | 'delivered' | 'outcome'>): boolean {
  return body.outcome === 'approved-session' && body.grant !== null && body.delivered === true;
}

/** A session's grant as its list shows it (C57, C92): fat-g's record of what it sent, and no reading of the CLI. */
export interface SessionGrant {
  /** The card's item. */
  readonly itemId: string;
  readonly covers: string;
  readonly decidedAt: number | null;
  /** The CLI's own word that it took the decision. */
  readonly confirmed: boolean;
  /** Its process is the session's current one. */
  readonly live: boolean;
}

function readChange(value: unknown): ApprovalChange[] {
  if (!isRow(value) || typeof value['path'] !== 'string') return [];
  return [{ path: value['path'], kind: oneOf(CHANGE_KINDS, value['kind']) ?? 'other', text: text(value['text']), replace: text(value['replace']), all: typeof value['all'] === 'boolean' ? value['all'] : null }];
}

function readDetail(value: unknown): ApprovalDetail {
  if (isRow(value)) {
    if (value['kind'] === 'command') return { kind: 'command', command: text(value['command']) ?? '' };
    if (value['kind'] === 'changes') return { kind: 'changes', changes: Array.isArray(value['changes']) ? value['changes'].flatMap(readChange) : [] };
    if (value['kind'] === 'input') return { kind: 'input', text: text(value['text']) ?? '' };
  }
  return { kind: 'input', text: '' };
}

function readRequest(value: unknown): ApprovalRequest {
  const row = isRow(value) ? value : {};
  const grant = isRow(row['grant']) && typeof row['grant']['covers'] === 'string' ? { covers: row['grant']['covers'] } : null;
  return {
    kind: oneOf(APPROVAL_KINDS, row['kind']) ?? 'tool',
    tool: text(row['tool']) ?? '',
    summary: text(row['summary']) ?? '',
    folder: text(row['folder']),
    targets: Array.isArray(row['targets']) ? row['targets'].filter((target: unknown): target is string => typeof target === 'string') : [],
    outside: row['outside'] === true,
    reason: text(row['reason']),
    authority: Array.isArray(row['authority']) ? row['authority'].flatMap((entry: unknown): ApprovalAuthority[] => (isRow(entry) ? [{ kind: oneOf(AUTHORITY_KINDS, entry['kind']) ?? 'other', mode: text(entry['mode']) }] : [])) : [],
    detail: readDetail(row['detail']),
    choices: Array.isArray(row['choices']) ? row['choices'].flatMap((choice: unknown) => { const known = oneOf(APPROVAL_CHOICES, choice); return known === null ? [] : [known]; }) : [],
    grant,
    modeThatWouldStop: text(row['modeThatWouldStop']),
    // A detail this build cannot read is shown as none, and said cut.
    cut: row['cut'] === true || !isRow(row['detail']) || !['command', 'changes', 'input'].includes(String(row['detail']['kind'])),
  };
}

/**
 * What this build reads of a stored approval (C77): the keys it knows, each checked. An outcome it
 * does not know reads `dropped`, and a stored `pending` is the store's alone to say: the chat
 * service reads it `dropped` unless the registry holds its request (C79). A grant reads ended.
 */
export function readApproval(value: unknown): ApprovalBody | null {
  if (!isRow(value)) return null;
  const grant = isRow(value['grant']) && typeof value['grant']['covers'] === 'string' && typeof value['grant']['processKey'] === 'string' ? { covers: value['grant']['covers'], processKey: value['grant']['processKey'], live: false } : null;
  return {
    kind: 'approval',
    request: readRequest(value['request']),
    outcome: oneOf(APPROVAL_OUTCOMES, value['outcome']) ?? 'dropped',
    decidedAt: whole(value['decidedAt']),
    settledAt: whole(value['settledAt']),
    delivered: typeof value['delivered'] === 'boolean' ? value['delivered'] : null,
    confirmedAt: whole(value['confirmedAt']),
    withdrawnBy: oneOf(WITHDRAWN_BY, value['withdrawnBy']),
    grant,
  };
}

// ── fat-g's words for an approval (C13, C14, C56, C57, C92) ───────────────────────────────────

export const APPROVAL_WORDS = {
  approved: 'Approved once',
  approvedSession: 'Approved for this session',
  denied: 'Denied',
  /** A decision whose reply the process refused (C12, C92). */
  notTaken: { approved: 'Approved; the process did not take it', 'approved-session': 'Approved for this session; the process did not take it', denied: 'Denied; the process did not take it' } satisfies Record<ApprovalDecision, string>,
  /** A decision written and never confirmed, once what carries it is over (M21, C68). */
  unconfirmed: { approved: 'Approved; the CLI did not confirm it', 'approved-session': 'Approved for this session; the CLI did not confirm it', denied: 'Denied; the CLI did not confirm it' } satisfies Record<ApprovalDecision, string>,
  /** What a session grant covers, after its outcome's words. */
  covers: (covers: string): string => `covers ${covers}`,
  grantEnded: 'ended with the process',
  /** The detail a restored card shows is the store's (C48). */
  cut: 'The whole action is no longer held: what fat-g saved of it is shown, shortened.',
  outside: 'outside the project’s folders',
  reason: 'The model says:',
  authority: 'The CLI would also grant:',
  detail: 'The whole action',
  approve: 'Approve once',
  deny: 'Deny',
  stop: 'Stop',
  /** The grant's choice, by what it covers (C56). */
  approveSession: (covers: string): string => `Approve for this session: ${covers}`,
  wouldStop: (label: string): string => `${label} would stop this question`,
  everyMatch: 'every matching passage',
  firstMatch: 'the first match',
  /** The session's own line while one of its turn's approvals waits (C78). */
  waiting: 'Waiting for your approval',
} as const;

/** What an authority is called (C8): `label` is fat-g's name for the mode it names, where it names one the provider lists. */
export function authorityWords(authority: ApprovalAuthority, label: string | null): string {
  switch (authority.kind) {
    case 'mode':
      return label === null ? 'a change of mode' : `a mode: ${label}`;
    case 'folder':
      return 'a folder';
    case 'saved-rule':
      return 'a rule saved beyond this session';
    case 'network':
      return 'network access';
    case 'other':
      return 'more than this action';
  }
}

/** "Claude asks to run a command" (C14): `who` is the provider's name, or a worker's word in its tab. */
export function askWords(kind: ApprovalKind, who: string): string {
  return `${who} asks to ${kind === 'command' ? 'run a command' : kind === 'file-change' ? 'change a file' : 'use a tool'}`;
}

/**
 * What a settled card says became of it, or null for one that still waits. `unconfirmed`: a
 * decision without the CLI's word, once what carries it is no longer running — the caller's to
 * say, as a question's is. A decision the process refused says so whatever runs (C92).
 */
export function approvalWords(body: Pick<ApprovalBody, 'outcome' | 'withdrawnBy' | 'delivered'>, unconfirmed: boolean): string | null {
  switch (body.outcome) {
    case 'pending':
      return null;
    case 'approved':
    case 'approved-session':
    case 'denied':
      if (body.delivered === false) return APPROVAL_WORDS.notTaken[body.outcome];
      if (unconfirmed) return APPROVAL_WORDS.unconfirmed[body.outcome];
      return body.outcome === 'approved' ? APPROVAL_WORDS.approved : body.outcome === 'denied' ? APPROVAL_WORDS.denied : APPROVAL_WORDS.approvedSession;
    case 'withdrawn':
      return withdrawnWords(body.withdrawnBy);
    case 'dropped':
      return OUTCOME_WORDS.dropped;
  }
}
