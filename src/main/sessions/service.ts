// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The sessions in main (docs/planning/_archive/M14.md, Design 2 and 4; decision 0010): one live summary per
// session, in memory only, beside the record the store keeps; the selection; and the record's rules.
// Created before any window opens, so the first snapshot a window receives already has the sessions.
//
//   start            summaries from the records' view → store.setSessions
//   records changed  new sessions get a summary, removed ones lose it, a removed selection clears → setSessions
//   source event     checked → known session? → turn or worker (C115) → applyEvent → record change, if any
//                    → setSessions, if it differs
//   select           selected id; notifications acknowledged, pending decisions stay lit
//   acknowledge      notifications acknowledged, pending decisions stay lit
//   main focused     the selected session's READY that arrived while the user was away acknowledged
//   quit             every running session's last turn ended as stopped → one write (C75)
//
// Electron-free, like the stores. The summaries are never written (C14): only what an event asks of
// the record is, each as one write through the store's queue (C12). The app state changes only when
// an entry, the selection or the orphan count differs (C24). Logs hold counts and kinds only, never a
// name, a reference, a path or a label (C66).
//
// Since M14b a session names one of its provider's instances, and may be held (Design 8; C29, C62):
// its provider or its instance cannot be used now, or it started in a configuration folder that is
// not the one its instance has now. Main says so in each entry; the page compares no folder.
//
// Since M18 a turn's end is the session's, and goes to two places in one step (Design 4 and 7; C29,
// C45, C54): the record's last turn, and the conversation store, which keeps it beside the
// provider's own end. What the two stores hold is reconciled through `reconcile`.
import type { Unavailable } from '@shared/contracts/availability';
import { type ResolvedAvatar, sameAvatar } from '@shared/contracts/avatars';
import { type InstanceRef, sameInstance } from '@shared/contracts/instances';
import type { ChatMode } from '@shared/contracts/permissions';
import { normalizeSessionName } from '@shared/contracts/names';
import type { ModelPreset } from '@shared/contracts/presets';
import { flagsClearedAtDone, type SessionFlag } from '@shared/contracts/session-flags';
import type { SessionOrderGroup } from '@shared/contracts/session-order';
import {
  type AgentView,
  type EventOwner,
  isActive,
  type LastTurn,
  nameReplaces,
  type SendBlock,
  type SessionCreated,
  type SessionEntry,
  SessionEventSchema,
  type SessionHold,
  type SessionRefusal,
  type SessionSaved,
  type SessionsState,
  type SessionView,
  type TurnOutcome,
} from '@shared/contracts/sessions';
import type { FolderBinding } from '../instances/binding';
import type { SessionRecord } from '../records/format';
import { normalizeRoot } from '../records/paths';
import type { RecordsStore, SessionRecipe } from '../records/store';
import type { AppStateStore } from '../state/app-state-store';
import { errorKind } from '../storage/error-kind';
import type { SummarySource } from './source';
import { acknowledged, applyEvent, isRunning, owns, type RecordEffect, type SessionState, stopped, summaryAtLaunch, turnOf, withRecord } from './summary';

type Result = SessionSaved | SessionRefusal;

