// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The demo source's stream form (docs/planning/_archive/M19.md, Design 9; C63, C69): what the recorded
// performance runs of V17 are made with. The demo switch's value `stream` (src/main/app/flavor.ts,
// the one place that reads it) runs fat-g with one provider, this file's own, in a throwaway data
// folder: one project, one session, the long-conversation fixture (C52) in that session's
// conversation, and the fixture's three streams played into it — through the real registry,
// runtime, bridge, chat service, store and page.
//
// Since M20a (docs/planning/_archive/M20a.md, Design 8; C44) each of the fixture's turns holds what it did
// between its prompt and its answer, a group of twenty activities, and two more streams play by
// their names: `tools`, a turn that runs twenty tools into the full window, and `worker`, the same
// with a worker whose answer streams beside it, into its thread in the Sub-agents tab.
//
// Since M20b (docs/planning/_archive/M20b.md, Design 9; V17) the form's provider answers a question asked
// beside the session, and the session keeps two hundred asides from its start, so the recorded runs
// can be made with them: an aside's answer streams into its tab beside the full window, as a Codex
// side thread's does, or — for a question that begins with the word `whole` — arrives whole after a
// wait, as a Claude side question's does.
//
// Since M21 (docs/planning/_archive/M21.md, Design 8; C52) the prompt `question` shows both of a question's
// cards without a CLI: the turn asks a blocking question, of two options and free text, and holds
// until it is answered from its card; it then says a message that carries a question of its own,
// whose card is answered by a prompt, and ends.
//
// Since M22b (docs/planning/_archive/M22b.md, Design 8; V8) a plan turn plays a plan, as Codex writes one:
// its item opened, its text a piece a step, completed whole, and the turn's end — the decision is
// the user's, from the panel. A plan turn whose prompt begins with `request` plays one as Claude asks
// one instead: whole, in a request that holds the turn until it is decided — feedback brings the
// next version in the same turn, Execute runs it, Cancel ends the turn. A turn that carries out a
// plan's Execute, by fat-g's words, says it ran.
//
// Since M22e (docs/planning/_archive/M22e.md, Design 9; B7, V6) the form's provider answers a review: fat-g's
// review prompt with a findings block of its own — five findings over three tiers, one anchored at
// the form's plan's heading — written a piece a step as any answer; Send notes with that review
// again, one finding moved down a tier under a new id naming `was`; and a note holding the word
// `ask` with a line of prose above the review sent again unchanged. An integration's plan turn
// brings the plan's next version, as any plan turn with a block of fat-g's does. Review by model
// makes the reviewer, a second session of the form's provider, as its runtime can.
//
// Since decision 0033 the form's sessions report how full their context is, as Claude's do: a window
// of 200,000 that compacts at 167,000, said once at a process's first turn and again at each turn's
// end, a little fuller each time; the prompt `context` brings it near that line, to show the meter's
// red cells filling.
//
// It starts no CLI and spends no turn: the built-in providers are not even defined in this form.
// Development and smoke builds only: it is reached through src/main/app/demo-stream-data.ts alone,
// which is loaded by a dynamic import behind `__FATG_SMOKE_HOOKS__` (src/main/index.ts), so a release
// bundle holds none of it, and the package audit refuses it there as it refuses the demo source.
//
// The fixture is no part of any build: it is read at start from the path the launcher gives
// (do-run-stream.bat, through the flavor switch), which is tests/fixtures/conversations/long-conversation.mjs.
//
// Electron-free, and it touches no file but the fixture it loads as a module: the page's evaluator
// and the clock arrive as options, and the data folder is made ready beside the app's own start
// (src/main/app/demo-stream-data.ts), since nothing under src/main/sessions writes a file.
import { pathToFileURL } from 'node:url';
import type { AgentEvent, HistoryActivity, HistoryMessage, HistoryTurn } from '@shared/contracts/agent-events';
import { type AsideSource, asideTitle, drawnDigest } from '@shared/contracts/aside';
import type { ApprovalChoice, BoundQuestion, GivenAnswer, RaisedApprovalRequest } from '@shared/contracts/interaction';
import { PLAN_WORDS, PLANS_AVAILABLE, type PlanCapability } from '@shared/contracts/plans';
import { type Finding, REVIEW_WORDS } from '@shared/contracts/review';
import type { ModeAvailability, PermissionCapability, SandboxSetupView } from '@shared/contracts/permissions';
import type { ProviderDescriptor } from '@shared/contracts/provider';
import type { ContextReading } from '@shared/contracts/sessions';
import type { ProviderDefinition } from '@shared/provider-kit/provider';
import type { AsideRequest, PlanAnswer, ProviderSession, SandboxFacet, SessionFacet, SessionStart, TurnRequest } from '@shared/provider-kit/sessions';
import { type BlobFiles, sha256 } from '../attachments/files';
import { readAttachmentHeader } from '../attachments/headers';
import type { TurnPlan } from '../conversations/merge';
import { stateSteps } from './demo-state-steps';
import type { ConversationStore } from '../conversations/store';

/** The form's own provider: the only one this form defines. */
export const STREAM_PROVIDER = 'fixture';
export const STREAM_PROJECT = '57ea0000-0000-4000-8000-000000000001';
export const STREAM_SESSION = '57ea0000-0000-4000-8000-000000000002';
/**
 * Two more chats of the project, empty, for a plan its chats share (decision 0029): a plan made in
 * "Fixture streams" is brought into each, and a review, a revision or an implementation in one shows
 * in the others.
 */
export const STREAM_CHATS = [
  { id: '57ea0000-0000-4000-8000-000000000003', name: 'Second chat' },
  { id: '57ea0000-0000-4000-8000-000000000004', name: 'Third chat' },
] as const;
const STREAM_REFERENCE = 'fixture-stream';
export const STREAM_MODEL = 'fixture';
/**
 * The form's two modes (M22, C35, V12): a reading one and one that asks, so the header's control,
 * the mode line and the cards can be seen without a CLI. A change between them is a restart, as
 * every change of a provider that declares no other is. It says it has a setup, so that the
 * prompts `approval setup` and `approval unknown` can show the dialog's states: until one of them
 * is sent, the asking mode needs none.
 */
export const STREAM_READ_ONLY = 'read-only';
export const STREAM_ASK_FIRST = 'ask-first';
export const STREAM_PERMISSIONS: PermissionCapability = {
  modes: [
    { id: STREAM_READ_ONLY, label: 'Read only', description: 'The fixture plays its streams; an approval prompt is refused as a real request would be.', asks: false, reading: true, transitionsFrom: [] },
    { id: STREAM_ASK_FIRST, label: 'Ask first', description: 'An approval prompt asks before its scripted action, on a card.', asks: true, reading: false, transitionsFrom: [] },
  ],
  fallback: STREAM_ASK_FIRST,
  setup: {
    changes: 'The fixture’s setup changes nothing on this machine: it plays the states a real one goes through.',
    approval: 'Nothing will ask for an administrator’s approval.',
    waiting: 'The fixture is playing a setup that waits.',
  },
  inherited: 'The fixture has no configuration of its own: nothing acts here but what its script plays.',
  rules: 'The fixture has no rules of its own to list.',
};
/** The fixture's conversation is dated from here, a minute a turn: the same every run. */
const FIXTURE_EPOCH = Date.parse('2026-01-01T09:00:00Z');
const MERGE_PAGE = 100;

/** How fast a stream is written: K3's 5,000 units a second, in pieces of 125 every 25 ms. Faster than either CLI writes. */
export const STREAM_STEP_MS = 25;
export const STREAM_STEP_UNITS = 125;

/** A stream of one answer that is written (M19, C52). */
export type AnswerStream = 'mixed' | 'fence' | 'table';
/** A stream of a turn's work (M20a, C44): its tools alone, or with a worker whose answer streams beside them. */
export type WorkStream = 'tools' | 'worker';
/** An aside's answer (M20b, V17): written a piece at a time, as a session's is, or arriving whole after a wait. */
export type AsideStream = 'aside' | 'aside-whole';
/** A turn that asks (M21, C52): a blocking question, then one asked in a message. */
export type QuestionStream = 'question';
/** A turn that asks leave for an action, or shows one a rule declined (M22, C35). */
export type ApprovalStream = 'approval';
/** A plan turn, or the turn that carries out a plan's Execute (M22b, V8). */
export type PlanStream = 'plan';
export type StreamKind = AnswerStream | WorkStream | AsideStream | QuestionStream | ApprovalStream | PlanStream | 'states';

/** The word a plan turn's prompt begins with to plan as Claude asks, in a request (M22b, V8). */
export const PLAN_REQUEST_WORD = 'request';
/** The form's plan, and its next version after a feedback. */
export const STREAM_PLAN = '# Measure the tides\n\n1. Read the tide tables for January.\n2. Measure high and low water for each day.\n3. Write the measurements to tides.md.';
export const STREAM_PLAN_REVISED = `${STREAM_PLAN}\n4. Check the table against last year’s.`;
export const PLAN_MESSAGES = { executed: 'Done: the plan ran, and tides.md holds the measurements.', cancelled: 'Understood: the plan was cancelled, so nothing ran.' } as const;
/** What the form says of its plans (M22b, C2, C5, C70): a plan turn under Ask first, and none under Read only, as on Claude, so that the toggle's reason can be seen. */
export const STREAM_PLANS: PlanCapability = { modes: [STREAM_ASK_FIRST], unavailable: 'The fixture cannot plan under Read only, as Claude cannot: choose Ask first to plan.' };
/** The word that plans a text past what the tab draws whole (M22b, V8; C60): drawn by sections, and written slowly enough to be stopped unfinished. */
export const PLAN_LONG_WORD = 'long';
/** That plan: sixty sections of a heading and a paragraph, about 330,000 units in all. */
export const STREAM_PLAN_LONG = longPlan();
/** How much of the long plan each step writes, and how long a step waits: about seven seconds in all. */
const LONG_STEP_UNITS = 32 * 1024;
const LONG_STEP_MS = 700;

