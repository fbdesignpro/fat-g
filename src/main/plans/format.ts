// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A plan's record, `plans/<plan id>/plan.json` (docs/planning/_archive/M22b.md, Design 2; C16, C59, C62; decision
// 0029): the plan's id, its project, its title, and per version its state, who produced it, when,
// its length and content hash, and how it came about — for a version a review's integration made,
// which review, which integration and which findings (M22e, C11, C35). The text is the version
// files' beside it, and never here. Pure: the store reads and writes the file, and this says what it
// holds.
//
// And since version 3 the plan's workflow (decision 0029): the one state its chats share — ready,
// under review, being revised, being implemented, interrupted, or implemented or discarded on its
// way to deletion — its revision, the version every decision stands on, the chats taking part, and
// the operation that holds it: its kind, its session, the version it started from and the turns it
// went by, so that a launch recovers it from the disk alone. The transitions a version's commit
// makes are here too, so that the commit and the workflow's change are one write.
//
// Under the version envelope every stored format carries (decision 0005): a newer file is refused
// and left as it is, an older one too until the first release (decision 0014). Unknown fields are
// kept: a field this build does not know is written back as it was read, the plan's, each
// version's and the workflow's alike, so that a newer build's additions survive an older build's write.
import { readEnvelope } from '../storage/envelope';
import { isPlanId, PLAN_CAUSES, PLAN_VERSION_STATES, type PlanCause, type PlanIntegration, type PlanVersionState } from '@shared/contracts/plans';
import { isFindingId, isReviewId } from '@shared/contracts/review';
import { WORKFLOW_OPERATIONS, WORKFLOW_STATES, type WorkflowOperation, type WorkflowState } from '@shared/contracts/workflow';

/**
 * The format of `plan.json`: the reader this build is, and the oldest that may read and edit what it
 * writes. Version 2 (M22e, C35): a version's cause may be `integration`, naming its review. Version 3
 * (decision 0029): the plan's shared workflow. An older file is refused as older and left as it is,
 * its `reviews/` folder with it (decision 0014).
 */
export const PLAN_SCHEMA_VERSION = 3;
export const PLAN_MIN_READER_VERSION = 3;

export const PLAN_FILE = 'plan.json';

/** A complete version's text, and a draft's (C59). */
export const versionFile = (version: number): string => `v${version}.md`;
export const draftFile = (version: number): string => `v${version}.draft.md`;

/** A plan's own removal mark, its folder renamed (C62). */
export const REMOVING_PLAN = /^\.removing-([a-z0-9-]{1,64})$/;
/** A project's removal mark, one file for its whole scope (C62). */
export const REMOVING_PROJECT = /^\.removing-([^/\\]{1,128})\.json$/;
export const removingPlan = (planId: string): string => `.removing-${planId}`;
export const removingProject = (projectId: string): string => `.removing-${projectId}.json`;

type Row = Record<string, unknown>;

export interface PlanVersionRecord {
  readonly version: number;
  readonly state: PlanVersionState;
  /** The session and turn that produced it. */
  readonly sessionId: string;
  readonly turnId: string;
  readonly providerId: string;
  /** The account it ran on. */
  readonly instanceId: string;
  readonly model: string;
  /** When it opened. */
  readonly at: number;
  /** UTF-16 units and SHA-256 of what it holds: a complete version's whole text, a draft's what it received. */
  readonly length: number;
  readonly hash: string;
  readonly cause: PlanCause;
  /** The version a feedback, or an integration, revised. */
  readonly revises: number | null;
  /** The review, the integration and the findings, for a version caused `integration` (M22e, C11, C35); else null. */
  readonly integration: PlanIntegration | null;
  /** What this build did not know of it, as it was read. */
  readonly unknown: Readonly<Row>;
}

/**
 * What holds a plan between two ready states (decision 0029): its kind and its own id, the session
 * that holds it — a reviewer, a writer, the chat that carries it out — the version it started from
 * and that version's hash, the turns it went by, and for a review, or an integration, its review.
 */