export interface SessionServiceOptions {
  readonly records: RecordsStore;
  readonly store: Pick<AppStateStore, 'setSessions'>;
  readonly now?: () => number;
  /** Whose path rules a session's folder is stored by, as a root is (C6). */
  readonly platform?: string;
  readonly log?: Pick<Console, 'info' | 'warn' | 'error'>;
  /**
   * Why nothing can be asked of an instance now, or null (M14, C108; M14b, C29). Without it no
   * session is held for its provider or its instance.
   */
  readonly unavailable?: (ref: InstanceRef) => Unavailable | null;
  /**
   * The configuration folders (M14b, C61, C62): the one stored with a session's reference, and the
   * comparison that holds a session whose folder has moved. Without it none is stored or compared.
   */
  readonly binding?: FolderBinding;
  /**
   * Why a session cannot take a prompt now, or null (M15, C105): asked for each entry, with the hold
   * this service worked out. Without it no entry carries a reason.
   */
  readonly block?: (record: SessionRecord, hold: SessionHold | null) => SendBlock | null;
  /**
   * The chat's mode and where it came from (M22, C1, C40): its saved one, or what the hierarchy
   * gives it now. The runtime's word, since the conversation store holds it; without it no entry
   * carries a mode.
   */
  readonly mode?: (record: SessionRecord) => ChatMode | null;
  /** Whether a change of a session's mode is under way (M22, C90). */
  readonly changingMode?: (sessionId: string) => boolean;
  /** Whether a plan's decision waits in the chat (M22b, C56, C58): the runtime's word. Without it no entry says so. */
  readonly planPending?: (sessionId: string) => boolean;
  /**
   * Whether the session's draft or queue holds something (M23, C83): null while the conversation
   * store cannot say. An entry says so where it does; the cleanup of unstarted sessions leaves every
   * session it does not answer false for. Without it, no entry says so and the cleanup goes by the records.
   */
  readonly hasContent?: (sessionId: string) => boolean | null;
  /**
   * What a session's capsule draws (M102, C29; M103, C9): the avatar its model in force is assigned,
   * else its provider's default face. `model` is the summary's: the record's key until a source reports
   * what the session runs with. Without it, or before the scan lands, no entry carries one, and the
   * placeholder stands.
   */
  readonly avatar?: (record: SessionRecord, model: string) => ResolvedAvatar | null;
  /** A session's reference could not be stored (M15, C108): told by the session's id alone. */
  readonly onReferenceUnsaved?: (sessionId: string) => void;
  /**
   * The session's end of a turn (M18, C45, C54), told in the step that asks for the record's write:
   * when the session stops running for the turn, and when a quit stops it. The conversation store
   * keeps it; a turn it does not have — the demo source's — changes nothing there.
   */
  readonly onSessionEnded?: (sessionId: string, turnId: string, at: number, outcome: TurnOutcome) => void;
  /** Live effects only: never called while reconciling saved records. */
  readonly onTurnStarted?: () => void;
  readonly onRequestRaised?: (sessionId: string, itemId: string, kind: 'question' | 'approval') => void;
  readonly onDisposition?: (kind: 'done' | 'shelve' | 'restore') => void;
  /**
   * Whether the Main window has the focus: the selected session's READY is acknowledged as it arrives
   * only then, and one that arrives while the user is away waits for `mainFocused`.
   * Without it the window is taken to have the focus.
   */
  readonly mainHasFocus?: () => boolean;
  /** Bounds the quit's wait for the writes still pending (M15, C118). */
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

/** What the conversation store holds and a session's record lacks (M18, Design 7; C28, C29). */
export interface RecordReconciliation {
  /** The provider's session reference, with the folder and the configuration folder it started in. */
  readonly reference?: { readonly reference: string; readonly folder: string; readonly configFolder: string | null };
  /** The record's last turn, as it should read: the session's start and end alone, never the provider's. */
  readonly lastTurn?: LastTurn;
}

export interface SessionService {
  /** Takes a source's events from now on (C25). Returns the function that detaches it. */
  attach(source: SummarySource): () => void;
  /** One event, checked against its schema first. A source's `subscribe` is handed this. */
  apply(event: unknown): void;
  /** What the Main window is shown: every session with its summary, the selection, the orphan count. */
  snapshot(): SessionsState;
  /** A session's record, as saved; undefined for one the list does not show. */
  record(id: string): SessionRecord | undefined;
  /** A worker's label as the agent list has it (M14, C113; M20a, C23), or null for one the session's summary does not list. */
  workerLabel(id: string, workerId: string): string | null;
  /**
   * Whether a request's owner is current in a session (M21, C11): its turn the one that runs, or its
   * worker listed as running. False for a session the list does not show.
   */
  owns(id: string, owner: EventOwner): boolean;
  /** In a turn, or waiting on its workers after one (C114): what the quit question, Complete and Remove count. */
  isRunning(id: string): boolean;
  /** The turn a running session runs, or whose end waits on its workers (`workersOnly`); null for one that does not run. */
  runningTurn(id: string): { readonly turnId: string; readonly workersOnly: boolean } | null;
  runningCount(): number;
  runningIn(projectId: string): boolean;
  /** Whether a session of this instance runs: what its Remove asks first (M14b, C23). */
  runningOn(ref: InstanceRef): boolean;
  /**
   * Why a session cannot be used now, or null, with its folder compared first: what a change awaits,
   * and what M15's gate asks before a start, a resume or a history read (M14b, C62, C65).
   */
  hold(id: string): Promise<SessionHold | null>;
  /** The same, as far as is known without waiting: what its entry shows now. */
  holdNow(id: string): SessionHold | null;
  /** Why it cannot take a prompt now, or null (M15, C105): what its entry carries, worked out afresh. */
  blockOf(id: string): SendBlock | null;
  /**
   * Being removed, completed or shelved (M15, C109): marked in the same step as the check for a
   * running session, until the write has answered. A prompt sent to one is refused.
   */
  isLeaving(id: string): boolean;
  /**
   * A project's removal: checks that none of its sessions runs and marks them all as leaving, in one
   * step, then runs `write`. Null when one of them runs, and nothing was marked.
   */
  removingProject<T>(projectId: string, write: () => Promise<T>): Promise<T> | null;
  /**
   * Something a session's entry reads has changed (M15, C126): a provider's or an instance's status,
   * a root's missing mark, an instance gaining or losing its runtime. Holds and reasons are worked
   * out again.
   */
  availabilityChanged(): void;
  /** The instances changed, in the preferences: the folders are compared again (M14b, C62). */
  instancesChanged(): void;
  /** The avatars' scan landed, or the assignments or the catalog changed (M102, C40, C57; M103, C12): each entry's avatar is asked again. */
  avatarsChanged(): void;
  /**
   * What the conversation store holds is put into a session's record (M18, C28, C29, C55): the
   * reference by the once-only rule, the last turn as given. The writes are asked for, and the
   * summary of a session that is not running is rebuilt at once from the record as it will be, so
   * that its status and its next prompt agree with the chat whatever becomes of the writes.
   */
  reconcile(id: string, change: RecordReconciliation): void;
  /** Makes the record, then selects it (C32). `name`: one fat-g gives it in the same write, a reviewer's (M22e, C26). */
  create(projectId: string, preset: ModelPreset, name?: string): Promise<SessionCreated | SessionRefusal>;
  /**
   * One for Main, never saved; unfolds the project before selecting and acknowledging notifications.
   * A session not already selected goes first in its group, best effort, as `noteUserAction` puts it.
   */
  select(id: string): Promise<Result>;
  /** Acknowledges notifications without selecting: the Pet's click, when it has one (C34). */
  acknowledge(id: string): Result;
  /**
   * The Main window took the focus: the selected session's READY that arrived while it was away is
   * acknowledged now. Not when a press on the Pet brought it forward to open another session: that
   * session's selection acknowledges its own, and the one it leaves stays lit.
   */
  mainFocused(): void;
  /** A press on the Pet is opening this session in the Main window (decision 0010): the focus it brings is that session's. */
  revealing(id: string): void;
  /** One flag set or cleared; the others are left as they are. */
  setFlag(id: string, flag: SessionFlag, on: boolean): Promise<Result>;
  /**
   * A name the user typed (M26): normalized as every name is, refused when nothing is left, and kept
   * as the user's, which no generated or provider name replaces.
   */
  setName(id: string, name: string): Promise<Result>;
  /**
   * Refused while the session runs. Its next turn reopens it (C35), and so does `restore`. Completing
   * the selected session clears the selection, as removing it does (the maintainer).
   * A shelved session leaves the shelf, and every flag but those Done keeps is cleared.
   */
  complete(id: string): Promise<Result>;
  /**
   * Puts an active or a completed session on the shelf — a completed one is then no longer completed:
   * refused while it runs, as Done is, and it clears the selection as Done does. A session no turn has
   * run is not shelved: nothing is written. Its next turn takes it off the shelf, as a turn reopens a
   * completed session.
   */
  shelve(id: string): Promise<Result>;
  /**
   * Back to the front of its active star group, from the shelf or from the completed ones — the
   * page's Unshelve and Restore: its flags stay as they are, and so does the selection.
   */
  restore(id: string): Promise<Result>;
  move(id: string, before: string | null, group: SessionOrderGroup): Promise<Result>;
  /** Best-effort ordering only: never changes the result of already accepted work. */
  noteUserAction(id: string): void;
  /** The level is the handler's to check, against the session's own instance (M14b, C28). */
  setEffort(id: string, effort: string): Promise<Result>;
  /** The tier, or null for standard speed, is the handler's to check, as a level is (decision 0016). */
  setSpeed(id: string, speed: string | null): Promise<Result>;
  /** Refused while the session runs (C36, C96). */
  remove(id: string): Promise<Result>;
  removeOrphans(): Promise<Result>;
  /**
   * The provisional sessions a run left behind (M26, round 2): one made from the New session popup,
   * never typed into and never started, shows no capsule, so a quit that left one would leave it
   * where nothing of it can be seen. Each holds a preset and nothing more — no reference, no turn
   * and no name, which is to say no prompt was ever accepted of it, and so no saved chat — and each
   * is removed at the next launch. A session made during this run is left alone, whatever it holds
   * yet: the page is still in it. Nothing is removed while the records are refused.
   */
  removeUnstarted(): Promise<Result>;
  /**
   * The quit (C75, C105): every running summary reads STOPPED, and every running record's last turn is
   * ended as `stopped` now, in one write, each end told to the conversation store in the same step
   * (M18, C45). Resolves once that write has landed or failed; a failure is logged by kind, and holds
   * nothing. No event is taken afterwards (C74).
   *
   * It then waits for every record change an event asked for that is still under way, whether or
   * not it wrote anything itself, `waitMs` at most (M15, C118): a turn that ended in time keeps
   * its own outcome, and a write that stalls cannot keep the process trees from being ended.
   */
  endRunningTurns(waitMs?: number): Promise<void>;
  /** Resolves once every record change an event asked for has landed or failed. For tests and the smoke run. */
  settled(): Promise<void>;
  stop(): void;
}

const UNKNOWN: SessionRefusal = { status: 'refused', reason: 'unknown-session' };
const RUNNING: SessionRefusal = { status: 'refused', reason: 'running' };
const REFUSED: SessionRefusal = { status: 'refused', reason: 'records-refused' };
const NAME_EMPTY: SessionRefusal = { status: 'refused', reason: 'name-empty' };
const SAVED: SessionSaved = { status: 'saved' };

const refOf = (record: Pick<SessionRecord, 'providerId' | 'instanceId'>): InstanceRef => ({ providerId: record.providerId, instanceId: record.instanceId });

/** What the page is shown of a record: never the reference, the folder or the configuration folder (C65; M14b, C61). */
function toView(record: SessionRecord): SessionView {
  return {
    id: record.id,
    projectId: record.projectId,
    providerId: record.providerId,
    instanceId: record.instanceId,
    model: record.model,
    effort: record.effort,
    speed: record.speed,
    name: record.name,
    nameSource: record.nameSource,
    starred: record.starred,
    toDo: record.toDo,
    toVerify: record.toVerify,
    shelvedAt: record.shelvedAt,
    completedAt: record.completedAt,
    createdAt: record.createdAt,
    lastActiveAt: record.lastActiveAt,
  };
}

function sameView(a: SessionView, b: SessionView): boolean {
  return (Object.keys(a) as (keyof SessionView)[]).every((key) => a[key] === b[key]);
}

/** How long the quit waits for the session writes still pending (M15, C118). */
export const QUIT_WRITES_MS = 2000;

export function createSessionService(options: SessionServiceOptions): SessionService {
  const { records, store, now = Date.now, platform = process.platform, log = console, unavailable, binding, mainHasFocus = () => true } = options;
  /** When this run began: a session made in it is this run's own, whatever it holds (M26, round 2). */
  const startedAt = now();
  const setTimer = options.setTimer ?? ((run: () => void, ms: number): unknown => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));
  /** Sessions whose removal or completion is being written (C109). */
  const leaving = new Set<string>();
  const states = new Map<string, SessionState>();
  const shown = new Map<string, SessionEntry>();
  const counts = new Map<string, number>();
  const writes = new Set<Promise<unknown>>();
  let selectedId: string | null = null;
  /** An older fold write must not select its session after a newer selection or creation. */
  let selectionRequest = 0;
  /** The session a press on the Pet is opening, until the Main window's focus or its selection arrives. */
  let revealingId: string | null = null;
  let published: SessionsState | null = null;
  let ended = false;
  let stopListening: (() => void) | null = null;

