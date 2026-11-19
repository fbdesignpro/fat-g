// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What a Codex item is, as an activity (docs/planning/_archive/M20a.md, Design 3; C7–C12, C14, C19): each
// item type's own fields, taken by name and bounded as they are taken, mapped onto fat-g's closed
// types. One reading for a live item's two frames and for an item of a history read, which holds
// both at once. Nothing else of an item leaves this module: no `cwd`, no `processId`, no `agentPath`,
// no account field.
//
//   commandExecution     read, when its first command action is a read; else command
//   fileChange           edit
//   mcpToolCall          mcp
//   webSearch            web-search
//   reasoning            thinking
//   collabAgentToolCall  by its tool (K3): `spawnAgent` is the worker's own item, with what the
//                        sub-agent is asked as its input; `wait` is a wait; any other, by its name
//   sleep                wait
//   imageView            read: an image the agent looked at, its one file — which the chat draws
//                        (decision 0022, item 15)
//   any other, a `plan`  other: its type as its name, and nothing else read of it (C4)
//
// `userMessage` and `agentMessage` are messages and `subAgentActivity` a worker's announcement:
// neither is read here. A command's `commandActions` are Codex's own reading of its command line;
// most read `unknown` (K1), and such a command is a command.
//
// The fields of `mcpToolCall` and `webSearch` are the schema's, read and not observed: the scratch
// configurations hold no MCP server (C12). A `fileChange` item is observed (M22, K1): its changes
// are on both of its frames, each a path, a kind and a diff.
//
// An item the user, a rule or Codex itself refused leave ends `declined` (docs/planning/_archive/M22.md,
// Design 4, 7; C76): a status of its own, live and from history, which is no failure of the agent's.
import { z } from 'zod';
import { type ActivityCut, type ActivityParts, type ActivityType, type ChangeKind, type ChecklistStep, cutParts, type EditChange, fileName, type FileReference, jsonText, placeholderLine, type StepState } from '@shared/contracts/activity';

const text = z.string().nullish();
const CommandItem = z.object({
  command: text,
  status: text,
  commandActions: z.array(z.object({ type: text, command: text, name: text, path: text })).nullish(),
  aggregatedOutput: text,
  exitCode: z.number().nullish(),
  durationMs: z.number().nullish(),
});
const FileChangeItem = z.object({ status: text, changes: z.array(z.object({ path: z.string(), kind: z.unknown().optional(), diff: text })).nullish() });
const McpItem = z.object({ server: text, tool: text, status: text, arguments: z.unknown().optional(), result: z.unknown().optional(), error: z.unknown().optional(), durationMs: z.number().nullish() });
const WebSearchItem = z.object({ query: text, status: text });
const ReasoningItem = z.object({ summary: z.array(z.unknown()).nullish(), content: z.array(z.unknown()).nullish() });
const WaitItem = z.object({ tool: text, status: text, prompt: text });
const ImageViewItem = z.object({ path: text, status: text });
const StatusItem = z.object({ status: text });
const PlanFrame = z.object({ plan: z.array(z.object({ step: z.string(), status: text })) });

/** How an item says it stands: `in-progress` while it runs, and on a frame that names no status at all a completed frame is its end. `declined` (M22, C76): it was refused leave, and never ran. */
type Outcome = 'completed' | 'failed' | 'declined' | 'in-progress';

export interface TakenActivity {
  readonly itemId: string;
  readonly activityType: ActivityType;
  /** What its start says, within its bounds. */
  readonly start: ActivityParts & { readonly name: string; readonly summary: string };
  readonly startCut: ActivityCut | null;
  /** What its end adds, within its bounds. */
  readonly end: ActivityParts;
  readonly endCut: ActivityCut | null;
  readonly exitCode: number | null;
  readonly outcome: Outcome;
  /** The CLI's own, a zero included; null where the item has none. */
  readonly durationMs: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A whole number of the CLI's, or null: a duration, an exit code. */
const whole = (value: number | null | undefined, min: number): number | null => (typeof value === 'number' && Number.isSafeInteger(Math.round(value)) && Math.round(value) >= min ? Math.round(value) : null);

function outcomeOf(status: string | null | undefined, failed = false): Outcome {
  // Codex's own word comes first (M22, C76): an item that was declined never ran, whatever else its frame holds.
  if (status === 'declined') return 'declined';
  if (failed || status === 'failed') return 'failed';
  return status === 'inProgress' ? 'in-progress' : 'completed';
}

/** A change's kind, from the schema's `{ type }` or a bare string. */
export function changeKind(kind: unknown): ChangeKind {
  const type = isRecord(kind) ? kind['type'] : kind;
  return type === 'add' || type === 'delete' || type === 'update' ? type : 'other';
}

/** A result's content blocks as text (C12): a text block as it is, an image or a resource a placeholder line. */
function blocksText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const lines = content.map((block: unknown): string => {
    if (!isRecord(block)) return placeholderLine('other');
    if (block['type'] === 'text' && typeof block['text'] === 'string') return block['text'];
    return placeholderLine(block['type'] === 'image' ? 'image' : block['type'] === 'resource' || block['type'] === 'resource_link' ? 'resource' : 'other');
  });
  return lines.join('\n\n');
}