function longPlan(): string {
  const paragraph = 'Read the gauge at the harbour wall, note the height against the chart datum, and compare it with the table’s prediction for that hour; where the two differ by more than a hand’s width, mark the day for a second reading at the next tide. '.repeat(24);
  const sections = Array.from({ length: 60 }, (_, index) => `## Day ${index + 1}\n\n${paragraph.trim()}`);
  return `# Measure the tides, day by day\n\n${sections.join('\n\n')}`;
}

/** The form's review of its plan (M22e, B7): five findings over three tiers, the first anchored at the plan's heading. */
export const STREAM_FINDINGS: readonly Finding[] = [
  { id: 'T1.1', tier: 1, category: 'PROD', title: 'No tide table is named', example: 'Step 1 reads “the tide tables for January” but names no source.', description: 'Without a named table the measurements cannot be checked against one.', correction: 'Name the table, its port and its year in step 1.', anchor: { heading: 'Measure the tides', quote: 'Read the tide tables for January.' } },
  { id: 'T1.2', tier: 1, category: 'PROD', title: 'High and low water are measured at no stated time', example: 'Step 2 measures each day, but not when.', description: 'A tide read an hour late reads another height.', correction: 'Measure at the times the table predicts.' },
  { id: 'T2.1', tier: 2, category: 'GENERAL', title: 'tides.md has no stated layout', example: 'Step 3 writes the measurements, in no stated order.', description: 'A reader cannot tell the high from the low water.', correction: 'Write one row a day: date, high, low.' },
  { id: 'T3.1', tier: 3, category: 'TEST-ONLY', title: 'Nothing checks the measurements', example: 'No step compares a reading with the table.', description: 'A misread gauge goes unnoticed.', correction: 'Add a step that compares each reading with its prediction.' },
  { id: 'T3.2', tier: 3, category: 'GENERAL', title: 'January has no year', example: '“January” could be any year’s.', description: 'Two Januaries’ tables differ.', correction: 'Say the year.' },
];
/** Send notes' round: T2.1 moved down a tier, under a new id naming `was`; every other finding kept. */
export const STREAM_FINDINGS_MOVED: readonly Finding[] = STREAM_FINDINGS.map((finding) => (finding.id === 'T2.1' ? { ...finding, id: 'T3.3', tier: 3, was: 'T2.1', correction: 'Write one row a day, as a table: date, high, low.' } : finding));
/** The word a note holds to be answered in prose above the review sent again unchanged. */
export const ASK_WORD = 'ask';
/**
 * The word a note holds to be answered with the review again, two of its findings unreadable (the
 * maintainer): T1.2 with no correction, which stands as the round before had it, and a
 * new one with no id, left out.
 */
export const GARBLE_WORD = 'garble';
const findingsBlock = (issues: readonly unknown[]): string => `\`\`\`json\n${JSON.stringify({ version: 2, appraisal: 'A short plan whose steps name no source, no time and no layout.', issues }, null, 2)}\n\`\`\``;
/**
 * The form's answer to a prompt of a review's (M22e, B7), or null for any other: the review, a round
 * that moves one finding, prose above the round as it stands, or the round as it stands with two
 * findings garbled. `moved`: what the session's review stands at, which a Send notes that settles
 * moves on.
 */
export function reviewAnswer(prompt: string, moved: boolean): { readonly text: string; readonly moved: boolean } | null {
  if (prompt.startsWith(PLAN_WORDS.reviewOpening)) return { text: `Three of these rest on what the plan leaves unnamed.\n\n${findingsBlock(STREAM_FINDINGS)}`, moved: false };
  if (!prompt.startsWith(REVIEW_WORDS.sendNotes)) return null;
  const notes = prompt.split('\n\n')[1] ?? '';
  if (new RegExp(`\\b${GARBLE_WORD}\\b`, 'i').test(notes)) {
    const garbled = (moved ? STREAM_FINDINGS_MOVED : STREAM_FINDINGS).map((finding) => {
      if (finding.id !== 'T1.2') return finding;
      const { correction: _correction, ...rest } = finding;
      return rest;
    });
    const unnumbered = { tier: 4, category: 'GENERAL', title: 'The plan has no last day', example: 'No step says when the measuring stops.', description: 'The work could run on.', correction: 'Say the last day.' };
    return { text: `Two of these came out garbled.\n\n${findingsBlock([...garbled, unnumbered])}`, moved };
  }
  if (new RegExp(`\\b${ASK_WORD}\\b`, 'i').test(notes)) return { text: `You asked about a tier: it stands where the consequence puts it, so the review below is unchanged.\n\n${findingsBlock(moved ? STREAM_FINDINGS_MOVED : STREAM_FINDINGS)}`, moved };
  return { text: `T2.1 moves to T3 as T3.3, its correction as the note asked.\n\n${findingsBlock(STREAM_FINDINGS_MOVED)}`, moved: true };
}

/** The word a question begins with to be answered whole. */
export const WHOLE_WORD = 'whole';
/** How long a whole answer is awaited: long enough for the tab's waiting line to count. */
export const WHOLE_WAIT_MS = 2_000;
/** How many asides the session keeps from its start (M20b, V17). */
export const SEEDED_ASIDES = 200;

/**
 * The form's context (decision 0033): a Claude model's window and the line it compacts at, what the
 * session holds before its first turn, what each turn adds, and where the prompt `context` brings it.
 */
export const CONTEXT_WORD = 'context';
export const STREAM_CONTEXT = { window: 200_000, compactAt: 167_000, start: 18_400, perTurn: 9_000, near: 161_500 } as const;

/** A reading of `used` tokens, in the parts Claude names, its messages split as a working session's are. */
export function streamReading(used: number): ContextReading {
  const system = 3_200;
  const tools = 15_200;
  const messages = Math.max(0, used - system - tools);
  const toolResults = Math.round(messages * 0.55);
  const toolCalls = Math.round(messages * 0.15);
  const answers = Math.round(messages * 0.2);
  return {
    used,
    window: STREAM_CONTEXT.window,
    compactAt: STREAM_CONTEXT.compactAt,
    parts: [{ label: 'System prompt', tokens: system }, { label: 'System tools', tokens: tools }, { label: 'Messages', tokens: messages }],
    messages: { toolCalls, toolResults, answers, prompts: messages - toolResults - toolCalls - answers, attachments: 0, other: 0 },
    lastCall: { input: 1_200, cacheRead: Math.max(0, used - 2_700), cacheWrite: 600, output: 900 },
  };
}

/**
 * The prompt that plays a turn which asks (M21, C52), and the word that may follow it for a card
 * no CLI shows on request (V16; C88): `question form` asks four questions at once — one option
 * to choose, several to choose among, a text alone, a secret (M100b, round 4) — and never confirms
 * the answer; `question
 * worker` has a sub-agent ask, in its own thread; `question withdrawn` takes its request back after a
 * wait and goes on; `question lost` ends after the same wait as a session whose process was lost
 * does, the request still held.
 */
export const QUESTION_PROMPT = 'question';
export const QUESTION_VARIANTS = ['form', 'worker', 'withdrawn', 'lost'] as const;
export type QuestionVariant = 'one' | (typeof QUESTION_VARIANTS)[number];
/** Which turn that asks a prompt plays, or none: the word alone, or the word and a variant's. */
export function questionVariant(prompt: string): QuestionVariant | null {
  const [word, variant, ...more] = prompt.trim().toLowerCase().split(/\s+/);
  if (word !== QUESTION_PROMPT || more.length > 0) return null;
  if (variant === undefined) return 'one';
  return QUESTION_VARIANTS.find((name) => name === variant) ?? null;
}
/**
 * The prompt that plays a turn which asks leave for an action (M22, C35, V12), and the word that
 * may follow it: `approval command` asks to run a command, once; `approval file` to change two
 * files, one outside the project's folders, with a change long enough to be drawn lazily;
 * `approval grant` to run a command the session's own grant can cover — granted, the same prompt
 * then runs with no card, until the process is closed; `approval denied` shows an action a rule
 * declined, with no card; `approval worker` has a sub-agent ask, in its own thread. Two words show
 * the setup dialog's states instead, and ask nothing: after `approval setup` the asking mode needs
 * a setup whose first try fails and whose second completes; after `approval unknown` the first
 * waits until Stop waiting, and its outcome is unknown. Under Read only each asking word is
 * refused, as a real request is.
 */