  /** The first, the tenth, the hundredth: enough to know it happens, never enough to flood (C66). */
  function count(what: string): void {
    const total = (counts.get(what) ?? 0) + 1;
    counts.set(what, total);
    if (/^10*$/.test(String(total))) log.warn(`[sessions] event ${what}, ${total} so far`);
  }

  /**
   * What the last comparison said of each session's folder, and which comparison is the latest asked.
   * An answer stands until the next one arrives: a session is not released, then held again, each
   * time its folder is compared anew.
   */
  const moved = new Map<string, boolean>();
  const asked = new Map<string, number>();
  let asks = 0;

  /**
   * Why a session is held, as far as is known without waiting: a folder is said to have moved only
   * once its comparison has answered, and a session with no reference is never held for it (C62).
   */
  function holdOf(record: SessionRecord): SessionHold | null {
    const off = unavailable?.(refOf(record)) ?? null;
    if (off !== null) return off;
    if (binding === undefined || record.reference === null || record.configFolder === null) return null;
    return moved.get(record.id) === true ? 'folder-moved' : null;
  }

  /** Compares one session's stored folder with its instance's, and keeps the answer. */
  async function compareOne(record: SessionRecord): Promise<boolean> {
    if (binding === undefined || record.reference === null || record.configFolder === null) return false;
    asks += 1;
    const ask = asks;
    asked.set(record.id, ask);
    const answer = await binding.check(refOf(record), record.configFolder);
    // No folder to compare with: its instance is not configured, which holds it by itself.
    if (answer === 'unknown') return moved.get(record.id) === true;
    // A later comparison of the same session has the last word.
    if (asked.get(record.id) === ask) moved.set(record.id, answer === 'moved');
    return answer === 'moved';
  }

