// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What a tool's use and its result are, as an activity (docs/planning/_archive/M20a.md, Design 4; C7–C12,
// C17, C18, C23, C25): a `tool_use` block's id, name and input, mapped by the tool's name onto
// fat-g's closed types, and a `tool_result` block's content and error flag. Each field is taken by
// its name and bounded as it is taken; nothing else of a frame leaves this file.
//
//   Read                                      read
//   Glob, Grep                                search
//   Bash                                      command
//   Write, Edit, MultiEdit, NotebookEdit      edit, with its changes from its input
//   WebSearch, WebFetch                       web-search
//   TodoWrite                                 checklist
//   Agent, Task                               worker (C23)
//   a tool of the user's own configuration    mcp: its server and its tool, split from its name
//   AskUserQuestion                           no activity (M21, C19): a question's card stands for it
//   the plan's tool                           no activity (M22b, C23): the plan's line stands for it
//   any other                                 other
//
// Under the launch only Read, Glob, Grep, Agent, AskUserQuestion, the configuration's MCP tools and,
// under a mode that acts, Bash, Write, Edit, WebFetch, WebSearch and the plan's tool are offered
// (decision 0020, item 5), and nothing here changes what is: the other names are mapped
// for a launch that offers them, and for a worker of an agent the user defined. Their inputs' shapes
// are the SDK's types, read and not observed (C10, C12).
//
// A tool's input is kept as JSON text (C17). An edit's change is what the tool was handed — a
// file's content, or the text an edit puts in — as reported then: fat-g computes no diff (C10).
//
// A request to act (docs/planning/_archive/M22.md, Design 4, 6; C8, C9, C48, C56, C68; decision 0027) is read
// the same way, from the request's own `input`: the view its card shows, whole and within every
// bound, or nothing — a request that cannot be shown whole is refused, never shown cut. The view is
// never made from the activity's copy, which is cut to an activity's bounds. A fetch's card is headed
// by the address it names and a search's by its query; one that names neither is refused.
import { type ActivityCut, type ActivityParts, type ActivityType, type ChecklistStep, cutParts, type EditChange, fileName, type FileReference, jsonText, MAX_REFERENCE_LINE, placeholderLine, type StepState } from '@shared/contracts/activity';
import { cutLine, cutTo, MAX_AGENT_ID } from '@shared/contracts/agent-events';
import { catalogId } from '@shared/contracts/catalog';
import { type ApprovalAuthority, type ApprovalChange, type ApprovalChoice, type ApprovalDetail, type ApprovalKind, type ApprovalOverBound, approvalOverBound, type ApprovalRequest, MAX_APPROVAL_AUTHORITY, MAX_APPROVAL_REASON, MAX_APPROVAL_SUMMARY, MAX_APPROVAL_TOOL, MAX_GRANT_COVERS } from '@shared/contracts/interaction';
import type { ActionRequest } from './chat-frames';
import { modeIdOfWord, PLAN_TOOL } from './chat-modes';
import type { Offer, SessionGrant } from './chat-wire';

/** The launch's `Agent` tool, as either name reports it (C67): its use starts a worker. */
const WORKER_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task']);
const SEARCH_TOOLS: ReadonlySet<string> = new Set(['Glob', 'Grep']);
const EDIT_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const WEB_TOOLS: ReadonlySet<string> = new Set(['WebSearch', 'WebFetch']);
/** The tool that asks the user (M21, C19): its use is a question's, and opens no activity. */
const QUESTION_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion']);

type Record_ = Record<string, unknown>;
const isRecord = (value: unknown): value is Record_ => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
/** An id of the CLI's: over its length, empty, or with a control character, it is no id (agent-events.ts). */
const takeId = (value: unknown): string | null => (typeof value === 'string' && value.length >= 1 && value.length <= MAX_AGENT_ID && !/\p{Cc}/u.test(value) ? value : null);

