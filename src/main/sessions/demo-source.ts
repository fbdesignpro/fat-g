// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The demo source (docs/planning/_archive/M14.md, Design 5; C27–C29): a small summary source for development
// and smoke runs, which drives the sessions that are not completed through a fixed script on a timer,
// so the list shows every state before M15 brings a live source. Enabled by FATG_DEMO_SESSIONS
// (src/main/app/flavor.ts) and loaded only by a dynamic import behind `__FATG_SMOKE_HOOKS__`
// (src/main/index.ts), so a release bundle holds none of it; the package audit refuses it there.
//
// It starts no process, reads no file and sends no reference: a demo turn is never a real one. Its
// turns do write the last turn and the last-active time, as any source's do (C10). With `seed` it
// also adds three sessions to each project that has none, through the same create path as Start
// session, on its provider's first instance (M14b, C31). Its names, labels and worker descriptions
// are the fixed strings below: no user data feeds it. Two of its three workers name the session's own
// model and the third none, so that a row is drawn with its avatar and one assumed (M106, C39).
import type { CatalogState } from '@shared/contracts/catalog';
import { FIRST_INSTANCE_ID } from '@shared/contracts/instances';
import { defaultPreset, type ModelPreset, presetTiles } from '@shared/contracts/presets';
import { isActive, type SessionCreated, type SessionEvent, type SessionRefusal, type SessionsState } from '@shared/contracts/sessions';
import type { SessionEventListener, SummarySource } from './source';

/** How long one frame of the script lasts, unless the smoke run shortens it. */
export const DEMO_STEP_MS = 2500;
/** How many frames apart two neighbouring sessions start, so the list shows every state at once. */
export const DEMO_PHASE = 3;
const SEEDED_PER_PROJECT = 3;
const SEED_NAMES = ['Create plan', 'Fix login', 'Review the notes'];
/** What the secretary would make of each (M26): reported at the frame after the seed, as a title comes a few seconds after the first prompt. */
const SEED_TITLES = ['Plan the next release', 'Fix the login form', 'Review the meeting notes'];
const SENTENCE = 'I’ll read sample.txt to find the cat’s name, then compare it with the other notes in the folder.';
const WORKERS = ['Explore the login flow', 'Run the test suite', 'Check the release notes'];

type Event = DistributiveOmit<SessionEvent, 'sessionId'>;
type DistributiveOmit<U, K extends PropertyKey> = U extends unknown ? Omit<U, K> : never;

/** One session's place in the script: the frame it shows next, the ids of its current turn, and the model its record names. */
interface Position {
  frame: number;
  turns: number;
  model: string;
}

const turnId = (position: Position): string => `demo-turn-${position.turns}`;
const workerId = (position: Position, index: number): string => `demo-worker-${position.turns}-${index}`;

/**
 * The script (Design 5): ten steps, a step with a "then" being two frames. After the last frame a
 * session goes back to the second one, a new turn.
 */
