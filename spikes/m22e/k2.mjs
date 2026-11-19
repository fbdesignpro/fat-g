// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M22e spike K2 (docs/planning/_archive/M22e-spec-sheet.md; C3, C4, C29, C31, C32): a review's later rounds, in
// one reviewer session per provider on K1's scratch project, under version 2 of C3's instruction
// draft, which asks for an anchor wherever an issue concerns one place. Four prompts, as the panels
// would send them: the review; Send notes with one note that settles a point (it asks the finding be
// moved down a tier); Send notes with one note that only asks; Show updated review. Marks as a user
// would leave them: the first finding accepted, the last refused, the rest undecided.
//
//   node spikes/m22e/k2.mjs --list
//   node spikes/m22e/k2.mjs --scenario claude|codex --confirm-turns 4 [--again] [--model <id>] [--effort <level>]
//
// Recorded for each answer: whether it is prose or closes with one block that checks (C5), and for
// each round against the one before it, which ids it kept, which findings it moved naming `was`,
// which are new, which it left out, which it revised, and what became of the accepted, the refused
// and the settled finding; how many findings are anchored; sizes and times. Ids only — never a text
// of the model's. The launches, folders, deadlines and refusals are K1's (k1.mjs).
import { checkSessionStart } from '../m10/codex/driver.mjs';
import { typeKey } from '../m10/claude/frames.mjs';
import { deadlines } from '../m10/lib/deadlines.mjs';
import { isMain } from '../m10/lib/paths.mjs';
import { log, runSpike, warn } from '../m10/lib/spike.mjs';
import * as codex from '../m15/lib/common.mjs';
import { didNotHappen, happened, notRun, outline, runScenario as runClaudeScenario } from '../m16/lib/common.mjs';
import { typeCounts } from '../m22b/lib/common.mjs';
import { FILES } from '../../tests/fixtures/project-files.mjs';
import { CLAUDE_OPTIONS, CODEX_OPTIONS, DEFAULT_EFFORT, READING, READ_ONLY, claudeTurn, codexFolders, codexModel, codexOutline, codexTurn, errorOf } from './k1.mjs';
import { PLAN_V1, compareRounds, findingsOf, newPlanId, reviewPrompt, sendNotesPrompt, showUpdatedPrompt } from './lib/common.mjs';

/** Four turns, each up to a minute or so: the scenario wait and the invocation's budget around it. */
const SCENARIO_MS = 660_000;
const BUDGET_MS = 780_000;
/** The instruction's version K2 runs on (C3). */
const INSTRUCTION = 2;

/** The user's notes: the spike's own words. */
export const NOTES = Object.freeze({
  settle: (tier) => (tier < 5
    ? 'Agreed in substance, but it is less severe than rated: move it down one tier, and say in its correction that it can wait for a later change.'
    : 'Agreed in substance, but it is more severe than rated: move it up one tier.'),
  ask: 'Why did you rate this one at its tier rather than one tier lower?',
});

const tierOf = (id) => Number(/^T([1-5])\./.exec(id)?.[1] ?? 0);
const roundFacts = (findings) => ({ count: findings.length, ids: findings.map((f) => f.id), anchored: findings.filter((f) => f.anchor !== undefined).length, wasNamed: findings.filter((f) => f.was !== undefined).map((f) => ({ id: f.id, was: f.was })) });

/**
 * One step's answer against the live round: where it holds a round, the round compared with the one
 * before, the marks carried, and the three findings the spike follows found again by id or `was`.
 */