/** `configured`: how the CLI names a tool the user's own configuration brings, which the file of names holds (chat-frames.ts). */
export function toolType(name: string, configured: string): ActivityType {
  if (name === 'Read') return 'read';
  if (SEARCH_TOOLS.has(name)) return 'search';
  if (name === 'Bash') return 'command';
  if (EDIT_TOOLS.has(name)) return 'edit';
  if (WEB_TOOLS.has(name)) return 'web-search';
  if (name === 'TodoWrite') return 'checklist';
  if (WORKER_TOOLS.has(name)) return 'worker';
  return name.startsWith(configured) ? 'mcp' : 'other';
}

/** A configured tool's server and tool, split from its name (C12): the prefix, the server, two underscores and the tool, which keeps whatever follows. */
function serverAndTool(name: string, configured: string): string {
  const rest = name.slice(configured.length);
  const split = rest.indexOf('__');
  return split === -1 ? rest : `${rest.slice(0, split)}: ${rest.slice(split + 2)}`;
}

/** A line a reference names: a whole number from one up, or none. */
const lineOf = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_REFERENCE_LINE ? value : null);

/** An edit tool's changes, from its input (C10). */
function changesOf(name: string, input: Record_): EditChange[] {
  const path = text(name === 'NotebookEdit' ? input['notebook_path'] : input['file_path']);
  if (path === null) return [];
  if (name === 'Write') return [{ path, kind: 'write', text: text(input['content']) }];
  if (name === 'Edit') return [{ path, kind: 'update', text: text(input['new_string']) }];
  if (name === 'MultiEdit') {
    const edits = Array.isArray(input['edits']) ? input['edits'].filter(isRecord) : [];
    return edits.length === 0 ? [{ path, kind: 'update', text: null }] : edits.map((edit) => ({ path, kind: 'update', text: text(edit['new_string']) }));
  }
  const mode = input['edit_mode'];
  return [{ path, kind: mode === 'insert' ? 'add' : mode === 'delete' ? 'delete' : 'update', text: text(input['new_source']) }];
}

const TODO_STATES: Readonly<Record<string, StepState>> = { pending: 'pending', in_progress: 'in-progress', completed: 'completed' };

function stepsOf(input: Record_): ChecklistStep[] {
  const todos = Array.isArray(input['todos']) ? input['todos'].filter(isRecord) : [];
  return todos.flatMap((todo): ChecklistStep[] => (typeof todo['content'] === 'string' ? [{ text: todo['content'], state: TODO_STATES[typeof todo['status'] === 'string' ? todo['status'] : ''] ?? 'pending' }] : []));
}

/** What a tool's use says of itself, by its type: its line, the files it names, an edit's changes, a checklist's steps. */
function partsOf(type: ActivityType, name: string, input: Record_, configured: string): ActivityParts & { readonly name: string; readonly summary: string } {
  const base = { name, input: jsonText(input) };
  switch (type) {
    case 'read': {
      const path = text(input['file_path']);
      return { ...base, summary: path === null ? '' : fileName(path), files: path === null ? [] : [{ path, line: lineOf(input['offset']) }] };
    }
    case 'search': {
      const path = text(input['path']);
      const files: FileReference[] = path === null ? [] : [{ path, line: null }];
      return { ...base, summary: text(input['pattern']) ?? path ?? '', files };
    }
    case 'command':
      return { ...base, summary: text(input['command']) ?? '' };
    case 'edit': {
      const changes = changesOf(name, input);
      const [first] = changes;
      return { ...base, summary: first === undefined ? '' : fileName(first.path), changes, files: first === undefined ? [] : [{ path: first.path, line: null }] };
    }
    case 'web-search':
      return { ...base, summary: text(input['query']) ?? text(input['url']) ?? '' };
    case 'checklist':
      return { ...base, summary: '', steps: stepsOf(input) };
    case 'worker':
      // Its own words for what it hands over; the agent list's label replaces them once a worker is paired (C23).
      return { ...base, summary: text(input['description']) ?? '' };
    case 'mcp': {
      const named = serverAndTool(name, configured);
      return { ...base, name: named, summary: named };
    }
    // No tool's name maps to a wait or a thinking; a tool it does not know keeps its input, and says no more.
    case 'wait':
    case 'thinking':
    case 'other':
      return { ...base, summary: '' };
  }
}