export const APPROVAL_PROMPT = 'approval';
export const APPROVAL_VARIANTS = ['command', 'file', 'grant', 'denied', 'worker', 'setup', 'unknown'] as const;
export type ApprovalVariant = (typeof APPROVAL_VARIANTS)[number];
/** Which approval a prompt plays, or none: the word alone is `command`. */
export function approvalVariant(prompt: string): ApprovalVariant | null {
  const [word, variant, ...more] = prompt.trim().toLowerCase().split(/\s+/);
  if (word !== APPROVAL_PROMPT || more.length > 0) return null;
  if (variant === undefined) return 'command';
  return APPROVAL_VARIANTS.find((name) => name === variant) ?? null;
}
const NO_OFFER = { folder: null, outside: false, authority: [], modeThatWouldStop: null, cut: false as const };
/** What `approval command` asks leave for: one command, approved once or denied. */
export const STREAM_COMMAND: RaisedApprovalRequest = {
  ...NO_OFFER, kind: 'command', tool: 'Bash', summary: 'node scripts/measure.mjs --tides', targets: [], reason: 'To measure the tides before answering.',
  detail: { kind: 'command', command: 'node scripts/measure.mjs --tides --from 2026-01-01 --to 2026-01-31' }, choices: ['approve', 'deny'], grant: null,
};
/** What `approval grant` asks leave for: a command the CLI's own session grant can cover. */
export const STREAM_GRANTED: RaisedApprovalRequest = {
  ...NO_OFFER, kind: 'command', tool: 'Bash', summary: 'touch notes.txt', targets: ['notes.txt'], reason: 'To make the note you asked for.',
  detail: { kind: 'command', command: 'touch notes.txt' }, choices: ['approve', 'approve-session', 'deny'], grant: { covers: 'Bash(touch notes.txt)' },
};
/** What `approval file` asks leave for: an edit of every matching passage, and a file written outside the project's folders. */
export const STREAM_FILE: RaisedApprovalRequest = {
  kind: 'file-change', tool: 'Edit', summary: 'tides.md and one more file', folder: null, targets: ['docs/tides.md', '../elsewhere/table.txt'], outside: true, reason: 'To correct the table and keep a copy.',
  authority: [{ kind: 'folder', mode: null }],
  detail: {
    kind: 'changes',
    changes: [
      { path: 'docs/tides.md', kind: 'update', text: 'high water', replace: 'high tide', all: true },
      { path: '../elsewhere/table.txt', kind: 'write', text: Array.from({ length: 400 }, (_, row) => `${String(row + 1).padStart(3, '0')}  ${(1.2 + (row % 9) / 10).toFixed(1)} m`).join('\n'), replace: null, all: null },
    ],
  },
  choices: ['approve', 'deny'], grant: null, modeThatWouldStop: null, cut: false,
};
/** `approval worker`'s sub-agent, as the agent list labels it. */
export const APPROVAL_WORKER = 'Make the note';
/** What a turn says once its action was decided, was declined by a rule, or was refused under Read only; and once a setup's script is armed. */
export const APPROVAL_MESSAGES = {
  ran: 'Done: the action ran.',
  denied: 'Understood: the action was not run.',
  byRule: 'A rule of the configuration declined that, so nothing ran.',
  refused: 'This chat is Read only, so the request was refused. Change the mode to try again.',
  armed: 'The fixture’s asking mode now needs its setup: open the mode menu to see it.',
  workerRan: 'The sub-agent’s action was decided in its own thread, and it is done.',
} as const;
/** How long a scripted setup waits before its end, and why its first try fails. */
export const SETUP_WAIT_MS = 1_500;
export const SETUP_FAILURE = 'The fixture’s setup was declined at the administrator’s prompt.';

/** What that turn asks as a request: one question, two options with their descriptions, and free text taken. */
export const STREAM_QUESTION: BoundQuestion = {
  text: 'Which of the three streams should the next prompt play?',
  header: 'Next stream',
  options: [{ label: 'The table', description: 'A table of 1,500 rows, written a row at a time.' }, { label: 'The code fence', description: 'One long block of code.' }],
  multiple: false,
  freeText: true,
  secret: false,
};
/** What the demo says once its question was skipped (M100b, C31). */
export const DECLINED_MESSAGE = 'Understood: you declined to answer, so I went on without it.';
/** What it then asks, in a message that carries a question of its own. */
export const QUESTION_ASKED = [{ title: 'How long should the answer be?', options: ['A line', 'A page'] }];
/** Its message's text is the CLI's own copy of its questions, as Codex writes it, which the card stands for (decision 0026, item 2). */
export const QUESTION_MESSAGE = 'How long should the answer be?\n- A line\n- A page';
/**
 * What `question form` asks, in one request: one option to choose and then several among the same
 * three, so that the two kinds of choice can be told apart side by side (M100b, round 4); a text and
 * nothing else; and a secret.
 */
export const STREAM_FORM: BoundQuestion[] = [
  { text: 'Which stream should the run play first?', header: 'First', options: [{ label: 'Mixed', description: 'Prose, lists, a table and code.' }, { label: 'The table', description: null }, { label: 'The code fence', description: null }], multiple: false, freeText: false, secret: false },
  { text: 'Which streams should it play after that?', header: 'Then', options: [{ label: 'Mixed', description: 'Prose, lists, a table and code.' }, { label: 'The table', description: null }, { label: 'The code fence', description: null }], multiple: true, freeText: false, secret: false },
  { text: 'What should the run be called?', header: null, options: [], multiple: false, freeText: true, secret: false },
  { text: 'A token for the run. It is sent and not kept.', header: 'Secret', options: [], multiple: false, freeText: false, secret: true },
];
/** What that turn says once it is answered. It confirms nothing: the card then says the model did not. */
export const FORM_MESSAGE = 'The four answers were sent. This fixture confirms none of them, so the card says so now that the reply is over.';
/** `question worker`'s sub-agent, as the agent list labels it, and what it says once it is answered. */
export const QUESTION_WORKER = 'Ask which stream to play';
export const QUESTION_WORKER_ANSWER = 'The sub-agent has its answer, and ends.';
/** How long `question withdrawn` waits before it takes its request back, and `question lost` before its end; and what the first then says. */
export const WITHDRAW_WAIT_MS = 5_000;
export const WITHDRAWN_MESSAGE = 'No answer came, so the fixture took its question back and went on.';

/** One thing a fixture turn did: what it was given, and what it returned. */
export interface FixtureActivity {
  readonly id: string;
  readonly type: 'read' | 'search' | 'command';
  readonly name: string;
  readonly summary: string;
  readonly input: string;
  readonly output: string;
  readonly file: string | null;
  readonly exitCode: number | null;
}

/** What the form reads of the fixture (tests/fixtures/conversations/long-conversation.mjs). */
export interface StreamFixture {
  readonly TURNS: number;
  readonly STREAMS: readonly AnswerStream[];
  readonly ACTIVITY_STREAMS: readonly WorkStream[];
  turn(n: number): { readonly prompt: string; readonly answer: string };
  streamText(kind: AnswerStream): string;
  /** What turn `n` did between its prompt and its answer, in order (M20a, C44). */
  activities(n: number): readonly FixtureActivity[];
  /** What a worker's answer grows to. */
  workerText(): string;
}

/** A turn that is being played. */
interface Playing {
  readonly turnId: string;
  readonly kind: StreamKind;
  timer: unknown;
  /** The worker a work stream started and has not ended, with the item of the session's own that started it. */
  worker: { readonly workerId: string; readonly itemId: string } | null;
  /** M105's synthetic parallel children and an early end already sent by its held-parent case. */
  stateWorkers?: Set<string>;
  parentReported?: true;
  /** The request a question's turn made and holds the turn for (M21, C52), until it is answered. */
  question: string | null;
  /** Which turn that asks it is, or none. */
  readonly variant: QuestionVariant | null;
  /** The approval a turn asked and holds the turn for (M22), until it is decided: its request, and the action it is for. */
  approval: { readonly requestId: string; readonly itemId: string; readonly request: RaisedApprovalRequest } | null;
  /** The plan a turn asked about in a request (M22b, V8), and how many it has proposed. */
  plan: { requestId: string; versions: number } | null;
}

/** A fixture activity as its two events tell it, under an id that is its turn's own. */
function activityEvents(turnId: string, itemId: string, activity: FixtureActivity): { readonly started: AgentEvent; readonly ended: AgentEvent } {
  return {
    started: { type: 'activity-started', turnId, itemId, activityType: activity.type, name: activity.name, summary: activity.summary, input: activity.input, ...(activity.file === null ? {} : { files: [{ path: activity.file, line: null }] }) },
    ended: { type: 'activity-ended', turnId, itemId, status: 'completed', output: activity.output, ...(activity.exitCode === null ? {} : { exitCode: activity.exitCode }) },
  };
}

/** What a work stream's own answer says, once its tools have run. */
export const WORK_ANSWER = 'The twenty steps are done: each is in the group above.';
/** What `question worker`'s own turn answers, once its sub-agent has asked and ended. */
export const WORK_ANSWER_ASKED = 'The sub-agent asked its question in its own thread, was answered there, and is done.';
/** A work stream's worker, as the agent list labels it. */
export const WORK_WORKER = 'Summarize the measurements';

