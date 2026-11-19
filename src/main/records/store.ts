// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// fat-g's own records: projects and, since M14, sessions (decision 0011; docs/planning/_archive/M12.md, Design 2
// and 3; M14.md, Design 1). Main process only, Electron-free: the folder, clock and file system arrive
// as options.
//
// Changes queue up and are applied in order, against the latest state (C10). With no write running,
// a change is applied to a copy of the saved document and written at once; the changes that arrive
// meanwhile wait, and go to disk together in the next write. Each request answers once its change
// is on disk, and a failed write changes nothing — memory, view and file stay as they were (C9). So
// a change a window asked for is never pending at quit. The one write that starts at quit — the
// running turns ended as stopped (M14, C75) — is awaited in the shutdown's drain (src/main/app/shutdown.ts).
//
// The store is the file's keeper: what a session's fields mean, and when they change, is the session
// service's (src/main/sessions), which hands its changes here as recipes (M14, C12, C25).
//
// A file fat-g cannot read stays exactly as it is, and every change but Start fresh is refused, until
// the user chooses Start fresh and confirms it (C5, C61) — or, for a file that could not be opened,
// Try again (C67).
import { randomUUID } from 'node:crypto';
import type { ModelPreset } from '@shared/contracts/presets';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type {
  ProjectColor,
  ProjectRefusal,
  ProjectSaved,
  RecordsRefusalCause,
  RecordsStatus,
  TrustAnswer,
} from '@shared/contracts/projects';
import { normalizeSessionName } from '@shared/contracts/names';
import { type SessionCreated, type SessionRefusal, type SessionSaved } from '@shared/contracts/sessions';
import { moveSessionEntry, promoteSessionEntry, sameSessionOrderGroup, sessionOrderGroup, type SessionOrderGroup } from '@shared/contracts/session-order';
import type { RetryResult, StartFreshResult } from '@shared/contracts/stored-file';
import { writeFileAtomic } from '../storage/atomic-write';
import { plainObject, readEnvelope } from '../storage/envelope';
import { readJsonFile, readTextFile, serializeJson, type ReadText } from '../storage/json-file';
import { nodeSetAsideIo, setAside, type SetAsideIo } from '../storage/set-aside';
import {
  type ProjectRecord,
  type RawDocument,
  readProject,
  isChangeableField,
  readSession,
  RECORDS_FILE,
  RECORDS_VERSION,
  type SessionChange,
  type SessionRecord,
  storedId,
  storedProjectId,
  trustAnswer,
} from './format';

// ── What the store shows ──────────────────────────────────────────────────────────────────────

export interface StoredProject {
  readonly kind: 'project';
  readonly key: string;
  readonly id: string;
  readonly name: string;
  readonly color: ProjectColor | null;
  readonly hidden: boolean;
  readonly collapsed: boolean;
  /** Registered providers only, in the registry's order (C12). */
  readonly providers: readonly string[];
  readonly roots: readonly { readonly path: string; readonly trust: TrustAnswer | null }[];
  /** How many session entries its removal takes with it (M14, C13, C57). */
  readonly sessions: number;
  /** Its default mode for each registered provider that has one (M22, C40). */
  readonly permissionModes: Readonly<Record<string, string>>;
}

export type StoredEntry = StoredProject | { readonly kind: 'unreadable'; readonly key: string; readonly sessions: number };

export interface RecordsView {
  readonly status: RecordsStatus;
  /** In stored order (C15). */
  readonly projects: readonly StoredEntry[];
  /** The readable sessions whose project is readable, in stored order (M14, C3, C11). */
  readonly sessions: readonly SessionRecord[];
  /** Session entries no project's removal reaches (M14, C107). */
  readonly orphans: number;
}

// ── What it is asked ──────────────────────────────────────────────────────────────────────────

export interface ProjectInput {
  /** Already normalized, and not empty (C16). */
  readonly name: string;
  readonly roots: readonly { readonly path: string; readonly trust: TrustAnswer }[];
  /** Registered ids only (the handler refuses others). */
  readonly providers: readonly string[];
  /**
   * The project's default mode for each provider that has one (M22, C40), by registered provider
   * id: a provider left out uses the user's default. Left out whole, what is stored stays.
   */
  readonly permissionModes?: Readonly<Record<string, string>>;
}

export type ChangeResult = ProjectSaved | ProjectRefusal;
export type AddResult = { readonly status: 'saved'; readonly id: string } | ProjectRefusal;
export type SessionResult = SessionSaved | SessionRefusal;