export interface TakenTool {
  /** The tool use's own id: what its result names it by. */
  readonly itemId: string;
  readonly activityType: ActivityType;
  /** What its start says, within its bounds. */
  readonly start: ActivityParts & { readonly name: string; readonly summary: string };
  readonly cut: ActivityCut | null;
  /**
   * The use is a question to the user (M21, C19): it is no activity, and nothing of its start is
   * told — the request that follows it carries the same questions, and the card stands for both.
   */
  readonly question: boolean;
  /**
   * The use hands a plan over for the user's decision (M22b, C8, C23): it is no activity either, and
   * nothing of its input is told — the request that follows it carries the plan, and its line stands for it.
   */
  readonly plan: boolean;
  /**
   * A worker's use: the model its input asks for (M106, C14), an alias — `haiku`, `opus`, `sonnet` —
   * or a key, where it is one a catalog id can be; null otherwise, and for every other tool.
   */
  readonly model: string | null;
  /** A worker's use: the agent definition its input names (M106, C20), one line; null otherwise. */
  readonly agentType: string | null;
}

/** A model a frame names, where it is a catalog id (M106, C14): a key or an alias, never a word with a space in it. */
export const modelKey = (value: unknown): string | null => (typeof value === 'string' ? catalogId(value) : null);

/** A `tool_use` block as an activity's start (C17), or null for one with no id or no name that could be one. */
export function takeTool(block: Record_, configured: string): TakenTool | null {
  const itemId = takeId(block['id']);
  const name = text(block['name']);
  if (itemId === null || name === null || name === '') return null;
  const activityType = toolType(name, configured);
  // A question's input is its questions: none of it is taken here, where an activity's start would hold it.
  if (QUESTION_TOOLS.has(name)) return { itemId, activityType, start: { name, summary: '' }, cut: null, question: true, plan: false, model: null, agentType: null };
  // A plan's input is the plan (M22b, C9): none of it is taken here either.
  if (name === PLAN_TOOL) return { itemId, activityType, start: { name, summary: '' }, cut: null, question: false, plan: true, model: null, agentType: null };
  const input = isRecord(block['input']) ? block['input'] : {};
  const taken = cutParts(partsOf(activityType, name, input, configured));
  // A worker's model and agent definition are fields of their own: the parts keep the known fields alone.
  const worker = activityType === 'worker';
  const agentType = worker && typeof input['subagent_type'] === 'string' ? cutLine(input['subagent_type']) || null : null;
  return { itemId, activityType, start: { ...taken.parts, name: taken.parts.name ?? '', summary: taken.parts.summary ?? '' }, cut: taken.cut, question: false, plan: false, model: worker ? modelKey(input['model']) : null, agentType };
}

export interface TakenToolResult {
  /** The tool use it answers. */
  readonly toolUseId: string;
  /** Its error flag: the tool failed, or was not found, or was refused. */
  readonly failed: boolean;
  /** Its content as text, within its bound; null where it has none. */
  readonly output: string | null;
  readonly cut: ActivityCut | null;
}

/**
 * A result's content as text (C18): a string as it is; an array's text blocks joined by a blank
 * line, an image or any other block a placeholder line.
 */
function resultText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  return content.map((block: unknown): string => {
    if (!isRecord(block)) return placeholderLine('other');
    if (block['type'] === 'text' && typeof block['text'] === 'string') return block['text'];
    return placeholderLine(block['type'] === 'image' ? 'image' : block['type'] === 'resource' || block['type'] === 'resource_link' ? 'resource' : 'other');
  }).join('\n\n');
}

/**
 * The `tool_result` blocks of a `user` frame's content, and nothing else of it (C18): a text block
 * in one — a prompt's echo, an interrupt's mark, a worker's instruction — is no message and is not
 * read, and neither are `tool_use_result` and `tool_result_meta`.
 */
