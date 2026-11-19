// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The frames a chat session reads, and the names it reads them by (decisions 0020, 0027;
// docs/planning/_archive/M16.md, Design 4, 5; C22, C32, C67; M19.md, Design 3; C10; M20a.md, Design 4; C17,
// C18, C22; M21.md, Design 3; C19, C20; M22.md, Design 6; C5, C7, C8, C76, C91; docs/planning/_archive/M106.md,
// Design 2; C14, C20): loose shapes — unknown
// keys are tolerated, never forwarded — each taken down to the few fields the mapping needs, as the
// CLI names them in K1's, K14's and K20's traces, in M19's K2 for a reply as it is written, in
// M21's K1 for a question's request and its withdrawal, and in M22's K2 for a request to act, a
// change of mode's reply and status frame, and a denial by a rule.
// Nothing else of a frame leaves this file, and no frame is logged.
//
// What a report says of the permission mode and the tools is given as it came, a word and a list of
// names: which words and names a session's mode is reported by is the mode table's to say
// (chat-modes.ts), and the session compares (M22, C5, C7). The names are the CLI's reported ones,
// never the launch's own spelling (C67): a launch that asks for the `Agent` tool is told of a
// `Task` tool.
import { z } from 'zod';
import { MAX_ACTIVITY_THINKING } from '@shared/contracts/activity';
import { cutLine, cutTo, MAX_AGENT_ID, MAX_MESSAGE_TEXT, MAX_NOTICE_DETAIL } from '@shared/contracts/agent-events';
import type { InteractionOption, RawQuestion } from '@shared/contracts/interaction';
import { MAX_PLAN_TEXT } from '@shared/contracts/plans';
import { type ActionKind, MAX_REFERENCE } from '@shared/contracts/sessions';
import { CommandNameSchema, MAX_COMMAND_TEXT } from '@shared/contracts/composer';
import type { ProviderCommand } from '@shared/provider-kit/sessions';
import { PLAN_TOOL } from './chat-modes';
import { modelKey, type TakenTool, type TakenToolResult, takeTool, takeToolResults } from './chat-tools';

// ── Names (C21, C67) ──────────────────────────────────────────────────────────────────────────

/** The tool that asks the user a question, as the launch, `init` and its request all name it (M21, C16, C19). */
export const QUESTION_TOOL = 'AskUserQuestion';
/** How `init` names a tool the user's own configuration brings (K14): those are the user's (C17), and are not compared. A tool's use names it the same way (M20a, C17). */
export const MCP_TOOL_PREFIX = 'mcp__';

// ── Requests from the CLI (C22) ───────────────────────────────────────────────────────────────

/**
 * The request by which the CLI asks to use a tool. The question tool's is answered from its card
 * (M21, C17); any other tool's is answered from its own card under a mode that acts, and denied
 * under the reading mode (M22, C6, C8). Every other request gets the error reply.
 */
export const TOOL_REQUEST = 'can_use_tool';
/** What a refused request is counted under: one of these, the SDK types' list, or `other`. Never a string the CLI chose. */
export const REQUEST_SUBTYPES = ['can_use_tool', 'hook_callback', 'mcp_message', 'elicitation', 'request_user_dialog'] as const;

export function refusedSubtype(subtype: unknown): string {
  return typeof subtype === 'string' && (REQUEST_SUBTYPES as readonly string[]).includes(subtype) ? subtype : 'other';
}

// ── Shapes ────────────────────────────────────────────────────────────────────────────────────

const noControl = (value: string): boolean => !/\p{Cc}/u.test(value);
/** An id of the CLI's: over its length, or with a control character, it is no id (agent-events.ts). */
const id = z.string().min(1).max(MAX_AGENT_ID).refine(noControl);
const reference = z.string().min(1).max(MAX_REFERENCE).refine(noControl);