function advance(state, turn, step) {
  if (turn.refused) { step.refused = true; return state; }
  step.answerIs = turn.facts.answer.verdict === 'findings' ? 'a round' : turn.facts.answer.jsonBlocks > 0 ? `a block that does not check (${turn.facts.answer.verdict})` : 'prose';
  const next = findingsOf(turn.text, { version: INSTRUCTION });
  if (!next) return state;
  const compared = compareRounds(state.findings, next, state.marks);
  const where = (id) => {
    if (compared.kept.includes(id)) return { now: id, how: 'kept' };
    const moved = compared.moved.find((m) => m.from === id);
    return moved ? { now: moved.to, how: 'moved' } : { now: null, how: 'left out' };
  };
  const followed = Object.fromEntries(Object.entries(state.key).map(([name, id]) => [name, { was: id, ...where(id) }]));
  step.round = { ...roundFacts(next), kept: compared.kept, moved: compared.moved, added: compared.added, leftOut: compared.leftOut, revised: compared.revised, followed, marksCarried: compared.carried };
  const key = Object.fromEntries(Object.entries(followed).map(([name, f]) => [name, f.now ?? state.key[name]]));
  const marks = Object.fromEntries(Object.entries(compared.carried).filter(([, mark]) => mark !== 'open'));
  return { findings: next, marks, key, rounds: state.rounds + 1 };
}

/** The four prompts through one session: `send(prompt)` answers `{ refused?, text, facts }`. */
async function rounds(send, folder) {
  const steps = {};
  const first = await send(reviewPrompt({ planId: newPlanId(), version: 1, text: PLAN_V1, folder, instruction: INSTRUCTION }));
  steps.review = { ...first.facts };
  const findings = first.refused ? null : findingsOf(first.text, { version: INSTRUCTION });
  if (!findings || findings.length < 2) return { steps, stopped: findings ? 'the review held fewer than two findings' : 'the review held no findings' };
  steps.review.round = roundFacts(findings);
  let state = {
    findings, rounds: 1,
    marks: { [findings[0].id]: 'accepted', [findings.at(-1).id]: 'rejected' },
    key: { accepted: findings[0].id, refused: findings.at(-1).id, settled: findings[1].id },
  };

  // Send notes, one note that settles a point (C31).
  const settleNote = NOTES.settle(tierOf(state.key.settled));
  const settle = await send(sendNotesPrompt({ findings: state.findings, marks: state.marks, notes: { [state.key.settled]: settleNote }, instruction: INSTRUCTION }));
  steps.settle = { noteOn: state.key.settled, marksSent: { ...state.marks }, ...settle.facts };
  state = advance(state, settle, steps.settle);

  // Send notes, one note that only asks (C31): on an undecided finding other than the settled one, else the accepted one.
  const askOn = state.findings.find((f) => !state.marks[f.id] && f.id !== state.key.settled)?.id ?? state.key.accepted;
  const ask = await send(sendNotesPrompt({ findings: state.findings, marks: state.marks, notes: { [askOn]: NOTES.ask }, instruction: INSTRUCTION }));
  steps.ask = { noteOn: askOn, marksSent: { ...state.marks }, ...ask.facts };
  state = advance(state, ask, steps.ask);

  // Show updated review (C32): every mark, no note left unsent.
  const update = await send(showUpdatedPrompt({ findings: state.findings, marks: state.marks, instruction: INSTRUCTION }));
  steps.update = { marksSent: { ...state.marks }, ...update.facts };
  state = advance(state, update, steps.update);
  return { steps, rounds: state.rounds, finalMarks: state.marks };
}

let WANTED = { model: null, effort: DEFAULT_EFFORT };