/** An MCP call's result as text: its error's own words, else its content, else whatever it holds, as JSON. */
function mcpOutput(result: unknown, error: unknown): string | null {
  if (isRecord(error) && typeof error['message'] === 'string') return error['message'];
  if (error !== null && error !== undefined) return jsonText(error);
  if (isRecord(result)) return blocksText(result['content']) ?? jsonText(result);
  return jsonText(result);
}

/** A reasoning item's lists as one text (C9): each entry a string, or an object with its text. Empty lists give none. */
function reasoningText(...lists: (readonly unknown[] | null | undefined)[]): string | null {
  const parts = lists.flatMap((list) => (list ?? []).flatMap((entry: unknown): string[] => (typeof entry === 'string' ? [entry] : isRecord(entry) && typeof entry['text'] === 'string' ? [entry['text']] : [])));
  const joined = parts.filter((part) => part !== '').join('\n\n');
  return joined === '' ? null : joined;
}

interface Read {
  readonly activityType: ActivityType;
  readonly start: ActivityParts & { readonly name: string; readonly summary: string };
  readonly end: ActivityParts;
  readonly exitCode?: number | null;
  readonly outcome: Outcome;
  readonly durationMs?: number | null;
}

function read(type: string, raw: unknown): Read {
  switch (type) {
    case 'commandExecution': {
      const item = CommandItem.safeParse(raw).data ?? {};
      const actions = item.commandActions ?? [];
      const first = actions[0];
      const reads = first?.type === 'read';
      const files: FileReference[] = actions.flatMap((action) => (typeof action.path === 'string' && action.path !== '' ? [{ path: action.path, line: null }] : []));
      // The file's name for a read; else the command as Codex read it out of its shell's own line.
      const summary = reads ? first.name ?? (typeof first.path === 'string' ? fileName(first.path) : '') : first?.command ?? item.command ?? '';
      const exitCode = whole(item.exitCode, Number.MIN_SAFE_INTEGER);
      return {
        activityType: reads ? 'read' : 'command',
        start: { name: type, summary, input: item.command ?? null, files },
        end: typeof item.aggregatedOutput === 'string' ? { output: item.aggregatedOutput } : {},
        exitCode,
        outcome: outcomeOf(item.status, exitCode !== null && exitCode !== 0),
        durationMs: whole(item.durationMs, 0),
      };
    }
    case 'fileChange': {
      const item = FileChangeItem.safeParse(raw).data ?? {};
      const changes: EditChange[] = (item.changes ?? []).map((change) => ({ path: change.path, kind: changeKind(change.kind), text: change.diff ?? null }));
      const [first] = changes;
      const summary = first === undefined ? '' : changes.length === 1 ? fileName(first.path) : `${fileName(first.path)} and ${changes.length - 1} more`;
      // What was reported at the time, on whichever frame holds it (C10): Codex gives it with the item's end.
      const reported = changes.length === 0 ? {} : { changes, files: changes.map((change) => ({ path: change.path, line: null })) };
      return { activityType: 'edit', start: { name: type, summary, ...reported }, end: reported, outcome: outcomeOf(item.status) };
    }
    case 'mcpToolCall': {
      const item = McpItem.safeParse(raw).data ?? {};
      const name = `${item.server ?? ''}: ${item.tool ?? ''}`;
      const failed = item.error !== null && item.error !== undefined;
      const output = mcpOutput(item.result, item.error);
      return { activityType: 'mcp', start: { name, summary: name, input: jsonText(item.arguments) }, end: output === null ? {} : { output }, outcome: outcomeOf(item.status, failed), durationMs: whole(item.durationMs, 0) };
    }
    case 'webSearch': {
      const item = WebSearchItem.safeParse(raw).data ?? {};
      return { activityType: 'web-search', start: { name: type, summary: item.query ?? '', input: item.query ?? null }, end: {}, outcome: outcomeOf(item.status) };
    }
    case 'reasoning': {
      const item = ReasoningItem.safeParse(raw).data ?? {};
      const thinking = reasoningText(item.summary, item.content);
      const held = thinking === null ? {} : { thinking };
      return { activityType: 'thinking', start: { name: type, summary: '', ...held }, end: held, outcome: 'completed' };
    }
    case 'collabAgentToolCall': {
      const item = WaitItem.safeParse(raw).data ?? {};
      // A call that was interrupted did not do what it was for.
      const outcome = outcomeOf(item.status, item.status === 'interrupted');
      // The tool that starts a sub-agent is the worker's own item (C23; K3): what the sub-agent is asked is its input.
      if (item.tool === 'spawnAgent') return { activityType: 'worker', start: { name: item.tool, summary: '', input: item.prompt ?? null }, end: {}, outcome };
      if (item.tool === 'wait') return { activityType: 'wait', start: { name: type, summary: item.tool }, end: {}, outcome };
      // Any other of its tools — a message to a sub-agent, its closing — is kept by its name, and is no wait.
      return { activityType: 'other', start: { name: item.tool ?? type, summary: '' }, end: {}, outcome };
    }
    case 'sleep': {
      const item = WaitItem.safeParse(raw).data ?? {};
      return { activityType: 'wait', start: { name: type, summary: item.tool ?? '' }, end: {}, outcome: outcomeOf(item.status) };
    }
    case 'imageView': {
      // The image tool shows a picture to the model alone: its file, as a read's, is what the chat draws for the user.
      const item = ImageViewItem.safeParse(raw).data ?? {};
      const files: FileReference[] = typeof item.path === 'string' && item.path !== '' ? [{ path: item.path, line: null }] : [];
      return { activityType: 'read', start: { name: type, summary: files[0] === undefined ? '' : fileName(files[0].path), files }, end: {}, outcome: outcomeOf(item.status) };
    }
    default:
      // A type the adapter does not know, a `plan` among them: its name, and nothing else of it (C4).
      return { activityType: 'other', start: { name: type, summary: '' }, end: {}, outcome: outcomeOf(StatusItem.safeParse(raw).data?.status) };
  }
}