  /**
   * Asks for the comparisons: every one, when the instances changed, else those of the sessions that
   * have none yet. An answer that changes what a session shows is published.
   */
  function compare(all: boolean): void {
    if (binding === undefined) return;
    for (const record of records.getView().sessions) {
      if (record.reference === null || record.configFolder === null || (!all && moved.has(record.id))) continue;
      const before = moved.get(record.id) === true;
      void compareOne(record).then((after) => {
        if (after !== before && !ended) publish();
      });
    }
  }

  /** The summaries follow the records: a new session gets one, a removed one loses its own. */
  function sync(): void {
    const view = records.getView();
    const listed = new Set<string>();
    for (const record of view.sessions) {
      listed.add(record.id);
      const state = states.get(record.id);
      states.set(record.id, state === undefined ? summaryAtLaunch(record) : withRecord(state, record));
    }
    for (const id of [...states.keys()]) {
      if (listed.has(id)) continue;
      states.delete(id);
      shown.delete(id);
      moved.delete(id);
      asked.delete(id);
    }
    // Removing the selected session, or its project, clears the selection (C33).
    if (selectedId !== null && !listed.has(selectedId)) selectedId = null;
    publish();
    compare(false);
  }

  /**
   * Each listed sub-agent's avatar, by its own model, as the session's is resolved (M106, C17): asked
   * once per model, not once per sub-agent, since a list may hold a hundred. One with no model has
   * none here, its row drawing the session's (C16); none at all for a list that names no model. The
   * previous map is kept while every avatar in it is the same.
   */
  function agentAvatarsOf(record: SessionRecord, agents: readonly AgentView[], previous: SessionEntry['agentAvatars']): SessionEntry['agentAvatars'] {
    const resolve = options.avatar;
    if (resolve === undefined) return undefined;
    const byModel = new Map<string, ResolvedAvatar | null>();
    const next: Record<string, ResolvedAvatar | null> = {};
    for (const agent of agents) {
      if (agent.model === null) continue;
      let resolved = byModel.get(agent.model);
      if (resolved === undefined) { resolved = resolve(record, agent.model); byModel.set(agent.model, resolved); }
      next[agent.id] = resolved;
    }
    const ids = Object.keys(next);
    if (ids.length === 0) return undefined;
    const kept = previous !== undefined && Object.keys(previous).length === ids.length && ids.every((id) => id in previous && sameAvatar(previous[id] ?? null, next[id] ?? null));
    return kept ? previous : next;
  }

