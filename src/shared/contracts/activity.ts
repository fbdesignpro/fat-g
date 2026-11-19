// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What a session does between its messages (docs/planning/_archive/M20a.md, Design 1; C3–C12; decision 0024):
// a read, a search, a command, an edit, an MCP call, a web search, a sub-agent, a wait, a thinking,
// a checklist, or a tool fat-g does not know. Each is an item of the conversation of kind
// `activity`, and this is its body: what the provider reported of it, bounded, as it was reported
// at the time and never as the file system's present state. fat-g computes nothing of it but a
// duration where the provider gives none.
//
// Renderer-safe, and provider-neutral: the types are closed, and each adapter maps its CLI's items
// and tools onto them in its own folder. An item or a tool an adapter does not know is `other`,
// with the provider's name for it and nothing else read of it (C4). A plan is no type here.
//
// It imports `zod` and the one cut, and nothing of Node, the page or main.
import { z } from 'zod';
import { cutFromEnd, cutTo } from './cut';

// ── Types and statuses (C4, C6) ───────────────────────────────────────────────────────────────

export const ACTIVITY_TYPES = ['read', 'search', 'command', 'edit', 'mcp', 'web-search', 'worker', 'wait', 'thinking', 'checklist', 'other'] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/**
 * `running` from the item's start; `completed` or `failed` at its end, as the provider reports it;
 * `unfinished` for one whose end never came when its turn ended, or when fat-g did (C6). A
 * checklist, which no frame ends, is completed with its turn (C11); a worker item's status is its
 * worker's end (C23). `declined` (M22, C76): the action was refused leave and never ran — by the
 * user's Deny, by a rule of the user's own configuration, or as the provider reports it — which is
 * no failure of the agent's; an action that ran keeps the status its provider gave.
 */
export const ACTIVITY_STATUSES = ['running', 'completed', 'failed', 'unfinished', 'declined'] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];
/** How an item's own end reads: what an adapter may report. */
export const ENDED_STATUSES = ['completed', 'failed', 'declined'] as const;
export type EndedStatus = (typeof ENDED_STATUSES)[number];
/** What a provider's history says of an item: its end, or that it has none. */
export const HISTORY_STATUSES = ['completed', 'failed', 'unfinished', 'declined'] as const;

/** Who declined an action, where its adapter knows (M22, C76): the user, on its card, or a rule of the user's own CLI configuration. */
export const DECLINED_BY = ['user', 'rule'] as const;
export type DeclinedBy = (typeof DECLINED_BY)[number];