const SCRIPT: readonly ((position: Position) => Event[])[] = [
  // 1. Nothing: the capsule reads Not started, or what the last launch left.
  () => [],
  // 2. A turn starts.
  (p) => {
    p.turns += 1;
    return [{ type: 'turn-started', turnId: turnId(p) }, { type: 'action-changed', turnId: turnId(p), kind: 'thinking' }];
  },
  // 3. Reading a file; then a provider's own sentence, at the clamp.
  (p) => [{ type: 'action-changed', turnId: turnId(p), kind: 'reading', file: 'notes.txt' }],
  (p) => [{ type: 'action-changed', turnId: turnId(p), kind: 'writing', line: SENTENCE }],
  // 4. Three workers start, and each progresses; then two end.
  (p) => WORKERS.flatMap((description, index): Event[] => [
    { type: 'worker-started', workerId: workerId(p, index), description, ...(index === 2 ? {} : { model: p.model }) },
    { type: 'worker-progressed', workerId: workerId(p, index), kind: index === 1 ? 'running' : 'reading', ...(index === 1 ? {} : { file: `module-${index + 1}.ts` }) },
  ]),
  (p) => [{ type: 'worker-ended', workerId: workerId(p, 1), outcome: 'completed' }, { type: 'worker-ended', workerId: workerId(p, 2), outcome: 'failed' }],
  // 5. A request of one question; then one of two: "3 questions" (M100b, C24).
  (p) => [{ type: 'action-changed', turnId: turnId(p), kind: 'asking' }, { type: 'request-raised', owner: { turnId: turnId(p) }, requestId: `${turnId(p)}-q1`, kind: 'question', count: 1 }],
  (p) => [{ type: 'request-raised', owner: { turnId: turnId(p) }, requestId: `${turnId(p)}-q2`, kind: 'question', count: 2 }],
  // 6. Both answered, and the turn ends with one worker still running: "Waiting on 1 worker".
  (p) => [
    { type: 'request-resolved', owner: { turnId: turnId(p) }, requestId: `${turnId(p)}-q1` },
    { type: 'request-resolved', owner: { turnId: turnId(p) }, requestId: `${turnId(p)}-q2` },
    { type: 'turn-ended', turnId: turnId(p), outcome: 'completed' },
  ],
  // 7. The last worker ends: READY.
  (p) => [{ type: 'worker-ended', workerId: workerId(p, 0), outcome: 'completed' }],
  // 8. Another turn, and an approval; then it is answered.
  (p) => {
    p.turns += 1;
    return [
      { type: 'turn-started', turnId: turnId(p) },
      { type: 'action-changed', turnId: turnId(p), kind: 'running' },
      { type: 'request-raised', owner: { turnId: turnId(p) }, requestId: `${turnId(p)}-a1`, kind: 'approval', count: 1 },
    ];
  },
  (p) => [{ type: 'request-resolved', owner: { turnId: turnId(p) }, requestId: `${turnId(p)}-a1` }, { type: 'action-changed', turnId: turnId(p), kind: 'tool' }],
  // 9. The turn fails: ERROR.
  (p) => [{ type: 'turn-ended', turnId: turnId(p), outcome: 'failed' }],
  // 10. A pause, then step 2 again.
  () => [],
];
/** Where a session goes after the last frame: step 2. */
const LOOP_TO = 1;

export const DEMO_FRAMES = SCRIPT.length;

export interface DemoProject {
  readonly id: string;
  /** The providers the project is enabled for, switched-off ones left out. */
  readonly providers: readonly string[];
  /** How many session entries it holds. */
  readonly sessions: number;
}

export interface DemoSourceOptions {
  /** The sessions as the service shows them. */
  readonly sessions: () => SessionsState;
  /** `FATG_DEMO_SESSIONS=seed` only: what a seed needs, and the service's own create (C29). */
  readonly seed?: {
    readonly projects: () => readonly DemoProject[];
    readonly catalog: () => CatalogState | undefined;
    readonly create: (projectId: string, preset: ModelPreset) => Promise<SessionCreated | SessionRefusal>;
  };
  readonly stepMs?: number;
  readonly timers?: { readonly setInterval: (run: () => void, ms: number) => unknown; readonly clearInterval: (handle: unknown) => void };
  readonly log?: Pick<Console, 'info' | 'warn'>;
}

export interface DemoSource extends SummarySource {
  /** Shows each session's first frame at once, then one frame per step. */
  start(): void;
  stop(): void;
  /** The smoke run compares what every page shows with main's state, and holds the script still for it. */
  pause(): void;
  resume(): void;
  /** One frame now, for every session. What the timer calls. */
  tick(): void;
}

