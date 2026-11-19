// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V2, V35 (docs/planning/_archive/M21.md; C4–C9, C30, C39, C60, C78): a question's contract — its body with
// each mode and each outcome, the bounds that cut and the one that refuses, what can be shown, what
// an answer must fit, how it is kept, the words an async answer is sent in, and the outcome's words.
import { describe, expect, it } from 'vitest';
import {
  AnswerEntriesSchema,
  AnswerEntrySchema,
  answerPrompt,
  asksAsync,
  asksBlocking,
  boundQuestions,
  canShow,
  fits,
  fromMessageQuestions,
  type GivenAnswer,
  INTERACTION_MODES,
  INTERACTION_OUTCOMES,
  type InteractionBody,
  type QuestionBody,
  type InteractionQuestion,
  InteractionQuestionSchema,
  InteractionQuestionsSchema,
  interactionUnits,
  isAnswered,
  isSettled,
  keptAnswers,
  MAX_ANSWER_TEXT,
  MAX_OPTION_DESCRIPTION,
  MAX_OPTIONS,
  MAX_QUESTION_TEXT,
  MAX_QUESTIONS,
  NO_ANSWER,
  noneAnswered,
  OUTCOME_WORDS,
  outcomeWords,
  placeAnswers,
  QUESTION_CAPABILITIES,
  raisedBody,
  type RawQuestion,
  readInteraction,
  sentAnswers,
  takesText,
} from './interaction';

const long = (length: number): string => 'x'.repeat(length);
const option = (label: string, description: string | null = null) => ({ label, description });
const question = (patch: Partial<InteractionQuestion> = {}): InteractionQuestion => ({ text: 'Which file?', header: 'File', options: [option('notes-1.txt', 'The first note'), option('notes-2.txt')], multiple: false, freeText: true, secret: false, ...patch });
const given = (options: number[], text: string | null = null): GivenAnswer => ({ options, text });

describe('the bounds (V2; C7, C8)', () => {
  it('are the sheet’s: 16 questions, 8 options, 500 units for a text, a header and a label, 2,000 for a description, 10,000 for an answer', () => {
    expect([MAX_QUESTIONS, MAX_OPTIONS, MAX_QUESTION_TEXT, MAX_OPTION_DESCRIPTION, MAX_ANSWER_TEXT]).toEqual([16, 8, 500, 2_000, 10_000]);
  });

  it('leave a question within them as it is, with no flag', () => {
    const whole = [question({ text: long(MAX_QUESTION_TEXT), header: long(MAX_QUESTION_TEXT), options: Array.from({ length: MAX_OPTIONS }, () => option(long(MAX_QUESTION_TEXT), long(MAX_OPTION_DESCRIPTION))) })];
    expect(boundQuestions(whole)).toEqual({ questions: whole, cut: false });
  });

  it.each<[string, RawQuestion[], (bound: InteractionQuestion[]) => unknown, unknown]>([
    ['the 17th question', Array.from({ length: 17 }, () => question()), (bound) => bound.length, 16],
    ['the ninth option', [question({ options: Array.from({ length: 9 }, (_, index) => option(`o${index}`)) })], (bound) => bound[0]?.options.length, 8],
    ['a 501-unit text', [question({ text: long(501) })], (bound) => bound[0]?.text.length, 500],
    ['a 501-unit header', [question({ header: long(501) })], (bound) => bound[0]?.header?.length, 500],
    ['a 501-unit label', [question({ options: [option(long(501))] })], (bound) => bound[0]?.options[0]?.label.length, 500],
    ['a 2,001-unit description', [question({ options: [option('a', long(2_001))] })], (bound) => bound[0]?.options[0]?.description?.length, 2_000],
  ])('cut %s, with the flag set', (_name, raw, read, expected) => {
    const bound = boundQuestions(raw);
    expect(bound.cut).toBe(true);
    expect(read(bound.questions)).toBe(expected);
    expect(InteractionQuestionsSchema.safeParse(bound.questions).success).toBe(true);
  });

  it('never cut between the two halves of a pair, and read an empty header or description as none', () => {
    const bound = boundQuestions([question({ text: `${long(499)}😀`, header: '  ', options: [option('a', '')] })]);
    expect(bound.questions[0]).toMatchObject({ text: long(499), header: null, options: [{ label: 'a', description: null }] });
  });

  it('refuse an answer past its bound, and never cut it', () => {
    expect(AnswerEntrySchema.safeParse({ question: 0, options: [], text: long(MAX_ANSWER_TEXT) }).success).toBe(true);
    expect(AnswerEntrySchema.safeParse({ question: 0, options: [], text: long(MAX_ANSWER_TEXT + 1) }).success).toBe(false);
    expect(fits([question()], [given([], long(MAX_ANSWER_TEXT + 1))])).toBe(false);
  });
});