/** The kind of change an edit reports for a file (C10): `write` is a whole file's content, `other` a kind fat-g does not know. */
export const CHANGE_KINDS = ['add', 'delete', 'update', 'write', 'other'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const STEP_STATES = ['pending', 'in-progress', 'completed'] as const;
export type StepState = (typeof STEP_STATES)[number];

// ── Bounds (C5), in UTF-16 units ──────────────────────────────────────────────────────────────

export const MAX_ACTIVITY_NAME = 256;
/** A worker item's model, a catalog id's bound (M106, C19). */
export const MAX_ACTIVITY_MODEL = 128;
/** One line. */
export const MAX_ACTIVITY_SUMMARY = 2_000;
export const MAX_ACTIVITY_INPUT = 10_000;
/** Kept as its first and its last half, with how much was left out between them. */
export const MAX_ACTIVITY_OUTPUT = 20_000;
export const MAX_ACTIVITY_THINKING = 20_000;
/** A change's text, and how many changes an edit keeps. */
export const MAX_CHANGE_TEXT = 20_000;
export const MAX_CHANGES = 20;
export const MAX_ACTIVITY_PATH = 2_048;
export const MAX_ACTIVITY_FILES = 200;
export const MAX_STEPS = 100;
export const MAX_STEP_TEXT = 500;
/** The body as a whole, in units of its strings: past it, fields give way in `GIVES_WAY`'s order. */
export const MAX_ACTIVITY_UNITS = 200_000;
/** The highest line a reference names: nine digits, as a target's is (M19b, C22). */
export const MAX_REFERENCE_LINE = 999_999_999;

// ── The body ──────────────────────────────────────────────────────────────────────────────────

/** A file an item names (C8): the path as the provider wrote it, resolved by no one until it is pressed. */
export interface FileReference {
  readonly path: string;
  readonly line: number | null;
}

/** One file of an edit (C10): what the provider reported, the diff or the content where it gave one. */
export interface EditChange {
  readonly path: string;
  readonly kind: ChangeKind;
  readonly text: string | null;
}

export interface ChecklistStep {
  readonly text: string;
  readonly state: StepState;
}

/** The fields a cut can name. */
export const ACTIVITY_CUT_FIELDS = ['name', 'summary', 'input', 'output', 'thinking', 'changes', 'steps', 'files'] as const;
export type ActivityCutField = (typeof ACTIVITY_CUT_FIELDS)[number];

/**
 * What was cut of an item, so its row can say so (C5), as a message says its marker (M15, C53).
 * `fields`: each field that lost something — a text cut to its bound, a list cut to its count, or
 * either given up whole to the body's bound. `output`: for an output kept as two halves, how many
 * units were left out between them, and where the first half ends in what is kept.
 */
export interface ActivityCut {
  /** A list of its own, never shared: an event carries it as it is. */
  readonly fields: ActivityCutField[];
  readonly output: { readonly omitted: number; readonly at: number } | null;
  /** How many files, steps and changes were left out. */
  readonly files: number;
  readonly steps: number;
  readonly changes: number;
}

/** A duration with whose it is (C7): the provider's, or the span of fat-g's own receipts on a monotonic clock. */
export interface ActivityDuration {
  readonly ms: number;
  readonly provenance: 'provider' | 'local';
}

export interface ActivityBody {
  readonly type: ActivityType;
  /** The provider's name for it: a tool's name, an item's type, an MCP server and tool. */
  readonly name: string;
  /** One line: fat-g's or the provider's. A worker item's is its worker's label, as the agent list has it (C23). */
  readonly summary: string;
  /** A command line, a tool's input as JSON text, an MCP call's arguments. */
  readonly input: string | null;
  /** Aggregated output, a tool result's text, a worker's report. */
  readonly output: string | null;
  readonly files: readonly FileReference[];
  readonly status: ActivityStatus;
  readonly exitCode: number | null;
  /** An edit's. */
  readonly changes: readonly EditChange[];
  /** A checklist's. */
  readonly steps: readonly ChecklistStep[];
  /** A thinking item's text, as the provider emitted it: never fabricated (C9). */
  readonly thinking: string | null;
  /** A worker item's worker, once one is paired with it (C23). Not whose item this is: that is the item's own `workerId`. */
  readonly workerId: string | null;
  readonly duration: ActivityDuration | null;
  readonly cut: ActivityCut | null;
  /** For a `declined` item, who declined it, where known (M22, C76); null for every other, and where the provider said no more. */
  readonly declinedBy: DeclinedBy | null;
  /**
   * A worker item's model, as its CLI named it — at the start, then again once the worker spoke —
   * a key or an alias; null where none was named, and for every other type (M106, C19).
   */
  readonly model: string | null;
  /** A worker item's agent definition, as the CLI named it (M106, C20); null where it named none. */
  readonly agentType: string | null;
}

// ── Schemas: what an event may carry (C5, C59) ────────────────────────────────────────────────
// A string that is only too long never fails: the adapter cuts it first (`cutParts`).

const count = z.number().int().min(0).max(1_000_000_000);
const path = z.string().min(1).max(MAX_ACTIVITY_PATH);

export const FileReferenceSchema = z.strictObject({ path, line: z.number().int().min(1).max(MAX_REFERENCE_LINE).nullable() });
export const EditChangeSchema = z.strictObject({ path, kind: z.enum(CHANGE_KINDS), text: z.string().max(MAX_CHANGE_TEXT).nullable() });
export const ChecklistStepSchema = z.strictObject({ text: z.string().max(MAX_STEP_TEXT), state: z.enum(STEP_STATES) });
export const ActivityCutSchema = z.strictObject({
  fields: z.array(z.enum(ACTIVITY_CUT_FIELDS)).max(ACTIVITY_CUT_FIELDS.length),
  output: z.strictObject({ omitted: count, at: z.number().int().min(0).max(MAX_ACTIVITY_OUTPUT) }).nullable(),
  files: count,
  steps: count,
  changes: count,
});

/** What both of an item's events may carry of its body. */
const sharedFields = {
  files: z.array(FileReferenceSchema).max(MAX_ACTIVITY_FILES).optional(),
  changes: z.array(EditChangeSchema).max(MAX_CHANGES).optional(),
  steps: z.array(ChecklistStepSchema).max(MAX_STEPS).optional(),
  thinking: z.string().max(MAX_ACTIVITY_THINKING).optional(),
  cut: ActivityCutSchema.optional(),
};

/** What an item's start says of it. A worker item's may name its model and its agent definition (M106, C19, C20). */
export const activityStartFields = {
  activityType: z.enum(ACTIVITY_TYPES),
  name: z.string().max(MAX_ACTIVITY_NAME),
  summary: z.string().max(MAX_ACTIVITY_SUMMARY),
  input: z.string().max(MAX_ACTIVITY_INPUT).optional(),
  model: z.string().min(1).max(MAX_ACTIVITY_MODEL).refine((value) => !/\p{Cc}/u.test(value), 'control character').optional(),
  agentType: z.string().max(MAX_ACTIVITY_SUMMARY).optional(),
  ...sharedFields,
};

/** What an item's end adds. */
export const activityEndFields = {
  output: z.string().max(MAX_ACTIVITY_OUTPUT).optional(),
  exitCode: z.number().int().min(-2_147_483_648).max(2_147_483_647).optional(),
  /** With a `declined` status, who declined it (M22, C76). */
  declinedBy: z.enum(DECLINED_BY).optional(),
  ...sharedFields,
};

/**
 * What stands in a result's text for a block that is no text (C12, C18): an image, a UI resource,
 * or a block of a kind an adapter does not read. fat-g's words, the same for every provider.
 */
export function placeholderLine(kind: 'image' | 'resource' | 'other'): string {
  return kind === 'image' ? '[An image, which fat-g does not show.]' : kind === 'resource' ? '[A resource, which fat-g does not show.]' : '[Content of a kind fat-g does not show.]';
}

/** A value as the JSON text an input or a result shows (C12, C17): indented, or nothing for a value that has none. */
export function jsonText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2) ?? null; } catch { return null; }
}