export interface SessionInput {
  readonly projectId: string;
  readonly providerId: string;
  /** Which of the provider's instances runs it, already checked against the preferences (M14b, C25). */
  readonly instanceId: string;
  /** The catalog's key, effort id and speed tier, already checked against the catalog (M14, C32; decision 0016). */
  readonly model: string;
  readonly effort: string | null;
  readonly speed: string | null;
  /** A name fat-g gives it in the same write, as a `generated` one (M22e, C26): a reviewer's. Left out, it has none yet. */
  readonly name?: string;
}

/**
 * A change to one session, worked out against the record as the queue has it (M14, C12): the fields
 * to set, or nothing. Called inside the queue, so it must not wait.
 */
export type SessionRecipe = (record: SessionRecord) => SessionChange | null;

/** Whether the folder picker returned this path in this run (C23). */
export type PickedInRun = (root: string) => boolean;

export interface RecordsStore {
  getView(): RecordsView;
  /** Called after every change of the view. Returns the function that unsubscribes. */
  subscribe(listener: () => void): () => void;
  isRefused(): boolean;
  /** A readable project, as saved. */
  getProject(id: string): ProjectRecord | undefined;
  /** Every root of every readable project, for the missing check (C29). */
  allRoots(): readonly string[];
  add(input: ProjectInput & { readonly color: ProjectColor }, picked: PickedInRun): Promise<AddResult>;
  /** `color` left out keeps the stored one, one this build does not know included (C12). */
  update(id: string, input: ProjectInput & { readonly color?: ProjectColor }, picked: PickedInRun): Promise<ChangeResult>;
  setHidden(id: string, hidden: boolean): Promise<ChangeResult>;
  setCollapsed(id: string, collapsed: boolean): Promise<ChangeResult>;
  move(id: string, hidden: boolean, before: string | null): Promise<ChangeResult>;
  /** Takes, in the same write, every session entry storing the entry's id as its project (M14, C13). */
  remove(key: string): Promise<ChangeResult>;
  /** A readable session, as saved. */
  getSession(id: string): SessionRecord | undefined;
  /** A new session before its project's others, with no reference, folder or name yet (M14, C4, C10, C11). */
  createSession(input: SessionInput): Promise<SessionCreated | SessionRefusal>;
  /** One write, or none when the recipe changes nothing (M14, C12). */
  changeSession(id: string, recipe: SessionRecipe): Promise<SessionResult>;
  /** The sole exception to fixed model/account fields: an unstarted draft, guarded by the runtime. */
  setDraftPreset(id: string, preset: ModelPreset): Promise<SessionResult>;
  /** The same for several sessions, in one write: the quit (M14, C75). Unknown ids are passed over. */
  changeSessions(recipes: ReadonlyMap<string, SessionRecipe>): Promise<SessionSaved | SessionRefusal>;
  /** Before `before`, or after the last of its group in its project (M14, C11, C55). */
  moveSession(id: string, before: string | null, group: SessionOrderGroup): Promise<SessionResult>;
  /** Accepted user work: first within its current project, lifecycle and star group. */
  promoteSession(id: string): Promise<SessionResult>;
  removeSession(id: string): Promise<SessionResult>;
  /** Deletes the session entries no project's removal reaches, in one write (M14, C107). */
  removeOrphans(): Promise<SessionSaved | SessionRefusal>;
  /**
   * The ids of the session entries an entry's removal takes with it, and of those no project's
   * removal reaches, as the file stores them, readable or not (M18, C21, C30): whose saved chats a
   * removal deletes too.
   */
  sessionIdsTaken(key: string): readonly string[];
  orphanIds(): readonly string[];
  startFresh(): Promise<StartFreshResult>;
  retry(): RetryResult;
}

export interface RecordsStoreOptions {
  readonly dir: string;
  /** The registry's providers, in its order: what the view lists (C12). */
  readonly providerIds?: readonly string[];
  /** Whose path rules decide what an absolute root is. */
  readonly platform?: string;
  /** The format this build reads and writes; tests raise it to see an older file refused (C7). */
  readonly version?: number;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly log?: Pick<Console, 'info' | 'warn' | 'error'>;
  readonly write?: (filePath: string, data: string) => Promise<void>;
  readonly readFile?: ReadText;
  readonly setAsideIo?: SetAsideIo;
}

// ── Inside ────────────────────────────────────────────────────────────────────────────────────