  function publish(): void {
    const view = records.getView();
    const sessions = view.sessions.flatMap((record): SessionEntry[] => {
      const state = states.get(record.id);
      if (state === undefined) return [];
      const previous = shown.get(record.id);
      const next = toView(record);
      const recordView = previous !== undefined && sameView(previous.record, next) ? previous.record : next;
      const hold = holdOf(record);
      const block = options.block?.(record, hold) ?? null;
      const asked = options.mode?.(record) ?? null;
      // The same mode from the same source is the same object, so an entry that did not change is not sent again.
      const mode = previous !== undefined && previous.mode !== null && asked !== null && previous.mode.id === asked.id && previous.mode.source === asked.source ? previous.mode : asked;
      const changingMode = options.changingMode?.(record.id) === true;
      const planPending = options.planPending?.(record.id) === true;
      const content = options.hasContent?.(record.id) === true;
      // The same files are the same avatar, so a Rescan that changed nothing of it sends no entry again (M102, C57).
      const resolved = options.avatar?.(record, state.summary.model) ?? null;
      const avatar = previous !== undefined && sameAvatar(previous.avatar, resolved) ? previous.avatar : resolved;
      const agentAvatars = agentAvatarsOf(record, state.summary.agents, previous?.agentAvatars);
      const same = previous !== undefined && previous.record === recordView && previous.summary === state.summary && previous.hold === hold && previous.block === block && previous.mode === mode && previous.changingMode === changingMode && (previous.planPending === true) === planPending && (previous.content === true) === content && previous.avatar === avatar && previous.agentAvatars === agentAvatars;
      // Only where one waits (M22b, C58), where a draft or a queue holds something (M23, C83), and where a sub-agent names a model (M106, C17): every other entry is as it was.
      const entry = same ? previous : { record: recordView, summary: state.summary, hold, block, mode, changingMode, ...(planPending ? { planPending } : {}), ...(content ? { content: true as const } : {}), avatar, ...(agentAvatars === undefined ? {} : { agentAvatars }) };
      shown.set(record.id, entry);
      return [entry];
    });
    const unchanged =
      published !== null &&
      published.selectedId === selectedId &&
      published.orphans === view.orphans &&
      published.sessions.length === sessions.length &&
      published.sessions.every((entry, index) => entry === sessions[index]);
    if (unchanged) return;
    published = { sessions, selectedId, orphans: view.orphans };
    store.setSessions(published);
  }

  /**
   * Sends one change to the store. The summary keeps what the event said, whatever becomes of it;
   * `unsaved` is told when the change did not reach the file, a refusal included.
   */
  function write(id: string, recipe: SessionRecipe, unsaved?: () => void): void {
    const pending = records.changeSession(id, recipe).then((answer) => {
      if (answer.status !== 'saved') unsaved?.();
    }, (error: unknown) => {
      log.error(`[sessions] a record change could not be saved (${errorKind(error)})`);
      unsaved?.();
    });
    writes.add(pending);
    void pending.finally(() => writes.delete(pending));
  }

  /** Marks these sessions as leaving until `work` has answered, whatever the answer (C109). */
  function whileLeaving<T>(ids: readonly string[], work: () => Promise<T>): Promise<T> {
    for (const id of ids) leaving.add(id);
    const lift = (): void => { for (const id of ids) leaving.delete(id); };
    let pending: Promise<T>;
    try { pending = work(); } catch (error) { lift(); return Promise.reject(error instanceof Error ? error : new Error('failed')); }
    void pending.then(lift, lift);
    return pending;
  }

  function recipeFor(effect: RecordEffect): SessionRecipe {
    switch (effect.kind) {
      case 'reference':
        // Once, with its folder in the same write, and kept from then on (C5, C6). The configuration
        // folder goes with them: the one the session's instance has now, from main and not from the
        // event (M14b, C61).
        return (record) => (record.reference !== null ? null : { reference: effect.reference, folder: effect.folder, configFolder: binding?.current(refOf(record)) ?? null });
      case 'turn-started':
        // A turn reopens a completed session, and takes a shelved one off the shelf, in the same write as its start (C35).
        return () => ({ lastTurn: { turnId: effect.turnId, startedAt: effect.at, endedAt: null, outcome: null }, lastActiveAt: effect.at, completedAt: null, shelvedAt: null });
      case 'turn-ended':
        return () => ({ lastTurn: { turnId: effect.turnId, startedAt: effect.startedAt, endedAt: effect.at, outcome: effect.outcome }, lastActiveAt: effect.at });
      case 'name':
        return (record) => (nameReplaces(record.nameSource, effect.source) ? { name: effect.name, nameSource: effect.source } : null);
    }
  }