export interface WorkflowOperationRecord {
  readonly id: string;
  readonly kind: WorkflowOperation;
  readonly sessionId: string;
  /** Null for a new plan's first version, which revises none. */
  readonly version: number | null;
  readonly hash: string | null;
  readonly turns: readonly string[];
  readonly reviewId: string | null;
  readonly at: number;
  readonly unknown: Readonly<Row>;
}

export interface WorkflowRecord {
  readonly state: WorkflowState;
  readonly revision: number;
  /** The latest complete version every decision stands on; null for a plan with none yet. */
  readonly version: number | null;
  readonly participants: readonly string[];
  readonly operation: WorkflowOperationRecord | null;
  readonly unknown: Readonly<Row>;
}

export interface PlanFileRecord {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly createdAt: number;
  readonly versions: readonly PlanVersionRecord[];
  readonly workflow: WorkflowRecord;
  readonly unknown: Readonly<Row>;
}

export type PlanFileReading =
  | { readonly kind: 'ok'; readonly plan: PlanFileRecord }
  /** Not a plan's record, or one whose fields this build cannot take: left as it is, and listed nowhere. */
  | { readonly kind: 'corrupt' }
  /** Written by a newer reader, or an older one (decision 0014): left as it is, and listed nowhere. */
  | { readonly kind: 'refused' };

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 4096): string | null => (typeof value === 'string' && value.length > 0 && value.length <= max && !/\p{Cc}/u.test(value) ? value : null);
const count = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null);
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | null => (typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : null);

const PLAN_KEYS = new Set(['schemaVersion', 'minReaderVersion', 'id', 'projectId', 'title', 'createdAt', 'versions', 'workflow']);
const WORKFLOW_KEYS = new Set(['state', 'revision', 'version', 'participants', 'operation']);
const OPERATION_KEYS = new Set(['id', 'kind', 'sessionId', 'version', 'hash', 'turns', 'reviewId', 'at']);
const VERSION_KEYS = new Set(['version', 'state', 'sessionId', 'turnId', 'providerId', 'instanceId', 'model', 'at', 'length', 'hash', 'cause', 'revises', 'integration']);
const rest = (row: Row, known: ReadonlySet<string>): Row => Object.fromEntries(Object.entries(row).filter(([key]) => !known.has(key)));

/** A version's integration (M22e, C35): its review, its integration and the findings it took, each checked. */
function readIntegration(value: unknown): PlanIntegration | null | undefined {
  if (value === null || value === undefined) return null;
  if (!isRow(value) || !isReviewId(value['reviewId']) || !isReviewId(value['integrationId']) || !Array.isArray(value['findings']) || !value['findings'].every(isFindingId)) return undefined;
  return { reviewId: value['reviewId'], integrationId: value['integrationId'], findings: [...value['findings']] };
}

function readVersion(value: unknown): PlanVersionRecord | null {
  if (!isRow(value)) return null;
  const version = count(value['version']);
  const state = oneOf(PLAN_VERSION_STATES, value['state']);
  const sessionId = text(value['sessionId'], 128);
  const turnId = text(value['turnId'], 128);
  const providerId = text(value['providerId'], 128);
  const instanceId = text(value['instanceId'], 128);
  const model = text(value['model'], 256);
  const at = count(value['at']);
  const length = count(value['length']);
  const hash = typeof value['hash'] === 'string' && /^[0-9a-f]{64}$/.test(value['hash']) ? value['hash'] : null;
  const cause = oneOf(PLAN_CAUSES, value['cause']) ?? 'plan-turn';
  const revises = value['revises'] === null || value['revises'] === undefined ? null : count(value['revises']);
  const integration = readIntegration(value['integration']);
  if (version === null || version < 1 || state === null || sessionId === null || turnId === null || providerId === null || instanceId === null || model === null || at === null || length === null || hash === null || integration === undefined) return null;
  // An integration's version names its review (C35); no other names one.
  if ((cause === 'integration') !== (integration !== null)) return null;
  return { version, state, sessionId, turnId, providerId, instanceId, model, at, length, hash, cause, revises, integration, unknown: rest(value, VERSION_KEYS) };
}

