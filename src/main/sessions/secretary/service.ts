// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The secretary (docs/planning/_archive/M26.md, Design 1 and 4, round 2; decision 0028): small one-shot
// requests a session's own instance answers in a process of its own, with no tool and nothing kept.
// Its tasks are a new session's title, asked at the first prompt, and a description of a session no
// turn has run, asked from its unsent draft; each is reported as a `generated` name, which the ladder
// lets replace the first-prompt name and nothing above it.
//
// It names no provider and starts no process: the instance's session facet answers, or there is no
// title. It reads the catalog and the preferences as main gives them, and writes nothing but the
// name's event. What it sends is conversation content: it logs counts and failure kinds alone,
// never a prompt, a reply or a title (decision 0019, item 13).
import { catalogEntry } from '@shared/contracts/presets';
import type { CatalogState } from '@shared/contracts/catalog';
import type { InstanceRef } from '@shared/contracts/instances';
import type { SessionEvent } from '@shared/contracts/sessions';
import { SESSION_TITLE_MODEL } from '@shared/contracts/title-model';
import type { SecretaryAnswer, SessionFacet } from '@shared/provider-kit/sessions';
import type { SecretaryTask } from './task';
import { DRAFT_TASK } from './draft';
import { TITLE_TASK } from './title';

/** What a request is asked for: the session's instance and the model its record holds. */
export interface TitledSession {
  readonly providerId: string;
  readonly instanceId: string;
  /** The catalog's key. */
  readonly model: string;
}

/** The two settings of `titles` (M26, Design 6). */
export interface TitleSettings {
  readonly generated: boolean;
  /** By provider id: a catalog key, or SESSION_TITLE_MODEL. Absence means Latest small model. */
  readonly models: Readonly<Record<string, string>>;
}

export interface SecretaryOptions {
  /** The session facet of an instance, where one runs. */
  readonly facet: (ref: InstanceRef) => SessionFacet | undefined;
  readonly catalog: () => CatalogState | undefined;
  readonly settings: () => TitleSettings;
  /** The session service's `apply`. */
  readonly apply: (event: SessionEvent) => void;
  /** Counts and failure kinds only. */
  readonly log?: Pick<Console, 'warn'>;
  /** Tests only. */
  readonly deadlineMs?: number;
  readonly perInstance?: number;
}

export interface Secretary {
  /**
   * Asks for the session's title from its first prompt, unless the switch is off, the instance has
   * no secretary or the prompt is a bare CLI command. Answers at once; the name comes later, or never.
   */
  title(sessionId: string, session: TitledSession, prompt: string): void;
  /**
   * Asks for a description of a session no turn has run, from the text standing unsent in its
   * composer (round 2), under the same conditions. Whether a request went out: the channel says
   * `taken` or `skipped` by it, and the name, here too, comes later or never.
   */
  draft(sessionId: string, session: TitledSession, draft: string): boolean;
  /** Lets go of the session's request, queued or running: its answer is nobody's. */
  forget(sessionId: string): void;
  /** Lets go of every request. Nothing is asked afterwards. */
  dispose(): void;
}

/** How long a request may take, from its start: the CLI's launch included. */
export const SECRETARY_DEADLINE_MS = 30_000;
/** How many requests run at once for one instance; the others wait their turn. */
export const SECRETARY_PER_INSTANCE = 2;

type Outcome = 'named' | 'empty' | 'timeout' | 'failed' | 'no-model';

interface Job {
  readonly sessionId: string;
  readonly key: string;
  /** Its own task's: a reply is read by the task that asked for it. */
  readonly parse: (reply: string) => string | null;
  readonly run: (signal: AbortSignal) => Promise<SecretaryAnswer>;
  readonly controller: AbortController;
  timedOut: boolean;
}

const keyOf = (ref: InstanceRef): string => `${ref.providerId}\u0000${ref.instanceId}`;