describe('the schemas (V2; C7, C31)', () => {
  it('take a question in its bounds, and refuse a field of another shape or one too many', () => {
    expect(InteractionQuestionSchema.safeParse(question()).success).toBe(true);
    expect(InteractionQuestionSchema.safeParse({ ...question(), key: 'k' }).success).toBe(false);
    expect(InteractionQuestionSchema.safeParse({ ...question(), text: long(501) }).success).toBe(false);
    expect(InteractionQuestionsSchema.safeParse([]).success).toBe(false);
    expect(InteractionQuestionsSchema.safeParse(Array.from({ length: 17 }, () => question())).success).toBe(false);
  });

  it('take an answer by places alone: its question’s, and each chosen option’s', () => {
    expect(AnswerEntriesSchema.safeParse([{ question: 0, options: [1], text: null }, { question: 1, options: [], text: 'typed' }]).success).toBe(true);
    for (const entry of [{ question: -1, options: [], text: null }, { question: 16, options: [], text: null }, { question: 0, options: [8], text: null }, { question: 0, options: ['notes-1.txt'], text: null }, { question: 0, options: [], text: null, label: 'x' }, { question: 0, options: [] }]) {
      expect(AnswerEntrySchema.safeParse(entry).success, JSON.stringify(entry)).toBe(false);
    }
    expect(AnswerEntriesSchema.safeParse([]).success).toBe(false);
  });
});

describe('what can be shown (V2, V35; C60, C78)', () => {
  const options = (count: number) => Array.from({ length: count }, (_, index) => option(`o${index}`));
  it.each<[string, Pick<RawQuestion, 'options' | 'freeText' | 'secret'>[], boolean]>([
    ['one question with options', [question()], true],
    ['sixteen questions', Array.from({ length: 16 }, () => question()), true],
    ['seventeen questions', Array.from({ length: 17 }, () => question()), false],
    ['no question at all', [], false],
    ['nine options with free text: cut, and answered in words', [{ options: options(9), freeText: true, secret: false }], true],
    ['nine options and no free text: the ninth could not be chosen', [{ options: options(9), freeText: false, secret: false }], false],
    ['eight options and no free text', [{ options: options(8), freeText: false, secret: false }], true],
    ['no option and free text: the field alone', [{ options: [], freeText: true, secret: false }], true],
    ['no option and no free text: nothing could answer it', [{ options: [], freeText: false, secret: false }], false],
    ['a secret with no option and no free text: its masked field answers it', [{ options: [], freeText: false, secret: true }], true],
    ['one question in several that cannot be', [question(), { options: [], freeText: false, secret: false }], false],
  ])('%s', (_name, raw, expected) => {
    expect(canShow(raw)).toBe(expected);
  });

  it('takes a text where the provider says so, and always for a secret', () => {
    expect([takesText({ freeText: true, secret: false }), takesText({ freeText: false, secret: true }), takesText({ freeText: false, secret: false })]).toEqual([true, true, false]);
  });
});

