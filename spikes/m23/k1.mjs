// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M23 spike K1 (docs/planning/_archive/M23-spec-sheet.md; C24, C25, C36, C39, C45, C63, C64): Codex under
// production's handshake as M19 leaves it, the message delta kept, in M22's scratch Codex
// configuration folder (`CODEX_HOME`, C70): the maintainer's own Codex configuration is neither
// read nor changed. Every thread is read-only with approvals `never`, as the app's Read only is.
//
//   node spikes/m23/k1.mjs --list
//   node spikes/m23/k1.mjs --scenario <name> --confirm-turns <n> [--again] [--model <id>]
//
// Without --confirm-turns equal to the scenario's count it prints its plan and launches nothing
// (C70). One invocation is one run; at most three runs per scenario (M10's ledger, under
// spikes/output/m23). `image` sends a prompt with one `localImage`, then one with two, and reads
// the thread's history after them (C24, C25); `big-image` sends one at the sheet's 5 MiB bound (C2).
// `steer` starts a long turn, steers it by `turn/steer` naming the running turn, and names that turn
// again once it has ended (C36, C39). `async` invites a question asked in a message while the turn
// goes on, and answers it by `turn/steer` in fat-g's words (C45). `commands` sends `/compact` and
// `/review` as a turn's text (C63). `skills` lists the working folder's skills and sends a turn whose
// input holds a `skill` item (C64).
//
// The images are the harness's own, drawn from a formula (lib/common.mjs), and stand in a folder
// beside the scratch configuration — outside the temp folder and the working folder, as fat-g's data
// folder is — for the run alone. Every request from the CLI is declined; a question asked in a
// message is answered by a steer, or by the next prompt.
//
// What a run records is never a text of the model's: each reply's shape, each item's type and
// size, where an image's path lies, whether an answer holds the marker word the spike dictated, and
// each refusal's code with the CLI's own words around the scratch folders' names.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { checkSessionStart } from '../m10/codex/driver.mjs';
import { EXIT, settlesWithin, sleep } from '../m10/lib/deadlines.mjs';
import { cleanEnvironment } from '../m10/lib/env.mjs';
import { isMain } from '../m10/lib/paths.mjs';
import { log, runSpike, warn } from '../m10/lib/spike.mjs';
import { codexLoggedIn, parseVersion } from '../m10/preflight.mjs';
import { instanceEnvironment } from '../m14b/lib/instance-env.mjs';
import * as codex from '../m15/lib/common.mjs';
import { CODEX_TEXT_DELTA, M19CodexDriver, OMITTED_CODEX, received } from '../m19/lib/common.mjs';
import { WORDS, asyncAnswerPrompt, optionMatching } from '../m21/lib/common.mjs';
import { CODEX_HOME } from '../m22/k1.mjs';
import { tidy, typeCounts, whereIs } from '../m22b/lib/common.mjs';
import { FILES } from '../../tests/fixtures/project-files.mjs';
import { COLOUR_WORDS, M23_DIR, MARKERS, PROMPTS, SKILL_MD, SKILL_NAME, holds, imageFacts, images, readState, writeState } from './lib/common.mjs';

const READ_ONLY = Object.freeze({ sandbox: 'read-only', approvalPolicy: 'never' });
/** Where the images stand (C24): a folder beside the scratch configuration, outside the temp folder and the working folder, as fat-g's data folder is. */
const IMAGES_DIR = path.join(path.dirname(CODEX_HOME), 'm23-images');
const IMAGE = Object.freeze({ redBlue: 'two-colours-red-blue.png', greenYellow: 'two-colours-green-yellow.png', noise: 'noise-at-the-bound.png' });

/** M19's driver: production's handshake less the opt-out of the message delta; every request declined by the runner's handler. */
class K1Driver extends M19CodexDriver {}