const LifecycleSchema = z.looseObject({ command_uuid: id, state: z.string().max(64) });
const InitSchema = z.looseObject({ session_id: z.unknown().optional(), model: z.unknown().optional(), tools: z.unknown().optional(), permissionMode: z.unknown().optional(), capabilities: z.unknown().optional(), slash_commands: z.unknown().optional(), skills: z.unknown().optional(), terminal_slash_commands: z.unknown().optional() });
/** How many blocks a reply may hold, and so the highest index a block of one may have. */
const MAX_BLOCKS = 64;
const AssistantSchema = z.looseObject({
  uuid: z.unknown().optional(),
  parent_tool_use_id: z.unknown().optional(),
  error: z.unknown().optional(),
  message: z.looseObject({ id: z.unknown().optional(), model: z.unknown().optional(), content: z.array(z.unknown()).max(MAX_BLOCKS) }),
});
/** A reply as it is written (M19, C10): the event's type, and the few fields of it each type is read for. */
const StreamSchema = z.looseObject({
  parent_tool_use_id: z.unknown().optional(),
  event: z.looseObject({ type: z.string().max(64), index: z.unknown().optional(), message: z.unknown().optional(), content_block: z.unknown().optional(), delta: z.unknown().optional() }),
});
const TaskSchema = z.looseObject({ task_id: id });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A frame's kind, read off its `type` and, for a `system` frame, its `subtype`: all the mapping needs to decide whether to read it at all. */
export function frameKind(frame: unknown): 'lifecycle' | 'init' | 'assistant' | 'stream' | 'tool-results' | 'result' | 'task-started' | 'task-progress' | 'task-updated' | 'task-notification' | 'request' | 'cancel' | 'request-progress' | 'status' | 'permission-denied' | 'commands' | 'unread' {
  if (!isRecord(frame)) return 'unread';
  switch (frame['type']) {
    case 'command_lifecycle': return 'lifecycle';
    case 'assistant': return 'assistant';
    case 'stream_event': return 'stream';
    // Read for its `tool_result` blocks, and for nothing else of it (M20a, C18).
    case 'user': return 'tool-results';
    case 'result': return 'result';
    case 'control_request': return 'request';
    // The CLI takes a request of its own back (M21, C20): read for the request it names, a question's.
    case 'control_cancel_request': return 'cancel';
    case 'system':
      switch (frame['subtype']) {
        case 'init': return 'init';
        case 'task_started': return 'task-started';
        case 'task_progress': return 'task-progress';
        case 'task_updated': return 'task-updated';
        case 'task_notification': return 'task-notification';
        // How a request of fat-g's is getting on (M20b, C14): read for a side question's, and for nothing else.
        case 'control_request_progress': return 'request-progress';
        // What the process is doing, and — after a change of mode — the mode it now runs under (M22, C7): read for that word alone.
        case 'status': return 'status';
        // A rule of the user's own configuration refused a tool's use, with no request made (M22, C76).
        case 'permission_denied': return 'permission-denied';
        // The CLI's command list, whole, replacing the one it gave before (M23, C60): read for its rows alone.
        case 'commands_changed': return 'commands';
        default: return 'unread';
      }
    // `rate_limit_event`, a hook's frames, a reply to nothing: never parsed (C32).
    default: return 'unread';
  }
}

// ── A side question (M20b, C13, C14) ──────────────────────────────────────────────────────────

const ProgressSchema = z.looseObject({ request_id: id, status: z.string().max(64) });

/**
 * Of a `control_request_progress` frame (M20b, C14): the request it names, and whether it says the
 * request started or is being tried again. Nothing else of it is read, and it carries no text.
 */
export function takeProgress(frame: unknown): { readonly requestId: string; readonly status: 'started' | 'retry' | null } | null {
  const parsed = ProgressSchema.safeParse(frame);
  if (!parsed.success) return null;
  const { status } = parsed.data;
  return { requestId: parsed.data.request_id, status: status === 'started' ? 'started' : status === 'api_retry' ? 'retry' : null };
}

export interface SideReply {
  /** The answer, whole, cut to a message's bound; null where the reply holds none, or holds a placeholder no model wrote. */
  readonly text: string | null;
  readonly cut: boolean;
  /** The model that answered in place of the session's, where the reply names one that could be a catalog key. */
  readonly model: string | null;
}

/**
 * Of a side question's reply (M20b, C13): `response`, the answer or null; `synthetic`, which marks
 * a placeholder that is no answer; and the model `refusal_fallback` names as the one that answered.
 * Nothing else of it is read. A value that is no object reads as no answer.
 */
export function takeSideReply(value: unknown): SideReply {
  if (!isRecord(value)) return { text: null, cut: false, model: null };
  const response = value['response'];
  if (typeof response !== 'string' || response === '' || value['synthetic'] === true) return { text: null, cut: false, model: null };
  const fallback = value['refusal_fallback'];
  const named = isRecord(fallback) ? fallback['fallback_model'] : undefined;
  const cut = cutTo(response, MAX_MESSAGE_TEXT);
  return { text: cut.text, cut: cut.cut, model: typeof named === 'string' && named.length >= 1 && named.length <= 128 && noControl(named) ? named : null };
}

/** A permission mode as a report names it: a short word. Null for anything else, which no mode is reported by. */
const modeWord = (value: unknown): string | null => (typeof value === 'string' && value.length >= 1 && value.length <= 64 && noControl(value) ? value : null);