/** A path's last segment, whichever way its separators lean: what a row names a file by. */
export function fileName(path: string): string {
  return path.split(/[\\/]/).filter((part) => part !== '').at(-1) ?? path;
}

// ── The cut, field by field (C5) ──────────────────────────────────────────────────────────────

/** An item's fields as an adapter read them, before any bound. A field left out was not read. */
export interface ActivityParts {
  readonly name?: string;
  readonly summary?: string;
  readonly input?: string | null;
  readonly output?: string | null;
  readonly thinking?: string | null;
  readonly files?: readonly FileReference[];
  readonly changes?: readonly EditChange[];
  readonly steps?: readonly ChecklistStep[];
}

const NO_CUT: ActivityCut = { fields: [], output: null, files: 0, steps: 0, changes: 0 };

const isCut = (cut: ActivityCut): boolean => cut.fields.length > 0;

/** `fields` in the contract's own order, one of each. */
const ordered = (fields: Iterable<ActivityCutField>): ActivityCutField[] => {
  const seen = new Set(fields);
  return ACTIVITY_CUT_FIELDS.filter((field) => seen.has(field));
};

/** Two cuts of one item, as one: a later one's output cut and counts stand for the fields it names. */
export function mergeCuts(earlier: ActivityCut | null, later: ActivityCut | null): ActivityCut | null {
  if (earlier === null || later === null) return later ?? earlier;
  const named = (field: ActivityCutField): boolean => later.fields.includes(field);
  return {
    fields: ordered([...earlier.fields, ...later.fields]),
    output: named('output') ? later.output : earlier.output,
    files: named('files') ? later.files : earlier.files,
    steps: named('steps') ? later.steps : earlier.steps,
    changes: named('changes') ? later.changes : earlier.changes,
  };
}

/** A summary is one line (C5): the first that holds anything, cut. */
function oneLine(value: string): { readonly text: string; readonly cut: boolean } {
  const first = value.split(/\r?\n/).find((part) => part.trim() !== '') ?? '';
  return cutTo(first.trim(), MAX_ACTIVITY_SUMMARY);
}