/** A one-shot command in the scratch configuration, through the launcher's confirmed teardown (M22's K1). */
async function once(launcher, executable, args, { cwd, waits, env }) {
  const tree = await launcher.launch({ executable, args, cwd, env });
  let stdout = '';
  if (tree.child) { tree.stdout.setEncoding('utf8'); tree.stdout.on('data', (chunk) => { if (stdout.length < 100_000) stdout += chunk; }); tree.stdin.end(); }
  await settlesWithin(tree.closed, waits.request);
  const code = tree.exitInfo?.code ?? null;
  await tree.teardown();
  return { code, stdout, stderr: tree.stderrTail ?? '' };
}

function environment() {
  const { env } = instanceEnvironment('codex', CODEX_HOME);
  return { env, removed: cleanEnvironment('codex').removed, set: ['CODEX_HOME'] };
}

/** The CLI's version, and that the scratch configuration folder is signed in. No login is ever started. */
async function ready(launcher, waits, executable, cwd) {
  const fail = (message) => Object.assign(new Error(message), { exitCode: EXIT.cliMissing });
  if (!existsSync(CODEX_HOME) || !existsSync(path.join(path.dirname(CODEX_HOME), '.fat-g-spike'))) throw fail(`the scratch Codex configuration folder, or the spikes' marker beside it, is not at ${CODEX_HOME} (spikes/README.md, M22).`);
  const { env } = environment();
  const version = parseVersion((await once(launcher, executable, ['--version'], { cwd, waits, env })).stdout);
  const status = await once(launcher, executable, ['login', 'status'], { cwd, waits, env });
  if (!version || !codexLoggedIn(status)) throw fail(`codex is ${version ? 'not logged in in the scratch configuration folder' : 'not answering --version'}. Sign in from your own terminal, with CODEX_HOME naming that folder (agents never log in).`);
  return { name: 'codex', version, kind: executable.kind };
}

/**
 * The runner's options. `ownAccount` (`--own-account`): the maintainer's own Codex configuration in
 * place of the scratch one — M10's clean environment with the default `CODEX_HOME`, and M15's
 * login check — at their word alone (C70), for the one case a model only their account lists
 * (C45, `gpt-6-astra`). The working folder is still the scratch one, and the thread read-only.
 */
const optionsFor = (ownAccount) => ({
  dir: M23_DIR, milestone: 'M23', Driver: K1Driver, omitted: OMITTED_CODEX, ...(ownAccount ? {} : { environment, ready }),
  toolPermissions: () => ({ readTools: 'reads inside the read-only sandbox', scenarioTools: [], preApproved: [], sandbox: READ_ONLY.sandbox, approvalPolicy: READ_ONLY.approvalPolicy, reviewer: null, policy: 'every request from the CLI is declined; a question asked in a message is answered by a steer in fat-g\'s words, or by the next prompt' }),
});

const foldersOf = (ctx) => ({ 'working folder': ctx.scratch, 'images folder': IMAGES_DIR, 'outside the folder': ctx.outside, 'configuration folder': CODEX_HOME, 'app-server folder': ctx.probe });
const errorOf = (reply, folders) => (reply.ok ? null : { code: reply.error?.code ?? null, message: tidy(String(reply.error?.message ?? ''), folders) });

/** Set from `--model` before a run: a model the scratch account lists, named in place of its default. */
let MODEL = null;

/** The model a run names: `--model` where the account lists it, else the saved one, else the account's default. */
async function modelOf(driver) {
  if (MODEL === null) return readState().codexModel ?? codex.pickModel(driver);
  const reply = await driver.request('model/list', { limit: 100 });
  const listed = (reply.ok && Array.isArray(reply.value?.data) ? reply.value.data : []).find((m) => m.model === MODEL);
  if (!listed) return { model: null, effort: null };
  const efforts = (listed.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort);
  return { model: MODEL, effort: efforts.includes('low') ? 'low' : efforts[0] ?? null };
}