const SCENARIOS = {
  claude: {
    id: 'm22e-rounds', name: 'm22e-claude-rounds', turns: 4, atMost: true, files: FILES,
    title: "K2: a review, Send notes that settles a point, Send notes that asks, Show updated review, under the reading mode (C29, C31, C32)",
    successCondition: 'The four turns end; each answer read as prose or a round, and each round compared with the one before by id and was',
    async run(ctx) {
      const model = WANTED.model ?? ctx.model;
      if (!model) return notRun("no model chosen: run M16's --scenario discover first, or name one with --model");
      const driver = await ctx.open({ launch: { extra: ['--include-partial-messages'], tools: READING, permissionMode: 'default', model, effort: WANTED.effort }, background: false });
      const notes = { model, effort: WANTED.effort, instruction: INSTRUCTION, ...(await rounds((prompt) => claudeTurn(ctx, driver, prompt, { version: INSTRUCTION }), ctx.project)) };
      notes.typeCounts = typeCounts(driver, typeKey);
      notes.outline = outline(driver, 0).filter((row) => row.recv !== 'stream_event');
      if (notes.stopped) return didNotHappen(notes.stopped, notes);
      return happened(notes, notes.steps.update.endIndex);
    },
  },

  codex: {
    id: 'm22e-rounds', name: 'm22e-codex-rounds', turns: 4, files: FILES,
    title: 'K2: a review, Send notes that settles a point, Send notes that asks, Show updated review, in a read-only thread (C29, C31, C32)',
    successCondition: 'The four turns end; each answer read as prose or a round, and each round compared with the one before by id and was',
    async run(ctx) {
      const driver = await ctx.open();
      const model = await codexModel(driver, WANTED.model, WANTED.effort);
      if (!model.model) return codex.notRun(WANTED.model ? `the scratch account does not list ${WANTED.model}` : 'the CLI listed no model');
      const params = { cwd: ctx.scratch, ...READ_ONLY, model: model.model };
      const thread = await driver.startThread(params);
      driver.sessionStart = { request: params, replyIndex: thread.index, ok: thread.ok, check: thread.ok ? checkSessionStart(READ_ONLY, thread.value) : null };
      const notes = { model, instruction: INSTRUCTION, thread: { ok: thread.ok, error: errorOf(thread, codexFolders(ctx)), matchesWhatWasAsked: thread.ok ? driver.sessionStart.check.passed : null } };
      if (!thread.ok) return codex.didNotHappen('thread/start was refused', notes);
      const send = async (prompt) => { const turn = await codexTurn(ctx, driver, model, prompt, { version: INSTRUCTION }); return turn.refused ? { refused: true, facts: turn } : turn; };
      Object.assign(notes, await rounds(send, ctx.scratch));
      notes.typeCounts = typeCounts(driver, (frame) => frame?.method ?? 'response');
      notes.outline = codexOutline(driver, 0);
      if (notes.stopped) return codex.didNotHappen(notes.stopped, notes);
      return codex.happened(notes, notes.steps.update?.endIndex ?? null);
    },
  },
};

if (isMain(import.meta.url)) {
  await runSpike('m22e-k2', (frame) => {
    if (frame.args.list) {
      for (const [key, scenario] of Object.entries(SCENARIOS)) log(`${key.padEnd(7)} ${scenario.turns} prompt(s)  ${scenario.title}`);
      log('total: 8 prompts for one run of each, of the eight K2 may spend, with a reserve of four for retries shared with K1 (C19)');
      return 0;
    }
    const key = String(frame.args.scenario ?? '');
    const chosen = SCENARIOS[key];
    if (!chosen) { warn('usage: node spikes/m22e/k2.mjs --list | --scenario claude|codex --confirm-turns 4 [--again] [--model <id>] [--effort <level>] [--path <executable>]'); return 1; }
    WANTED = { model: typeof frame.args.model === 'string' ? frame.args.model : null, effort: typeof frame.args.effort === 'string' ? frame.args.effort : DEFAULT_EFFORT };
    const waits = deadlines({ scenario: SCENARIO_MS });
    log(`K2 on ${key}: ${WANTED.model ? `the model ${WANTED.model}` : 'the saved or default model'} at ${WANTED.effort} effort; instruction version ${INSTRUCTION}; the scenario wait ${SCENARIO_MS / 1000} s`);
    return key === 'claude' ? runClaudeScenario('m22e-k2', chosen, { ...frame, waits }, CLAUDE_OPTIONS) : codex.runScenario('m22e-k2', chosen, { ...frame, waits }, CODEX_OPTIONS);
  }, { budgetMs: BUDGET_MS });
}