/**
 * An output within its bound: as it is, or its first and its last half (C5) — a command's line is at
 * its start and its error at its end — with how many units were left out between them.
 */
export function cutOutput(value: string): { readonly text: string; readonly cut: ActivityCut['output'] } {
  if (value.length <= MAX_ACTIVITY_OUTPUT) return { text: value, cut: null };
  const half = MAX_ACTIVITY_OUTPUT / 2;
  const head = cutTo(value, half).text;
  const tail = cutFromEnd(value, half);
  return { text: head + tail, cut: { omitted: value.length - head.length - tail.length, at: head.length } };
}

/**
 * Each field of `parts` within its own bound (C5), with what was cut. What an adapter runs every
 * item through as it takes it (M15, C113), so that no event fails its schema for a length: a field
 * left out stays out, a path over its bound is no path and its entry is left out and counted.
 */
export function cutParts(parts: ActivityParts): { readonly parts: ActivityParts; readonly cut: ActivityCut | null } {
  const fields = new Set<ActivityCutField>();
  let cut: ActivityCut = NO_CUT;
  const out: { -readonly [K in keyof ActivityParts]: ActivityParts[K] } = {};
  const take = (field: 'name' | 'input' | 'thinking', max: number): void => {
    const value = parts[field];
    if (value === undefined) return;
    if (value === null) { if (field !== 'name') out[field] = null; return; }
    const taken = cutTo(value, max);
    out[field] = taken.text;
    if (taken.cut) fields.add(field);
  };
  take('name', MAX_ACTIVITY_NAME);
  if (parts.summary !== undefined) {
    const taken = oneLine(parts.summary);
    out.summary = taken.text;
    if (taken.cut) fields.add('summary');
  }
  take('input', MAX_ACTIVITY_INPUT);
  if (parts.output !== undefined) {
    const taken = parts.output === null ? null : cutOutput(parts.output);
    out.output = taken?.text ?? null;
    if (taken !== null && taken.cut !== null) { fields.add('output'); cut = { ...cut, output: taken.cut }; }
  }
  take('thinking', MAX_ACTIVITY_THINKING);
  if (parts.files !== undefined) {
    const valid = parts.files.filter((file) => file.path !== '' && file.path.length <= MAX_ACTIVITY_PATH);
    out.files = valid.slice(0, MAX_ACTIVITY_FILES);
    const left = parts.files.length - out.files.length;
    if (left > 0) { fields.add('files'); cut = { ...cut, files: left }; }
  }
  if (parts.changes !== undefined) {
    const valid = parts.changes.filter((change) => change.path !== '' && change.path.length <= MAX_ACTIVITY_PATH);
    let textCut = false;
    out.changes = valid.slice(0, MAX_CHANGES).map((change) => {
      if (change.text === null) return change;
      const taken = cutTo(change.text, MAX_CHANGE_TEXT);
      textCut ||= taken.cut;
      return taken.cut ? { ...change, text: taken.text } : change;
    });
    const left = parts.changes.length - out.changes.length;
    if (left > 0 || textCut) { fields.add('changes'); cut = { ...cut, changes: left }; }
  }
  if (parts.steps !== undefined) {
    let textCut = false;
    out.steps = parts.steps.slice(0, MAX_STEPS).map((step) => {
      const taken = cutTo(step.text, MAX_STEP_TEXT);
      textCut ||= taken.cut;
      return taken.cut ? { ...step, text: taken.text } : step;
    });
    const left = parts.steps.length - out.steps.length;
    if (left > 0 || textCut) { fields.add('steps'); cut = { ...cut, steps: left }; }
  }
  cut = { ...cut, fields: ordered(fields) };
  return { parts: out, cut: isCut(cut) ? cut : null };
}

const units = (value: string | null | undefined): number => value?.length ?? 0;

/** A body's size, in UTF-16 units of its strings: what its own bound counts (C5), and the window's (C31). */
export function activityUnits(body: Pick<ActivityBody, 'name' | 'summary' | 'input' | 'output' | 'thinking' | 'files' | 'changes' | 'steps'>): number {
  return (
    body.name.length + body.summary.length + units(body.input) + units(body.output) + units(body.thinking) +
    body.files.reduce((sum, file) => sum + file.path.length, 0) +
    body.changes.reduce((sum, change) => sum + change.path.length + units(change.text), 0) +
    body.steps.reduce((sum, step) => sum + step.text.length, 0)
  );
}