interface Entry {
  /** A project's id, or for an unreadable entry a key made for this run and never written (C60). */
  readonly key: string;
  /** Exactly what the file holds, and what is written back. */
  raw: unknown;
  /** Null for an entry this build cannot read. */
  record: ProjectRecord | null;
}

interface SessionEntry {
  /** Exactly what the file holds, and what is written back. */
  raw: unknown;
  /** Null for an entry this build cannot read (M14, C3). */
  record: SessionRecord | null;
}

interface Document {
  /** Everything at the top of the file; `entries` and `sessions` replace its two lists when written. */
  readonly top: RawDocument;
  entries: Entry[];
  sessions: SessionEntry[];
}

type State =
  | { readonly kind: 'refused'; readonly cause: RecordsRefusalCause }
  | { readonly kind: 'loaded'; readonly doc: Document; readonly keptAs: string | null };

type Applied<R> = { readonly result: R; readonly changed: boolean };
type Operation<R> = (doc: Document) => Applied<R>;

interface Pending {
  readonly operation: Operation<unknown>;
  resolve(result: unknown): void;
  reject(error: unknown): void;
}

const REFUSED: ProjectRefusal & SessionRefusal = { status: 'refused', reason: 'records-refused' };
const UNKNOWN: ProjectRefusal & SessionRefusal = { status: 'refused', reason: 'unknown-project' };
const UNKNOWN_SESSION: SessionRefusal = { status: 'refused', reason: 'unknown-session' };
const OUTSIDE_GROUP: SessionRefusal = { status: 'refused', reason: 'outside-group' };
const SAVED: ProjectSaved = { status: 'saved' };

/**
 * Which session entries each project entry's removal takes, and which none reaches (M14, Design 1).
 * Matched on the ids the file stores, readable or not: an id two project entries store takes no
 * session with either, and a session whose project id no project entry stores is an orphan.
 */
function reach(doc: Document): { taken(entry: Entry): SessionEntry[]; orphans: SessionEntry[] } {
  const stored = new Map<string, number>();
  for (const entry of doc.entries) {
    const id = storedId(entry.raw);
    if (id !== null) stored.set(id, (stored.get(id) ?? 0) + 1);
  }
  return {
    taken(entry) {
      const id = storedId(entry.raw);
      return id === null || stored.get(id) !== 1 ? [] : doc.sessions.filter((session) => storedProjectId(session.raw) === id);
    },
    orphans: doc.sessions.filter((session) => {
      const id = storedProjectId(session.raw);
      return id === null || !stored.has(id);
    }),
  };
}
const unchanged = <R>(result: R): Applied<R> => ({ result, changed: false });
/** The ids these session entries store, readable or not: one that stores none has no chat to find. */
const storedSessionIds = (sessions: readonly SessionEntry[]): string[] => sessions.flatMap((session) => {
  const id = storedId(session.raw);
  return id === null ? [] : [id];
});