/** Of the `initialize` reply, one thing: the permission mode it reports (C21; M22, C5). It names no tools (K14). */
export function takeReply(reply: unknown): { readonly mode: string | null } {
  return { mode: modeWord(isRecord(reply) ? reply['current_permission_mode'] : undefined) };
}

/** Of the reply to a change of mode, one thing: the mode it says the process now runs under (M22, C5). */
export function takeModeReply(reply: unknown): { readonly mode: string | null } {
  return { mode: modeWord(isRecord(reply) ? reply['mode'] : undefined) };
}

/**
 * Of a `status` frame, one thing (M22, C7): the permission mode it names, where it names one — as
 * the frame that follows a change of mode does. Most name none: they say what the process is doing,
 * which is not read. `named`: the frame carries the field at all, whatever it holds.
 */
export function takeStatus(frame: unknown): { readonly named: boolean; readonly mode: string | null } {
  const value = isRecord(frame) ? frame['permissionMode'] : undefined;
  return { named: value !== undefined && value !== null, mode: modeWord(value) };
}

/**
 * Of a `permission_denied` frame, two things (M22, C76): the tool use it refused, and whether its
 * reason is a rule of the user's configuration. Its message is not read.
 */
export function takeDenied(frame: unknown): { readonly toolUseId: string | null; readonly rule: boolean } {
  const record = isRecord(frame) ? frame : {};
  const toolUse = id.safeParse(record['tool_use_id']);
  return { toolUseId: toolUse.success ? toolUse.data : null, rule: record['decision_reason_type'] === 'rule' };
}

/** The states of a prompt's `command_lifecycle` frames (C31): the two that open its turn, and the two that close it. */
export type LifecycleState = 'queued' | 'started' | 'completed' | 'cancelled';
const LIFECYCLE_STATES: readonly string[] = ['queued', 'started', 'completed', 'cancelled'];

/** An interrupt's reply (M23, C43; K2): the ids it dropped, and those the CLI still holds. Empty lists for a reply that names none. */
export function takeInterruptReply(reply: unknown): { readonly cancelled: readonly string[]; readonly stillQueued: readonly string[] } {
  const record = isRecord(reply) ? reply : {};
  const ids = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && id.safeParse(entry).success) : []);
  return { cancelled: ids(record['cancelled']), stillQueued: ids(record['still_queued']) };
}

export function takeLifecycle(frame: unknown): { readonly promptId: string; readonly state: LifecycleState | null } | null {
  const parsed = LifecycleSchema.safeParse(frame);
  if (!parsed.success) return null;
  const { state } = parsed.data;
  return { promptId: parsed.data.command_uuid, state: LIFECYCLE_STATES.includes(state) ? (state as LifecycleState) : null };
}

export interface InitFrame {
  /** Null when the frame names none that could be a reference. */
  readonly sessionId: string | null;
  /** The resolved model id it names, when it is one a catalog key can be. */
  readonly model: string | null;
  /** The permission mode it names (M22, C5), or null for none that could be one: the session's mode is compared with it. */
  readonly mode: string | null;
  /**
   * The built-in tools it lists, by name (C21, C67): a tool of the user's own configuration is left
   * out, being the user's. Null for a list that is no list of names, which cannot be compared.
   */
  readonly tools: readonly string[] | null;
  /** Its `capabilities` name `interrupt_cancel_queued_v1` (M23, C43): a Stop can drop the messages the CLI holds. */
  readonly cancelsQueued: boolean;
  /** Its three lists of command names (M23, C60): every command, the skills among them, and those bound to a terminal. Null for a list it did not give. */
  readonly commandNames: readonly string[] | null;
  readonly skillNames: readonly string[] | null;
  readonly terminalNames: readonly string[] | null;
}

// ── The CLI's commands (M23, C58–C62, C65; K2) ─────────────────────────────────────────────────

/** The most rows a command list keeps, and names an `init` list keeps (C65): what is past them is left out. */
export const MAX_COMMANDS = 256;

const commandName = (value: unknown): string | null => (typeof value === 'string' && CommandNameSchema.safeParse(value).success ? value : null);
/** A description or a hint, as plain text cut to the menu's bound (C65): its control characters made spaces. */
const commandText = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? cutTo(value.replace(/\p{Cc}/gu, ' ').trim(), MAX_COMMAND_TEXT).text : null);

/**
 * The `initialize` reply's `commands`, or a list push's (C60; K2): each its name, description and
 * argument hint, bounded; a row whose name is no single token is left out. Null where there is no list.
 */