/** The order fields give way in, past the body's bound (C5): each whole, a text to nothing and a list to its count. */
export const GIVES_WAY = ['changes', 'output', 'input', 'steps', 'thinking', 'files'] as const;

/**
 * A body within every bound (C5): each field within its own, by `cutParts`, and the whole within
 * `MAX_ACTIVITY_UNITS` — past that, fields give way in `GIVES_WAY`'s order until it fits, each cut
 * to nothing or to its count, and `cut` names them. A body within its bounds comes back as it is.
 */
export function boundActivity(body: ActivityBody): ActivityBody {
  const taken = cutParts({ name: body.name, summary: body.summary, input: body.input, output: body.output, thinking: body.thinking, files: body.files, changes: body.changes, steps: body.steps });
  let next: ActivityBody = taken.cut === null ? body : { ...body, ...(taken.parts as Partial<ActivityBody>), cut: mergeCuts(body.cut, taken.cut) };
  if (activityUnits(next) <= MAX_ACTIVITY_UNITS) return next;
  let cut = next.cut ?? NO_CUT;
  for (const field of GIVES_WAY) {
    if (activityUnits(next) <= MAX_ACTIVITY_UNITS) break;
    if (field === 'changes' || field === 'steps' || field === 'files') {
      const held = next[field].length;
      if (held === 0) continue;
      next = { ...next, [field]: [] };
      cut = { ...cut, fields: ordered([...cut.fields, field]), [field]: cut[field] + held };
    } else {
      if (next[field] === null || next[field] === '') continue;
      next = { ...next, [field]: null };
      cut = { ...cut, fields: ordered([...cut.fields, field]), ...(field === 'output' ? { output: null } : {}) };
    }
  }
  return { ...next, cut };
}

// ── A body, made and changed ──────────────────────────────────────────────────────────────────

/** What an item's start gives of its body: the start event's fields, and the worker paired with a worker item, its model and its agent definition. */
export interface ActivityStart extends ActivityParts {
  readonly type: ActivityType;
  readonly name: string;
  readonly summary: string;
  readonly workerId?: string | null;
  readonly cut?: ActivityCut | null;
  readonly model?: string | null;
  readonly agentType?: string | null;
}

/** What an item's end adds to it. */
export interface ActivityEnd extends ActivityParts {
  readonly status: ActivityStatus;
  readonly exitCode?: number | null;
  readonly duration?: ActivityDuration | null;
  readonly cut?: ActivityCut | null;
  readonly declinedBy?: DeclinedBy | null;
}

/** A body at its start: running, with what the start said, within every bound. */
export function startedBody(start: ActivityStart): ActivityBody {
  return boundActivity({
    type: start.type, name: start.name, summary: start.summary, input: start.input ?? null, output: start.output ?? null, files: start.files ?? [], status: 'running',
    exitCode: null, changes: start.changes ?? [], steps: start.steps ?? [], thinking: start.thinking ?? null, workerId: start.workerId ?? null, duration: null, cut: start.cut ?? null, declinedBy: null,
    model: start.model ?? null, agentType: start.agentType ?? null,
  });
}

/**
 * A second start for an item that is open (C59): the fields it gives replace the body's, and what
 * it does not give stays — the item's status, its output, its duration. A checklist's each update,
 * and a worker item's model once its worker named it (M106, C19).
 */
export function restartedBody(body: ActivityBody, start: ActivityStart): ActivityBody {
  return boundActivity({
    ...body,
    type: start.type,
    name: start.name,
    summary: start.summary,
    ...(start.input === undefined ? {} : { input: start.input }),
    ...(start.files === undefined ? {} : { files: start.files }),
    ...(start.changes === undefined ? {} : { changes: start.changes }),
    ...(start.steps === undefined ? {} : { steps: start.steps }),
    ...(start.thinking === undefined ? {} : { thinking: start.thinking }),
    ...(start.workerId === undefined || start.workerId === null ? {} : { workerId: start.workerId }),
    ...(start.model === undefined || start.model === null ? {} : { model: start.model }),
    ...(start.agentType === undefined || start.agentType === null ? {} : { agentType: start.agentType }),
    cut: mergeCuts(body.cut, start.cut ?? null),
  });
}