/** The fixture images written into the images folder for the run: their files, and their measurements for the notes. */
function writeImages() {
  mkdirSync(IMAGES_DIR, { recursive: true });
  const out = {};
  for (const [name, bytes] of Object.entries(images())) {
    const file = path.join(IMAGES_DIR, name);
    writeFileSync(file, bytes);
    out[name] = { file, facts: imageFacts(name, bytes) };
  }
  return out;
}
const removeImages = () => rmSync(IMAGES_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
const factsOf = (written) => Object.fromEntries(Object.entries(written).map(([name, { facts }]) => [name, facts]));

/** A saved read-only thread in the working folder, as the app asks for one; the reply checked as the app checks it. */
async function openThread(ctx, driver, model) {
  const params = { cwd: ctx.scratch, ...READ_ONLY, model: model.model };
  const reply = await driver.startThread(params);
  driver.sessionStart = { request: params, replyIndex: reply.index, ok: reply.ok, check: reply.ok ? checkSessionStart(READ_ONLY, reply.value) : null };
  return { ok: reply.ok, error: errorOf(reply, foldersOf(ctx)), matchesWhatWasAsked: reply.ok ? driver.sessionStart.check.passed : null };
}

const textInput = (text) => ({ type: 'text', text, text_elements: [] });
const localImage = (file) => ({ type: 'localImage', path: file });

/** A turn as the app starts one (session.ts), with `input` as given; counted once Codex took it. */
async function startTurn(driver, ctx, input, model) {
  const from = driver.nextIndex;
  const params = { threadId: driver.threadId, input, model: model.model, ...(model.effort ? { effort: model.effort } : {}), clientUserMessageId: randomUUID() };
  const reply = await driver.requestWithin('turn/start', params, 15_000);
  if (reply.ok) { ctx.countTurn(); driver.turnId = reply.value?.turn?.id ?? null; driver.turnActive = true; }
  return { from, ok: reply.ok, turnId: driver.turnId, inputTypes: input.map((part) => part.type), error: errorOf(reply, foldersOf(ctx)) };
}

/** A message steered into the turn `turnId` (C36): refused when that is not the active turn. Counted as a prompt where it is taken. */
async function steer(driver, ctx, text, turnId) {
  const from = driver.nextIndex;
  const atMs = driver.tree.elapsed();
  const params = { threadId: driver.threadId, expectedTurnId: turnId, input: [textInput(text)], clientUserMessageId: randomUUID() };
  const reply = await driver.requestWithin('turn/steer', params, 15_000);
  if (reply.ok) ctx.countTurn();
  const replyAt = driver.session.frames.find((f) => f.index === reply.index)?.ms ?? atMs;
  return { from, atMs: Math.round(atMs), replyMs: Math.round(replyAt - atMs), ok: reply.ok, replyKeys: reply.ok ? Object.keys(reply.value ?? {}).sort() : null, namesTheRunningTurn: reply.ok ? reply.value?.turnId === turnId : null, error: errorOf(reply, foldersOf(ctx)) };
}

/** The completed items of the session's thread from `from` on. */
const completedItems = (driver, from) => received(driver, from).filter((f) => f.frame?.method === 'item/completed' && f.frame.params?.threadId === driver.threadId).map((f) => ({ index: f.index, ms: f.ms, item: f.frame.params.item ?? {} }));
const deltaUnitsOf = (driver, from, itemId) => received(driver, from).filter((f) => f.frame?.method === CODEX_TEXT_DELTA && f.frame.params?.itemId === itemId).reduce((n, f) => n + String(f.frame.params.delta ?? '').length, 0);
const partFacts = (part, folders) => ({ type: part?.type ?? null, ...(typeof part?.path === 'string' ? { path: whereIs(part.path, folders) } : {}), ...(typeof part?.text === 'string' ? { units: part.text.length } : {}), ...(typeof part?.url === 'string' ? { url: part.url.startsWith('data:') ? `a data URL of ${part.url.length} units` : 'a URL' } : {}) });
const test = (text, word) => (word instanceof RegExp ? word.test(text) : holds(text, word));

/** A turn's facts from `from` on: its items by kind, the user messages' parts, each agent message's shape and whether it holds a word, the end. Never a text. */
function turnFacts(driver, from, ctx, words = {}) {
  const folders = foldersOf(ctx);
  const items = completedItems(driver, from);
  const methods = {};
  for (const f of received(driver, from)) if (f.frame?.method && f.frame.method !== CODEX_TEXT_DELTA && f.frame.method !== 'thread/tokenUsage/updated') methods[f.frame.method] = (methods[f.frame.method] ?? 0) + 1;
  const end = received(driver, from).find((f) => f.frame?.method === 'turn/completed' && f.frame.params?.threadId === driver.threadId) ?? null;
  const agentTexts = items.filter(({ item }) => item.type === 'agentMessage').map(({ item }) => String(item.text ?? ''));
  return {
    itemTypes: items.map(({ item }) => item.type),
    userMessages: items.filter(({ item }) => item.type === 'userMessage').map(({ item }) => ({ keys: Object.keys(item).sort(), parts: (Array.isArray(item.content) ? item.content : []).map((part) => partFacts(part, folders)) })),
    agentMessages: items.filter(({ item }) => item.type === 'agentMessage').map(({ item, index }) => ({
      index, phase: item.phase ?? null, delivery: item.delivery ?? null, units: String(item.text ?? '').length, deltaUnits: deltaUnitsOf(driver, from, item.id),
      questions: Array.isArray(item.questions) ? item.questions.map((q) => ({ keys: Object.keys(q).sort(), options: Array.isArray(q.options) ? q.options.length : null })) : null,
      holds: Object.fromEntries(Object.entries(words).map(([name, word]) => [name, test(String(item.text ?? ''), word)])),
    })),
    otherItems: items.filter(({ item }) => !['agentMessage', 'userMessage', 'reasoning'].includes(item.type)).map(({ item }) => ({ type: item.type, status: item.status ?? null })),
    errors: received(driver, from).filter((f) => f.frame?.method === 'error').map((f) => ({ willRetry: f.frame.params?.willRetry ?? null, message: tidy(String(f.frame.params?.error?.message ?? ''), folders, 300) })),
    end: end ? { index: end.index, status: end.frame.params.turn?.status ?? null, error: end.frame.params.turn?.error ? tidy(String(end.frame.params.turn.error.message ?? JSON.stringify(end.frame.params.turn.error)), folders, 300) : null } : null,
    anyAgentMessageHolds: Object.fromEntries(Object.entries(words).map(([name, word]) => [name, agentTexts.some((text) => test(text, word))])),
    methods,
  };
}

const outlineOf = (driver, from) => codex.outline(driver, from).filter((row) => row.method !== CODEX_TEXT_DELTA && row.method !== 'thread/tokenUsage/updated' && row.method !== 'mcpServer/startupStatus/updated');

/** One prompt through to its turn's end. */
async function turn(ctx, driver, input, model, words = {}) {
  const started = await startTurn(driver, ctx, input, model);
  if (!started.ok) return { refused: true, inputTypes: started.inputTypes, error: started.error, outline: outlineOf(driver, started.from) };
  const end = await ctx.turnEnd(driver, started.from);
  await sleep(1_500);
  return { refused: false, inputTypes: started.inputTypes, endIndex: end.index, ...turnFacts(driver, started.from, ctx, words), outline: outlineOf(driver, started.from) };
}

/** The thread's turns read as the app's history check reads them (C24, C25): each user message's parts, and where an image's path lies. */
async function historyRead(ctx, driver, threadId) {
  const folders = foldersOf(ctx);
  const reply = await driver.requestWithin('thread/turns/list', { threadId, limit: 20, itemsView: 'full' }, 30_000);
  if (!reply.ok) return { ok: false, error: errorOf(reply, folders) };
  const data = Array.isArray(reply.value?.data) ? reply.value.data : [];
  return {
    ok: true, turns: data.length,
    perTurn: data.map((one) => {
      const items = Array.isArray(one.items) ? one.items : [];
      return { status: one.status ?? null, itemTypes: items.map((item) => item.type), userMessages: items.filter((item) => item.type === 'userMessage').map((item) => ({ keys: Object.keys(item).sort(), parts: (Array.isArray(item.content) ? item.content : []).map((part) => partFacts(part, folders)) })) };
    }),
  };
}

/** The spike's own thread, opened: the driver, its model and the thread's facts, or why not. */
async function ownThread(ctx) {
  const driver = await ctx.open();
  const model = await modelOf(driver);
  if (!model.model) return { driver, model, notRun: MODEL ? `the scratch account does not list ${MODEL}` : 'the CLI listed no model' };
  const thread = await openThread(ctx, driver, model);
  writeState({ codexModel: model });
  return { driver, model, thread };
}

const COLOURS = { red: COLOUR_WORDS.red, blue: COLOUR_WORDS.blue, green: COLOUR_WORDS.green, yellow: COLOUR_WORDS.yellow };
const common = (driver, extra = {}) => ({ ...extra, typeCounts: typeCounts(driver, (frame) => frame?.method ?? 'response') });

const SCENARIOS = {
  image: {
    id: 'm23-image', name: 'm23-codex-image', turns: 2, files: FILES,
    title: 'K1: a prompt with one localImage under Read only, then one with two, and the history read after them (C24, C25)',
    successCondition: "turn/start taken with localImage items, the answers naming the images' colours, and history returning the user messages with their image parts",
    async run(ctx) {
      const written = writeImages();
      try {
        const { driver, model, thread, notRun } = await ownThread(ctx);
        if (notRun) return codex.notRun(notRun);
        if (!thread.ok) return codex.didNotHappen('thread/start was refused', { thread });
        const notes = { model, thread, images: factsOf(written) };
        notes.one = await turn(ctx, driver, [textInput(PROMPTS.image), localImage(written[IMAGE.redBlue].file)], model, { red: COLOURS.red, blue: COLOURS.blue });
        if (notes.one.refused) return codex.didNotHappen('turn/start with a localImage was refused', common(driver, notes));
        notes.two = await turn(ctx, driver, [textInput(PROMPTS.twoImages), localImage(written[IMAGE.redBlue].file), localImage(written[IMAGE.greenYellow].file)], model, COLOURS);
        notes.history = await historyRead(ctx, driver, driver.threadId);
        return codex.happened(common(driver, notes), notes.two.refused ? notes.one.endIndex : notes.two.endIndex);
      } finally { removeImages(); }
    },
  },

  'big-image': {
    id: 'm23-big-image', name: 'm23-codex-big-image', turns: 1, files: FILES,
    title: "K1: a prompt with a localImage of noise at the sheet's 5 MiB bound (C2, C24)",
    successCondition: 'Whether Codex takes the image at the bound, and what it says when it does not',
    async run(ctx) {
      const written = writeImages();
      try {
        const { driver, model, thread, notRun } = await ownThread(ctx);
        if (notRun) return codex.notRun(notRun);
        if (!thread.ok) return codex.didNotHappen('thread/start was refused', { thread });
        const notes = { model, thread, image: written[IMAGE.noise].facts };
        notes.turn = await turn(ctx, driver, [textInput(PROMPTS.bigImage), localImage(written[IMAGE.noise].file)], model, { noise: COLOUR_WORDS.noise });
        notes.history = notes.turn.refused ? null : await historyRead(ctx, driver, driver.threadId);
        if (notes.turn.refused) return codex.didNotHappen('turn/start with the image at the bound was refused', common(driver, notes));
        return codex.happened(common(driver, notes), notes.turn.endIndex);
      } finally { removeImages(); }
    },
  },

  steer: {
    id: 'm23-steer', name: 'm23-codex-steer', turns: 2, files: FILES,
    title: 'K1: a long turn steered by turn/steer naming the running turn, and the same turn named again once it has ended (C36, C39)',
    successCondition: "The steer taken into the running turn, the answer holding the spike's marker word, and the stale steer's refusal code",
    async run(ctx) {
      const { driver, model, thread, notRun } = await ownThread(ctx);
      if (notRun) return codex.notRun(notRun);
      if (!thread.ok) return codex.didNotHappen('thread/start was refused', { thread });
      const started = await startTurn(driver, ctx, [textInput(PROMPTS.countCodex)], model);
      const notes = { model, thread, first: { ok: started.ok, error: started.error } };
      if (!started.ok) return codex.didNotHappen('the first turn/start was refused', common(driver, notes));
      // The message's first delta: the turn is being written when the steer goes.
      const firstDelta = await driver.session.waitFor((f) => f?.method === CODEX_TEXT_DELTA && f.params?.threadId === driver.threadId, { wait: 'scenario', ms: 90_000, fromIndex: started.from });
      await sleep(800);
      notes.steered = await steer(driver, ctx, PROMPTS.steerCodex, started.turnId);
      notes.steered.msAfterTheFirstDelta = Math.round(notes.steered.atMs - (driver.session.frames.find((f) => f.index === firstDelta.index)?.ms ?? notes.steered.atMs));
      const end = await ctx.turnEnd(driver, started.from);
      await sleep(1_500);
      Object.assign(notes, turnFacts(driver, started.from, ctx, { marker: MARKERS.steerCodex }));
      notes.itemsStartedAfterTheSteer = received(driver, notes.steered.from).filter((f) => f.frame?.method === 'item/started' && f.frame.params?.threadId === driver.threadId).map((f) => f.frame.params.item?.type ?? null);
      notes.turnsCompleted = received(driver, started.from).filter((f) => f.frame?.method === 'turn/completed' && f.frame.params?.threadId === driver.threadId).length;
      // The turn named again once it has ended (C39): what refuses it.
      notes.stale = await steer(driver, ctx, PROMPTS.steerCodex, started.turnId);
      if (notes.stale.ok) { const again = await ctx.turnEnd(driver, notes.stale.from); notes.stale.ranAsATurn = turnFacts(driver, notes.stale.from, ctx, { marker: MARKERS.steerCodex }); notes.stale.endIndex = again.index; }
      notes.outline = outlineOf(driver, started.from);
      if (!notes.steered.ok) return codex.didNotHappen('turn/steer was refused on the running turn', common(driver, notes));
      return codex.happened(common(driver, notes), end.index);
    },
  },

  async: {
    id: 'm23-async', name: 'm23-codex-async', turns: 2, files: FILES,
    title: "K1: a question asked in a message while the turn goes on, answered by turn/steer in fat-g's words (C45)",
    successCondition: 'The message with its questions, the steer taken while the turn runs and the model acting on the answer — or the turn over first, the steer refused, and the answer sent as the next prompt (C39)',
    async run(ctx) {
      const { driver, model, thread, notRun } = await ownThread(ctx);
      if (notRun) return codex.notRun(notRun);
      if (!thread.ok) return codex.didNotHappen('thread/start was refused', { thread });
      const started = await startTurn(driver, ctx, [textInput(PROMPTS.asyncCodex)], model);
      const notes = { model, thread, first: { ok: started.ok, error: started.error } };
      if (!started.ok) return codex.didNotHappen('the first turn/start was refused', common(driver, notes));
      const isQuestion = (f) => f?.method === 'item/completed' && f.params?.threadId === driver.threadId && f.params.item?.type === 'agentMessage' && Array.isArray(f.params.item.questions) && f.params.item.questions.length > 0;
      const isEnd = (f) => f?.method === 'turn/completed' && f.params?.threadId === driver.threadId;
      const hit = await driver.session.waitFor((f) => isQuestion(f) || isEnd(f), { wait: 'scenario', ms: 150_000, fromIndex: started.from });
      if (isEnd(hit.frame)) {
        Object.assign(notes, turnFacts(driver, started.from, ctx), { outline: outlineOf(driver, started.from) });
        return codex.didNotHappen('the turn ended with no message that asks', common(driver, notes));
      }
      const questions = hit.frame.params.item.questions;
      notes.question = { index: hit.index, delivery: hit.frame.params.item.delivery ?? null, phase: hit.frame.params.item.phase ?? null, questions: questions.map((q) => ({ keys: Object.keys(q).sort(), options: Array.isArray(q.options) ? q.options.length : null })) };
      // The answer as fat-g sends one (M21, C26): each question's title, then the option chosen.
      const answer = asyncAnswerPrompt(questions.map((q) => ({ title: String(q.title ?? ''), answer: optionMatching(q.options, /notes-4/) ?? optionMatching(q.options, /./) ?? 'notes-4.txt' })));
      const words = { 'notes-4': WORDS['notes-4.txt'], 'notes-3': WORDS['notes-3.txt'] };
      notes.steered = await steer(driver, ctx, answer, started.turnId);
      if (notes.steered.ok) {
        const end = await ctx.turnEnd(driver, started.from);
        await sleep(1_500);
        notes.turn = turnFacts(driver, started.from, ctx, words);
        notes.afterTheSteer = turnFacts(driver, notes.steered.from, ctx, words);
        notes.turnsCompleted = received(driver, started.from).filter((f) => isEnd(f.frame)).length;
        notes.outline = outlineOf(driver, started.from);
        return codex.happened(common(driver, notes), end.index);
      }
      // The turn was over first, or the steer was refused otherwise (C39): the answer goes as the next prompt.
      const end = await ctx.turnEnd(driver, started.from);
      notes.turn = turnFacts(driver, started.from, ctx, words);
      notes.next = await turn(ctx, driver, [textInput(answer)], model, words);
      notes.outline = outlineOf(driver, started.from);
      return codex.happened(common(driver, notes), notes.next.refused ? end.index : notes.next.endIndex);
    },
  },

  commands: {
    id: 'm23-commands', name: 'm23-codex-commands', turns: 2, files: FILES,
    title: 'K1: a turn whose text is /compact, and one whose text is /review (C63)',
    successCondition: 'Whether the app-server does anything with the text but hand it to the model: the items, the notifications and the end of each turn',
    async run(ctx) {
      const { driver, model, thread, notRun } = await ownThread(ctx);
      if (notRun) return codex.notRun(notRun);
      if (!thread.ok) return codex.didNotHappen('thread/start was refused', { thread });
      const notes = { model, thread };
      notes.compact = await turn(ctx, driver, [textInput(PROMPTS.compact)], model);
      if (!notes.compact.refused) notes.compact.signs = { methods: Object.keys(notes.compact.methods).filter((m) => /compact/i.test(m)), items: notes.compact.itemTypes.filter((t) => /compact/i.test(String(t))) };
      notes.review = await turn(ctx, driver, [textInput(PROMPTS.review)], model);
      if (!notes.review.refused) notes.review.signs = { methods: Object.keys(notes.review.methods).filter((m) => /review/i.test(m)), items: notes.review.itemTypes.filter((t) => /review/i.test(String(t))) };
      if (notes.compact.refused && notes.review.refused) return codex.didNotHappen('both turn/start were refused', common(driver, notes));
      return codex.happened(common(driver, notes), notes.review.refused ? notes.compact.endIndex : notes.review.endIndex);
    },
  },

  skills: {
    id: 'm23-skills', name: 'm23-codex-skills', turns: 1, files: { ...FILES, [`.agents/skills/${SKILL_NAME}/SKILL.md`]: SKILL_MD, [`.codex/skills/${SKILL_NAME}/SKILL.md`]: SKILL_MD },
    title: 'K1: skills/list for the working folder, and a turn whose input holds a skill item (C64)',
    successCondition: "The spike's skill listed with its scope and its folder, and the answer holding the skill's marker word",
    async run(ctx) {
      const folders = foldersOf(ctx);
      const driver = await ctx.open();
      // The list, before any thread (C64): what the app's existing connection would ask.
      const listed = await driver.requestWithin('skills/list', { cwds: [ctx.scratch] }, 15_000);
      const data = listed.ok && Array.isArray(listed.value?.data) ? listed.value.data : [];
      const oursRaw = data.flatMap((entry) => (Array.isArray(entry.skills) ? entry.skills : []).filter((s) => s?.name === SKILL_NAME));
      const notes = {
        list: listed.ok ? {
          replyKeys: Object.keys(listed.value ?? {}).sort(), entries: data.map((entry) => ({
            cwd: whereIs(entry.cwd, folders), skills: Array.isArray(entry.skills) ? entry.skills.length : null,
            ours: (Array.isArray(entry.skills) ? entry.skills : []).filter((s) => s?.name === SKILL_NAME).map((s) => ({ keys: Object.keys(s).sort(), scope: s.scope ?? null, enabled: s.enabled ?? null, path: whereIs(s.path, folders), underAgents: /[\\/]\.agents[\\/]/.test(String(s.path)), underCodex: /[\\/]\.codex[\\/]/.test(String(s.path)), hasInterface: s.interface !== undefined })),
            errors: (Array.isArray(entry.errors) ? entry.errors : []).map((e) => ({ path: whereIs(e?.path, folders), underAgents: /[\\/]\.agents[\\/]/.test(String(e?.path)), underCodex: /[\\/]\.codex[\\/]/.test(String(e?.path)), message: tidy(String(e?.message ?? ''), folders, 200) })),
          })),
        } : { refused: errorOf(listed, folders) },
      };
      const model = await modelOf(driver);
      if (!model.model) return codex.notRun(MODEL ? `the scratch account does not list ${MODEL}` : 'the CLI listed no model', notes);
      const thread = await openThread(ctx, driver, model);
      notes.model = model;
      notes.thread = thread;
      if (!thread.ok) return codex.didNotHappen('thread/start was refused', common(driver, notes));
      const skillPath = typeof oursRaw[0]?.path === 'string' ? oursRaw[0].path : path.join(ctx.scratch, '.agents', 'skills', SKILL_NAME, 'SKILL.md');
      notes.skillItemPath = oursRaw.length > 0 ? 'the listed path' : 'the .agents path, since the list did not hold the skill';
      notes.turn = await turn(ctx, driver, [textInput(PROMPTS.skillCodex), { type: 'skill', name: SKILL_NAME, path: skillPath }], model, { marker: MARKERS.skill });
      if (notes.turn.refused) return codex.didNotHappen('turn/start with a skill item was refused', common(driver, notes));
      return codex.happened(common(driver, notes), notes.turn.endIndex);
    },
  },
};

/** The scenarios of one planned run of each, in their order. */
const PLANNED = ['image', 'big-image', 'steer', 'async', 'commands', 'skills'];

if (isMain(import.meta.url)) {
  await runSpike('m23-k1', (frame) => {
    if (frame.args.list) {
      for (const key of PLANNED) log(`codex   ${key.padEnd(10)} ${String(SCENARIOS[key].turns).padStart(2)} prompt(s)  ${SCENARIOS[key].title}`);
      log(`total: ${PLANNED.reduce((sum, key) => sum + SCENARIOS[key].turns, 0)} prompts for one run of each, of the ten K1 may spend (C70); skills/list and a history read cost none`);
      return 0;
    }
    const chosen = SCENARIOS[String(frame.args.scenario ?? '')];
    if (!chosen) { warn(`usage: node spikes/m23/k1.mjs --list | --scenario ${Object.keys(SCENARIOS).join('|')} --confirm-turns <n> [--again] [--model <id>] [--own-account] [--path <executable>]`); return 1; }
    MODEL = typeof frame.args.model === 'string' ? frame.args.model : null;
    const ownAccount = frame.args['own-account'] === true;
    log(`K1:${MODEL ? ` the model ${MODEL};` : ''} production's handshake with the message delta kept (M19); ${ownAccount ? "the maintainer's own Codex configuration, at their word (C70)" : 'the scratch configuration folder (CODEX_HOME); images in a folder beside it for the run'}`);
    return codex.runScenario('m23-k1', chosen, frame, optionsFor(ownAccount));
  });
}