export function takeCommands(value: unknown): ProviderCommand[] | null {
  const list = isRecord(value) ? value['commands'] : undefined;
  if (!Array.isArray(list)) return null;
  const rows: ProviderCommand[] = [];
  for (const entry of list.slice(0, MAX_COMMANDS)) {
    if (!isRecord(entry)) continue;
    const name = commandName(entry['name']);
    if (name === null || rows.some((row) => row.name === name)) continue;
    rows.push({ name, description: commandText(entry['description']), hint: commandText(entry['argumentHint']), group: 'commands', selector: null });
  }
  return rows;
}

/** One of `init`'s lists of names (C60): its names that are single tokens, bounded; null for one that is no list. */
function names(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  return value.slice(0, MAX_COMMANDS).flatMap((entry) => {
    const name = commandName(entry);
    return name === null ? [] : [name];
  });
}

/** The capability a Stop needs to take back a message the CLI holds (M23, C43; K2). */
export const CANCEL_QUEUED_CAPABILITY = 'interrupt_cancel_queued_v1';

/** Of `init`: the session id, the model, the tools and the permission mode, by name (C32). */
export function takeInit(frame: unknown): InitFrame | null {
  const parsed = InitSchema.safeParse(frame);
  if (!parsed.success) return null;
  const { session_id: sessionId, model, tools, permissionMode, capabilities, slash_commands: slashCommands, skills, terminal_slash_commands: terminal } = parsed.data;
  const named = reference.safeParse(sessionId);
  const listed = Array.isArray(tools) && tools.every((tool): tool is string => typeof tool === 'string') ? tools : null;
  return {
    sessionId: named.success ? named.data : null,
    model: typeof model === 'string' && model.length >= 1 && model.length <= 128 && noControl(model) ? model : null,
    mode: modeWord(permissionMode),
    tools: listed === null ? null : listed.filter((tool) => !tool.startsWith(MCP_TOOL_PREFIX)),
    cancelsQueued: Array.isArray(capabilities) && capabilities.includes(CANCEL_QUEUED_CAPABILITY),
    commandNames: names(slashCommands),
    skillNames: names(skills),
    terminalNames: names(terminal),
  };
}

/** The model name the CLI's own answers carry (K19, K20): a failure's text, a refused command's. No model said them. */
const SYNTHETIC_MODEL = '<synthetic>';

export type AssistantBlock =
  | { readonly type: 'text'; readonly text: string; readonly cut: boolean }
  /** `text`: the block's own, where the CLI sends one (M20a, C9): the installed CLI sends it empty, with a signature. */
  | { readonly type: 'thinking'; readonly text: string | null }
  /**
   * `file`: for a read, the last segment of its path, and nothing else of a tool's input, for the
   * action's label (C38). `tool`: the use as an activity's start (M20a, C17), for the chat alone;
   * null for a block with no id or name that could be one.
   */
  | { readonly type: 'tool'; readonly kind: ActionKind; readonly file: string | null; readonly tool: TakenTool | null };

/** Whose frame it is (C34; M20a, C22): the tool use that started the worker it belongs to, or null for the session's own. An id that could be none reads as a worker's that no worker claims. */
function parentOf(parent: unknown): string | null {
  if (parent === null || parent === undefined) return null;
  const named = id.safeParse(parent);
  return named.success ? named.data : '';
}

export interface AssistantFrame {
  /** The session's own: no worker's (C34). */
  readonly own: boolean;
  /** For a worker's, the `Agent` tool use it names (M20a, C22). */
  readonly parent: string | null;
  /** The frame's own id, which is its message's item id (C77). Null when it has none that could be one. */
  readonly uuid: string | null;
  /** The id of the reply it is one block of, which its `stream_event` frames named at their start (M19, C11). Null when it has none. */
  readonly replyId: string | null;
  /** A model said it: the frame's model is not the CLI's own marker (C87). */
  readonly fromModel: boolean;
  /** The model it names, where a model said it and the name is a catalog id: a worker's resolves its alias (M106, C14). */
  readonly model: string | null;
  /** Marked `error`: no message, and its text the failed turn's detail (C37). */
  readonly error: boolean;
  readonly blocks: readonly AssistantBlock[];
}

/** The action a tool's name gives (C38). The launch's `Agent` is reported as either name (C67). */
export function toolAction(name: unknown): ActionKind {
  if (name === 'Read') return 'reading';
  if (name === 'Bash') return 'running';
  if (name === 'Write' || name === 'Edit') return 'writing';
  if (name === 'Agent' || name === 'Task') return 'waiting';
  return 'tool';
}

function lastSegment(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  const segment = path.split(/[\\/]/).filter((part) => part !== '').at(-1);
  return segment === undefined ? null : cutLine(segment) || null;
}