  /** The session's end, for the conversation store (M18, C54). A failure there is the store's to tell: it holds nothing here. */
  function sessionEnded(sessionId: string, turnId: string, at: number, outcome: TurnOutcome): void {
    try {
      options.onSessionEnded?.(sessionId, turnId, at, outcome);
    } catch (error) {
      log.error(`[sessions] a turn's end could not be told (${errorKind(error)})`);
    }
  }

  function apply(raw: unknown): void {
    if (ended) return;
    const parsed = SessionEventSchema.safeParse(raw);
    if (!parsed.success) {
      count('refused (not an event)');
      return;
    }
    let event = parsed.data;
    const state = states.get(event.sessionId);
    if (state === undefined) {
      // A session the records do not hold, or one whose project cannot be read (C26).
      count('refused (unknown session)');
      return;
    }
    if (event.type === 'reference-set') {
      // Stored as a root is stored (C6); a folder that is not absolute is no folder.
      const folder = normalizeRoot(event.folder, platform);
      if (folder === null) {
        count('refused (not an event)');
        return;
      }
      event = { ...event, folder };
    }
    const applied = applyEvent(state, event, now());
    if (applied.discarded !== null) {
      count(`discarded (${applied.discarded})`);
      return;
    }
    let next = applied.state;
    // A report taken back: the summary follows the record again, at once (C103).
    if (event.type === 'in-force' && event.withdrawn === true) {
      const record = records.getSession(event.sessionId);
      if (record !== undefined) next = withRecord(next, record);
    }
    // The selected session's chat is in front of the user (M100, C49): its turn's READY is acknowledged
    // as it arrives while the Main window has the focus, so its capsule never lights. One that arrives
    // while the user is away stays lit, in the Pet too, until the window takes the focus.
    // Any other kind lights it as before.
    if (event.sessionId === selectedId && next.summary.attention?.kind === 'ready' && mainHasFocus()) next = acknowledged(next);
    if (next !== state) states.set(event.sessionId, next);
    if (event.type === 'request-raised' && event.kind !== 'plan' && !state.requests.some((request) => request.id === event.requestId)
      && next.requests.some((request) => request.id === event.requestId)) options.onRequestRaised?.(event.sessionId, event.requestId, event.kind);
    if (applied.effect !== null) {
      const { sessionId } = event;
      // A reference that did not reach the file is the runtime's to keep for the run (C108).
      write(sessionId, recipeFor(applied.effect), applied.effect.kind === 'reference' ? () => options.onReferenceUnsaved?.(sessionId) : undefined);
      // The session stopped running for the turn: the same end goes to the conversation store (M18, C54).
      if (applied.effect.kind === 'turn-started') options.onTurnStarted?.();
      if (applied.effect.kind === 'turn-ended') sessionEnded(sessionId, applied.effect.turnId, applied.effect.at, applied.effect.outcome);
    }
    if (next !== state) publish();
  }

  /** A change the Main window asked for: refused for a session the list does not show. */
  function change(id: string, recipe: SessionRecipe): Promise<Result> {
    if (records.isRefused()) return Promise.resolve(REFUSED);
    if (!states.has(id)) return Promise.resolve(UNKNOWN);
    return records.changeSession(id, recipe);
  }

  async function disposition(id: string, kind: 'done' | 'shelve' | 'restore', recipe: SessionRecipe): Promise<Result> {
    let changed = false;
    const answer = await change(id, (record) => {
      const patch = recipe(record);
      changed = patch !== null;
      return patch;
    });
    if (answer.status === 'saved' && changed) options.onDisposition?.(kind);
    return answer;
  }

  function acknowledge(id: string): boolean {
    const state = states.get(id);
    if (state === undefined) return false;
    states.set(id, acknowledged(state));
    return true;
  }

  const running = (id: string): boolean => {
    const state = states.get(id);
    return state !== undefined && isRunning(state);
  };

  /** First in its group (decision 0011, item 12): best effort, so a failure is logged and nothing else. */
  function promote(id: string): void {
    const pending = records.promoteSession(id).then((answer) => {
      if (answer.status !== 'saved') log.warn('[sessions] session order could not be saved');
    }, () => { log.warn('[sessions] session order could not be saved'); });
    writes.add(pending);
    void pending.finally(() => writes.delete(pending));
  }

  stopListening = records.subscribe(sync);
  sync();