export function takeToolResults(content: unknown): TakenToolResult[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: unknown): TakenToolResult[] => {
    if (!isRecord(block) || block['type'] !== 'tool_result') return [];
    const toolUseId = takeId(block['tool_use_id']);
    if (toolUseId === null) return [];
    const taken = cutParts({ output: resultText(block['content']) });
    return [{ toolUseId, failed: block['is_error'] === true, output: taken.parts.output ?? null, cut: taken.cut }];
  });
}

// ── A request to act, as its card's view (M22, C8, C9, C48, C56, C68) ─────────────────────────

/** What a request to act is, by its tool's name: a command, a file's change, or any other tool's use. */
function approvalKind(name: string): ApprovalKind {
  if (name === 'Bash') return 'command';
  return EDIT_TOOLS.has(name) ? 'file-change' : 'tool';
}

/** One edit by match (C9): the text it puts in, the text it replaces, and whether every matching passage or the first. Null where any of the three is not what it must be. */
function matchEdit(path: string, edit: Record_): ApprovalChange | null {
  const replace = text(edit['old_string']);
  const put = text(edit['new_string']);
  const all = edit['replace_all'] ?? false;
  return replace === null || put === null || typeof all !== 'boolean' ? null : { path, kind: 'update', text: put, replace, all };
}

/**
 * A file change's detail, from its input as it came (C9, C48): a whole file's content, or each edit
 * by match with its scope. Null for an input that does not hold what its tool must — no path, no
 * content, an edit with no text to find: the action cannot be shown whole. A notebook's edit names
 * a cell beside its text, so its detail is its input, whole.
 */
function changeDetail(name: string, input: Record_): ApprovalDetail | null {
  if (name === 'NotebookEdit') return inputDetail(input);
  const path = text(input['file_path']);
  if (path === null || path === '') return null;
  if (name === 'Write') {
    const content = text(input['content']);
    return content === null ? null : { kind: 'changes', changes: [{ path, kind: 'write', text: content, replace: null, all: null }] };
  }
  const edits = name === 'MultiEdit' ? (Array.isArray(input['edits']) ? input['edits'] : []) : [input];
  const changes: ApprovalChange[] = [];
  for (const edit of edits as unknown[]) {
    const change = isRecord(edit) ? matchEdit(path, edit) : null;
    if (change === null) return null;
    changes.push(change);
  }
  return changes.length === 0 ? null : { kind: 'changes', changes };
}

/** A tool's input as JSON text, whole. Null where it cannot be written out. */
function inputDetail(input: Record_): ApprovalDetail | null {
  try { return { kind: 'input', text: JSON.stringify(input, null, 2) }; } catch { return null; }
}

/** The field a web tool's card is headed by: a fetch's address, a search's query. */
const WEB_HEADING: ReadonlyMap<string, string> = new Map([['WebFetch', 'url'], ['WebSearch', 'query']]);

function detailOf(kind: ApprovalKind, name: string, input: Record_): ApprovalDetail | null {
  if (kind === 'file-change') return changeDetail(name, input);
  const heading = WEB_HEADING.get(name);
  if (heading !== undefined && (text(input[heading]) ?? '').trim() === '') return null;
  if (kind === 'tool') return inputDetail(input);
  const command = text(input['command']);
  return command === null || command === '' ? null : { kind: 'command', command };
}

/** The one line a card is headed by: a command's first line, a file's name, a fetch's address, a search's query, the tool's name. */
function summaryOf(kind: ApprovalKind, name: string, input: Record_, configured: string): string {
  if (kind === 'command') return cutLine(text(input['command']) ?? '');
  const heading = WEB_HEADING.get(name);
  if (heading !== undefined) return cutLine(text(input[heading]) ?? '');
  const path = text(name === 'NotebookEdit' ? input['notebook_path'] : input['file_path']);
  if (kind === 'file-change' && path !== null) return cutTo(fileName(path), MAX_APPROVAL_SUMMARY).text;
  return cutTo(name.startsWith(configured) ? serverAndTool(name, configured) : name, MAX_APPROVAL_SUMMARY).text;
}