export function takeAssistant(frame: unknown): AssistantFrame | null {
  const parsed = AssistantSchema.safeParse(frame);
  if (!parsed.success) return null;
  const { uuid, parent_tool_use_id: parent, error, message } = parsed.data;
  const named = id.safeParse(uuid);
  const reply = id.safeParse(message.id);
  const blocks: AssistantBlock[] = [];
  for (const block of message.content) {
    if (!isRecord(block)) continue;
    if (block['type'] === 'text' && typeof block['text'] === 'string') {
      const text = cutTo(block['text'], MAX_MESSAGE_TEXT);
      blocks.push({ type: 'text', text: text.text, cut: text.cut });
    } else if (block['type'] === 'thinking') {
      const thought = typeof block['thinking'] === 'string' && block['thinking'] !== '' ? cutTo(block['thinking'], MAX_ACTIVITY_THINKING).text : null;
      blocks.push({ type: 'thinking', text: thought });
    } else if (block['type'] === 'tool_use') {
      const named = toolAction(block['name']);
      const kind = named === 'waiting' && isRecord(block['input']) && block['input']['run_in_background'] === true ? 'tool' : named;
      blocks.push({ type: 'tool', kind, file: kind === 'reading' && isRecord(block['input']) ? lastSegment(block['input']['file_path']) : null, tool: takeTool(block, MCP_TOOL_PREFIX) });
    }
  }
  return {
    own: parent === null || parent === undefined,
    parent: parentOf(parent),
    uuid: named.success ? named.data : null,
    replyId: reply.success ? reply.data : null,
    fromModel: message.model !== SYNTHETIC_MODEL,
    model: message.model === SYNTHETIC_MODEL ? null : modelKey(message.model),
    error: error !== undefined && error !== null,
    blocks,
  };
}

/**
 * What a `stream_event` frame says, of the little that is read of one (M19, C10):
 *
 *   reply       `message_start`: a reply begins, under an id every frame of it will carry.
 *   block       `content_block_start`: its block at `index` begins: a text, a thinking (M20a, C17),
 *               or neither.
 *   text        `content_block_delta` with a `text_delta`: more of the text block at `index`.
 *   reply-end   `message_stop`: the reply is over.
 *   other       anything else — a thinking, signature or tool-input delta, a block's stop, the
 *               reply's own delta, an event type this build does not know: passed over unread.
 */
export type StreamEvent =
  | { readonly kind: 'reply'; readonly replyId: string | null; readonly fromModel: boolean }
  | { readonly kind: 'block'; readonly index: number; readonly text: boolean; readonly thinking: boolean }
  | { readonly kind: 'text'; readonly index: number; readonly text: string }
  | { readonly kind: 'block-end'; readonly index: number }
  | { readonly kind: 'reply-end' }
  | { readonly kind: 'other' };

export interface StreamFrame {
  /** The session's own: no worker's (C12). */
  readonly own: boolean;
  /** For a worker's, the `Agent` tool use it names (M20a, C22). */
  readonly parent: string | null;
  readonly event: StreamEvent;
}

const blockIndex = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < MAX_BLOCKS ? value : null);
const OTHER: StreamEvent = { kind: 'other' };

export function takeStream(frame: unknown): StreamFrame | null {
  const parsed = StreamSchema.safeParse(frame);
  if (!parsed.success) return null;
  const { parent_tool_use_id: parent, event } = parsed.data;
  const own = parent === null || parent === undefined;
  const index = blockIndex(event.index);
  let taken: StreamEvent = OTHER;
  if (event.type === 'message_start') {
    const message = isRecord(event.message) ? event.message : {};
    const reply = id.safeParse(message['id']);
    // A model's reply: its model is named, and is not the CLI's own marker (C60).
    taken = { kind: 'reply', replyId: reply.success ? reply.data : null, fromModel: typeof message['model'] === 'string' && message['model'] !== '' && message['model'] !== SYNTHETIC_MODEL };
  } else if (event.type === 'content_block_start') {
    if (index === null) return null;
    const blockType = isRecord(event.content_block) ? event.content_block['type'] : undefined;
    taken = { kind: 'block', index, text: blockType === 'text', thinking: blockType === 'thinking' };
  } else if (event.type === 'content_block_delta') {
    const delta = isRecord(event.delta) ? event.delta : {};
    // Only a text's own delta is read: nothing of a thinking, a signature or a tool's input is.
    if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
      if (index === null) return null;
      taken = { kind: 'text', index, text: cutTo(delta['text'], MAX_MESSAGE_TEXT).text };
    }
  } else if (event.type === 'content_block_stop') {
    if (index === null) return null;
    taken = { kind: 'block-end', index };
  } else if (event.type === 'message_stop') {
    taken = { kind: 'reply-end' };
  }
  return { own, parent: parentOf(parent), event: taken };
}