export interface StreamTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
const realTimers: StreamTimers = { set: (run, ms) => setTimeout(run, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

export interface StreamFacetOptions {
  readonly fixture: StreamFixture;
  readonly timers?: StreamTimers;
  readonly stepMs?: number;
  readonly stepUnits?: number;
  /** Told when a prompt is taken, before anything of its stream is said, with which stream it will be. */
  readonly onTurnStart?: (kind: StreamKind) => void;
  /** Told when a stream's turn is over, with which stream it was. */
  readonly onTurnEnd?: (kind: StreamKind, outcome: 'completed' | 'interrupted') => void;
}

/**
 * The form's sessions: each prompt plays one of the fixture's three streams as a message that is
 * written — opened, grown a piece at a time, completed by its whole message. A prompt that is a
 * stream's name plays that one; any other plays the next in the fixture's order.
 *
 * A prompt that names a work stream plays that (M20a, C44): twenty activities, each started at one
 * step and ended at the next, then a short answer. `worker` starts a worker first, with the item of
 * the session's own that started it, and writes the worker's answer a piece a step beside the
 * tools, under the worker's id; the worker ends, and its item with it, before the turn's answer.
 *
 * The prompt `question` plays a turn that asks (M21, C52): a blocking question as a request, which
 * holds the turn until `answer` names it, then a message that carries a question, and the turn's
 * end. A Stop while it waits ends the turn as any, and a close says the request dropped first, as an
 * adapter does at its process's end (C67). A word after it plays a card of another look (C88): see
 * `QUESTION_VARIANTS`.
 */
export function streamFacet(options: StreamFacetOptions): SessionFacet {
  const { fixture } = options;
  const timers = options.timers ?? realTimers;
  const stepMs = options.stepMs ?? STREAM_STEP_MS;
  const stepUnits = options.stepUnits ?? STREAM_STEP_UNITS;
  /** Turns played by every session of the form, so no id repeats after a resume. */
  let turns = 0;
  /** How full the conversation's context is (decision 0033): the conversation's, so a resumed session goes on from it. */
  let contextUsed: number = STREAM_CONTEXT.start;

  // ── The scripted setup (M22, V12; C60–C62, C72) ──────────────────────────────────────────
  // The form's one account: whether its asking mode needs a setup, which script a press plays,
  // and where the setup stands. In memory alone, as a real one's is.
  const setup: { needs: boolean; script: 'setup' | 'unknown' | null; presses: number; view: SandboxSetupView; timer: unknown } = { needs: false, script: null, presses: 0, view: { state: 'idle', error: null, readiness: null }, timer: undefined };
  const modeListeners = new Set<() => void>();
  const modesChanged = (): void => { for (const listener of [...modeListeners]) listener(); };
  const settle = (view: SandboxSetupView, needs = setup.needs): void => { setup.view = view; setup.needs = needs; modesChanged(); };
  const modes = (): readonly ModeAvailability[] => [
    { id: STREAM_READ_ONLY, available: true, reason: null, setup: false, records: false, unconfined: false, places: null },
    { id: STREAM_ASK_FIRST, available: !setup.needs, reason: setup.needs ? 'needs-setup' : null, setup: setup.needs, records: false, unconfined: false, places: null },
  ];
  const sandbox: SandboxFacet = {
    state: () => setup.view,
    act(action) {
      const waiting = setup.view.state === 'starting' || setup.view.state === 'waiting';
      if (action === 'stop-waiting') {
        if (!waiting) return 'no-setup';
        // Let go of, and its outcome unknown: what a fresh look answers is said with it (C72).
        timers.clear(setup.timer);
        settle({ state: 'unknown', error: null, readiness: 'not-configured' });
        return 'stopping';
      }
      if (waiting) return 'running';
      if (!setup.needs) return 'no-setup';
      setup.presses += 1;
      const first = setup.presses === 1;
      settle({ state: 'starting', error: null, readiness: setup.view.readiness });
      setup.timer = timers.set(() => {
        settle({ state: 'waiting', error: null, readiness: setup.view.readiness });
        // The first try of `unknown` waits until it is let go of; every other ends by itself.
        if (first && setup.script === 'unknown') return;
        setup.timer = timers.set(() => {
          if (first) settle({ state: 'failed', error: SETUP_FAILURE, readiness: 'not-configured' });
          else settle({ state: 'completed', error: null, readiness: 'ready' }, false);
        }, SETUP_WAIT_MS);
      }, 0);
      return 'started';
    },
  };
  /** `approval setup` and `approval unknown` arm the script: the asking mode needs its setup from here on. */
  const arm = (script: 'setup' | 'unknown'): void => { timers.clear(setup.timer); setup.script = script; setup.presses = 0; settle({ state: 'idle', error: null, readiness: 'not-configured' }, true); };

  function session(start: SessionStart, referenced: boolean): ProviderSession {
    const listeners = new Set<(event: AgentEvent) => void>();
    const emit = (event: AgentEvent): void => { for (const listener of [...listeners]) listener(event); };
    let known = referenced;
    let running: Playing | null = null;
    let over = false;
    /** The mode this process confirmed (M22, C2): said once, with the first thing it starts. */
    let confirmed = false;
    const confirm = (turnId?: string): void => {
      if (confirmed || start.mode === null) return;
      confirmed = true;
      emit({ type: 'in-force', ...(turnId === undefined ? {} : { turnId }), mode: start.mode });
    };
    /** The session grant this process holds (M22, C21): `approval grant` then runs with no card, until the process is closed. */
    let granted = false;
    /** Where this session's review stands (M22e, B7): moved once a note settled a point. */
    let reviewMoved = false;
    /** Whether this process has said its context yet, and whether the turn that runs was the prompt `context` (decision 0033). */
    let contextSaid = false;
    let contextNear = false;
    let resolveClosed: (result: { ok: boolean }) => void = () => undefined;
    const closed = new Promise<{ ok: boolean }>((resolve) => { resolveClosed = resolve; });

    /** The asides whose turn runs, by aside (M20b): each beside whatever the session plays, and ended by itself. */
    const asking = new Map<string, { readonly turnId: string; readonly kind: AsideStream; timer: unknown }>();
    let asked = 0;
    function endAside(asideId: string, outcome: 'completed' | 'interrupted', reported: boolean): void {
      const open = asking.get(asideId);
      if (open === undefined) return;
      timers.clear(open.timer);
      asking.delete(asideId);
      emit({ type: 'turn-ended', turnId: open.turnId, asideId, outcome, reported });
      options.onTurnEnd?.(open.kind, outcome);
    }
    /**
     * A question beside the session (M20b, V17): the `mixed` stream's text as the aside's answer,
     * under the aside's own turn — a piece a step, or whole after a wait for a question that begins
     * with `whole`. Nothing of the session's own turn is touched by it.
     */
    function ask(request: AsideRequest): void {
      if (over || asking.has(request.asideId)) return;
      asked += 1;
      const { asideId, turnId } = request;
      const kind: AsideStream = request.text.trim().toLowerCase().startsWith(WHOLE_WORD) ? 'aside-whole' : 'aside';
      const itemId = `fixture-aside-${asked}`;
      const text = fixture.streamText('mixed');
      const open = { turnId, kind, timer: undefined as unknown };
      asking.set(asideId, open);
      options.onTurnStart?.(kind);
      const whole = (): void => {
        if (asking.get(asideId) !== open) return;
        emit({ type: 'message', turnId, role: 'assistant', itemId, phase: 'final', text, asideId });
        endAside(asideId, 'completed', true);
      };
      let at = 0;
      const step = (): void => {
        if (asking.get(asideId) !== open) return;
        if (at >= text.length) { whole(); return; }
        emit({ type: 'message-delta', turnId, itemId, phase: 'final', text: text.slice(at, at + stepUnits), asideId });
        at += stepUnits;
        open.timer = timers.set(step, stepMs);
      };
      open.timer = timers.set(() => {
        if (asking.get(asideId) !== open) return;
        confirm();
        emit({ type: 'turn-started', turnId, providerTurnId: `fixture-aside-turn-${asked}`, asideId });
        if (kind === 'aside-whole') { open.timer = timers.set(whole, WHOLE_WAIT_MS); return; }
        emit({ type: 'message-delta', turnId, itemId, phase: 'final', text: '', asideId });
        open.timer = timers.set(step, stepMs);
      }, 0);
    }

    function end(outcome: 'completed' | 'interrupted', reported: boolean): void {
      const turn = running;
      if (turn === null) return;
      timers.clear(turn.timer);
      running = null;
      // A request still held when the session's own end is made — its close — is dropped first (M21, C67);
      // one held at a Stop is left to the turn's end, which withdraws it.
      if (turn.question !== null && !reported) emit({ type: 'question-resolved', requestId: turn.question, reason: 'dropped' });
      turn.question = null;
      // And so is an approval still held (M22, C11).
      if (turn.approval !== null && !reported) emit({ type: 'approval-resolved', requestId: turn.approval.requestId, reason: 'dropped' });
      turn.approval = null;
      // A worker still running ends with its turn, as failed, and so does the item that started it (M20a, C23).
      if (turn.worker !== null) {
        emit({ type: 'activity-ended', turnId: turn.turnId, itemId: turn.worker.itemId, status: 'failed' });
        emit({ type: 'worker-ended', workerId: turn.worker.workerId, outcome: 'failed' });
      }
      for (const workerId of turn.stateWorkers ?? []) emit({ type: 'worker-ended', workerId, outcome: 'failed' });
      turn.stateWorkers?.clear();
      if (turn.parentReported !== true) emit({ type: 'turn-ended', turnId: turn.turnId, outcome, reported });
      // What the turn left in the context, as the CLI would count it after the turn's end (decision 0033).
      contextUsed = contextNear ? STREAM_CONTEXT.near : Math.min(contextUsed + STREAM_CONTEXT.perTurn, STREAM_CONTEXT.window);
      contextNear = false;
      emit({ type: 'context', reading: streamReading(contextUsed) });
      options.onTurnEnd?.(turn.kind, outcome);
    }

    return {
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      send(request: TurnRequest) {
        if (over || running !== null) return;
        turns += 1;
        const n = turns;
        const asked = request.prompt.trim().toLowerCase();
        const states = /^states(?: (?:held|lost))?$/.test(asked);
        const work = fixture.ACTIVITY_STREAMS.find((name) => name === asked);
        const kind: StreamKind = states ? 'states' : work ?? fixture.STREAMS.find((name) => name === asked) ?? fixture.STREAMS[(n - 1) % fixture.STREAMS.length] ?? 'mixed';
        const { turnId } = request;
        const itemId = `fixture-stream-${n}`;
        const variant = questionVariant(asked);
        const approval = approvalVariant(asked);
        const executing = asked.startsWith(PLAN_WORDS.execute.toLowerCase()) || asked.startsWith(PLAN_WORDS.broughtExecute.toLowerCase());
        const planning = request.plan === true || executing;
        const turn: Playing = { turnId, kind: planning ? 'plan' : variant !== null ? 'question' : approval !== null ? 'approval' : kind, timer: undefined, worker: null, question: null, variant, approval: null, plan: null };
        running = turn;
        contextNear = asked === CONTEXT_WORD;
        // What the context holds before the turn adds to it, said once a process (decision 0033).
        if (!contextSaid) { contextSaid = true; emit({ type: 'context', reading: streamReading(contextUsed) }); }
        options.onTurnStart?.(turn.kind);
        /** The turn's opening, as every stream has it: its start, the reference where it is still to come, and the prompt's echo. */
        const open = (action: 'writing' | 'running' | 'thinking'): void => {
          confirm(turnId);
          emit({ type: 'turn-started', turnId, providerTurnId: `fixture-turn-live-${n}` });
          if (!known) { known = true; emit({ type: 'session-started', reference: STREAM_REFERENCE, folder: start.folder }); }
          emit({ type: 'message', turnId, role: 'user', itemId: `fixture-prompt-${n}`, phase: null, text: request.prompt, clientId: request.messageId });
          emit({ type: 'action-changed', turnId, kind: action });
        };

        if (states && !planning) {
          const steps = stateSteps(turnId, asked === 'states held');
          turn.stateWorkers = new Set();
          let index = 0;
          const step = (): void => {
            if (running !== turn) return;
            const current = steps[index];
            if (current !== undefined) {
              for (const event of current.events) {
                if (event.type === 'worker-started') turn.stateWorkers?.add(event.workerId);
                if (event.type === 'worker-ended') turn.stateWorkers?.delete(event.workerId);
                if (event.type === 'turn-ended') turn.parentReported = true;
                emit(event);
              }
              index += 1;
            }
            const next = steps[index];
            turn.timer = timers.set(next === undefined ? () => end(asked === 'states lost' ? 'interrupted' : 'completed', asked !== 'states lost') : step, next?.after ?? 1500);
          };
          turn.timer = timers.set(() => { if (running === turn) { open('thinking'); turn.timer = timers.set(step, steps[0]?.after ?? 0); } }, 0);
          return;
        }
        const reviewing = planning ? null : reviewAnswer(request.prompt, reviewMoved);
        if (reviewing !== null) {
          // A review's answer (M22e, B7): written a piece a step, as any answer, its block whole at its end.
          reviewMoved = reviewing.moved;
          const { text } = reviewing;
          let at = 0;
          const step = (): void => {
            if (running !== turn) return;
            if (at >= text.length) {
              emit({ type: 'message', turnId, role: 'assistant', itemId, phase: 'final', text });
              end('completed', true);
              return;
            }
            emit({ type: 'message-delta', turnId, itemId, phase: 'final', text: text.slice(at, at + stepUnits) });
            at += stepUnits;
            turn.timer = timers.set(step, stepMs);
          };
          turn.timer = timers.set(() => {
            if (running !== turn) return;
            open('writing');
            emit({ type: 'message-delta', turnId, itemId, phase: 'final', text: '' });
            turn.timer = timers.set(step, stepMs);
          }, 0);
          return;
        }

        if (planning) {
          // A plan (M22b, V8): asked in a request, or written as an item; or the turn that runs one.
          turn.timer = timers.set(() => {
            if (running !== turn) return;
            open('writing');
            if (executing) {
              emit({ type: 'message', turnId, role: 'assistant', itemId, phase: 'final', text: PLAN_MESSAGES.executed });
              end('completed', true);
              return;
            }
            const long = asked.split(/\s+/).includes(PLAN_LONG_WORD);
            if (asked.startsWith(PLAN_REQUEST_WORD)) {
              const requestId = `fixture-plan-${n}-1`;
              turn.plan = { requestId, versions: 1 };
              emit({ type: 'plan-raised', turnId, requestId, sourceId: `fixture-plan-use-${n}-1`, text: long ? STREAM_PLAN_LONG : STREAM_PLAN });
              return;
            }
            // Written a piece a step, then whole, as Codex writes one; a block of fat-g's that revises brings the next version.
            const text = long ? STREAM_PLAN_LONG : asked.includes('<fat-g-plan ') ? STREAM_PLAN_REVISED : STREAM_PLAN;
            const units = long ? LONG_STEP_UNITS : stepUnits;
            const wait = long ? LONG_STEP_MS : stepMs;
            const planItem = `fixture-plan-item-${n}`;
            emit({ type: 'plan-delta', turnId, itemId: planItem, text: '' });
            let at = 0;
            const step = (): void => {
              if (running !== turn) return;
              if (at >= text.length) {
                emit({ type: 'plan-completed', turnId, itemId: planItem, text });
                end('completed', true);
                return;
              }
              emit({ type: 'plan-delta', turnId, itemId: planItem, text: text.slice(at, at + units) });
              at += units;
              turn.timer = timers.set(step, wait);
            };
            turn.timer = timers.set(step, wait);
          }, 0);
          return;
        }

        if (approval !== null) {
          // A turn that asks leave (M22, C35): as the question's, the request is held before it is told.
          turn.timer = timers.set(() => {
            if (running !== turn) return;
            open('running');
            const say = (text: string): void => { emit({ type: 'message', turnId, role: 'assistant', itemId, phase: 'final', text }); end('completed', true); };
            if (approval === 'setup' || approval === 'unknown') { arm(approval); say(APPROVAL_MESSAGES.armed); return; }
            const actionId = `fixture-action-${n}`;
            const request = approval === 'file' ? STREAM_FILE : approval === 'command' ? STREAM_COMMAND : STREAM_GRANTED;
            const began = (workerId?: string): void => { emit({ type: 'activity-started', turnId, itemId: actionId, activityType: request.kind === 'command' ? 'command' : 'edit', name: request.tool, summary: request.summary, ...(workerId === undefined ? {} : { workerId }) }); };
            // Under the reading mode every request to act is refused, as a real one is (C6, C45).
            if (start.mode !== STREAM_ASK_FIRST) { emit({ type: 'notice', turnId, kind: 'request-refused' }); say(APPROVAL_MESSAGES.refused); return; }
            if (approval === 'denied') {
              // A rule of the configuration declined it (C76): no card, and the action's row says who.
              began();
              emit({ type: 'activity-ended', turnId, itemId: actionId, status: 'declined', declinedBy: 'rule' });
              say(APPROVAL_MESSAGES.byRule);
              return;
            }
            if (approval === 'grant' && granted) {
              // What the session's grant covers runs with no card (C14, C21).
              began();
              emit({ type: 'activity-ended', turnId, itemId: actionId, status: 'completed', exitCode: 0 });
              say(APPROVAL_MESSAGES.ran);
              return;
            }
            const requestId = `s:fixture-approval-${n}`;
            if (approval === 'worker') {
              const workerId = `fixture-worker-${n}`;
              const launchId = `fixture-launch-${n}`;
              emit({ type: 'worker-started', workerId, description: APPROVAL_WORKER });
              emit({ type: 'activity-started', turnId, itemId: launchId, activityType: 'worker', name: 'Worker', summary: APPROVAL_WORKER, pairedWorkerId: workerId });
              emit({ type: 'action-changed', turnId, kind: 'waiting' });
              turn.worker = { workerId, itemId: launchId };
              turn.approval = { requestId, itemId: actionId, request };
              emit({ type: 'approval-raised', turnId, workerId, requestId, sourceId: actionId, request });
              return;
            }
            turn.approval = { requestId, itemId: actionId, request };
            emit({ type: 'approval-raised', turnId, requestId, sourceId: actionId, request });
          }, 0);
          return;
        }

        if (variant !== null) {
          // A turn that asks (M21, C52): the request is held before it is told, since main may refuse it at once.
          turn.timer = timers.set(() => {
            if (running !== turn) return;
            open('running');
            const requestId = `fixture-request-${n}`;
            const sourceId = `fixture-question-${n}`;
            if (variant === 'worker') {
              // A sub-agent asks (C21, C42): the request names it, and its card stands in its thread.
              const workerId = `fixture-worker-${n}`;
              const launchId = `fixture-launch-${n}`;
              emit({ type: 'worker-started', workerId, description: QUESTION_WORKER });
              emit({ type: 'activity-started', turnId, itemId: launchId, activityType: 'worker', name: 'Worker', summary: QUESTION_WORKER, pairedWorkerId: workerId });
              // The session itself asks nothing: it waits on its sub-agent, and its line says so.
              emit({ type: 'action-changed', turnId, kind: 'waiting' });
              turn.worker = { workerId, itemId: launchId };
              turn.question = requestId;
              emit({ type: 'question-raised', turnId, workerId, requestId, sourceId, questions: [STREAM_QUESTION], cut: false });
              return;
            }
            turn.question = requestId;
            emit({ type: 'question-raised', turnId, requestId, sourceId, questions: variant === 'form' ? STREAM_FORM : [STREAM_QUESTION], cut: false });
            if (variant === 'lost') {
              // As an adapter's own end for a lost process (C67): the request dropped first, then the end it makes.
              turn.timer = timers.set(() => { if (running === turn && turn.question === requestId) end('interrupted', false); }, WITHDRAW_WAIT_MS);
              return;
            }
            if (variant !== 'withdrawn') return;
            // The provider takes its request back while the turn goes on (C12, C20): the card is withdrawn by the model.
            turn.timer = timers.set(() => {
              if (running !== turn || turn.question !== requestId) return;
              turn.question = null;
              emit({ type: 'question-resolved', requestId, reason: 'withdrawn' });
              emit({ type: 'message', turnId, role: 'assistant', itemId: `fixture-went-on-${n}`, phase: 'final', text: WITHDRAWN_MESSAGE });
              end('completed', true);
            }, WITHDRAW_WAIT_MS);
          }, 0);
          return;
        }

        if (work !== undefined) {
          // A turn of the fixture's own, past its last: the same twenty at every run.
          const done = fixture.activities(fixture.TURNS + n);
          const report = work === 'worker' ? fixture.workerText() : '';
          const workerId = `fixture-worker-${n}`;
          const launchId = `fixture-launch-${n}`;
          const reportId = `fixture-report-${n}`;
          let index = 0;
          let started = false;
          let told = 0;
          const step = (): void => {
            if (running !== turn) return;
            // The worker's answer, a piece a step, beside whatever the session does.
            if (told < report.length) {
              emit({ type: 'message-delta', turnId, itemId: reportId, phase: null, text: report.slice(told, told + stepUnits), workerId });
              told += stepUnits;
            }
            // The session's own tools: one starts at a step, and ends at the next.
            const activity = done[index];
            if (activity !== undefined) {
              const events = activityEvents(turnId, `fixture-${n}-${activity.id}`, activity);
              emit(started ? events.ended : events.started);
              if (started) index += 1;
              started = !started;
            }
            if (index < done.length || told < report.length) { turn.timer = timers.set(step, stepMs); return; }
            if (turn.worker !== null) {
              // The worker's whole answer completes what its deltas opened; it ends, and its item with it, before the turn's answer.
              emit({ type: 'message', turnId, role: 'assistant', itemId: reportId, phase: null, text: report, workerId });
              emit({ type: 'activity-ended', turnId, itemId: launchId, status: 'completed' });
              emit({ type: 'worker-ended', workerId, outcome: 'completed' });
              turn.worker = null;
            }
            emit({ type: 'message', turnId, role: 'assistant', itemId, phase: 'final', text: WORK_ANSWER });
            end('completed', true);
          };
          turn.timer = timers.set(() => {
            if (running !== turn) return;
            open('running');
            if (work === 'worker') {
              emit({ type: 'worker-started', workerId, description: WORK_WORKER });
              emit({ type: 'activity-started', turnId, itemId: launchId, activityType: 'worker', name: 'Worker', summary: WORK_WORKER, pairedWorkerId: workerId });
              turn.worker = { workerId, itemId: launchId };
              emit({ type: 'message-delta', turnId, itemId: reportId, phase: null, text: '', workerId });
            }
            turn.timer = timers.set(step, stepMs);
          }, 0);
          return;
        }

        const text = fixture.streamText(kind as AnswerStream);
        let at = 0;
        const step = (): void => {
          if (running !== turn) return;
          if (at >= text.length) {
            // The whole message completes what the deltas opened, with the same text.
            emit({ type: 'message', turnId, role: 'assistant', itemId, phase: 'final', text });
            end('completed', true);
            return;
          }
          emit({ type: 'message-delta', turnId, itemId, phase: 'final', text: text.slice(at, at + stepUnits) });
          at += stepUnits;
          turn.timer = timers.set(step, stepMs);
        };
        turn.timer = timers.set(() => {
          if (running !== turn) return;
          open('writing');
          emit({ type: 'message-delta', turnId, itemId, phase: 'final', text: '' });
          turn.timer = timers.set(step, stepMs);
        }, 0);
      },
      // A Stop the provider confirms: the message is left open, as far as it was written.
      stop() { end('interrupted', true); },
      /**
       * The answer to the turn's question (M21, C52): confirmed at once, then a message that asks in
       * its turn, and the turn's end. A refusal ends the turn the same way, with nothing confirmed.
       * `form` confirms nothing and says so; `worker` confirms, has the sub-agent say a line and
       * end, and then answers; `withdrawn` and `lost`, answered before their wait is over, are as
       * the plain one.
       */
      answer(requestId: string, answers: readonly GivenAnswer[] | null) {
        const turn = running;
        if (over || turn === null || turn.question !== requestId) return;
        turn.question = null;
        // The wait of a request that was to be taken back: it was answered first.
        timers.clear(turn.timer);
        const { turnId } = turn;
        if (turn.variant === 'form') {
          emit({ type: 'message', turnId, role: 'assistant', itemId: `fixture-form-${turns}`, phase: 'final', text: FORM_MESSAGE });
          end('completed', true);
          return;
        }
        if (answers !== null) emit({ type: 'question-resolved', requestId, reason: 'confirmed' });
        if (turn.variant === 'worker' && turn.worker !== null) {
          const { workerId, itemId } = turn.worker;
          emit({ type: 'message', turnId, role: 'assistant', itemId: `fixture-report-${turns}`, phase: null, text: QUESTION_WORKER_ANSWER, workerId });
          emit({ type: 'activity-ended', turnId, itemId, status: 'completed' });
          emit({ type: 'worker-ended', workerId, outcome: 'completed' });
          turn.worker = null;
          emit({ type: 'message', turnId, role: 'assistant', itemId: `fixture-stream-${turns}`, phase: 'final', text: WORK_ANSWER_ASKED });
          end('completed', true);
          return;
        }
        emit({ type: 'message', turnId, role: 'assistant', itemId: `fixture-asking-${turns}`, phase: 'final', text: QUESTION_MESSAGE, questions: QUESTION_ASKED });
        end('completed', true);
      },
      /**
       * The user skipped the turn's question (M100b, C31): confirmed at once, as Claude's CLI takes a
       * decline, then a line that says so, and the turn's end — the turn going on, as K1 saw.
       */
      decline(requestId: string) {
        const turn = running;
        if (over || turn === null || turn.question !== requestId) return;
        turn.question = null;
        timers.clear(turn.timer);
        const { turnId } = turn;
        emit({ type: 'question-resolved', requestId, reason: 'confirmed' });
        emit({ type: 'message', turnId, role: 'assistant', itemId: `fixture-declined-${turns}`, phase: 'final', text: DECLINED_MESSAGE });
        end('completed', true);
      },
      /**
       * The decision on the turn's approval (M22, C35): confirmed at once; the action then runs, or
       * is declined at the user's word, and the turn answers and ends. The session's grant is kept
       * for this process. A refusal ends the turn with nothing confirmed. The write always goes.
       */
      decide(requestId: string, choice: ApprovalChoice | null) {
        const turn = running;
        if (over || turn === null || turn.approval?.requestId !== requestId) return Promise.resolve(false);
        const { itemId: actionId, request } = turn.approval;
        turn.approval = null;
        const { turnId } = turn;
        const workerId = turn.worker?.workerId;
        const owned = workerId === undefined ? {} : { workerId };
        const say = (text: string): void => { emit({ type: 'message', turnId, role: 'assistant', itemId: `fixture-stream-${turns}`, phase: 'final', text }); end('completed', true); };
        if (choice === null) { say(APPROVAL_MESSAGES.denied); return Promise.resolve(true); }
        emit({ type: 'approval-resolved', requestId, reason: 'confirmed' });
        if (choice === 'approve-session') granted = true;
        emit({ type: 'activity-started', turnId, itemId: actionId, activityType: request.kind === 'command' ? 'command' : 'edit', name: request.tool, summary: request.summary, ...owned });
        emit(choice === 'deny'
          ? { type: 'activity-ended', turnId, itemId: actionId, status: 'declined', declinedBy: 'user', ...owned }
          : { type: 'activity-ended', turnId, itemId: actionId, status: 'completed', ...(request.kind === 'command' ? { exitCode: 0 } : {}), ...owned });
        if (turn.worker !== null) {
          emit({ type: 'activity-ended', turnId, itemId: turn.worker.itemId, status: 'completed' });
          emit({ type: 'worker-ended', workerId: turn.worker.workerId, outcome: 'completed' });
          turn.worker = null;
          say(APPROVAL_MESSAGES.workerRan);
          return Promise.resolve(true);
        }
        say(choice === 'deny' ? APPROVAL_MESSAGES.denied : APPROVAL_MESSAGES.ran);
        return Promise.resolve(true);
      },
      /**
       * The decision on the turn's plan (M22b, V8): confirmed at once. Feedback brings the next
       * version, in a request of its own; Execute runs it and ends the turn; Cancel ends it stopped.
       * A refusal ends the turn with nothing confirmed. The write always goes.
       */
      decidePlan(requestId: string, answer: PlanAnswer | null) {
        const turn = running;
        if (over || turn === null || turn.plan?.requestId !== requestId) return Promise.resolve(false);
        const { turnId } = turn;
        const say = (text: string, outcome: 'completed' | 'interrupted' = 'completed'): void => { emit({ type: 'message', turnId, role: 'assistant', itemId: `fixture-stream-${turns}`, phase: 'final', text }); end(outcome, true); };
        if (answer === null) { turn.plan = null; say(PLAN_MESSAGES.cancelled); return Promise.resolve(true); }
        emit({ type: 'plan-resolved', requestId, reason: 'confirmed' });
        if (answer.kind === 'feedback') {
          const versions = turn.plan.versions + 1;
          const next = `fixture-plan-${turns}-${versions}`;
          turn.plan = { requestId: next, versions };
          emit({ type: 'plan-raised', turnId, requestId: next, sourceId: `fixture-plan-use-${turns}-${versions}`, text: STREAM_PLAN_REVISED });
          return Promise.resolve(true);
        }
        turn.plan = null;
        if (answer.kind === 'cancel') { end('interrupted', true); return Promise.resolve(true); }
        say(PLAN_MESSAGES.executed);
        return Promise.resolve(true);
      },
      ask,
      // An aside's own Stop: its answer is left as far as it was written, and the session's turn goes on.
      stopAside(asideId) { endAside(asideId, 'interrupted', true); },
      closed,
      close() {
        if (!over) {
          over = true;
          for (const asideId of [...asking.keys()]) endAside(asideId, 'interrupted', false);
          end('interrupted', false);
          resolveClosed({ ok: true });
        }
        return closed;
      },
      recheck: () => Promise.resolve({ ok: true }),
    };
  }

  return {
    start: (start) => session(start, false),
    resume: (resume) => session(resume, true),
    modes,
    // The form's two modes differ by what a process refuses: a change is the process closed, as a provider's that declares no other is.
    transition: () => 'restart',
    onModesChanged(listener) { modeListeners.add(listener); return () => modeListeners.delete(listener); },
    sandbox,
    // Its one account plans (M22b, V8).
    plans: () => PLANS_AVAILABLE,
  };
}

const DESCRIPTOR: ProviderDescriptor = {
  id: STREAM_PROVIDER,
  displayName: 'Fixture',
  installGuidance: 'The stream form’s own provider: it plays the long-conversation fixture, and starts no CLI.',
  loginCommand: '',
  minPollIntervalSec: 60,
  // Sessions alone: no account, no usage, no history to read back, no model list. And asides (M20b,
  // V17), declared as written while they arrive: one asked with the word `whole` arrives whole all
  // the same, as a provider's would that declares so, and the tab waits for it by its own turn. And
  // questions of both kinds (M21, C52): the `question` prompt asks one as a request and one in a message.
  // And plans (M22b, V8): a plan turn under either mode, as an item or — `request` — in a request.
  capabilities: { account: false, usage: 'none', sessions: true, history: false, otherFolders: false, models: false, asides: { followUp: true, streamed: true, tools: 'none' }, questions: 'both', declines: true, permissions: STREAM_PERMISSIONS, plans: STREAM_PLANS, context: true },
};

/** The form's provider, as the registry takes any: found at once, with nothing to read but its sessions. */
export function streamDefinition(facet: SessionFacet): ProviderDefinition {
  return {
    descriptor: DESCRIPTOR,
    catalogDefaults: { presentation: { barColor: '#6b6b6b', icon: { viewBox: '0 0 24 24', path: 'M4 6H20V8H4ZM4 11H16V13H4ZM4 16H12V18H4Z' }, stream: { ground: '#2b2b2b', lights: ['#303030', '#393939', '#3e3e3e', '#424242', '#4b4b4b', '#505050'] } }, canRequestSpeedTier: false, efforts: [] },
    installationGuide: 'https://example.invalid/fat-g-stream-form',
    executableNames: [],
    installDirectoryHints: [],
    factory: () => ({
      descriptor: DESCRIPTOR,
      detect: () => Promise.resolve({ kind: 'found', installation: { source: 'path', version: null } }),
      getAccount: () => Promise.resolve({ kind: 'account', account: { authKind: 'unknown' } }),
      getUsage: () => Promise.resolve({ kind: 'empty' }),
      sessions: facet,
      dispose: () => Promise.resolve(),
    }),
  };
}

/**
 * The fixture's turns, written into the session's conversation through the store (C69): each a
 * prompt, what the turn did — its group of twenty activities (M20a, C44) — and its answer, read as
 * a provider's history is, a page a transaction, so that the window the streams arrive into is
 * full. Answers how many turns were written.
 */
export function fillConversation(store: Pick<ConversationStore, 'ensure' | 'mergePage' | 'markReached'>, fixture: StreamFixture, turns: number = fixture.TURNS): number {
  store.ensure(STREAM_SESSION, FIXTURE_EPOCH);
  let anchor: string | null = null;
  // Newest page first, each page newest first: a new turn goes directly before the one placed before it.
  for (let newest = turns; newest >= 1; newest -= MERGE_PAGE) {
    const plans: TurnPlan[] = [];
    for (let n = newest; n > Math.max(0, newest - MERGE_PAGE); n -= 1) {
      const { prompt, answer } = fixture.turn(n);
      const startedAt = FIXTURE_EPOCH + n * 60_000;
      const turn: HistoryTurn = { turnId: `fixture-turn-${n}`, outcome: 'completed', startedAt, endedAt: startedAt + 30_000, durationMs: 30_000 };
      const done = fixture.activities(n);
      // In the turn's order: the prompt, what it did, the answer.
      const messages: HistoryMessage[] = [
        { role: 'user', itemId: `fixture-u${n}`, phase: null, text: prompt, turnId: turn.turnId, at: startedAt, order: 0 },
        { role: 'assistant', itemId: `fixture-a${n}`, phase: 'final', text: answer, turnId: turn.turnId, at: startedAt, order: done.length + 1 },
      ];
      const activities: HistoryActivity[] = done.map((activity, index) => ({
        turnId: turn.turnId, itemId: `fixture-${n}-${activity.id}`, activityType: activity.type, name: activity.name, summary: activity.summary, input: activity.input, output: activity.output,
        ...(activity.file === null ? {} : { files: [{ path: activity.file, line: null }] }),
        ...(activity.exitCode === null ? {} : { exitCode: activity.exitCode }),
        status: 'completed', durationMs: 1_000, at: startedAt, order: index + 1,
      }));
      plans.push({ kind: 'new', turn, messages, activities, notShown: false });
    }
    anchor = store.mergePage(STREAM_SESSION, plans, anchor, '').anchor;
  }
  // The conversation is whole: nothing earlier is missing from it.
  store.markReached(STREAM_SESSION, [], true);
  return turns;
}

/**
 * The fixture's image turn (M23, C30): each image written under its hash into fat-g's own folder,
 * staged into the session's draft and taken by a prompt, as a pasted image is, and answered. Resolves
 * with how many images it holds; none where none was read, or where one is no image fat-g takes.
 */
export async function fillImages(store: ImageFillStore, blobs: Pick<BlobFiles, 'write'>, images: readonly StreamImage[], turns: number): Promise<number> {
  const read = images.map((image) => ({ image, header: readAttachmentHeader(image.bytes) }));
  if (read.length === 0 || read.some((entry) => entry.header.kind !== 'image')) return 0;
  // A minute after the fixture's last turn, as each of its turns is a minute after the one before.
  const at = FIXTURE_EPOCH + (turns + 1) * 60_000;
  const ids: string[] = [];
  for (const [index, { image, header }] of read.entries()) {
    if (header.kind !== 'image') return 0;
    const hash = sha256(image.bytes);
    await blobs.write(hash, header.mediaType, image.bytes);
    const id = `fixture-image-${index + 1}`;
    store.stageDraft(STREAM_SESSION, { hash, mediaType: header.mediaType, bytes: image.bytes.byteLength, width: header.width, height: header.height, stagedAt: at }, { id, name: image.name }, at, true);
    ids.push(id);
  }
  const turnId = 'fixture-turn-images';
  store.acceptPrompt({ conversationId: STREAM_SESSION, turnId, itemId: 'fixture-images-prompt', text: STREAM_IMAGE_PROMPT, at, started: true, from: { draft: { revision: 1, text: STREAM_IMAGE_PROMPT, intent: { plan: false, skill: null }, attachmentIds: ids } } });
  store.providerTook(STREAM_SESSION, turnId, 'fixture-turn-images');
  store.addItem(STREAM_SESSION, turnId, { id: 'fixture-images-answer', kind: 'message', origin: 'local', providerItemId: 'fixture-images-answer', role: 'assistant', phase: 'final', text: STREAM_IMAGE_ANSWER, cut: false, questions: [], notice: null, detail: null, receivedAt: at, providerAt: null });
  store.providerEnded(STREAM_SESSION, turnId, 'completed', at + 2_000, null, 2_000);
  store.sessionEnded(STREAM_SESSION, turnId, at + 2_000, 'completed');
  return ids.length;
}

/** What begins a block of Markdown and is no part of what is drawn of it: a quotation's mark, a heading's, a list item's. */
const BLOCK_MARK = /^(?:>\s+|#{1,6}\s+|\d+\.\s+|[-*+]\s+)/;
/** Plain words at a text's start: what is drawn as it is written, whatever follows. */
const PLAIN_WORDS = /^[A-Za-z]+(?: [A-Za-z]+){0,3}/;

/**
 * Where a seeded aside's passage lies in what the page draws of an answer (M20b, C75): its first
 * few plain words, which are drawn as they are written wherever the answer begins with a paragraph,
 * a quotation, a heading or a list item. An answer that begins with a table, a code block or a
 * task's box has no such place worked out here: its digest then holds for nothing the page draws,
 * so its passage is not painted, and its marker stands — as for a text that has changed since.
 */
export function seedPlace(answer: string): { readonly range: { readonly start: number; readonly end: number }; readonly digest: string; readonly excerpt: string } {
  const words = PLAIN_WORDS.exec(answer.replace(BLOCK_MARK, ''))?.[0] ?? '';
  const excerpt = words === '' ? answer.slice(0, 40).trim() || 'A passage.' : words;
  return { range: { start: 0, end: words.length }, digest: drawnDigest(words === '' ? `${excerpt}\u0000not drawn` : words), excerpt };
}

type AsideStore = Pick<ConversationStore, 'newestPage' | 'pageBefore' | 'acceptPrompt' | 'addItem' | 'providerEnded' | 'sessionEnded'>;

/**
 * Two hundred asides of the session, in the store from the start (M20b, V17): two about each of the
 * conversation's newest hundred answers, the first on its opening words, each an aside's own
 * conversation of one question and one answer, ended. What a session's read lists, and what the
 * page draws its markers and its passages from. Answers how many were written.
 */
export function seedAsides(store: AsideStore, count: number = SEEDED_ASIDES): number {
  const answers: { readonly id: string; readonly text: string }[] = [];
  let page = store.newestPage(STREAM_SESSION);
  for (let guard = 0; guard < 50; guard += 1) {
    for (const item of [...page.items].reverse()) {
      if (item.kind === 'message' && item.role === 'assistant' && item.phase === 'final' && answers.length * 2 < count) answers.push({ id: item.id, text: item.blocks[0]?.text ?? '' });
    }
    const oldest = page.items[0];
    if (answers.length * 2 >= count || !page.older || oldest === undefined) break;
    const before = store.pageBefore(STREAM_SESSION, oldest.id);
    if (before === null) break;
    page = before;
  }
  let made = 0;
  for (const answer of answers) {
    const place = seedPlace(answer.text);
    for (const which of [0, 1] as const) {
      if (made >= count) break;
      made += 1;
      const asideId = `57ea0000-0000-4000-8000-${String(0xa51de0000 + made).padStart(12, '0')}`;
      const turnId = `fixture-aside-turn-${made}`;
      // The first is about the answer's opening words, and is painted where they are drawn; the second about its whole first line.
      const source: AsideSource = which === 0
        ? { kind: 'message', itemId: answer.id, role: 'assistant', part: null, workerId: null, path: null, lines: { first: 1, last: 1 }, range: place.range, digest: place.digest, excerpt: place.excerpt, cut: false }
        : { kind: 'message', itemId: answer.id, role: 'assistant', part: null, workerId: null, path: null, lines: { first: 1, last: 1 }, range: { start: 0, end: 0 }, digest: drawnDigest(`${made}\u0000not drawn`), excerpt: (answer.text.split('\n')[0] ?? '').slice(0, 200) || 'A line.', cut: false };
      const at = FIXTURE_EPOCH + made * 1_000;
      store.acceptPrompt({ conversationId: asideId, turnId, itemId: `fixture-aside-question-${made}`, text: `Explain passage ${made}.`, at, started: false, aside: { parentId: STREAM_SESSION, source, title: asideTitle(source, '') } });
      store.addItem(asideId, turnId, { id: `fixture-aside-answer-${made}`, kind: 'message', origin: 'local', providerItemId: `fixture-aside-item-${made}`, role: 'assistant', phase: 'final', text: `Passage ${made} is the fixture’s own: it says nothing in particular.`, cut: false, questions: [], notice: null, detail: null, receivedAt: at + 500, providerAt: null });
      store.providerEnded(asideId, turnId, 'completed', at + 500);
      store.sessionEnded(asideId, turnId, at + 500, 'completed');
    }
  }
  return made;
}

/** The fixture, read from its file: plain JavaScript that no build holds. */
export async function loadFixture(file: string): Promise<StreamFixture> {
  const loaded = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as Partial<StreamFixture>;
  if (typeof loaded.turn !== 'function' || typeof loaded.streamText !== 'function' || !Array.isArray(loaded.STREAMS) || typeof loaded.TURNS !== 'number') throw new Error('not the long-conversation fixture');
  if (typeof loaded.activities !== 'function' || typeof loaded.workerText !== 'function' || !Array.isArray(loaded.ACTIVITY_STREAMS)) throw new Error('not the long-conversation fixture as M20a has it');
  return loaded as StreamFixture;
}

/**
 * What the page counts in this form alone (C63): its long tasks and long animation frames, each
 * with its count and its longest, and how long the newest page took to show after a session was
 * chosen. Put into the Main page by main, once it has loaded; a release build holds no such script.
 */
export const STREAM_PROBE = `(() => {
  if (window.__fatgStream) return true;
  const probe = window.__fatgStream = { tasks: 0, longestTask: 0, frames: 0, longestFrame: 0, newestPageMs: null, click: 0 };
  const watch = (type, count, longest) => {
    try {
      new PerformanceObserver((list) => { for (const entry of list.getEntries()) { probe[count] += 1; probe[longest] = Math.max(probe[longest], entry.duration); } }).observe({ type, buffered: false });
    } catch { /* this entry type is not observed here */ }
  };
  watch('longtask', 'tasks', 'longestTask');
  watch('long-animation-frame', 'frames', 'longestFrame');
  document.addEventListener('click', (event) => { probe.click = event.timeStamp; }, true);
  // The newest page's time: from the click that chose the session to two frames after its messages are there.
  let shown = false;
  new MutationObserver(() => {
    const has = document.querySelector('main[aria-label="Chat"] [data-chat-list] article') !== null;
    if (has && !shown) { const from = probe.click; requestAnimationFrame(() => requestAnimationFrame(() => { probe.newestPageMs = Math.round(performance.now() - from); console.info('[stream] the newest page showed ' + probe.newestPageMs + ' ms after the click'); })); }
    shown = has;
  }).observe(document.body, { childList: true, subtree: true });
  window.__fatgStreamReport = (label) => {
    const line = '[stream] ' + label + ': ' + probe.tasks + ' long tasks (longest ' + Math.round(probe.longestTask) + ' ms), ' + probe.frames + ' long animation frames (longest ' + Math.round(probe.longestFrame) + ' ms)' + (probe.newestPageMs === null ? '' : '; newest page ' + probe.newestPageMs + ' ms');
    console.info(line);
    probe.tasks = 0; probe.longestTask = 0; probe.frames = 0; probe.longestFrame = 0;
    return line;
  };
  return true;
})()`;

/** Asks the page for its counts since the last report, under a label, and resets them. The line is printed in the page's console, and answered. */
export const streamReport = (label: string): string => `window.__fatgStreamReport ? window.__fatgStreamReport(${JSON.stringify(label)}) : null`;

export interface StreamForm {
  readonly definition: ProviderDefinition;
  /** After the conversation store has opened, and before any window: the fixture goes in, and the session's asides. */
  fill(store: Pick<ConversationStore, 'ensure' | 'mergePage' | 'markReached'> & AsideStore): void;
  /**
   * The fixture's message with two images (M23, C30), last in the session's conversation: the images
   * written into fat-g's own folder and named in the store through the same staging and acceptance
   * as a pasted image's, so that the chat draws them through the media route. Resolves with how many.
   */
  fillImages(store: ImageFillStore, blobs: Pick<BlobFiles, 'write'>): Promise<number>;
  /** Once the Main page can be asked: its probe goes in, and each stream's end is reported from then on. */
  watch(evaluate: (script: string) => Promise<unknown>): void;
}

export interface StreamFormOptions {
  readonly fixture: StreamFixture;
  /** The fixture's two images (M23, C30), read by the launcher's bootstrap from tests/fixtures/attachments: none where it read none. */
  readonly images?: readonly StreamImage[];
  readonly log?: Pick<Console, 'info' | 'warn'>;
}

/** One of the fixture's images (M23, C30): its file's name, and its bytes. */
export interface StreamImage {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** The fixture's images, by their files' names in tests/fixtures/attachments (M23, C30). */
export const STREAM_IMAGE_FILES = ['two-colours-red-blue.png', 'two-colours-green-yellow.png'] as const;

/** What the image turn is written through: the store's own staging and acceptance (M23, C30). */
export type ImageFillStore = Pick<ConversationStore, 'stageDraft' | 'acceptPrompt' | 'providerTook' | 'addItem' | 'providerEnded' | 'sessionEnded'>;

/** The image turn's prompt and answer (M23, C30). */
export const STREAM_IMAGE_PROMPT = 'Two images are attached. Which colours fill each one’s halves?';
export const STREAM_IMAGE_ANSWER = 'The first is red on the left and blue on the right; the second green on the left and yellow on the right.';

/**
 * The stream form's session side: its provider, the fixture into the conversation, and the page's
 * counts reported around each stream. Its data folder is made ready by src/main/app/demo-stream-data.ts,
 * which is what the bootstrap loads: nothing here touches the file system.
 */
export function createStreamForm({ fixture, images = [], log = console }: StreamFormOptions): StreamForm {
  let evaluate: ((script: string) => Promise<unknown>) | null = null;
  /** The page's counts since its last report, printed here as in its console; nothing before the page can be asked. */
  const report = (label: string): void => {
    const ask = evaluate;
    if (ask !== null) void ask(streamReport(label)).then((line) => { if (typeof line === 'string') log.info(line); }, () => undefined);
  };
  const facet = streamFacet({
    fixture,
    // What the page counted before the stream — its start, the session chosen, the newest page — is
    // said apart, and the counts start again: a stream's line is the stream's alone.
    onTurnStart(kind) { report(`before the ${kind} stream`); },
    onTurnEnd(kind, outcome) {
      // A moment later: the page has drawn the completion by then, and its frames are counted.
      setTimeout(() => { report(`${kind} stream, ${outcome}`); }, 500);
    },
  });
  return {
    definition: streamDefinition(facet),
    fill(store) {
      const written = fillConversation(store, fixture);
      const asides = seedAsides(store);
      log.info(`[stream] the fixture’s ${written} turns are in the session’s conversation, with ${asides} asides about its newest answers`);
    },
    async fillImages(store, blobs) {
      const count = await fillImages(store, blobs, images, fixture.TURNS);
      if (count > 0) log.info(`[stream] the fixture’s message with ${count} images is the conversation’s last`);
      return count;
    },
    watch(ask) {
      evaluate = ask;
      void ask(STREAM_PROBE).then(() => { log.info('[stream] the page counts its long tasks and frames: send any prompt in “Fixture streams”, or mixed, fence or table, to play a stream; tools or worker plays a turn of twenty tools, the second with a sub-agent whose answer streams into its thread; question plays a turn that asks from a card, and question form, question worker, question withdrawn or question lost a card of another look; once a prompt was sent, Explain this or a side question plays an aside’s answer into its tab, whole after a wait where the question begins with “whole”'); }, () => { log.warn('[stream] the page’s probe could not be put in'); });
    },
  };
}