const HASH = /^[0-9a-f]{64}$/;
const ids = (value: unknown): string[] | null => (Array.isArray(value) && value.every((one) => text(one, 128) !== null) ? [...(value as string[])] : null);

function readOperation(value: unknown): WorkflowOperationRecord | null | undefined {
  if (value === null || value === undefined) return null;
  if (!isRow(value)) return undefined;
  const id = text(value['id'], 128);
  const kind = oneOf(WORKFLOW_OPERATIONS, value['kind']);
  const sessionId = text(value['sessionId'], 128);
  const version = value['version'] === null ? null : count(value['version']);
  const hash = value['hash'] === null ? null : typeof value['hash'] === 'string' && HASH.test(value['hash']) ? value['hash'] : undefined;
  const turns = ids(value['turns']);
  const reviewId = value['reviewId'] === null || value['reviewId'] === undefined ? null : isReviewId(value['reviewId']) ? value['reviewId'] : undefined;
  const at = count(value['at']);
  if (id === null || kind === null || sessionId === null || (value['version'] !== null && version === null) || hash === undefined || turns === null || reviewId === undefined || at === null) return undefined;
  return { id, kind, sessionId, version, hash, turns, reviewId, at, unknown: rest(value, OPERATION_KEYS) };
}

/** A plan's workflow as its record holds it; undefined where it cannot be taken. */
function readWorkflow(value: unknown): WorkflowRecord | undefined {
  if (!isRow(value)) return undefined;
  const state = oneOf(WORKFLOW_STATES, value['state']);
  const revision = count(value['revision']);
  const version = value['version'] === null ? null : count(value['version']);
  const participants = ids(value['participants']);
  const operation = readOperation(value['operation']);
  if (state === null || revision === null || (value['version'] !== null && version === null) || participants === null || operation === undefined) return undefined;
  // A state between two ready ones has its operation, and `ready` and `cancelled` none.
  if ((operation === null) !== (state === 'ready' || state === 'cancelled')) return undefined;
  return { state, revision, version, participants: [...new Set(participants)], operation, unknown: rest(value, WORKFLOW_KEYS) };
}

/** What this build reads of a `plan.json`: refused by its envelope, corrupt, or the plan with what it did not know kept. */
export function readPlanFile(document: unknown): PlanFileReading {
  const envelope = readEnvelope(document, PLAN_SCHEMA_VERSION);
  if (envelope.kind === 'corrupt') return { kind: 'corrupt' };
  if (envelope.kind !== 'ok' || !isRow(document)) return { kind: 'refused' };
  const id = document['id'];
  const projectId = text(document['projectId'], 128);
  const title = typeof document['title'] === 'string' ? document['title'] : null;
  const createdAt = count(document['createdAt']);
  const rawVersions = document['versions'];
  const workflow = readWorkflow(document['workflow']);
  if (!isPlanId(id) || projectId === null || title === null || createdAt === null || !Array.isArray(rawVersions) || workflow === undefined) return { kind: 'corrupt' };
  const versions: PlanVersionRecord[] = [];
  for (const raw of rawVersions) {
    const version = readVersion(raw);
    // One version this build cannot take makes the record one it cannot write back whole.
    if (version === null) return { kind: 'corrupt' };
    versions.push(version);
  }
  const numbers = new Set(versions.map((version) => version.version));
  if (numbers.size !== versions.length) return { kind: 'corrupt' };
  // The version a workflow stands on is a complete one of its own.
  if (workflow.version !== null && versions.find((one) => one.version === workflow.version)?.state !== 'complete') return { kind: 'corrupt' };
  return { kind: 'ok', plan: { id, projectId, title, createdAt, versions: [...versions].sort((a, b) => a.version - b.version), workflow, unknown: rest(document, PLAN_KEYS) } };
}