export interface UserFrame {
  /** The session's own: no worker's. */
  readonly own: boolean;
  /** For a worker's, the `Agent` tool use it names (M20a, C22). */
  readonly parent: string | null;
  /** Its `tool_result` blocks (M20a, C18): nothing else of the frame is read. */
  readonly results: readonly TakenToolResult[];
}

/**
 * A `user` frame, read for its tool results and nothing else (M20a, C18): its text blocks make no
 * message, as before. Three fields are looked at, by name — whose it is, its message, and that
 * message's content — so `tool_use_result` and `tool_result_meta` are never read.
 */
export function takeUser(frame: unknown): UserFrame | null {
  if (!isRecord(frame)) return null;
  const message = frame['message'];
  const parent = parentOf(frame['parent_tool_use_id']);
  return { own: parent === null, parent, results: isRecord(message) ? takeToolResults(message['content']) : [] };
}

/** A failed turn's detail: the CLI's own words, cut (C37). */
export function errorDetail(blocks: readonly AssistantBlock[]): string | null {
  const text = blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n').trim();
  return text === '' ? null : cutTo(text, MAX_NOTICE_DETAIL).text;
}

/** Of `result`, one thing: whether it is an error (C36). Its `subtype` decides nothing: a failure can read `success`. */
export function takeResult(frame: unknown): { readonly isError: boolean } {
  return { isError: !isRecord(frame) || frame['is_error'] !== false };
}

/** A worker's statuses that end it (C39): `completed` is the one success. */
const CLOSING_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'killed', 'stopped']);

export interface TaskFrame {
  readonly background?: boolean;
  readonly taskId: string;
  /** `task_started`'s own words for the worker; its `prompt` is never read (C39). */
  readonly description: string | null;
  /** `task_started`'s `subagent_type` (M106, C20): the agent definition the worker runs as, one line; `general-purpose` by default. */
  readonly agentType: string | null;
  /** `task_progress`: the action of the tool it names. */
  readonly action: ActionKind | null;
  /** How the worker ended, when this frame says it has. */
  readonly ended: 'completed' | 'failed' | null;
  /** `task_started`, `task_notification`: the `Agent` tool use that started the worker (M20a, C22). */
  readonly toolUseId: string | null;
  /** `task_notification`: the worker's report, as the CLI gives it (M20a, C22). Not cut here: the mapper cuts it as an output. */
  readonly summary: string | null;
  /** `task_notification`: how long the CLI says the worker took (M20a, C22). */
  readonly durationMs: number | null;
}

export function takeTask(kind: 'task-started' | 'task-progress' | 'task-updated' | 'task-notification', frame: unknown): TaskFrame | null {
  const parsed = TaskSchema.safeParse(frame);
  if (!parsed.success) return null;
  const data = parsed.data as Record<string, unknown>;
  const description = kind === 'task-started' && typeof data['description'] === 'string' ? cutLine(data['description']) || null : null;
  const agentType = kind === 'task-started' && typeof data['subagent_type'] === 'string' ? cutLine(data['subagent_type']) || null : null;
  const action = kind === 'task-progress' && typeof data['last_tool_name'] === 'string' ? toolAction(data['last_tool_name']) : null;
  let ended: TaskFrame['ended'] = null;
  if (kind === 'task-notification') {
    // The notification is the worker's end, whatever it reads.
    ended = data['status'] === 'completed' ? 'completed' : 'failed';
  } else if (kind === 'task-updated') {
    const status = isRecord(data['patch']) ? data['patch']['status'] : undefined;
    if (typeof status === 'string' && CLOSING_STATUSES.has(status)) ended = status === 'completed' ? 'completed' : 'failed';
  }
  const toolUse = id.safeParse(data['tool_use_id']);
  const notified = kind === 'task-notification';
  const usage = notified && isRecord(data['usage']) ? data['usage']['duration_ms'] : undefined;
  return {
    taskId: parsed.data.task_id, description, agentType, action, ended,
    ...(typeof data['is_backgrounded'] === 'boolean' ? { background: data['is_backgrounded'] } : {}),
    toolUseId: toolUse.success ? toolUse.data : null,
    summary: notified && typeof data['summary'] === 'string' ? data['summary'] : null,
    durationMs: typeof usage === 'number' && Number.isSafeInteger(Math.round(usage)) && usage >= 0 ? Math.round(usage) : null,
  };
}

/**
 * What is read of a tool request that names the question tool (M21, C19): the tool use that carries
 * the same questions, the request's `input`, and the worker it names where it names one. Nothing of
 * it is cut: an answer is encoded from the request as it came (C59).
 */