describe('an answer and its questions (V2, V35; C8, C45, C78)', () => {
  const single = question({ freeText: false });
  const several = question({ multiple: true, freeText: false });
  const secret = question({ secret: true, freeText: false });

  it.each<[string, InteractionQuestion[], (GivenAnswer | null)[], boolean]>([
    ['an option by its place', [single], [given([1])], true],
    ['a question left unanswered', [single, single], [given([0]), null], true],
    ['a text where one is taken', [question()], [given([], 'another file')], true],
    ['an option and a text beside it', [question()], [given([0], 'and this')], true],
    ['several options where several may be chosen', [several], [given([0, 1])], true],
    ['a text for a secret', [secret], [given([], 'hunter2')], true],
    ['a text where none is taken', [single], [given([0], 'and this')], false],
    ['several options where one may be chosen', [single], [given([0, 1])], false],
    ['a place past the options', [single], [given([2])], false],
    ['a negative place', [single], [given([-1])], false],
    ['the same option twice', [several], [given([1, 1])], false],
    ['an option for a secret, whose options are not drawn', [secret], [given([0])], false],
    ['fewer answers than questions', [single, single], [given([0])], false],
    ['more answers than questions', [single], [given([0]), given([1])], false],
  ])('%s', (_name, questions, answers, expected) => {
    expect(fits(questions, answers)).toBe(expected);
  });

  it('places the card’s entries one for each question, and none for an entry that says nothing', () => {
    expect(placeAnswers(2, [{ question: 1, options: [], text: 'typed' }, { question: 0, options: [1], text: null }])).toEqual([given([1]), given([], 'typed')]);
    expect(placeAnswers(2, [{ question: 0, options: [], text: '   ' }, { question: 1, options: [0], text: '' }])).toEqual([null, given([0])]);
  });

  it.each<[string, number, { question: number; options: number[]; text: string | null }[]]>([
    ['an answer short of a question', 2, [{ question: 0, options: [0], text: null }]],
    ['one answer too many', 1, [{ question: 0, options: [0], text: null }, { question: 1, options: [0], text: null }]],
    ['a question named twice', 2, [{ question: 0, options: [0], text: null }, { question: 0, options: [1], text: null }]],
    ['a place past the questions', 2, [{ question: 0, options: [0], text: null }, { question: 2, options: [1], text: null }]],
  ])('places nothing for %s', (_name, count, entries) => {
    expect(placeAnswers(count, entries)).toBeNull();
  });

  it('tells a card with nothing answered from one with something, and sends a blank question as "No answer" (M100b, C30)', () => {
    expect(noneAnswered([given([0]), null])).toBe(false);
    expect(noneAnswered([null, given([], '  '), given([])])).toBe(true);
    expect(sentAnswers([given([1]), null, given([], ' ')])).toEqual([given([1]), { options: [], text: NO_ANSWER }, { options: [], text: NO_ANSWER }]);
    expect(NO_ANSWER).toBe('No answer');
    expect([isAnswered(null), isAnswered(given([])), isAnswered(given([], ' ')), isAnswered(given([0])), isAnswered(given([], 'x'))]).toEqual([false, false, false, true, true]);
  });

  it('keeps an answer by its places and its text, and a secret’s as the fact alone (C8, C44)', () => {
    expect(keptAnswers([single, question(), secret, single], [given([1]), given([0], 'typed'), given([], 'hunter2'), null])).toEqual([
      { options: [1], text: null, secret: false },
      { options: [0], text: 'typed', secret: false },
      { options: [], text: null, secret: true },
      null,
    ]);
    expect(JSON.stringify(keptAnswers([secret], [given([], 'hunter2')]))).not.toContain('hunter2');
  });
});

describe('an async answer, as its prompt (V2; C26)', () => {
  const which = question({ text: 'Which file do you want me to read?', header: null, options: [option('notes-1.txt'), option('notes-2.txt')] });
  it('is the question’s text on a line and its answer on the next, as K2 sent it', () => {
    expect(answerPrompt([which], [given([1])])).toBe('Which file do you want me to read?\nnotes-2.txt');
  });

  it('gives the typed text, or the option and then the text on a line of its own, and separates questions by a blank line', () => {
    const other = question({ text: 'In which form?', options: [option('A summary'), option('The whole text')] });
    expect(answerPrompt([which, other], [given([], 'notes-3.txt'), given([0], 'in two lines')])).toBe('Which file do you want me to read?\nnotes-3.txt\n\nIn which form?\nA summary\nin two lines');
  });

  it('says "No answer" under a question that was not answered (M100b, C30)', () => {
    expect(answerPrompt([which, which], [null, given([0])])).toBe('Which file do you want me to read?\nNo answer\n\nWhich file do you want me to read?\nnotes-1.txt');
  });
});

describe('a message’s questions as a card’s (V2; C7, C28)', () => {
  it('are one choice with free text, no header and no description', () => {
    expect(fromMessageQuestions([{ title: 'Which file?', options: ['a', 'b'] }])).toEqual({
      questions: [{ text: 'Which file?', header: null, options: [option('a'), option('b')], multiple: false, freeText: true, secret: false }],
      cut: false,
    });
  });

  it('say they were cut only where the message does and a question stands at a bound', () => {
    expect(fromMessageQuestions([{ title: 'Short', options: ['a'] }], true).cut).toBe(false);
    expect(fromMessageQuestions([{ title: long(MAX_QUESTION_TEXT), options: ['a'] }], true).cut).toBe(true);
    expect(fromMessageQuestions([{ title: long(MAX_QUESTION_TEXT), options: ['a'] }], false).cut).toBe(false);
  });
});