/** A body at its end: its status, and what the end said over what the start did. */
export function endedBody(body: ActivityBody, end: ActivityEnd): ActivityBody {
  return boundActivity({
    ...body,
    status: end.status,
    ...(end.summary === undefined ? {} : { summary: end.summary }),
    ...(end.output === undefined ? {} : { output: end.output }),
    ...(end.exitCode === undefined ? {} : { exitCode: end.exitCode }),
    ...(end.files === undefined ? {} : { files: end.files }),
    ...(end.changes === undefined ? {} : { changes: end.changes }),
    ...(end.steps === undefined ? {} : { steps: end.steps }),
    ...(end.thinking === undefined ? {} : { thinking: end.thinking }),
    ...(end.duration === undefined ? {} : { duration: end.duration }),
    // Who declined it stands for a declined item alone (M22, C76).
    declinedBy: end.status === 'declined' ? end.declinedBy ?? null : null,
    cut: mergeCuts(body.cut, end.cut ?? null),
  });
}

/** Whether an item's end has come: what the store's `complete` says of it (C29, C58). A declined one's has (M22, C76). */
export function isEnded(status: ActivityStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'declined';
}

// ── A stored body, read (C28) ─────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const whole = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) ? value : null);
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | null => (typeof value === 'string' && (values as readonly string[]).includes(value) ? (value as T) : null);
const list = <T>(value: unknown, read: (entry: Row) => T | null): T[] => (Array.isArray(value) ? value.flatMap((entry: unknown) => { const taken = isRow(entry) ? read(entry) : null; return taken === null ? [] : [taken]; }) : []);

function readCut(value: unknown): ActivityCut | null {
  if (!isRow(value)) return null;
  const output = isRow(value['output']) ? { omitted: whole(value['output']['omitted']) ?? 0, at: whole(value['output']['at']) ?? 0 } : null;
  const fields = Array.isArray(value['fields']) ? ordered(value['fields'].flatMap((field: unknown) => { const known = oneOf(ACTIVITY_CUT_FIELDS, field); return known === null ? [] : [known]; })) : [];
  return { fields, output, files: whole(value['files']) ?? 0, steps: whole(value['steps']) ?? 0, changes: whole(value['changes']) ?? 0 };
}

/**
 * What this build reads of a stored activity: the keys it knows, each checked, and nothing failing
 * for a key it does not. Null for what is no activity at all. A type this build does not know reads
 * `other`; a status it does not know reads `unfinished`, which claims nothing.
 */
export function readActivity(value: unknown): ActivityBody | null {
  if (!isRow(value)) return null;
  const duration = isRow(value['duration']) && whole(value['duration']['ms']) !== null ? { ms: Math.max(0, whole(value['duration']['ms']) ?? 0), provenance: value['duration']['provenance'] === 'provider' ? 'provider' as const : 'local' as const } : null;
  return {
    type: oneOf(ACTIVITY_TYPES, value['type']) ?? 'other',
    name: text(value['name']) ?? '',
    summary: text(value['summary']) ?? '',
    input: text(value['input']),
    output: text(value['output']),
    files: list(value['files'], (entry) => (typeof entry['path'] === 'string' ? { path: entry['path'], line: whole(entry['line']) } : null)),
    status: oneOf(ACTIVITY_STATUSES, value['status']) ?? 'unfinished',
    exitCode: whole(value['exitCode']),
    changes: list(value['changes'], (entry) => (typeof entry['path'] === 'string' ? { path: entry['path'], kind: oneOf(CHANGE_KINDS, entry['kind']) ?? 'other', text: text(entry['text']) } : null)),
    steps: list(value['steps'], (entry) => (typeof entry['text'] === 'string' ? { text: entry['text'], state: oneOf(STEP_STATES, entry['state']) ?? 'pending' } : null)),
    thinking: text(value['thinking']),
    workerId: text(value['workerId']),
    duration,
    cut: readCut(value['cut']),
    declinedBy: oneOf(DECLINED_BY, value['declinedBy']),
    model: text(value['model']),
    agentType: text(value['agentType']),
  };
}