/** The item types that are no activity: a message, the user's echo, and a worker's announcement. */
const NOT_ACTIVITIES: ReadonlySet<string> = new Set(['userMessage', 'agentMessage', 'subAgentActivity']);
/** The types a history read maps (C19): what Codex's history holds of a turn's work. */
const HISTORY_TYPES: ReadonlySet<string> = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'reasoning', 'imageView', 'imageGeneration']);

/** An item as an activity, or null for a type that is none. Every string is cut to its bound here. */
export function takeActivity(type: string, itemId: string, raw: unknown): TakenActivity | null {
  if (NOT_ACTIVITIES.has(type)) return null;
  const taken = read(type, raw);
  const start = cutParts(taken.start);
  const end = cutParts(taken.end);
  return {
    itemId,
    activityType: taken.activityType,
    start: { ...start.parts, name: start.parts.name ?? '', summary: start.parts.summary ?? '' },
    startCut: start.cut,
    end: end.parts,
    endCut: end.cut,
    exitCode: taken.exitCode ?? null,
    outcome: taken.outcome,
    durationMs: taken.durationMs ?? null,
  };
}

/** An item of a history read as an activity (C19), or null for a type history is not read for. */
export function takeHistoryActivity(type: string, itemId: string, raw: unknown): TakenActivity | null {
  return HISTORY_TYPES.has(type) ? takeActivity(type, itemId, raw) : null;
}

const STEP_STATES: Readonly<Record<string, StepState>> = { pending: 'pending', inProgress: 'in-progress', completed: 'completed' };

/**
 * The steps of a `turn/plan/updated` notification (C24): the whole list each time, each step's text
 * and its state. A state the adapter does not know reads pending. `explanation` is not read.
 */
export function takePlanSteps(params: unknown): { readonly steps: readonly ChecklistStep[]; readonly cut: ActivityCut | null } | null {
  const frame = PlanFrame.safeParse(params);
  if (!frame.success) return null;
  const taken = cutParts({ steps: frame.data.plan.map((step) => ({ text: step.step, state: STEP_STATES[step.status ?? ''] ?? 'pending' })) });
  return { steps: taken.parts.steps ?? [], cut: taken.cut };
}