/**
 * What the CLI's offers would grant beyond this action (C8, C56), each kind said once: a change of
 * mode by fat-g's own id for it, a folder, a rule the CLI would keep beyond the session, anything
 * else. The rule a session grant is made of is its choice on the card, and is said here only where
 * the CLI offered it at a scope that keeps it.
 */
function authorityOf(offers: readonly Offer[]): ApprovalAuthority[] {
  const said = new Map<string, ApprovalAuthority>();
  const say = (authority: ApprovalAuthority): void => { said.set(`${authority.kind}/${authority.mode ?? ''}`, authority); };
  for (const offer of offers) {
    if (offer.kind === 'mode') say({ kind: 'mode', mode: modeIdOfWord(offer.word) });
    else if (offer.kind === 'folder') say({ kind: 'folder', mode: null });
    else if (offer.kind === 'other') say({ kind: 'other', mode: null });
    else if (offer.saved) say({ kind: 'saved-rule', mode: null });
    else if (offer.kind === 'rule') say({ kind: 'other', mode: null });
  }
  return [...said.values()].slice(0, MAX_APPROVAL_AUTHORITY);
}

/**
 * A request to act as its card shows it, or why it is refused (C9, C48): `over` names the bound it
 * is past, and is null for a request that names no tool, holds no input, or lacks a field its
 * action stands on. `grant` is the CLI's own rule the session grant would send (C68, C69), kept
 * beside the view and never in it.
 */
export type ApprovalView =
  | { readonly kind: 'view'; readonly request: ApprovalRequest; readonly grant: SessionGrant | null }
  | { readonly kind: 'refused'; readonly over: ApprovalOverBound | null };

/**
 * The view of a request to act (C8), from the request as it came and its offers as the wire read
 * them. `configured`: how the CLI names a tool the user's own configuration brings.
 *
 * Its labels — the tool's name, the one line, the reason — are cut to their bounds; nothing else
 * is. The reason is the request's own line only where it is the model's, which is where the tool's
 * input holds the same words (K2): for a file's change that line is the path, and is no reason.
 * The grant is offered where the CLI offered a rule that allows and did not mark the request as one
 * to keep no rule for (C68); and where its only offer is one change of mode, the view names that
 * mode, by fat-g's id, as the one that would stop the question (C56).
 */
export function approvalView(asked: ActionRequest, offers: readonly Offer[], configured: string): ApprovalView {
  const { tool: name, input } = asked;
  if (name === null || input === null) return { kind: 'refused', over: null };
  const kind = approvalKind(name);
  const detail = detailOf(kind, name, input);
  if (detail === null) return { kind: 'refused', over: null };
  const targets = [...new Set([text(input['file_path']), text(input['notebook_path']), asked.blockedPath].filter((path): path is string => path !== null && path !== ''))];
  const offered = asked.noGrant ? undefined : offers.find((offer): offer is Extract<Offer, { kind: 'grant' }> => offer.kind === 'grant' && offer.covers.length <= MAX_GRANT_COVERS);
  const choices: ApprovalChoice[] = offered === undefined ? ['approve', 'deny'] : ['approve', 'approve-session', 'deny'];
  const over = approvalOverBound({ targets, choices, detail, folder: null });
  if (over !== null) return { kind: 'refused', over };
  const modes = offers.map((offer) => (offer.kind === 'mode' ? modeIdOfWord(offer.word) : null));
  const [only] = modes;
  const said = text(input['description']);
  return {
    kind: 'view',
    grant: offered?.grant ?? null,
    request: {
      kind, tool: cutTo(name, MAX_APPROVAL_TOOL).text, summary: summaryOf(kind, name, input, configured),
      // Claude's request names no working folder (K2).
      folder: null, targets, outside: asked.outside,
      reason: asked.description !== null && asked.description === said ? cutTo(asked.description, MAX_APPROVAL_REASON).text : null,
      authority: authorityOf(offers), detail, choices,
      grant: offered === undefined ? null : { covers: offered.covers },
      modeThatWouldStop: offered === undefined && only !== undefined && only !== null && modes.every((mode) => mode === only) ? only : null,
      cut: false,
    },
  };
}