describe('the body (V2; C4, C9)', () => {
  it('is pending at a blocking question’s raising and open at an async one’s, with nothing answered', () => {
    expect(raisedBody('blocking', [question()], false)).toEqual({ kind: 'question', mode: 'blocking', questions: [question()], answers: null, outcome: 'pending', settledAt: null, confirmedAt: null, answeredBy: null, withdrawnBy: null, cut: false });
    expect(raisedBody('async', [question()], true)).toMatchObject({ mode: 'async', outcome: 'open', cut: true });
  });

  it('reads back whole, with each mode and each outcome of the closed list', () => {
    expect(INTERACTION_MODES).toEqual(['blocking', 'async']);
    expect(INTERACTION_OUTCOMES).toEqual(['pending', 'open', 'answered', 'dismissed', 'passed', 'withdrawn', 'dropped']);
    for (const mode of INTERACTION_MODES) {
      for (const outcome of INTERACTION_OUTCOMES) {
        const body: InteractionBody = { ...raisedBody(mode, [question()], false), outcome, answers: [{ options: [0], text: 'x', secret: false }], settledAt: 5, confirmedAt: 6, answeredBy: 't2', withdrawnBy: 'request' };
        expect(readInteraction(JSON.parse(JSON.stringify(body)))).toEqual(body);
      }
    }
  });

  it('reads an outcome outside the list as dropped, which offers no control, and what is no body at all as none', () => {
    expect(readInteraction({ mode: 'async', questions: [], outcome: 'expired' })).toMatchObject({ outcome: 'dropped', mode: 'async' });
    expect(readInteraction({ mode: 'later', outcome: 'pending' })).toMatchObject({ mode: 'blocking' });
    expect(readInteraction({ questions: [{ text: 'q', options: [{ label: 'a' }, { nothing: true }, 'x'] }, { options: [] }, 7], answers: [null, { options: [1, 'two', -1], text: 5 }] })).toMatchObject({
      questions: [{ text: 'q', header: null, options: [{ label: 'a', description: null }], multiple: false, freeText: false, secret: false }],
      answers: [null, { options: [1], text: null, secret: false }],
    });
    for (const value of [null, undefined, 'interaction', 7, []]) expect(readInteraction(value)).toBeNull();
  });

  it('is settled by every outcome but the two it waits in', () => {
    expect(INTERACTION_OUTCOMES.filter((outcome) => !isSettled(outcome))).toEqual(['pending', 'open']);
  });

  it('counts its questions’ texts, headers, labels and descriptions and its answers’ texts (C36)', () => {
    const body = { questions: [question({ text: 'abcd', header: 'ef', options: [option('gh', 'ijk'), option('l')] })], answers: [{ options: [0], text: 'mnopq', secret: false }, null] };
    expect(interactionUnits(body)).toBe(4 + 2 + 2 + 3 + 1 + 5);
    expect(interactionUnits({ questions: [], answers: null })).toBe(0);
  });
});

describe('the capability (V2; C30)', () => {
  it('has four forms: none, blocking, async or both', () => {
    expect(QUESTION_CAPABILITIES).toEqual(['none', 'blocking', 'async', 'both']);
    expect(QUESTION_CAPABILITIES.map((capability) => [asksBlocking(capability), asksAsync(capability)])).toEqual([[false, false], [true, false], [false, true], [true, true]]);
  });
});

describe('an outcome’s words (V2; C39)', () => {
  it('are fat-g’s, one line for each way a card settles', () => {
    expect(OUTCOME_WORDS).toEqual({
      answered: 'Answered',
      unconfirmed: 'Answered; the model did not confirm it',
      withdrawnByRequest: 'Withdrawn: the model went on without an answer',
      withdrawnByTurn: 'Withdrawn: the reply ended',
      withdrawnByChange: 'Withdrawn: the request changed under its id and was refused',
      dropped: 'Not answered: the session’s process ended',
      dismissed: 'Declined; the model was not told',
      declined: 'Declined: the model was told',
      passed: 'Passed over: the conversation went on without an answer',
    });
  });

  it('say nothing of a card that still waits, and tell a withdrawal’s two causes apart', () => {
    const words = (outcome: QuestionBody['outcome'], withdrawnBy: QuestionBody['withdrawnBy'] = null, unconfirmed = false): string | null => outcomeWords({ outcome, withdrawnBy }, unconfirmed);
    expect([words('pending'), words('open')]).toEqual([null, null]);
    expect(words('answered')).toBe('Answered');
    expect(words('answered', null, true)).toBe('Answered; the model did not confirm it');
    expect(words('withdrawn', 'request')).toBe('Withdrawn: the model went on without an answer');
    expect(words('withdrawn', 'turn')).toBe('Withdrawn: the reply ended');
    // A withdrawal with no cause stored reads as its turn's: it claims nothing of the model.
    expect(words('withdrawn')).toBe('Withdrawn: the reply ended');
    expect(words('dropped')).toBe('Not answered: the session’s process ended');
    // A declined card (M100b, C42): an async one told nothing, a blocking one declined to the CLI.
    expect(words('dismissed')).toBe('Declined; the model was not told');
    expect(outcomeWords({ outcome: 'dismissed', withdrawnBy: null, mode: 'async' }, false)).toBe('Declined; the model was not told');
    expect(outcomeWords({ outcome: 'dismissed', withdrawnBy: null, mode: 'blocking' }, false)).toBe('Declined: the model was told');
    expect(words('passed')).toBe('Passed over: the conversation went on without an answer');
    // Only an answered card can be unconfirmed.
    expect(words('dropped', null, true)).toBe('Not answered: the session’s process ended');
  });
});