export function createSecretary(options: SecretaryOptions): Secretary {
  const deadlineMs = options.deadlineMs ?? SECRETARY_DEADLINE_MS;
  const perInstance = options.perInstance ?? SECRETARY_PER_INSTANCE;
  const jobs = new Map<string, Job>();
  const queued: Job[] = [];
  const running = new Map<string, number>();
  const counts = new Map<Outcome, number>();
  let disposed = false;

  /** The 1st, 10th and 100th of each kind, as the runtime counts. */
  function count(outcome: Outcome): void {
    const seen = (counts.get(outcome) ?? 0) + 1;
    counts.set(outcome, seen);
    if (outcome !== 'named' && (seen === 1 || seen === 10 || seen === 100)) options.log?.warn(`[secretary] a title was not given (${outcome}; ${seen} so far)`);
  }

  /** Resolve against the current account's catalog on every request; never pin the automatic choice. */
  function modelFor(session: TitledSession): { model: string; effort: string | null } | null {
    const entry = catalogEntry(options.catalog(), { providerId: session.providerId, instanceId: session.instanceId });
    const chosen = options.settings().models[session.providerId];
    const listed = (key: string | undefined) => (key === undefined ? undefined : entry?.models.find((model) => model.key === key));
    const preferred = chosen === undefined ? entry?.smallModel : chosen === SESSION_TITLE_MODEL ? session.model : chosen;
    const model = listed(preferred) ?? listed(session.model);
    if (model !== undefined) return { model: model.key, effort: model.efforts.find((effort) => !effort.caution)?.id ?? null };
    // A catalog that lists nothing yet still has the session's model: it named it at its start.
    return entry === undefined || entry.models.length === 0 ? { model: session.model, effort: null } : null;
  }

  function start(job: Job): void {
    running.set(job.key, (running.get(job.key) ?? 0) + 1);
    const timer = setTimeout(() => { job.timedOut = true; job.controller.abort(); }, deadlineMs);
    void job.run(job.controller.signal)
      .catch((): SecretaryAnswer => ({ kind: 'failed', reason: 'unavailable' }))
      .then((answer) => {
        clearTimeout(timer);
        const mine = jobs.get(job.sessionId) === job;
        if (mine) jobs.delete(job.sessionId);
        // A request let go of is nobody's: its answer, whatever it is, names nothing.
        if (mine && !disposed && !job.controller.signal.aborted && answer.kind === 'answered') {
          const name = job.parse(answer.text);
          if (name === null) count('empty');
          else {
            options.apply({ type: 'name-reported', sessionId: job.sessionId, name, source: 'generated' });
            count('named');
          }
        } else if (job.timedOut) count('timeout');
        else if (answer.kind === 'failed' && answer.reason !== 'aborted') count('failed');
        running.set(job.key, (running.get(job.key) ?? 1) - 1);
        next(job.key);
      });
  }

  function next(key: string): void {
    if (disposed) return;
    while ((running.get(key) ?? 0) < perInstance) {
      const index = queued.findIndex((job) => job.key === key);
      if (index < 0) return;
      const [job] = queued.splice(index, 1);
      if (job !== undefined) start(job);
    }
  }

  function forget(sessionId: string): void {
    const job = jobs.get(sessionId);
    if (job === undefined) return;
    jobs.delete(sessionId);
    const index = queued.indexOf(job);
    if (index >= 0) queued.splice(index, 1);
    job.controller.abort();
  }

  /**
   * One request of a task's, on the user's own text: the switch, the instance's secretary and a
   * model it lists are each needed, and a request of that session's already under way is let go of,
   * so a session has at most one. Whether one went out.
   */
  function ask(task: SecretaryTask<string>, sessionId: string, session: TitledSession, source: string): boolean {
    if (disposed || !options.settings().generated) return false;
    // A bare command has no description; a command or skill with arguments can name the work.
    if (/^\/\S*$/u.test(source.trim())) return false;
    const ref: InstanceRef = { providerId: session.providerId, instanceId: session.instanceId };
    const secretary = options.facet(ref)?.secretary;
    if (secretary === undefined) return false;
    const resolved = modelFor(session);
    if (resolved === null) { count('no-model'); return false; }
    forget(sessionId);
    const request = { instructions: task.instructions, text: task.input(source), model: resolved.model, effort: resolved.effort };
    const job: Job = { sessionId, key: keyOf(ref), parse: task.parse, run: (signal) => secretary(request, signal), controller: new AbortController(), timedOut: false };
    jobs.set(sessionId, job);
    queued.push(job);
    next(job.key);
    return true;
  }

  return {
    title(sessionId, session, prompt) {
      ask(TITLE_TASK, sessionId, session, prompt);
    },
    draft: (sessionId, session, draft) => ask(DRAFT_TASK, sessionId, session, draft),
    forget,
    dispose() {
      disposed = true;
      queued.length = 0;
      for (const job of jobs.values()) job.controller.abort();
      jobs.clear();
    },
  };
}