export function createDemoSource(options: DemoSourceOptions): DemoSource {
  const { sessions, seed, stepMs = DEMO_STEP_MS, log = console } = options;
  const timers = options.timers ?? { setInterval: (run: () => void, ms: number) => setInterval(run, ms), clearInterval: (handle: unknown) => clearInterval(handle as NodeJS.Timeout) };
  const listeners = new Set<SessionEventListener>();
  const positions = new Map<string, Position>();
  const seeding = new Set<string>();
  /** Seeded sessions whose generated title is still to come (M26). */
  const titles = new Map<string, string>();
  let driven = 0;
  let timer: unknown = null;
  let running = false;

  const send = (sessionId: string, events: readonly Event[]): void => {
    for (const event of events) for (const listener of listeners) listener({ ...event, sessionId });
  };

  /** A session's next frame. */
  function advance(id: string, position: Position): void {
    const frame = SCRIPT[position.frame];
    if (frame !== undefined) send(id, frame(position));
    position.frame = position.frame + 1 >= SCRIPT.length ? LOOP_TO : position.frame + 1;
  }

  function tick(): void {
    const active = sessions().sessions.filter((entry) => isActive(entry.record));
    const listed = new Set(active.map((entry) => entry.record.id));
    // A completed, shelved or removed session is left alone from then on: a turn would reopen it (C35).
    for (const id of [...positions.keys()]) if (!listed.has(id)) positions.delete(id);
    for (const [id, title] of [...titles]) {
      titles.delete(id);
      if (listed.has(id)) send(id, [{ type: 'name-reported', name: title, source: 'generated' }]);
    }
    for (const { record } of active) {
      let position = positions.get(record.id);
      if (position === undefined) {
        // A session new to the script starts some frames in, each at a different one, and is shown
        // there at once: the frames before it are played without waiting.
        position = { frame: 0, turns: 0, model: record.model };
        positions.set(record.id, position);
        const offset = (driven * DEMO_PHASE) % SCRIPT.length;
        driven += 1;
        for (let played = 0; played < offset; played += 1) advance(record.id, position);
      }
      position.model = record.model;
      advance(record.id, position);
    }
    if (seed !== undefined) void plant(seed);
  }

  /** Three sessions for each project that has none, once one of its providers lists a model (C29). */
  async function plant(given: NonNullable<DemoSourceOptions['seed']>): Promise<void> {
    for (const project of given.projects()) {
      if (project.sessions > 0 || seeding.has(project.id)) continue;
      // The first instances only: an added account is the user's to start a session on (C31).
      const preset = defaultPreset(presetTiles(given.catalog(), project.providers.map((providerId) => ({ providerId, instanceId: FIRST_INSTANCE_ID }))));
      if (preset === null) continue;
      seeding.add(project.id);
      try {
        // The last name first: a new session goes before its project's others (C11).
        for (const [index, name] of SEED_NAMES.slice(0, SEEDED_PER_PROJECT).map((seedName, at) => [at, seedName] as const).reverse()) {
          const created = await given.create(project.id, preset);
          if (created.status !== 'saved') break;
          // Of the lowest rank, so any real name replaces it (C9); a generated one follows (M26).
          send(created.id, [{ type: 'name-reported', name, source: 'first-message' }]);
          const title = SEED_TITLES[index];
          if (title !== undefined) titles.set(created.id, title);
        }
      } catch {
        log.warn('[sessions] the demo source could not seed a project');
      } finally {
        seeding.delete(project.id);
      }
    }
  }

  const arm = (): void => {
    if (timer === null) timer = timers.setInterval(tick, stepMs);
  };
  const disarm = (): void => {
    if (timer !== null) timers.clearInterval(timer);
    timer = null;
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      if (running) return;
      running = true;
      log.info(`[sessions] demo source on${seed === undefined ? '' : ' (seed)'}`);
      tick();
      arm();
    },
    stop() {
      running = false;
      disarm();
      listeners.clear();
    },
    pause: disarm,
    resume() {
      if (running) arm();
    },
    tick,
  };
}