  return {
    attach(source) {
      return source.subscribe((event) => apply(event));
    },
    apply,
    snapshot: () => published ?? { sessions: [], selectedId: null, orphans: 0 },
    record: (id) => (states.has(id) ? records.getSession(id) : undefined),
    workerLabel: (id, workerId) => states.get(id)?.summary.agents.find((agent) => agent.id === workerId)?.label ?? null,
    owns(id, owner) {
      const state = states.get(id);
      return state !== undefined && owns(state, owner);
    },
    isRunning: running,
    runningTurn(id) {
      const state = states.get(id);
      const turnId = state === undefined || !isRunning(state) ? null : turnOf(state);
      return state === undefined || turnId === null ? null : { turnId, workersOnly: state.turnId === null };
    },
    runningCount: () => [...states.values()].filter(isRunning).length,
    runningIn: (projectId) => [...states.keys()].some((id) => running(id) && records.getSession(id)?.projectId === projectId),
    runningOn: (ref) =>
      [...states.keys()].some((id) => {
        const record = running(id) ? records.getSession(id) : undefined;
        return record !== undefined && sameInstance(refOf(record), ref);
      }),

    async hold(id) {
      const record = states.has(id) ? records.getSession(id) : undefined;
      if (record === undefined) return null;
      const off = unavailable?.(refOf(record)) ?? null;
      if (off !== null) return off;
      const held = await compareOne(record);
      // What the page shows follows what was just answered.
      if (!ended) publish();
      return held ? 'folder-moved' : null;
    },

    holdNow(id) {
      const record = states.has(id) ? records.getSession(id) : undefined;
      return record === undefined ? null : holdOf(record);
    },

    blockOf(id) {
      const record = states.has(id) ? records.getSession(id) : undefined;
      return record === undefined ? null : options.block?.(record, holdOf(record)) ?? null;
    },

    isLeaving: (id) => leaving.has(id),

    removingProject(projectId, work) {
      const ids = [...states.keys()].filter((id) => records.getSession(id)?.projectId === projectId);
      if (ids.some(running)) return null;
      return whileLeaving(ids, work);
    },

    availabilityChanged() {
      if (!ended) publish();
    },

    instancesChanged() {
      if (ended) return;
      binding?.reset();
      publish();
      compare(true);
    },

    avatarsChanged() {
      if (!ended) publish();
    },

    reconcile(id, change) {
      if (ended) return;
      const state = states.get(id);
      const record = records.getSession(id);
      if (state === undefined || record === undefined) return;
      // Stored as the record stores a folder (C6); the record's own reference is never replaced (C28).
      const folder = change.reference === undefined ? null : normalizeRoot(change.reference.folder, platform);
      const reference = change.reference !== undefined && folder !== null && record.reference === null
        ? { reference: change.reference.reference, folder, configFolder: change.reference.configFolder }
        : null;
      const { lastTurn } = change;
      if (reference === null && lastTurn === undefined) return;
      const turn = lastTurn === undefined ? {} : {
        lastTurn,
        lastActiveAt: Math.max(record.lastActiveAt, lastTurn.endedAt ?? lastTurn.startedAt),
        // A turn reopens a completed session (C35): one accepted after the completion did. The same for the shelf.
        ...(record.completedAt !== null && record.completedAt < lastTurn.startedAt ? { completedAt: null } : {}),
        ...(record.shelvedAt !== null && record.shelvedAt < lastTurn.startedAt ? { shelvedAt: null } : {}),
      };
      if (!isRunning(state)) states.set(id, summaryAtLaunch({ ...record, ...(reference ?? {}), ...turn }));
      write(id, (current) => ({ ...(current.reference === null && reference !== null ? reference : {}), ...turn }), reference === null ? undefined : () => options.onReferenceUnsaved?.(id));
      publish();
    },

    async create(projectId, preset, name) {
      const request = ++selectionRequest;
      const answer = await records.createSession({ projectId, providerId: preset.providerId, instanceId: preset.instanceId, model: preset.model, effort: preset.effort, speed: preset.speed, ...(name === undefined ? {} : { name }) });
      // The store told `sync` before it answered, so the new session has its summary by now.
      if (!ended && request === selectionRequest && answer.status === 'saved' && states.has(answer.id)) {
        selectedId = answer.id;
        publish();
      }
      return answer;
    },

    async select(id) {
      const record = states.has(id) ? records.getSession(id) : undefined;
      if (ended || record === undefined) return UNKNOWN;
      const request = ++selectionRequest;
      // Queue even an unchanged flag: a manual fold may still be on its way to disk. Each
      // selection sees the latest queued value, and an expanded project causes no disk write.
      const pending = records.setCollapsed(record.projectId, false).then((answer): Result => {
        if (answer.status === 'saved') return SAVED;
        return answer.reason === 'records-refused' ? REFUSED : UNKNOWN;
      }, (): Result => ({ status: 'refused', reason: 'storage-failed' }));
      writes.add(pending);
      void pending.finally(() => writes.delete(pending));
      const answer = await pending;
      if (answer.status !== 'saved') return answer;
      if (request !== selectionRequest) return SAVED;
      if (ended) return UNKNOWN;
      if (!acknowledge(id)) return UNKNOWN;
      // Viewing acknowledges attention without changing the saved list order. Only accepted work
      // promotes a session; Ctrl+Tab keeps its separate visit history in the renderer.
      selectedId = id;
      if (revealingId === id) revealingId = null;
      publish();
      return SAVED;
    },

    acknowledge(id) {
      if (!acknowledge(id)) return UNKNOWN;
      publish();
      return SAVED;
    },

    mainFocused() {
      const pressed = revealingId;
      revealingId = null;
      if (ended || selectedId === null || (pressed !== null && pressed !== selectedId)) return;
      const state = states.get(selectedId);
      if (state === undefined || state.summary.attention?.kind !== 'ready') return;
      const next = acknowledged(state);
      if (next === state) return;
      states.set(selectedId, next);
      publish();
    },

    revealing(id) {
      revealingId = id;
    },

    setFlag: (id, flag, on) => change(id, (record) => (record[flag] === on ? null : { [flag]: on })),

    setName(id, name) {
      const normalized = normalizeSessionName(name);
      if (normalized === '') return Promise.resolve(NAME_EMPTY);
      return change(id, (record) => (record.name === normalized && record.nameSource === 'user' ? null : { name: normalized, nameSource: 'user' }));
    },

    async complete(id) {
      // The check and the mark are one step: a prompt sent after it is refused (C109).
      if (running(id)) return RUNNING;
      const answer = await whileLeaving([id], () => disposition(id, 'done', (record) => (record.completedAt === null ? { completedAt: now(), shelvedAt: null, ...flagsClearedAtDone() } : null)));
      // Done clears the selection, as a removal does (the maintainer): the session window
      // is left empty and the session drops out of the switcher's rows (the page's sessions/recent.ts).
      // Read after the write, so a session selected while it ran — an integration's next chat (M22e,
      // C11) — keeps the selection.
      if (answer.status === 'saved' && selectedId === id) {
        selectedId = null;
        if (!ended) publish();
      }
      return answer;
    },

    async shelve(id) {
      if (running(id)) return RUNNING;
      // Nothing to shelve before a first turn — no reference and no turn, as a provisional session (M26,
      // round 2) — nor once shelved: no write, and the selection stays.
      const record = states.has(id) ? records.getSession(id) : undefined;
      if (record !== undefined && (record.shelvedAt !== null || (record.reference === null && record.lastTurn === null))) return SAVED;
      const answer = await whileLeaving([id], () => disposition(id, 'shelve', (current) => (current.shelvedAt === null ? { shelvedAt: now(), completedAt: null } : null)));
      // Shelving takes the session away, as Done does.
      if (answer.status === 'saved' && selectedId === id) {
        selectedId = null;
        if (!ended) publish();
      }
      return answer;
    },

    restore: (id) => disposition(id, 'restore', (record) => (isActive(record) ? null : { shelvedAt: null, completedAt: null })),

    noteUserAction: promote,

    move(id, before, group) {
      if (records.isRefused()) return Promise.resolve(REFUSED);
      if (!states.has(id)) return Promise.resolve(UNKNOWN);
      return records.moveSession(id, before, group);
    },

    setEffort: (id, effort) => change(id, () => ({ effort })),
    setSpeed: (id, speed) => change(id, () => ({ speed })),

    remove(id) {
      if (records.isRefused()) return Promise.resolve(REFUSED);
      if (!states.has(id)) return Promise.resolve(UNKNOWN);
      if (running(id)) return Promise.resolve(RUNNING);
      return whileLeaving([id], () => records.removeSession(id));
    },

    removeOrphans: () => records.removeOrphans(),

    async removeUnstarted() {
      if (records.isRefused()) return REFUSED;
      const ids = records.getView().sessions
        .filter((record) => record.createdAt < startedAt && record.reference === null && record.lastTurn === null && record.name === null)
        // One whose draft or queue holds something stays, and one the conversation store cannot answer for (M23, C83).
        .filter((record) => options.hasContent === undefined || options.hasContent(record.id) === false)
        .map((record) => record.id);
      let answer: Result = SAVED;
      for (const id of ids) {
        // Nothing of one can be running — it has never started — but the mark is taken all the same.
        if (!states.has(id) || running(id)) continue;
        const one = await whileLeaving([id], () => records.removeSession(id));
        if (one.status !== 'saved') answer = one;
      }
      return answer;
    },

    async endRunningTurns(waitMs = QUIT_WRITES_MS) {
      const at = now();
      const recipes = new Map<string, SessionRecipe>();
      for (const [id, state] of states) {
        if (!isRunning(state)) continue;
        const startedAt = state.summary.turnStartedAt ?? at;
        // The turn that runs, or the one whose workers still do (C114).
        const turnId = turnOf(state);
        states.set(id, stopped(state, at));
        if (turnId === null) continue;
        recipes.set(id, () => ({ lastTurn: { turnId, startedAt, endedAt: at, outcome: 'stopped' }, lastActiveAt: at }));
        // To the conversation store in this same step, as the session's end: the provider's own
        // outcome, where it gave one, stays beside it (M18, C45, C54).
        sessionEnded(id, turnId, at, 'stopped');
      }
      // Nothing continues, ends or asks once fat-g is closing (C74).
      ended = true;
      publish();
      const stoppedWrite = recipes.size === 0 ? Promise.resolve() : records.changeSessions(recipes).then(() => undefined, (error: unknown) => {
        // The record keeps its missing end, which reads the same at the next launch (C105).
        log.error(`[sessions] the stopped turns could not be saved (${errorKind(error)})`);
      });
      // The writes the events asked for go to disk before this one or with it: all are waited for,
      // and none for longer than the bound (C118).
      const pending = Promise.all([stoppedWrite, ...writes]).then(() => undefined);
      let timer: unknown;
      const bound = new Promise<void>((resolve) => { timer = setTimer(resolve, waitMs); });
      await Promise.race([pending, bound]);
      clearTimer(timer);
    },

    async settled() {
      while (writes.size > 0) await Promise.all([...writes]);
    },

    stop() {
      ended = true;
      stopListening?.();
      stopListening = null;
    },
  };
}