/** The document a plan's record is written as: its unknown fields first, then what this build knows. */
export function planDocument(plan: PlanFileRecord): Row {
  return {
    ...plan.unknown,
    schemaVersion: PLAN_SCHEMA_VERSION,
    minReaderVersion: PLAN_MIN_READER_VERSION,
    id: plan.id,
    projectId: plan.projectId,
    title: plan.title,
    createdAt: plan.createdAt,
    versions: plan.versions.map((version) => ({
      ...version.unknown,
      version: version.version,
      state: version.state,
      sessionId: version.sessionId,
      turnId: version.turnId,
      providerId: version.providerId,
      instanceId: version.instanceId,
      model: version.model,
      at: version.at,
      length: version.length,
      hash: version.hash,
      cause: version.cause,
      revises: version.revises,
      ...(version.integration === null ? {} : { integration: { reviewId: version.integration.reviewId, integrationId: version.integration.integrationId, findings: [...version.integration.findings] } }),
    })),
    workflow: workflowDocument(plan.workflow),
  };
}

function workflowDocument(workflow: WorkflowRecord): Row {
  const { operation } = workflow;
  return {
    ...workflow.unknown,
    state: workflow.state,
    revision: workflow.revision,
    version: workflow.version,
    participants: [...workflow.participants],
    operation: operation === null ? null : { ...operation.unknown, id: operation.id, kind: operation.kind, sessionId: operation.sessionId, version: operation.version, hash: operation.hash, turns: [...operation.turns], reviewId: operation.reviewId, at: operation.at },
  };
}

// ── The workflow at a version's commit (decision 0029) ────────────────────────────────────────

/**
 * A new plan's workflow: its maker takes part in it and is the one writing it — or, for a plan whose
 * first version came whole, it is ready on that version at once.
 */
export function newWorkflow(maker: { readonly id: string; readonly sessionId: string; readonly turnId: string; readonly at: number }, complete: number | null): WorkflowRecord {
  if (complete !== null) return { state: 'ready', revision: 1, version: complete, participants: [maker.sessionId], operation: null, unknown: {} };
  return {
    state: 'revising', revision: 1, version: null, participants: [maker.sessionId],
    operation: { id: maker.id, kind: 'revision', sessionId: maker.sessionId, version: null, hash: null, turns: [maker.turnId], reviewId: null, at: maker.at, unknown: {} },
    unknown: {},
  };
}

/**
 * A complete version committed, in the same write as its commit: a plan being revised, or ready on a
 * version the same turn wrote, is ready on it now, its writer taking part. A plan any other
 * operation holds keeps its state: no version of it is admitted then.
 */
export function committed(workflow: WorkflowRecord, version: PlanVersionRecord): WorkflowRecord {
  if (version.state !== 'complete' || (workflow.state !== 'revising' && workflow.state !== 'ready')) return workflow;
  const participants = workflow.participants.includes(version.sessionId) ? workflow.participants : [...workflow.participants, version.sessionId];
  return { ...workflow, state: 'ready', revision: workflow.revision + 1, version: version.version, participants, operation: null };
}

/** A project's removal mark (C62): the project, and every plan the removal takes, named whole before anything else of it. */
export interface ProjectMark {
  readonly projectId: string;
  readonly plans: readonly string[];
}

export function readProjectMark(document: unknown): ProjectMark | null {
  if (!isRow(document)) return null;
  const projectId = text(document['projectId'], 128);
  const plans = document['plans'];
  if (projectId === null || !Array.isArray(plans) || !plans.every(isPlanId)) return null;
  return { projectId, plans };
}

export function projectMarkDocument(mark: ProjectMark): Row {
  return { schemaVersion: PLAN_SCHEMA_VERSION, minReaderVersion: PLAN_MIN_READER_VERSION, projectId: mark.projectId, plans: [...mark.plans] };
}
