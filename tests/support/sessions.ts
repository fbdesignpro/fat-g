// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Sessions for tests in both Vitest projects (node and jsdom): the fixture summaries of
// tests/fixtures/sessions (docs/planning/_archive/M14.md, C30), checked against the contract as they load, and
// builders for records and app state. Pure data and no Node APIs: tsconfig.web.json compiles this too.
import type { AppStateSnapshot } from '@shared/contracts/app-state';
import { type SendBlock, type SessionEntry, type SessionHold, type SessionsState, type SessionSummary, SessionSummarySchema, type SessionView } from '@shared/contracts/sessions';
import approval from '../fixtures/sessions/approval.json';
import error from '../fixtures/sessions/error.json';
import idle from '../fixtures/sessions/idle.json';
import manyWorkers from '../fixtures/sessions/many-workers.json';
import notStarted from '../fixtures/sessions/not-started.json';
import questions from '../fixtures/sessions/questions.json';
import readyAcknowledged from '../fixtures/sessions/ready-acknowledged.json';
import ready from '../fixtures/sessions/ready.json';
import runningSentence from '../fixtures/sessions/running-sentence.json';
import runningThinking from '../fixtures/sessions/running-thinking.json';
import runningWorkers from '../fixtures/sessions/running-workers.json';
import stopped from '../fixtures/sessions/stopped.json';
import waitingOnWorkers from '../fixtures/sessions/waiting-on-workers.json';

/** The fixtures as the files hold them, by file name: what the fixture test checks one by one. */
export const RAW_SUMMARIES: Readonly<Record<string, unknown>> = {
  'not-started': notStarted,
  idle,
  'running-thinking': runningThinking,
  'running-workers': runningWorkers,
  'running-sentence': runningSentence,
  'many-workers': manyWorkers,
  'waiting-on-workers': waitingOnWorkers,
  questions,
  approval,
  ready,
  'ready-acknowledged': readyAcknowledged,
  error,
  stopped,
};

const parse = (value: unknown): SessionSummary => SessionSummarySchema.parse(value);

/** One live summary per state a capsule can show. */
export const SUMMARIES = {
  notStarted: parse(notStarted),
  idle: parse(idle),
  runningThinking: parse(runningThinking),
  runningWorkers: parse(runningWorkers),
  /** The provider's own sentence as the label, at the clamp (C21). */
  runningSentence: parse(runningSentence),
  manyWorkers: parse(manyWorkers),
  /** The turn has ended and two workers still run (C114). */
  waitingOnWorkers: parse(waitingOnWorkers),
  questions: parse(questions),
  approval: parse(approval),
  ready: parse(ready),
  readyAcknowledged: parse(readyAcknowledged),
  error: parse(error),
  stopped: parse(stopped),
} as const;

/** When the fixtures' running turns started. */
export const TURN_STARTED_AT = 1_579_701_780_000;
/** When the sample sessions were created: 2020-01-22, 12:00 UTC. */
export const CREATED_AT = 1_579_696_800_000;

/** The two test projects every builder below can put a session under. */
export const PROJECT_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
export const PROJECT_B = 'bbbbbbbb-0000-4000-8000-00000000000b';

/** A name of exactly 60 characters: the longest a session's can be (C8, C30). */
export const LONG_NAME = 'A session whose name is exactly sixty characters long, as is';

/** A made-up UUID derived from a label, so a test can name its sessions. */
export function sessionId(label: string): string {
  let hash = 0;
  for (const char of label) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const hex = hash.toString(16).padStart(8, '0');
  return `5e55${hex.slice(4)}-0000-4000-8000-${hex.padStart(12, '0')}`;
}

/** A session's record view, named and under the first test project unless overridden. */
export function sessionView(name: string | null, overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: sessionId(name ?? `unnamed:${overrides.createdAt ?? CREATED_AT}`),
    projectId: PROJECT_A,
    providerId: 'claude',
    instanceId: 'default',
    model: 'sample-1',
    effort: 'high',
    speed: null,
    name,
    nameSource: name === null ? null : 'user',
    starred: false,
    toDo: false,
    toVerify: false,
    shelvedAt: null,
    completedAt: null,
    createdAt: CREATED_AT,
    lastActiveAt: CREATED_AT,
    ...overrides,
  };
}

/** A session with its summary; the summary's model and effort in force follow the record's. Not held, and able to take a prompt, unless said. */
export function sessionEntry(name: string | null, summary: SessionSummary = SUMMARIES.idle, overrides: Partial<SessionView> = {}, hold: SessionHold | null = null, block: SendBlock | null = hold): SessionEntry {
  const record = sessionView(name, overrides);
  return { record, summary: { ...summary, model: record.model, effort: record.effort }, hold, block, mode: null, changingMode: false, avatar: null };
}

export function sessionsState(sessions: readonly SessionEntry[], selectedId: string | null = null, orphans = 0): SessionsState {
  return { sessions, selectedId, orphans };
}

/** The app state with these sessions put in. `seq` must grow for a window to take it. */
export function withSessions(snapshot: AppStateSnapshot, sessions: SessionsState): AppStateSnapshot {
  return { ...snapshot, sessions };
}
