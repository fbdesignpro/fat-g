// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The plan store (docs/planning/_archive/M22b.md, Design 2; C16, C18, C19, C21, C59–C63, C73; decision 0029): a
// project's plans, each a folder of fat-g's data folder — `plans/<plan id>/plan.json`, the record,
// and each version's Markdown text beside it. The one writer of `plans/`; written from the wire alone
// (C9, C14), never by a CLI, never into a project (0015) and never into a configuration folder (0017).
//
// Its writes and removals are ordered so that a crash leaves nothing half-done and brings nothing
// back (C62): a version's file is whole on disk before `plan.json` lists it complete, which is its
// commit; a plan's removal renames its folder to its mark, then deletes it; a project's removal is
// one mark file for its whole scope, written whole before anything else of it. Launch recovery
// finishes or lifts what a crash left. Synchronous, as the conversation store is: a write is done
// when the call returns, so its order is the caller's.
//
// The registry (C63) is an index in memory read from `plans/` alone, never from a chat: a plan is
// listed, read and removed after every chat that made it is gone. Nothing here logs a text, a title
// or a path: a failure is said by its kind.
//
// A plan's reviews (docs/planning/_archive/M22e.md, Design 2; C6, C27, C36, C45, C52) are files of its folder's
// `reviews/`, each written whole at each change, indexed beside the plans and gone with their plan's
// folder. A newer complete version marks the older reviews of its plan stale, after `plan.json`; a
// launch mends what a crash between the two left, ends what was running, and settles an integration
// that was sent from `plan.json` alone. Nothing is sent again from here.
//
// A plan's workflow (decision 0029) is in its `plan.json` too: a new plan's is made with its first
// version, a version's commit moves it in the same write, and any other change is one write of the
// whole record through `setWorkflow`. What the workflow means is the coordinator's; this store keeps it.
import { createHash, type Hash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { PROGRESS_WRITE_MS } from '@shared/contracts/chat';
import { type PlanCause, type PlanIntegration, type PlansStorage, type PlanVersionState } from '@shared/contracts/plans';
import { REVIEWS_FOLDER } from '@shared/contracts/review';
import { renameWithRetrySync, writeFileAtomicSync } from '../storage/atomic-write';
import { errorKind } from '../storage/error-kind';
import { serializeJson } from '../storage/json-file';
import { committed, draftFile, newWorkflow, PLAN_FILE, planDocument, type PlanFileRecord, type PlanVersionRecord, projectMarkDocument, readPlanFile, readProjectMark, REMOVING_PLAN, REMOVING_PROJECT, removingPlan, removingProject, versionFile, type WorkflowRecord } from './format';
import { readReviewFile, REVIEW_FILE, reviewDocument, reviewFile, type ReviewRecord } from './review-format';

/** A write the store could not make. `kind` is what a log may say: never a text or a path. */
export class PlanStorageFailure extends Error {
  constructor(readonly kind: string) {
    super(`plan store: ${kind}`);
    this.name = 'PlanStorageFailure';
  }
}

/** Who and what produced a version (C16): the session and its turn, its provider, account and model, and how it came about. */
export interface VersionSource {
  readonly sessionId: string;
  readonly turnId: string;
  readonly providerId: string;
  readonly instanceId: string;
  readonly model: string;
  readonly cause: PlanCause;
  readonly revises: number | null;
  /** The review and its integration, for a version an integration makes (M22e, C11, C35). */
  readonly integration?: PlanIntegration | null;
}

/** Where a new version goes: the plan whose next it is, or — `planId` null — a new plan of the project. */
export interface VersionTarget {
  readonly planId: string | null;
  readonly projectId: string;
  readonly title: string;
}

export interface VersionMade {
  readonly planId: string;
  readonly version: number;
  readonly length: number;
  readonly hash: string;
}

export interface VersionText {
  readonly state: PlanVersionState;
  /** A range of it, in UTF-16 units. */
  readonly text: string;
  readonly start: number;
  /** All of it, in UTF-16 units, and its hash. */
  readonly length: number;
  readonly hash: string;
}

export type PlanRemoval = 'removed' | 'unknown' | 'writing';

export interface PlanStore {
  /**
   * At launch, before anything else (C62): what a crash left is finished, lifted or cleaned, and the
   * registry is read. `listed`: the projects the records list, or null where the records cannot be
   * read — a project's mark is then left as it is, since nothing is deleted on what cannot be read.
   */
  recover(listed: ReadonlySet<string> | null): void;
  /** A project's plans (C63), newest first by their latest version. */
  list(projectId: string): readonly PlanFileRecord[];
  all(): readonly PlanFileRecord[];
  get(planId: string): PlanFileRecord | null;
  /** A version whose whole text came at once (C9, C16): its file, then the record that lists it complete. */
  write(target: VersionTarget, source: VersionSource, text: string): VersionMade;
  /** A version being written (C59): listed `drafting`, its draft opened. */
  begin(target: VersionTarget, source: VersionSource): { readonly planId: string; readonly version: number };
  /** More of a draft (C59): held with its running hash, written to the disk at a message's progress interval. */
  append(planId: string, version: number, text: string): void;
  /** The completed text (C14, C59): the authority. The draft is renamed where it is the same, else the text is written. */
  complete(planId: string, version: number, text: string, title: string): VersionMade;
  /** A draft whose completion never comes (C59): kept with all it received, `unfinished`. */
  unfinish(planId: string, version: number): void;
  /** Every draft's text so far, to the disk (C59): at a Stop and at a quit. */
  flush(): void;
  /** A version of it is being written. */
  writing(planId: string): boolean;
  /**
   * One change of a plan's workflow (decision 0029): `change` answers the workflow as it is to be, or
   * null for none, and `plan.json` is written whole at once. Throws `PlanStorageFailure` where it could not be.
   */
  setWorkflow(planId: string, change: (plan: PlanFileRecord) => WorkflowRecord | null): PlanFileRecord;
  /** A range of a version's text (C60), or null where the plan or the version is not held. */
  read(planId: string, version: number, start: number, length: number): VersionText | null;
  /** A plan and everything in its folder (C18, C62): its mark, then its folder gone. Refused while a version is written. */
  remove(planId: string): PlanRemoval;
  /** A project's removal, its first step (C62): the mark naming it and every plan it takes, written whole. Answers those plans. */
  markProject(projectId: string): readonly string[];
  /** The removal did not land (C62): the mark is lifted, and the plans stay. */
  liftProject(projectId: string): void;
  /** The removal landed (C62): each plan its mark names is deleted, then the mark itself. */
  finishProject(projectId: string): void;
  /** The Storage tab's count and size (C21), and the plans whose project the records no longer list. */
  storage(listed: ReadonlySet<string> | null): PlansStorage;
  /** A plan's reviews this build can read (M22e, C6), oldest first; none for a plan it does not hold. */
  reviews(planId: string): readonly ReviewRecord[];
  /** Every readable review of every plan held, oldest first. */
  allReviews(): readonly ReviewRecord[];
  review(planId: string, reviewId: string): ReviewRecord | null;
  /** A new review's record (C6, C52), written whole: `staleBy` derived from its plan as it stands. */
  createReview(review: ReviewRecord): ReviewRecord;
  /**
   * One change of a review (C6): `change` answers the record as it is to be, or null for none, and
   * the whole file is written at once. Throws `PlanStorageFailure` where it could not be.
   */
  updateReview(planId: string, reviewId: string, change: (review: ReviewRecord) => ReviewRecord | null): ReviewRecord;
}

export interface PlanStoreOptions {
  /** The plans' folder: `plans` in fat-g's data folder. */
  readonly dir: string;
  readonly now?: () => number;
  readonly newId?: () => string;
  readonly log?: Pick<Console, 'info' | 'warn' | 'error'>;
  /** Called before each step of a write or a removal, by its name: a test throws from it to stop there, as a crash would. */
  readonly hook?: (point: string) => void;
}

interface Draft {
  readonly planId: string;
  readonly version: number;
  /** What came and is not on the disk yet. */
  pending: string[];
  /** Every unit received, in order: the running hash's and the length's. */
  readonly hash: Hash;
  units: number;
  flushedAt: number;
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const keyOf = (planId: string, version: number): string => `${planId}/${version}`;
const newest = (plan: PlanFileRecord): number => plan.versions.reduce((latest, version) => Math.max(latest, version.at), plan.createdAt);

export function createPlanStore(options: PlanStoreOptions): PlanStore {
  const { dir, now = Date.now, newId = () => crypto.randomUUID(), log = console, hook } = options;
  const index = new Map<string, PlanFileRecord>();
  /** Each plan's readable reviews, by review id (M22e, C6). */
  const reviewIndex = new Map<string, Map<string, ReviewRecord>>();
  const drafts = new Map<string, Draft>();
  /** Plans a project's mark names: listed nowhere until the mark is finished or lifted (C62). */
  const marked = new Set<string>();

  const folderOf = (planId: string): string => path.join(dir, planId);
  const step = (point: string): void => { hook?.(point); };

  function fail(kind: string, error: unknown): never {
    log.warn(`[plans] ${kind} (${errorKind(error)})`);
    throw new PlanStorageFailure(kind);
  }

  function writeRecord(plan: PlanFileRecord): void {
    step('record');
    writeFileAtomicSync(path.join(folderOf(plan.id), PLAN_FILE), serializeJson(planDocument(plan)));
    index.set(plan.id, plan);
  }

  function withVersion(plan: PlanFileRecord, version: PlanVersionRecord, title?: string): PlanFileRecord {
    const versions = [...plan.versions.filter((held) => held.version !== version.version), version].sort((a, b) => a.version - b.version);
    return { ...plan, ...(title === undefined ? {} : { title }), versions };
  }

  /**
   * The plan a new version goes into, made where it is new: its folder, and no record until its first
   * version's commit. A new plan's workflow is its maker's, writing it (decision 0029); the version's
   * own write says what it becomes.
   */
  function target(at: VersionTarget, source: VersionSource): { readonly plan: PlanFileRecord; readonly version: number; readonly fresh: boolean } {
    if (at.planId !== null) {
      const held = index.get(at.planId);
      if (held === undefined || marked.has(at.planId)) throw new PlanStorageFailure('unknown-plan');
      return { plan: held, version: held.versions.reduce((highest, version) => Math.max(highest, version.version), 0) + 1, fresh: false };
    }
    const id = newId();
    try { mkdirSync(folderOf(id), { recursive: true }); } catch (error) { fail('folder', error); }
    // Its first revision is known by the plan's own id: no other operation of it can be.
    const workflow = newWorkflow({ id, sessionId: source.sessionId, turnId: source.turnId, at: now() }, null);
    return { plan: { id, projectId: at.projectId, title: at.title, createdAt: now(), versions: [], workflow, unknown: {} }, version: 1, fresh: true };
  }

  /** A version's record written into its plan's, the workflow moved by its commit in the same write. */
  function withCommitted(plan: PlanFileRecord, record: PlanVersionRecord, title?: string): PlanFileRecord {
    const next = withVersion(plan, record, title);
    return { ...next, workflow: committed(next.workflow, record) };
  }

  const versionRecord = (version: number, source: VersionSource, state: PlanVersionState, length: number, hash: string): PlanVersionRecord => ({
    version, state, sessionId: source.sessionId, turnId: source.turnId, providerId: source.providerId, instanceId: source.instanceId, model: source.model, at: now(), length, hash, cause: source.cause, revises: source.revises,
    integration: source.cause === 'integration' ? source.integration ?? null : null, unknown: {},
  });

  // ── Reviews (M22e, C6, C36, C52) ────────────────────────────────────────────────────────────

  const reviewsFolder = (planId: string): string => path.join(folderOf(planId), REVIEWS_FOLDER);

  /** The first complete version of the plan above the one reviewed (C36): what makes a review stale, or null. */
  function staleOf(plan: PlanFileRecord, version: number): number | null {
    return plan.versions.find((one) => one.state === 'complete' && one.version > version)?.version ?? null;
  }

  function writeReview(review: ReviewRecord): void {
    step('review');
    mkdirSync(reviewsFolder(review.planId), { recursive: true });
    writeFileAtomicSync(path.join(reviewsFolder(review.planId), reviewFile(review.id)), serializeJson(reviewDocument(review)));
    const held = reviewIndex.get(review.planId) ?? new Map<string, ReviewRecord>();
    held.set(review.id, review);
    reviewIndex.set(review.planId, held);
  }

  /**
   * A newer complete version committed (C36): each older review of its plan, live until now, is
   * marked stale by it. After `plan.json`, so a crash between the two is mended at the next launch.
   */
  function markStale(planId: string, version: number): void {
    for (const review of [...(reviewIndex.get(planId)?.values() ?? [])]) {
      if (review.version >= version || review.staleBy !== null) continue;
      try { writeReview({ ...review, staleBy: version }); } catch (error) { log.warn(`[plans] a review was not marked stale (${errorKind(error)})`); }
    }
  }

  /**
   * A review as a crash may have left it (C6, C27, C45, C49): what was running or waiting ended
   * `interrupted` — a card an asked turn waited on reads dropped at a launch, so nothing continues
   * it — an integration that was sent settled from the plan's record by a complete version that
   * names it alone, and `staleBy` derived again. Nothing is sent again.
   */
  function recoverReview(plan: PlanFileRecord, review: ReviewRecord): ReviewRecord {
    const at = now();
    const turns = review.turns.map((turn) => (turn.outcome === 'waiting' || turn.outcome === 'asked' ? { ...turn, outcome: 'failed' as const, reason: 'interrupted' as const, card: null } : turn));
    const running = review.state === 'running';
    const integrations = review.integrations.map((one) => {
      if (one.state !== 'sent') return one;
      const produced = plan.versions.find((version) => version.state === 'complete' && version.integration?.integrationId === one.id);
      return produced === undefined ? { ...one, state: 'ended' as const, reason: 'interrupted' as const, settledAt: at, card: null } : { ...one, state: 'integrated' as const, produced: produced.version, settledAt: at, card: null };
    });
    const staleBy = review.staleBy ?? staleOf(plan, review.version);
    const changed = running || staleBy !== review.staleBy || turns.some((turn, n) => turn !== review.turns[n]) || integrations.some((one, n) => one !== review.integrations[n]);
    if (!changed) return review;
    return { ...review, turns, integrations, staleBy, ...(running ? { state: 'failed' as const, failure: 'interrupted' as const, endedAt: at } : {}) };
  }

  /** A plan's `reviews/` at launch: each record read, recovered and indexed; one this build cannot take left as it is. */
  function recoverReviews(plan: PlanFileRecord): void {
    const folder = reviewsFolder(plan.id);
    const held = new Map<string, ReviewRecord>();
    reviewIndex.set(plan.id, held);
    for (const entry of entriesOf(folder)) {
      // What an atomic write a crash cut short left beside its file.
      if (entry.endsWith('.tmp')) { remove(path.join(folder, entry)); continue; }
      const match = REVIEW_FILE.exec(entry);
      if (match === null) continue;
      let document: unknown;
      try { document = JSON.parse(readFileSync(path.join(folder, entry), 'utf8')); } catch (error) { log.warn(`[plans] a review could not be read (${errorKind(error)})`); continue; }
      const reading = readReviewFile(document);
      if (reading.kind !== 'ok') { log.warn(`[plans] a review was left as it is (${reading.kind})`); continue; }
      if (reading.review.id !== match[1] || reading.review.planId !== plan.id) { log.warn('[plans] a review names another one'); continue; }
      const recovered = recoverReview(plan, reading.review);
      held.set(recovered.id, recovered);
      if (recovered !== reading.review) {
        try { writeReview(recovered); } catch (error) { log.warn(`[plans] a review could not be recovered (${errorKind(error)})`); }
      }
    }
  }

  function draftOf(planId: string, version: number): Draft {
    const draft = drafts.get(keyOf(planId, version));
    if (draft === undefined) throw new PlanStorageFailure('not-drafting');
    return draft;
  }

  function flushDraft(draft: Draft): void {
    if (draft.pending.length === 0) return;
    const chunk = draft.pending.join('');
    step('append');
    try { appendFileSync(path.join(folderOf(draft.planId), draftFile(draft.version)), chunk, 'utf8'); } catch (error) { fail('append', error); }
    draft.pending = [];
    draft.flushedAt = now();
  }

  // ── Launch recovery (C62) ───────────────────────────────────────────────────────────────────

  const entriesOf = (folder: string): string[] => { try { return readdirSync(folder); } catch { return []; } };
  const remove = (target: string): void => { rmSync(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 25 }); };

  /** A plan's folder as a crash may have left it: unnamed files deleted, a draft unfinished. Answers its record, or null. */
  function recoverPlan(planId: string): PlanFileRecord | null {
    const folder = folderOf(planId);
    let document: unknown;
    try { document = JSON.parse(readFileSync(path.join(folder, PLAN_FILE), 'utf8')); } catch (error) {
      // No record: a plan whose first version never committed, which nothing names (C62).
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') { remove(folder); return null; }
      log.warn(`[plans] a record could not be read (${errorKind(error)})`);
      return null;
    }
    const reading = readPlanFile(document);
    // A record this build cannot take is left as it is, and listed nowhere.
    if (reading.kind !== 'ok') { log.warn(`[plans] a record was left as it is (${reading.kind})`); return null; }
    let plan = reading.plan;
    if (plan.id !== planId) { log.warn('[plans] a record names another plan'); return null; }
    for (const version of plan.versions) {
      if (version.state !== 'drafting') continue;
      // Found drafting (C59, C62): unfinished, with whichever of its files is there.
      const draft = path.join(folder, draftFile(version.version));
      const whole = path.join(folder, versionFile(version.version));
      if (!existsSync(draft) && existsSync(whole)) renameWithRetrySync(whole, draft);
      const text = existsSync(draft) ? readFileSync(draft, 'utf8') : '';
      plan = withVersion(plan, { ...version, state: 'unfinished', length: text.length, hash: sha256(text) });
    }
    if (plan !== reading.plan) writeRecord(plan);
    // Its reviews' folder is among what its record names (M22e, C6, C35).
    const named = new Set([PLAN_FILE, REVIEWS_FOLDER, ...plan.versions.map((version) => (version.state === 'complete' ? versionFile(version.version) : draftFile(version.version)))]);
    for (const entry of entriesOf(folder)) if (!named.has(entry)) remove(path.join(folder, entry));
    recoverReviews(plan);
    return plan;
  }

  const get = (planId: string): PlanFileRecord | null => (marked.has(planId) ? null : index.get(planId) ?? null);
  const all = (): PlanFileRecord[] => [...index.values()].filter((plan) => !marked.has(plan.id));
  const writing = (planId: string): boolean => [...drafts.values()].some((draft) => draft.planId === planId);

  return {
    recover(listed) {
      index.clear();
      reviewIndex.clear();
      marked.clear();
      drafts.clear();
      const entries = entriesOf(dir);
      // A plan's own removal, finished (C62).
      for (const entry of entries) if (REMOVING_PLAN.test(entry)) remove(path.join(dir, entry));
      // A project's: read against the records — gone, it is finished; still listed, it is lifted. With
      // records that cannot be read, nothing is done, and the plans it names are listed nowhere.
      for (const entry of entries) {
        const match = REMOVING_PROJECT.exec(entry);
        if (match === null) continue;
        const file = path.join(dir, entry);
        let mark: ReturnType<typeof readProjectMark>;
        try { mark = readProjectMark(JSON.parse(readFileSync(file, 'utf8'))); } catch { mark = null; }
        if (mark === null) { if (listed !== null) remove(file); continue; }
        if (listed === null) { for (const planId of mark.plans) marked.add(planId); continue; }
        if (listed.has(mark.projectId)) { remove(file); continue; }
        for (const planId of mark.plans) remove(folderOf(planId));
        remove(file);
      }
      for (const entry of entriesOf(dir)) {
        if (entry.startsWith('.') || marked.has(entry)) continue;
        // A stray file, or a folder that is no plan's (C62).
        let folder: boolean;
        try { folder = statSync(path.join(dir, entry)).isDirectory(); } catch { continue; }
        if (!folder) { remove(path.join(dir, entry)); continue; }
        if (!/^[a-z0-9-]{1,64}$/.test(entry)) continue;
        try {
          const plan = recoverPlan(entry);
          if (plan !== null) index.set(plan.id, plan);
        } catch (error) {
          log.warn(`[plans] a plan could not be recovered (${errorKind(error)})`);
        }
      }
    },

    list(projectId) {
      return [...index.values()].filter((plan) => plan.projectId === projectId && !marked.has(plan.id)).sort((a, b) => newest(b) - newest(a));
    },

    all,
    get,

    write(at, source, text) {
      const { plan, version } = target(at, source);
      const hash = sha256(text);
      try {
        // The version's file, whole on disk, before the record that lists it (C62).
        step('version');
        writeFileAtomicSync(path.join(folderOf(plan.id), versionFile(version)), text);
        writeRecord(withCommitted(plan, versionRecord(version, source, 'complete', text.length, hash), at.title));
      } catch (error) {
        if (error instanceof PlanStorageFailure) throw error;
        fail('write', error);
      }
      markStale(plan.id, version);
      return { planId: plan.id, version, length: text.length, hash };
    },

    begin(at, source) {
      const { plan, version } = target(at, source);
      try {
        step('draft');
        writeFileAtomicSync(path.join(folderOf(plan.id), draftFile(version)), '');
        writeRecord(withVersion(plan, versionRecord(version, source, 'drafting', 0, sha256('')), plan.versions.length === 0 ? at.title : undefined));
      } catch (error) {
        if (error instanceof PlanStorageFailure) throw error;
        fail('begin', error);
      }
      drafts.set(keyOf(plan.id, version), { planId: plan.id, version, pending: [], hash: createHash('sha256'), units: 0, flushedAt: now() });
      return { planId: plan.id, version };
    },

    append(planId, version, text) {
      if (text === '') return;
      const draft = draftOf(planId, version);
      draft.pending.push(text);
      draft.hash.update(text, 'utf8');
      draft.units += text.length;
      if (now() - draft.flushedAt >= PROGRESS_WRITE_MS) flushDraft(draft);
    },

    complete(planId, version, text, title) {
      const draft = draftOf(planId, version);
      const plan = index.get(planId);
      if (plan === undefined) throw new PlanStorageFailure('unknown-plan');
      const held = plan.versions.find((one) => one.version === version);
      if (held === undefined) throw new PlanStorageFailure('unknown-version');
      const hash = sha256(text);
      const folder = folderOf(planId);
      try {
        flushDraft(draft);
        step('complete');
        // The draft is the completed text itself where their hashes are one: renamed. Else the
        // completed text, which is the authority, is written and the draft deleted (C14, C59).
        if (draft.hash.copy().digest('hex') === hash) renameWithRetrySync(path.join(folder, draftFile(version)), path.join(folder, versionFile(version)));
        else {
          writeFileAtomicSync(path.join(folder, versionFile(version)), text);
          step('draft-deleted');
          unlinkSync(path.join(folder, draftFile(version)));
        }
        writeRecord(withCommitted(plan, { ...held, state: 'complete', length: text.length, hash }, title));
      } catch (error) {
        if (error instanceof PlanStorageFailure) throw error;
        fail('complete', error);
      } finally {
        drafts.delete(keyOf(planId, version));
      }
      markStale(planId, version);
      return { planId, version, length: text.length, hash };
    },

    unfinish(planId, version) {
      const draft = drafts.get(keyOf(planId, version));
      const plan = index.get(planId);
      const held = plan?.versions.find((one) => one.version === version);
      if (draft === undefined || plan === undefined || held === undefined) return;
      try {
        flushDraft(draft);
        writeRecord(withVersion(plan, { ...held, state: 'unfinished', length: draft.units, hash: draft.hash.copy().digest('hex') }));
      } catch (error) {
        if (error instanceof PlanStorageFailure) throw error;
        fail('unfinish', error);
      } finally {
        drafts.delete(keyOf(planId, version));
      }
    },

    flush() {
      for (const draft of drafts.values()) {
        try { flushDraft(draft); } catch { /* said by its kind; the next flush tries again */ }
      }
    },

    writing,

    setWorkflow(planId, change) {
      const plan = get(planId);
      if (plan === null) throw new PlanStorageFailure('unknown-plan');
      const workflow = change(plan);
      if (workflow === null || workflow === plan.workflow) return plan;
      const next = { ...plan, workflow };
      try { writeRecord(next); } catch (error) {
        if (error instanceof PlanStorageFailure) throw error;
        fail('workflow', error);
      }
      return next;
    },

    read(planId, version, start, length) {
      const plan = get(planId);
      const held = plan?.versions.find((one) => one.version === version);
      if (plan === null || held === undefined) return null;
      const draft = drafts.get(keyOf(planId, version));
      let text: string;
      try {
        text = readFileSync(path.join(folderOf(planId), held.state === 'complete' ? versionFile(version) : draftFile(version)), 'utf8');
      } catch (error) {
        log.warn(`[plans] a version could not be read (${errorKind(error)})`);
        return null;
      }
      // A draft's text so far: what is on the disk, and what came since.
      if (draft !== undefined) text += draft.pending.join('');
      const hash = draft !== undefined ? draft.hash.copy().digest('hex') : held.hash;
      return { state: held.state, text: text.slice(start, start + length), start, length: text.length, hash };
    },

    remove(planId) {
      if (!index.has(planId) || marked.has(planId)) return 'unknown';
      if (writing(planId)) return 'writing';
      try {
        // Its mark: the folder renamed, which puts it out of reach in one step (C62).
        step('mark');
        renameWithRetrySync(folderOf(planId), path.join(dir, removingPlan(planId)));
        index.delete(planId);
        reviewIndex.delete(planId);
        step('delete');
        remove(path.join(dir, removingPlan(planId)));
      } catch (error) {
        if (!index.has(planId)) {
          // Marked: a launch finishes the deletion.
          log.warn(`[plans] a removal is left to the next launch (${errorKind(error)})`);
          return 'removed';
        }
        fail('remove', error);
      }
      return 'removed';
    },

    markProject(projectId) {
      const plans = [...index.values()].filter((plan) => plan.projectId === projectId).map((plan) => plan.id);
      try {
        mkdirSync(dir, { recursive: true });
        step('project-mark');
        writeFileAtomicSync(path.join(dir, removingProject(projectId)), serializeJson(projectMarkDocument({ projectId, plans })));
      } catch (error) { fail('project-mark', error); }
      for (const planId of plans) marked.add(planId);
      return plans;
    },

    liftProject(projectId) {
      const file = path.join(dir, removingProject(projectId));
      let named: readonly string[];
      try { named = readProjectMark(JSON.parse(readFileSync(file, 'utf8')))?.plans ?? []; } catch { named = []; }
      try { remove(file); } catch (error) { fail('project-lift', error); }
      for (const planId of named) marked.delete(planId);
    },

    finishProject(projectId) {
      const file = path.join(dir, removingProject(projectId));
      let named: readonly string[];
      try { named = readProjectMark(JSON.parse(readFileSync(file, 'utf8')))?.plans ?? []; } catch { named = []; }
      try {
        for (const planId of named) {
          step('project-delete');
          remove(folderOf(planId));
          index.delete(planId);
          reviewIndex.delete(planId);
          marked.delete(planId);
        }
        // The mark last (0019, item 11): a crash before it finishes at the next launch.
        step('project-unmark');
        remove(file);
      } catch (error) { fail('project-finish', error); }
    },

    storage(listed) {
      const size = (target: string): number => {
        let total = 0;
        for (const entry of entriesOf(target)) {
          try {
            const at = path.join(target, entry);
            const stats = statSync(at);
            total += stats.isDirectory() ? size(at) : stats.size;
          } catch { /* gone meanwhile */ }
        }
        return total;
      };
      const bytes = size(dir);
      const plans = all();
      const reviews = plans.reduce((sum, plan) => sum + (reviewIndex.get(plan.id)?.size ?? 0), 0);
      return { count: plans.length, reviews, bytes, orphans: listed === null ? 0 : plans.filter((plan) => !listed.has(plan.projectId)).length };
    },

    reviews(planId) {
      if (get(planId) === null) return [];
      return [...(reviewIndex.get(planId)?.values() ?? [])].sort((a, b) => a.startedAt - b.startedAt);
    },

    allReviews() {
      return all().flatMap((plan) => [...(reviewIndex.get(plan.id)?.values() ?? [])]).sort((a, b) => a.startedAt - b.startedAt);
    },

    review(planId, reviewId) {
      return get(planId) === null ? null : reviewIndex.get(planId)?.get(reviewId) ?? null;
    },

    createReview(review) {
      const plan = get(review.planId);
      if (plan === null) throw new PlanStorageFailure('unknown-plan');
      if (reviewIndex.get(review.planId)?.has(review.id) === true) throw new PlanStorageFailure('review-exists');
      // A version can commit between a start's check and this write (C52): the review is born stale then.
      const made = { ...review, staleBy: review.staleBy ?? staleOf(plan, review.version) };
      try { writeReview(made); } catch (error) {
        if (error instanceof PlanStorageFailure) throw error;
        fail('review', error);
      }
      return made;
    },

    updateReview(planId, reviewId, change) {
      const held = get(planId) === null ? undefined : reviewIndex.get(planId)?.get(reviewId);
      if (held === undefined) throw new PlanStorageFailure('unknown-review');
      const next = change(held);
      if (next === null || next === held) return held;
      if (next.id !== held.id || next.planId !== held.planId) throw new PlanStorageFailure('review-renamed');
      try { writeReview(next); } catch (error) {
        if (error instanceof PlanStorageFailure) throw error;
        fail('review', error);
      }
      return next;
    },
  };
}