export interface QuestionRequest {
  /** The tool's own name: what the one `allow` is typed to (chat-wire.ts). */
  readonly tool: typeof QUESTION_TOOL;
  /** The request's id, where it is one an event can carry (agent-events.ts): null otherwise, and the request is then no question fat-g can hold. */
  readonly requestId: string | null;
  /** The `tool_use` block's id: where the card stands (C6). Null for one that could be none. */
  readonly toolUseId: string | null;
  /** The request's `input`, whole: sent back with the answers beside what it holds (C17). */
  readonly input: Readonly<Record<string, unknown>>;
  /**
   * `input.questions`, in fat-g's shape (C7): each question's text, its header, its options and
   * whether several may be chosen. Free text is always taken, the answer being any string, and none
   * is a secret. Null where it is no list of questions, each with a text and labelled options: such
   * a request cannot be shown whole.
   */
  readonly questions: readonly RawQuestion[] | null;
  /** `agent_id`: the worker whose question it is, where the request names one that could be an id (C21). */
  readonly agentId: string | null;
}

/**
 * What is read of a tool request that names any other tool (M22, C8, C68): a request to act. Its
 * `input` and its offers are kept as they came — the card's view is made from them (chat-tools.ts),
 * and a decision is encoded from the request itself, never from the view.
 */
export interface ActionRequest {
  /** The request's id, where it is one an event can carry: null otherwise, and the request is then none fat-g can hold. */
  readonly requestId: string | null;
  /** The `tool_use` block's id: where the card stands, and what the action's own activity is named by. Null for one that could be none. */
  readonly toolUseId: string | null;
  /** The worker whose request it is, where it names one that could be an id (C11). */
  readonly agentId: string | null;
  /** The tool's name, as the request gave it. Null for none. */
  readonly tool: string | null;
  /** The request's `input`, whole. Null where it is no object: nothing could then be shown of the action. */
  readonly input: Readonly<Record<string, unknown>> | null;
  /** The request's own line for the action. Whose words it is depends on the tool (K2): the model's for a command, the path for a file's change. */
  readonly description: string | null;
  /** The path the CLI says the action is held for, where it names one. */
  readonly blockedPath: string | null;
  /** The CLI's reason is that a path lies outside the folders the session was given (K2). */
  readonly outside: boolean;
  /** The CLI's offers of what the user could grant beyond this action, as they came (C8, C68): each read for its kind by the wire, and one kind alone ever sent back. */
  readonly suggestions: readonly unknown[];
  /** The CLI marked the request as one no rule is to be kept for (C68). */
  readonly noGrant: boolean;
}

/**
 * A tool request's whole authorization payload, as it came (M22, C91): its tool, its input, the tool
 * use that carries it and the worker it names. A request delivered again under an id the session
 * holds is the same request only where all four are equal.
 */
export interface RequestPayload {
  readonly tool: unknown;
  readonly input: unknown;
  readonly toolUseId: unknown;
  readonly agentId: unknown;
}

/**
 * A request for the user's decision on a plan (M22b, C9, C10): the plan's tool, by its ids, with its
 * input as it came — what Execute's `allow` sends back unchanged — and the plan's text, read from
 * `input.plan` and from nowhere else: null where the input holds none, as under Read only (C70).
 */
export interface PlanRequest {
  readonly requestId: string | null;
  readonly toolUseId: string | null;
  readonly agentId: string | null;
  readonly input: Readonly<Record<string, unknown>> | null;
  readonly text: string | null;
}

export interface TakenRequest {
  /** Its id, to answer by. */
  readonly requestId: string | null;
  /** The name it is counted under. */
  readonly subtype: string;
  /** It asks to use a tool. */
  readonly tool: boolean;
  /** For a tool request that names the question tool, what is read of it; null for every other request. */
  readonly question: QuestionRequest | null;
  /** For a tool request that names any other tool, what is read of it (M22, C8); null for a question's, a plan's and for a request that asks for no tool. */
  readonly action: ActionRequest | null;
  /** For a tool request that names the plan's tool, what is read of it (M22b, C9); null for every other request. */
  readonly plan: PlanRequest | null;
  /** A tool request's payload as it came, to compare a repeated delivery with (M22, C91); null for a request that asks for no tool. */
  readonly payload: RequestPayload | null;
}

/** Whether two values a frame carried are the same, key by key and item by item: what a repeated delivery is compared by (M22, C91). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]));
}

/** Whether a request delivered again is the one that is held (M22, C91): the same tool, input, tool use and worker. */
export function samePayload(held: RequestPayload | null, again: RequestPayload | null): boolean {
  return held !== null && again !== null && sameValue(held.tool, again.tool) && sameValue(held.input, again.input) && sameValue(held.toolUseId, again.toolUseId) && sameValue(held.agentId, again.agentId);
}