export function createRecordsStore(options: RecordsStoreOptions): RecordsStore {
  const {
    dir,
    providerIds = [],
    platform = process.platform,
    version = RECORDS_VERSION,
    now = Date.now,
    newId = randomUUID,
    log = console,
    write = writeFileAtomic,
    readFile = readTextFile,
    setAsideIo = nodeSetAsideIo,
  } = options;
  const filePath = path.join(dir, RECORDS_FILE);
  const registered = new Set(providerIds);
  const listeners = new Set<() => void>();
  let state = load();
  let view = buildView();
  let pending: Pending[] = [];
  let writing = false;
  let startingFresh: Promise<StartFreshResult> | null = null;

  function load(): State {
    const reading = readJsonFile(filePath, readFile);
    switch (reading.kind) {
      case 'missing':
        return fresh(null);
      case 'unreadable':
        log.warn(`[records] could not be read (${reading.code ?? 'no code'}); the file is left as it is`);
        return { kind: 'refused', cause: 'unreadable' };
      case 'invalid-json':
        log.warn('[records] refused: damaged (not JSON); the file is left as it is');
        return { kind: 'refused', cause: 'damaged' };
      case 'parsed':
        break;
    }
    const envelope = readEnvelope(reading.value, version);
    const document = reading.value;
    if (envelope.kind !== 'ok' || !plainObject(document)) {
      const cause = envelope.kind === 'newer' || envelope.kind === 'older' ? envelope.kind : 'damaged';
      log.warn(`[records] refused: ${cause}; the file is left as it is`);
      return { kind: 'refused', cause };
    }
    const projects = document['projects'];
    if (projects !== undefined && !Array.isArray(projects)) {
      log.warn('[records] refused: damaged (projects is not a list); the file is left as it is');
      return { kind: 'refused', cause: 'damaged' };
    }
    const seen = new Set<string>();
    const entries = (projects ?? []).map((raw: unknown): Entry => {
      const record = readProject(raw, platform);
      // An id used by an earlier entry makes this one unreadable: two entries cannot share a key.
      if (record === null || seen.has(record.id)) return { key: newId(), raw, record: null };
      seen.add(record.id);
      return { key: record.id, raw, record };
    });
    // A missing `sessions` reads as none, and is written at the next change (M14, C3).
    const stored = document['sessions'];
    if (stored !== undefined && !Array.isArray(stored)) {
      log.warn('[records] refused: damaged (sessions is not a list); the file is left as it is');
      return { kind: 'refused', cause: 'damaged' };
    }
    const used = new Set<string>();
    const sessions = (stored ?? []).map((raw: unknown): SessionEntry => {
      const record = readSession(raw, platform);
      // As for a project: an id an earlier session entry uses makes this one unreadable.
      if (record === null || used.has(record.id)) return { raw, record: null };
      used.add(record.id);
      return { raw, record };
    });
    const doc: Document = { top: document, entries, sessions };
    const unreadable = entries.filter((entry) => entry.record === null).length;
    const readable = entries.length - unreadable;
    const lost = sessions.filter((session) => session.record === null).length;
    const read = sessions.length - lost;
    // Counts only: never a name, a reference or a folder (C54; M14, C66).
    log.info(
      `[records] loaded ${readable} ${readable === 1 ? 'project' : 'projects'}, ${unreadable} unreadable; ` +
        `${read} ${read === 1 ? 'session' : 'sessions'}, ${lost} unreadable, ${reach(doc).orphans.length} without a project`,
    );
    return { kind: 'loaded', doc, keptAs: null };
  }

  /** No projects; nothing is written until the first change, which writes this version (C3, C4). */
  function fresh(keptAs: string | null): State {
    return { kind: 'loaded', doc: { top: { schemaVersion: version, minReaderVersion: version }, entries: [], sessions: [] }, keptAs };
  }

  function buildView(): RecordsView {
    if (state.kind === 'refused') return { status: { kind: 'refused', cause: state.cause }, projects: [], sessions: [], orphans: 0 };
    const { doc } = state;
    const reached = reach(doc);
    const projects = new Set(doc.entries.flatMap((entry) => (entry.record === null ? [] : [entry.record.id])));
    return {
      status: { kind: 'ok', keptAs: state.keptAs },
      projects: doc.entries.map((entry): StoredEntry => {
        const record = entry.record;
        const sessions = reached.taken(entry).length;
        if (record === null) return { kind: 'unreadable', key: entry.key, sessions };
        return {
          kind: 'project',
          key: entry.key,
          id: record.id,
          name: record.name,
          color: record.color,
          hidden: record.hidden,
          collapsed: record.collapsed,
          providers: providerIds.filter((id) => record.providers.includes(id)),
          roots: record.roots.map((root) => ({ path: root.path, trust: root.answer })),
          sessions,
          permissionModes: Object.fromEntries(providerIds.flatMap((id) => { const mode = record.permissionModes[id]; return mode === undefined ? [] : [[id, mode]]; })),
        };
      }),
      sessions: doc.sessions.flatMap((session) => (session.record !== null && projects.has(session.record.projectId) ? [session.record] : [])),
      orphans: reached.orphans.length,
    };
  }

  function replace(next: State): void {
    state = next;
    view = buildView();
    for (const listener of listeners) listener();
  }

  /** Both lists are always written, each in its stored order: no order field (M14, C3, C11). */
  function serialize(doc: Document): string {
    return serializeJson({ ...doc.top, projects: doc.entries.map((entry) => entry.raw), sessions: doc.sessions.map((session) => session.raw) });
  }

  // ── The queue ──────────────────────────────────────────────────────────────────────────

  function submit<R>(operation: Operation<R>): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      pending.push({ operation, resolve, reject });
      drain();
    });
  }

  function drain(): void {
    if (writing || pending.length === 0) return;
    const batch = pending;
    pending = [];
    const base = state;
    if (base.kind === 'refused') {
      for (const item of batch) item.resolve(REFUSED);
      return;
    }
    // Each change sees the ones before it; one the state refuses, or that alters nothing, answers now.
    let working = base.doc;
    const written: { item: Pending; result: unknown }[] = [];
    for (const item of batch) {
      const copy = structuredClone(working);
      let applied: Applied<unknown>;
      try {
        applied = item.operation(copy);
      } catch (error) {
        item.reject(error);
        continue;
      }
      if (!applied.changed) {
        item.resolve(applied.result);
        continue;
      }
      working = copy;
      written.push({ item, result: applied.result });
    }
    if (written.length === 0) return;

    writing = true;
    const doc = working;
    const data = serialize(doc);
    void (async () => {
      try {
        mkdirSync(dir, { recursive: true });
        await write(filePath, data);
      } catch (error) {
        for (const { item } of written) item.reject(error);
        return;
      } finally {
        writing = false;
      }
      replace({ kind: 'loaded', doc, keptAs: base.keptAs });
      for (const { item, result } of written) item.resolve(result);
    })().finally(drain);
  }

  // ── The changes ────────────────────────────────────────────────────────────────────────

  const stamp = (): string => new Date(now()).toISOString();
  const find = (doc: Document, id: string): Entry | undefined => doc.entries.find((entry) => entry.record?.id === id);
  const group = (entry: Entry): 'visible' | 'hidden' => (entry.record?.hidden === true ? 'hidden' : 'visible');

  function uniqueId(doc: Document): string {
    const used = new Set([
      ...doc.entries.flatMap((entry) => [entry.key, plainObject(entry.raw) ? String(entry.raw['id']) : '']),
      ...doc.sessions.map((session) => (plainObject(session.raw) ? String(session.raw['id']) : '')),
    ]);
    for (;;) {
      const id = newId();
      if (!used.has(id)) return id;
    }
  }

  /** Known ids in the order asked, then every stored id this build does not know (C12). */
  function providerList(asked: readonly string[], stored: readonly string[]): string[] {
    const known = [...new Set(asked)];
    const unknown = [...new Set(stored.filter((id) => !registered.has(id)))];
    return [...known, ...unknown];
  }

  /** The modes asked, for the providers this build knows, then every stored entry of a provider it does not (M22, C40; C12). */
  function modesFor(asked: Readonly<Record<string, string>>, stored: Readonly<Record<string, string>>): Record<string, string> {
    return { ...Object.fromEntries(Object.entries(asked).filter(([id]) => registered.has(id))), ...Object.fromEntries(Object.entries(stored).filter(([id]) => !registered.has(id))) };
  }

  /** The request's roots, each carried over from its stored root when the path is the same (C11, C33). */
  function rootsFor(input: ProjectInput, stored: readonly unknown[], at: string): RawDocument[] {
    return input.roots.map((root) => {
      const previous = stored.find((candidate) => plainObject(candidate) && candidate['path'] === root.path);
      const next: RawDocument = plainObject(previous) ? { ...previous } : { path: root.path };
      // The time is kept unless the answer is new or changed.
      if (trustAnswer(next['trust']) !== root.trust) {
        next['trust'] = { ...(plainObject(next['trust']) ? next['trust'] : {}), answer: root.trust, answeredAt: at };
      }
      return next;
    });
  }

  const notPicked = (roots: readonly { readonly path: string }[], allowed: (root: string) => boolean): ProjectRefusal | null => {
    const index = roots.findIndex((root) => !allowed(root.path));
    return index === -1 ? null : { status: 'refused', reason: 'root-not-allowed', index };
  };

  const findSession = (doc: Document, id: string): SessionEntry | undefined => doc.sessions.find((session) => session.record?.id === id);

  /** Applies a recipe to one session entry. Answers whether anything changed, or null for an unknown id. */
  function changeEntry(doc: Document, id: string, recipe: SessionRecipe): boolean | null {
    const entry = findSession(doc, id);
    if (entry === undefined || entry.record === null || !plainObject(entry.raw)) return null;
    const previousGroup = sessionOrderGroup(entry.record);
    const change = recipe(entry.record);
    if (change === null) return false;
    const raw = entry.raw;
    let changed = false;
    for (const [field, value] of Object.entries(change)) {
      if (value === undefined) continue;
      // What a session is never changes, whatever a recipe returns (C12; M14b, C26).
      if (!isChangeableField(field)) continue;
      const previous = raw[field];
      // The configuration folder is stored once, with the reference, and kept (M14b, C61).
      if (field === 'configFolder' && previous !== null && previous !== undefined) continue;
      // A last turn keeps what a later version stored in it, as a root's trust does (C11).
      const next: unknown = field === 'lastTurn' && typeof value === 'object' && value !== null && plainObject(previous) ? { ...previous, ...value } : value;
      if (JSON.stringify(previous) === JSON.stringify(next)) continue;
      raw[field] = next;
      changed = true;
    }
    if (!changed) return false;
    const record = readSession(raw, platform);
    if (record === null) throw new Error('a session change left its entry unreadable');
    entry.record = record;
    // Entering another list is one atomic change of its fields and destination position. A star
    // change alone keeps the underlying position, as do ordinary turn and reconciliation updates.
    if (previousGroup.list !== sessionOrderGroup(record).list) promote(doc, entry);
    return true;
  }

  function belongsTo(entry: SessionEntry, other: SessionEntry): boolean {
    return entry.record !== null && other.record !== null && other.record.projectId === entry.record.projectId &&
      sameSessionOrderGroup(sessionOrderGroup(entry.record), sessionOrderGroup(other.record));
  }

  function promote(doc: Document, entry: SessionEntry): boolean {
    const next = promoteSessionEntry(doc.sessions, entry, (other) => belongsTo(entry, other));
    if (next === doc.sessions) return false;
    doc.sessions = [...next];
    return true;
  }

  return {
    getView: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isRefused: () => state.kind === 'refused',
    getProject(id) {
      return state.kind === 'loaded' ? find(state.doc, id)?.record ?? undefined : undefined;
    },
    allRoots() {
      return state.kind === 'loaded' ? state.doc.entries.flatMap((entry) => entry.record?.roots.map((root) => root.path) ?? []) : [];
    },

    add(input, picked) {
      return submit<AddResult>((doc) => {
        const refusal = notPicked(input.roots, picked);
        if (refusal !== null) return unchanged(refusal);
        const id = uniqueId(doc);
        const raw: RawDocument = {
          id,
          name: input.name,
          color: input.color,
          roots: rootsFor(input, [], stamp()),
          hidden: false,
          collapsed: false,
          providers: providerList(input.providers, []),
          permissionModes: modesFor(input.permissionModes ?? {}, {}),
        };
        // At the end of the stored order (C49).
        doc.entries.push({ key: id, raw, record: readProject(raw, platform) });
        return { result: { status: 'saved', id }, changed: true };
      });
    },

    update(id, input, picked) {
      return submit<ChangeResult>((doc) => {
        const entry = find(doc, id);
        const record = entry?.record;
        if (entry === undefined || record === undefined || record === null || !plainObject(entry.raw)) return unchanged(UNKNOWN);
        // A saved root may stay without being picked again: after a restart none was, and a missing
        // folder cannot be (C23).
        const saved = new Set(record.roots.map((root) => root.path));
        const refusal = notPicked(input.roots, (root) => picked(root) || saved.has(root));
        if (refusal !== null) return unchanged(refusal);

        const raw = entry.raw;
        const before = JSON.stringify(raw);
        raw['name'] = input.name;
        if (input.color !== undefined) raw['color'] = input.color;
        raw['roots'] = rootsFor(input, Array.isArray(raw['roots']) ? raw['roots'] : [], stamp());
        raw['providers'] = providerList(input.providers, record.providers);
        if (input.permissionModes !== undefined) raw['permissionModes'] = modesFor(input.permissionModes, record.permissionModes);
        entry.record = readProject(raw, platform);
        return JSON.stringify(raw) === before ? unchanged(SAVED) : { result: SAVED, changed: true };
      });
    },

    setHidden(id, hidden) {
      return submit<ChangeResult>((doc) => {
        const entry = find(doc, id);
        if (entry?.record == null || !plainObject(entry.raw)) return unchanged(UNKNOWN);
        if (entry.record.hidden === hidden) return unchanged(SAVED);
        entry.raw['hidden'] = hidden;
        entry.record = { ...entry.record, hidden };
        return { result: SAVED, changed: true };
      });
    },

    setCollapsed(id, collapsed) {
      return submit<ChangeResult>((doc) => {
        const entry = find(doc, id);
        if (entry?.record == null || !plainObject(entry.raw)) return unchanged(UNKNOWN);
        if (entry.record.collapsed === collapsed) return unchanged(SAVED);
        entry.raw['collapsed'] = collapsed;
        entry.record = { ...entry.record, collapsed };
        return { result: SAVED, changed: true };
      });
    },

    move(id, hidden, before) {
      return submit<ChangeResult>((doc) => {
        const from = doc.entries.findIndex((entry) => entry.record?.id === id);
        const entry = doc.entries[from];
        if (entry?.record == null || !plainObject(entry.raw)) return unchanged(UNKNOWN);
        if (before !== null && !doc.entries.some((item) => item.key === before)) return unchanged(UNKNOWN);
        const order = doc.entries.map((item) => item.key).join();
        const wasHidden = entry.record.hidden;
        entry.raw['hidden'] = hidden;
        entry.record = { ...entry.record, hidden };
        // Before itself means where it is: only the group may change.
        if (before !== entry.key) {
          doc.entries.splice(from, 1);
          let to: number;
          if (before !== null) {
            to = doc.entries.findIndex((item) => item.key === before);
          } else {
            // After the last entry of its group; with none, a visible drop goes first, a hidden one last.
            const last = doc.entries.findLastIndex((item) => group(item) === (hidden ? 'hidden' : 'visible'));
            to = last !== -1 ? last + 1 : hidden ? doc.entries.length : 0;
          }
          doc.entries.splice(to, 0, entry);
        }
        const changed = wasHidden !== hidden || doc.entries.map((item) => item.key).join() !== order;
        return changed ? { result: SAVED, changed: true } : unchanged(SAVED);
      });
    },

    remove(key) {
      return submit<ChangeResult>((doc) => {
        const index = doc.entries.findIndex((entry) => entry.key === key);
        const entry = doc.entries[index];
        if (entry === undefined) return unchanged(UNKNOWN);
        // Its sessions go with it, in this write: matched on the ids the file stores (M14, C13).
        const taken = new Set(reach(doc).taken(entry));
        doc.sessions = doc.sessions.filter((session) => !taken.has(session));
        doc.entries.splice(index, 1);
        return { result: SAVED, changed: true };
      });
    },

    getSession(id) {
      return state.kind === 'loaded' ? findSession(state.doc, id)?.record ?? undefined : undefined;
    },

    createSession(input) {
      return submit<SessionCreated | SessionRefusal>((doc) => {
        const project = find(doc, input.projectId);
        if (project?.record == null || !plainObject(project.raw)) return unchanged(UNKNOWN);
        // Creating a session selects it: its project unfolds in the same atomic write.
        project.raw['collapsed'] = false;
        project.record = { ...project.record, collapsed: false };
        const id = uniqueId(doc);
        const at = now();
        const raw: RawDocument = {
          id,
          projectId: input.projectId,
          providerId: input.providerId,
          instanceId: input.instanceId,
          reference: null,
          folder: null,
          configFolder: null,
          model: input.model,
          effort: input.effort,
          speed: input.speed,
          // Normalized as every name is, and cut to what a name holds (0011): an empty one is none.
          name: input.name === undefined || normalizeSessionName(input.name) === '' ? null : normalizeSessionName(input.name),
          nameSource: input.name === undefined || normalizeSessionName(input.name) === '' ? null : 'generated',
          starred: false,
          toDo: false,
          toVerify: false,
          shelvedAt: null,
          completedAt: null,
          createdAt: at,
          lastActiveAt: at,
          lastTurn: null,
        };
        const record = readSession(raw, platform);
        if (record === null) throw new Error('a new session could not be read back');
        // Before its project's others, or at the end when it has none (C11).
        const first = doc.sessions.findIndex((session) => storedProjectId(session.raw) === input.projectId);
        doc.sessions.splice(first === -1 ? doc.sessions.length : first, 0, { raw, record });
        return { result: { status: 'saved', id }, changed: true };
      });
    },

    setDraftPreset(id, preset) {
      return submit<SessionResult>((doc) => {
        const entry = findSession(doc, id);
        if (entry?.record == null || !plainObject(entry.raw)) return unchanged(UNKNOWN_SESSION);
        if (entry.record.reference !== null || entry.record.lastTurn !== null || entry.record.completedAt !== null || entry.record.shelvedAt !== null) return unchanged({ status: 'refused', reason: 'draft-locked' });
        const raw = { ...entry.raw, providerId: preset.providerId, instanceId: preset.instanceId, model: preset.model, effort: preset.effort, speed: preset.speed };
        const record = readSession(raw, platform);
        if (record === null) return unchanged({ status: 'refused', reason: 'draft-locked' });
        Object.assign(entry.raw, raw);
        entry.record = record;
        return { result: SAVED, changed: true };
      });
    },

    changeSession(id, recipe) {
      return submit<SessionResult>((doc) => {
        const changed = changeEntry(doc, id, recipe);
        if (changed === null) return unchanged(UNKNOWN_SESSION);
        return changed ? { result: SAVED, changed: true } : unchanged(SAVED);
      });
    },

    changeSessions(recipes) {
      return submit<SessionSaved | SessionRefusal>((doc) => {
        let changed = false;
        for (const [id, recipe] of recipes) changed = changeEntry(doc, id, recipe) === true || changed;
        return changed ? { result: SAVED, changed: true } : unchanged(SAVED);
      });
    },

    promoteSession(id) {
      return submit<SessionResult>((doc) => {
        const entry = findSession(doc, id);
        if (entry?.record == null) return unchanged(UNKNOWN_SESSION);
        return { result: SAVED, changed: promote(doc, entry) };
      });
    },

    moveSession(id, before, expectedGroup) {
      return submit<SessionResult>((doc) => {
        const from = doc.sessions.findIndex((session) => session.record?.id === id);
        const entry = doc.sessions[from];
        const record = entry?.record;
        if (entry === undefined || record === undefined || record === null) return unchanged(UNKNOWN_SESSION);
        if (!sameSessionOrderGroup(sessionOrderGroup(record), expectedGroup)) return unchanged(OUTSIDE_GROUP);
        const inGroup = (other: SessionEntry): boolean => belongsTo(entry, other);
        if (before !== null) {
          const target = findSession(doc, before);
          if (target === undefined) return unchanged(UNKNOWN_SESSION);
          if (!inGroup(target)) return unchanged(OUTSIDE_GROUP);
        }
        // Where it already is — before itself, or before the one its group has next, the end included —
        // writes nothing: the entries of other projects and groups between them do not count.
        const group = doc.sessions.filter(inGroup);
        const next = group[group.indexOf(entry) + 1]?.record?.id ?? null;
        if (before === id || before === next) return unchanged(SAVED);
        doc.sessions = [...moveSessionEntry(doc.sessions, entry, before === null ? null : findSession(doc, before) ?? null, inGroup)];
        return { result: SAVED, changed: true };
      });
    },

    removeSession(id) {
      return submit<SessionResult>((doc) => {
        const index = doc.sessions.findIndex((session) => session.record?.id === id);
        if (index === -1) return unchanged(UNKNOWN_SESSION);
        doc.sessions.splice(index, 1);
        return { result: SAVED, changed: true };
      });
    },

    removeOrphans() {
      return submit<SessionSaved | SessionRefusal>((doc) => {
        const orphans = new Set(reach(doc).orphans);
        if (orphans.size === 0) return unchanged(SAVED);
        doc.sessions = doc.sessions.filter((session) => !orphans.has(session));
        return { result: SAVED, changed: true };
      });
    },

    sessionIdsTaken(key) {
      if (state.kind !== 'loaded') return [];
      const entry = state.doc.entries.find((candidate) => candidate.key === key);
      return entry === undefined ? [] : storedSessionIds(reach(state.doc).taken(entry));
    },

    orphanIds() {
      return state.kind === 'loaded' ? storedSessionIds(reach(state.doc).orphans) : [];
    },

    startFresh() {
      // Two confirmations sent together move the file once.
      startingFresh ??= (async (): Promise<StartFreshResult> => {
        if (state.kind !== 'refused') return { status: 'refused', reason: 'not-refused' };
        // A refused file is never written, so no write can be pending here.
        const keptAs = await setAside(dir, RECORDS_FILE, now(), setAsideIo);
        log.warn('[records] the refused file was moved aside; starting with no projects');
        replace(fresh(keptAs));
        return { status: 'done', keptAs };
      })().finally(() => {
        startingFresh = null;
      });
      return startingFresh;
    },

    retry() {
      if (state.kind !== 'refused') return { status: 'refused', reason: 'not-refused' };
      const previous = state.cause;
      const next = load();
      if (next.kind === 'loaded') {
        replace(next);
        return { status: 'loaded' };
      }
      // Still refused, perhaps for another reason now: the note says the new one.
      if (next.cause !== previous) replace(next);
      return { status: 'refused', reason: 'still-refused' };
    },
  };
}