/** A request's questions as they came (M21, C19), or null for what is not a list of them. */
function takeQuestions(value: unknown): RawQuestion[] | null {
  if (!Array.isArray(value)) return null;
  const questions: RawQuestion[] = [];
  for (const entry of value as unknown[]) {
    if (!isRecord(entry) || typeof entry['question'] !== 'string') return null;
    const listed: unknown = entry['options'] ?? [];
    if (!Array.isArray(listed)) return null;
    const options: InteractionOption[] = [];
    for (const option of listed as unknown[]) {
      if (!isRecord(option) || typeof option['label'] !== 'string') return null;
      options.push({ label: option['label'], description: typeof option['description'] === 'string' ? option['description'] : null });
    }
    questions.push({ text: entry['question'], header: typeof entry['header'] === 'string' ? entry['header'] : null, options, multiple: entry['multiSelect'] === true, freeText: true, secret: false });
  }
  return questions;
}

/**
 * A request of the CLI's: its id, to answer by, and the name it is counted under. For a tool request
 * that names the question tool (M21, C19), also its `request_id` as an id, its `tool_use_id`, its
 * `input` with the questions it holds, and its `agent_id`. For a tool request that names any other
 * tool (M22, C8), those four and its `tool_name`, its `description`, its `blocked_path`, whether its
 * `decision_reason_type` is the one for a path outside the session's folders, its
 * `permission_suggestions` and whether it is marked `suppress_always_allow_rule`. For every other
 * request, nothing more than its id and its name.
 */
export function takeRequest(frame: unknown): TakenRequest {
  const record = isRecord(frame) ? frame : {};
  const request = isRecord(record['request']) ? record['request'] : {};
  const tool = request['subtype'] === TOOL_REQUEST;
  const requestId = typeof record['request_id'] === 'string' && record['request_id'] !== '' ? record['request_id'] : null;
  if (!tool) return { requestId, subtype: refusedSubtype(request['subtype']), tool, question: null, action: null, plan: null, payload: null };
  const payload: RequestPayload = { tool: request['tool_name'], input: request['input'], toolUseId: request['tool_use_id'], agentId: request['agent_id'] };
  const named = id.safeParse(requestId);
  const toolUse = id.safeParse(request['tool_use_id']);
  const agent = id.safeParse(request['agent_id']);
  const ids = { requestId: named.success ? named.data : null, toolUseId: toolUse.success ? toolUse.data : null, agentId: agent.success ? agent.data : null };
  if (request['tool_name'] === QUESTION_TOOL) {
    const input = isRecord(request['input']) ? request['input'] : {};
    return { requestId, subtype: TOOL_REQUEST, tool, question: { tool: QUESTION_TOOL, ...ids, input, questions: takeQuestions(input['questions']) }, action: null, plan: null, payload };
  }
  if (request['tool_name'] === PLAN_TOOL) {
    // The plan's text from the request's own input, which the CLI fills from the plan file the model
    // wrote (K1): no plan file is read (S4). Nothing of the input's path is kept.
    const input = isRecord(request['input']) ? request['input'] : null;
    const plan = input === null ? null : input['plan'];
    return { requestId, subtype: TOOL_REQUEST, tool, question: null, action: null, plan: { ...ids, input, text: typeof plan === 'string' && plan.trim() !== '' && plan.length <= MAX_PLAN_TEXT ? plan : null }, payload };
  }
  const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
  const suggestions: unknown = request['permission_suggestions'];
  const action: ActionRequest = {
    ...ids, tool: text(request['tool_name']), input: isRecord(request['input']) ? request['input'] : null,
    description: text(request['description']), blockedPath: text(request['blocked_path']), outside: request['decision_reason_type'] === 'workingDir',
    suggestions: Array.isArray(suggestions) ? suggestions : [], noGrant: request['suppress_always_allow_rule'] === true,
  };
  return { requestId, subtype: TOOL_REQUEST, tool, question: null, action, plan: null, payload };
}

const CancelSchema = z.looseObject({ request_id: id });

/**
 * Of a `control_cancel_request` frame (M21, C20): the request of its own that the CLI takes back,
 * `{ type, request_id }` as K1's Stop showed it. Nothing else of it is read. Null for one that
 * names no request.
 */
export function takeCancel(frame: unknown): { readonly requestId: string } | null {
  const parsed = CancelSchema.safeParse(frame);
  return parsed.success ? { requestId: parsed.data.request_id } : null;
}
