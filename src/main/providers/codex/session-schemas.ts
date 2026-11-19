// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What the adapter takes of a session's frames (docs/planning/_archive/M15.md, Design 2, 7; C10, C113;
// M20a.md, Design 3; C14, C19, C24): each field by its name, cut to its bound as it is taken.
// Nothing else of a frame leaves this module: no raw frame, no `agentPath`, no account field. A
// command line leaves it as an activity's input, for the chat alone (M20a, C30), and by no other
// route: an action's label never holds one.
//
// An id over its bound, or with a control character in it, is no id: its frame is dropped and
// counted. A string that is only too long is cut, and its message says so.
//
// A question asked as a request is the one thing taken whole (docs/planning/_archive/M21.md, Design 4; C23,
// C25, C59): the session holds it as it came, in memory alone, and encodes the answer from that.
// What the card draws of it is bounded by the shared contract, and nothing of it reaches a log.
//
// What a session may do (docs/planning/_archive/M22.md, Design 7; C4, C7, C9, C10, C65, C68, C70). A start
// reply is read for its policy whole — the sandbox as it came, the approval policy and the reviewer
// — and the session holds it to its mode (modes.ts). A request for leave is read for whose it is,
// the action it names and the choices it lists; a file change's request names no file, so the
// `fileChange` item is read for its changes as they came, uncut, for the session to keep while the
// item is open. A request's id is kept lossless: a number and a string of one spelling are two.
import { z } from 'zod';
import type { ReturnedImage } from '@shared/contracts/returned-images';
import { takeReturnedImage } from './returned-images';
import { type AgentQuestion, cutLine, cutTo, MAX_AGENT_ID, MAX_HISTORY_IMAGE_PATH, MAX_HISTORY_IMAGES, MAX_MESSAGE_TEXT, MAX_NOTICE_DETAIL, MAX_OPTIONS, MAX_QUESTION_TEXT, MAX_QUESTIONS, type MessagePhase } from '@shared/contracts/agent-events';
import { MAX_PLAN_TEXT } from '@shared/contracts/plans';
import type { ChangeKind } from '@shared/contracts/activity';
import { catalogId } from '@shared/contracts/catalog';
import type { AuthorityKind, RawQuestion } from '@shared/contracts/interaction';
import { type ActionKind, type ContextCalls, type ContextReading, MAX_CONTEXT_TOKENS } from '@shared/contracts/sessions';
import { changeKind, type TakenActivity, takeActivity, takeHistoryActivity, takePlanSteps } from './activity';
import { COMMAND_APPROVAL, FILE_APPROVAL, MCP_ELICITATION } from './methods';
import type { ReportedPolicy } from './modes';

export type { TakenActivity };

const id = z.string().min(1).max(MAX_AGENT_ID).refine((value) => !/\p{Cc}/u.test(value));
const optionalId = id.nullish().transform((value) => value ?? null);

const ItemFrame = z.object({ threadId: id, turnId: optionalId, item: z.object({ type: z.string().max(64), id: optionalId }), startedAtMs: z.number().nullish(), completedAtMs: z.number().nullish() });
const PlanFrame = z.object({ threadId: id, turnId: optionalId });
const DeltaFrame = z.object({ threadId: id, turnId: optionalId, itemId: id, delta: z.string() });
/** A plan item (M22b, C14): its text, which no length of fat-g's bounds but the line's (C60, C61). */
const PlanItem = z.object({ text: z.string().max(MAX_PLAN_TEXT).nullish().transform((text) => text ?? '') });
const AgentMessage = z.object({ text: z.string(), phase: z.string().nullish(), questions: z.array(z.object({ title: z.string(), options: z.array(z.string()).nullish() })).nullish() });
const UserMessage = z.object({ clientId: z.string().nullish(), content: z.array(z.object({ type: z.string(), text: z.string().nullish(), path: z.string().nullish() })).nullish() });
const Command = z.object({ commandActions: z.array(z.object({ type: z.string().nullish(), name: z.string().nullish() })).nullish() });
/** `model` (M106, C15; K2): the model resolved at the sub-agent's creation, on its `started` kind; absent from older records. */
const SubAgent = z.object({ kind: z.string(), agentThreadId: id, model: z.unknown().optional() });
/**
 * A collab tool call (K3): its tool, its status, and the threads it names — for a spawn, the one it
 * started. `model` (M106, C15; K2): the model a spawn asked for, which its sub-agent's thread runs on.
 */
const CollabCall = z.object({ tool: z.string().nullish(), status: z.string().nullish(), receiverThreadIds: z.array(z.unknown()).nullish(), model: z.unknown().optional() });

/** A model a frame names, where it is a catalog id (M106, C15): an empty one, which an older spawn's start carried (K3), names none. */
const modelKey = (value: unknown): string | null => (typeof value === 'string' ? catalogId(value) : null);
const TurnFrame = z.object({ threadId: id, turn: z.object({ id, status: z.string().nullish(), error: z.object({ message: z.string().nullish() }).nullish() }) });
const ErrorFrame = z.object({ threadId: id, turnId: optionalId, willRetry: z.boolean().nullish(), error: z.object({ message: z.string().nullish() }).nullish() });
const StatusFrame = z.object({ threadId: id, status: z.object({ type: z.string() }) });
const Sandbox = z.object({ type: z.string().max(64), networkAccess: z.boolean().nullish(), writableRoots: z.array(z.unknown()).nullish(), excludeTmpdirEnvVar: z.boolean().nullish(), excludeSlashTmp: z.boolean().nullish() });
const StartReply = z.object({ thread: z.object({ id }), sandbox: Sandbox.nullish(), approvalPolicy: z.unknown(), approvalsReviewer: z.unknown().optional(), serviceTier: z.unknown().optional() });
const TurnStartReply = z.object({ turn: z.object({ id }) });
const HistoryPage = z.object({
  data: z.array(z.object({ id, status: z.string().nullish(), startedAt: z.number().nullish(), completedAt: z.number().nullish(), durationMs: z.number().nullish(), items: z.array(z.unknown()).nullish() })),
  nextCursor: z.string().min(1).max(4096).nullish(),
});

const ThreadFrame = z.object({ threadId: id });
/** `item/tool/requestUserInput` (M21, C23): `autoResolutionMs` is no field of it here, and is never read (C9). */
const QuestionRequest = z.object({
  threadId: id,
  turnId: id,
  itemId: id,
  questions: z.array(z.object({
    id: z.string(),
    header: z.string().nullish(),
    question: z.string(),
    isOther: z.boolean().nullish(),
    isSecret: z.boolean().nullish(),
    options: z.array(z.object({ label: z.string(), description: z.string().nullish() })).nullish(),
  })),
  isBlocking: z.boolean().nullish(),
});
const ResolvedFrame = z.object({ requestId: z.union([z.string(), z.number()]) });
/** Whose a request for leave is (M22, C11): both requests name the thread, the turn and the item. */
const Asked = { threadId: id, turnId: id, itemId: id, reason: z.string().nullish() };
const CommandApproval = z.object({
  ...Asked,
  command: z.string().nullish(),
  cwd: z.string().nullish(),
  commandActions: z.array(z.object({ path: z.string().nullish() })).nullish(),
  availableDecisions: z.array(z.unknown()).nullish(),
  proposedExecpolicyAmendment: z.unknown().optional(),
  proposedNetworkPolicyAmendments: z.unknown().optional(),
});
const FileApproval = z.object({ ...Asked, grantRoot: z.unknown().optional() });
const FileChangeFrame = z.object({ threadId: id, item: z.object({ type: z.literal('fileChange'), id, changes: z.array(z.object({ path: z.string(), kind: z.unknown().optional(), diff: z.string().nullish() })).nullish() }) });
/** The kind of elicitation that is Codex's leave to run an MCP tool, and not a server's own question (decision 0018). */
const MCP_APPROVAL_KIND = 'mcp_tool_call';
/**
 * Codex's leave to run an MCP tool (decision 0018): a form with no field, whose `_meta` says what it
 * is, which persistence its answer may ask for, and the call's arguments. It names its server, never
 * the item, and the tool only in its sentence, which is not read: the session places it on the call.
 */
const McpApproval = z.object({
  threadId: id, turnId: id, serverName: id, mode: z.literal('form'),
  _meta: z.object({ codex_approval_kind: z.literal(MCP_APPROVAL_KIND), persist: z.array(z.unknown()).nullish(), tool_params: z.unknown().optional() }),
});
const McpCallFrame = z.object({ threadId: id, turnId: id, item: z.object({ type: z.literal('mcpToolCall'), id, server: id, tool: id, arguments: z.unknown().optional() }) });
const ItemIdFrame = z.object({ threadId: id, item: z.object({ id }) });

// ── How full the context window is (decision 0033) ──────────────────────────────────────────
// `thread/tokenUsage/updated`, for each thread: `last` is the thread's last call, `total` every call
// of it so far, and `modelContextWindow` its model's window. What the context holds is the last
// call's whole count, as Codex's own interface reads it; Codex says nothing of where it compacts.

const tokens = z.number().int().min(0).max(MAX_CONTEXT_TOKENS);
const Usage = z.object({ inputTokens: tokens, cachedInputTokens: tokens.nullish(), cacheWriteInputTokens: tokens.nullish(), outputTokens: tokens, reasoningOutputTokens: tokens.nullish(), totalTokens: tokens });
const TokenUsageFrame = z.object({ threadId: id, tokenUsage: z.object({ last: Usage, total: Usage, modelContextWindow: tokens.min(1) }) });

/** A call's usage as the shared reading names it: Codex's input counts what came from the cache, which is set apart. */
function callsOf(usage: z.infer<typeof Usage>): ContextCalls {
  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens);
  return {
    input: usage.inputTokens - cached,
    cacheRead: cached,
    ...(usage.cacheWriteInputTokens == null ? {} : { cacheWrite: usage.cacheWriteInputTokens }),
    output: usage.outputTokens,
    ...(usage.reasoningOutputTokens == null ? {} : { reasoning: Math.min(usage.reasoningOutputTokens, usage.outputTokens) }),
  };
}

/** A token report: the thread it names, and the reading it gives. Null for one that names no window, or no count. */
export function takeTokenUsage(params: unknown): { readonly threadId: string; readonly reading: ContextReading } | null {
  const parsed = TokenUsageFrame.safeParse(params);
  if (!parsed.success) return null;
  const { last, total, modelContextWindow } = parsed.data.tokenUsage;
  return { threadId: parsed.data.threadId, reading: { used: last.totalTokens, window: modelContextWindow, lastCall: callsOf(last), calls: callsOf(total) } };
}

/** Whose frame it is, and nothing else of it (M20b, C20): what decides whether an aside's side thread holds it for its turn's name. */
export function takeThreadId(params: unknown): string | null {
  const parsed = ThreadFrame.safeParse(params);
  return parsed.success ? parsed.data.threadId : null;
}

/**
 * A request's id as the session holds its request by, and as an event names it (M21, C20, C23;
 * M22, C10): lossless, `n:` before a number and `s:` before a string, so that `0` and `"0"` are two
 * requests. The id as it came is kept apart, for the reply. Null for one that is no id of an
 * event's — none, an empty one, one past its bound — whose request is refused.
 */
export function takeRequestId(value: unknown): string | null {
  const key = typeof value === 'number' && Number.isFinite(value) ? `n:${String(value)}` : typeof value === 'string' && value !== '' ? `s:${value}` : null;
  if (key === null) return null;
  const parsed = id.safeParse(key);
  return parsed.success ? parsed.data : null;
}

/** One question of a request, as it came (M21, C23): its texts whole, for the answer's encoding (C59). */
export interface TakenQuestion {
  /** Codex's own id for the question: the key its answer is given under. */
  readonly id: string;
  readonly header: string | null;
  readonly question: string;
  /** A text is taken beside the options. The schema's default is false for it, and for `isSecret` (C25). */
  readonly isOther: boolean;
  readonly isSecret: boolean;
  readonly options: readonly { readonly label: string; readonly description: string | null }[];
}

export interface TakenQuestionRequest {
  readonly threadId: string;
  readonly turnId: string;
  /** The item that carries the question: where its card stands (C6). */
  readonly itemId: string;
  readonly questions: readonly TakenQuestion[];
  /** As the request gives it, or null where it gives none (C25): kept, and nothing of the card follows from it. */
  readonly isBlocking: boolean | null;
}

/**
 * An `item/tool/requestUserInput` request (M21, C23): whose thread and turn it is, the item that
 * carries it, its questions and `isBlocking`, and nothing more. Null for one that is not such a
 * request, or whose ids are not ids: it is refused.
 */
export function takeQuestionRequest(params: unknown): TakenQuestionRequest | null {
  const parsed = QuestionRequest.safeParse(params);
  if (!parsed.success) return null;
  const { threadId, turnId, itemId, questions, isBlocking } = parsed.data;
  return {
    threadId, turnId, itemId, isBlocking: isBlocking ?? null,
    questions: questions.map((question) => ({
      id: question.id,
      header: question.header ?? null,
      question: question.question,
      isOther: question.isOther === true,
      isSecret: question.isSecret === true,
      options: (question.options ?? []).map((option) => ({ label: option.label, description: option.description ?? null })),
    })),
  };
}

/**
 * A request's questions in the shape every provider's share (M21, C7, C25), before any bound:
 * `isOther` is whether a text is taken, `isSecret` whether the answer is masked and never kept, and
 * one option may be chosen — the schema has no way to ask for several.
 */
export function rawQuestions(request: TakenQuestionRequest): RawQuestion[] {
  return request.questions.map((question) => ({ text: question.question, header: question.header, options: question.options.map((option) => ({ label: option.label, description: option.description })), multiple: false, freeText: question.isOther, secret: question.isSecret }));
}

/** A `serverRequest/resolved` frame (M21, C23): the request it names, as the session holds one, and nothing else of it. */
export function takeResolvedFrame(params: unknown): string | null {
  const frame = ResolvedFrame.safeParse(params);
  return frame.success ? takeRequestId(frame.data.requestId) : null;
}

/** A request for leave to run a command, as it came (M22, C8, C68): what its card is built from, and nothing more of it. */
export interface TakenCommandApproval {
  readonly kind: 'command';
  readonly threadId: string;
  readonly turnId: string;
  /** The `commandExecution` item it asks for: what the action's own activity shares (C14). */
  readonly itemId: string;
  /** The whole invocation; null where the request names none, which is then no command fat-g can show. */
  readonly command: string | null;
  readonly cwd: string | null;
  /** The model's own words, where the request carries any. */
  readonly reason: string | null;
  /** The paths Codex read out of the command line. */
  readonly paths: readonly string[];
  /** Its list of decisions holds the session's own (C68): never seen for a command (K1), and offered only where it is. */
  readonly forSession: boolean;
  /** What its other offers would grant beyond this one action (C22, C56): said on the card, and never sent back. */
  readonly authority: readonly AuthorityKind[];
}

/** A request for leave to change files, as it came (M22, C8, C68): it names no file, only the item that holds the change. */
export interface TakenFileApproval {
  readonly kind: 'file-change';
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly reason: string | null;
  /** It asks for a root, and not for these files alone: no session grant is made of such a one (C68). */
  readonly grantRoot: boolean;
}

/**
 * Codex's leave to run an MCP tool, as it came (decision 0018). It names no item: the session places
 * it on the call it holds by its thread, its turn, its server and its arguments.
 */
export interface TakenMcpApproval {
  readonly kind: 'mcp-tool';
  readonly threadId: string;
  readonly turnId: string;
  readonly server: string;
  /** The call's arguments as the request has them, whole: what the card shows. */
  readonly params: unknown;
  /** Its persistence offers the session's own grant. */
  readonly forSession: boolean;
  /** What its other persistence would grant beyond this call (`always`, a rule Codex keeps): said on the card, and never sent back. */
  readonly authority: readonly AuthorityKind[];
}

export type TakenApproval = TakenCommandApproval | TakenFileApproval | TakenMcpApproval;

/** An elicitation that says it is Codex's leave to run an MCP tool, well formed or not: any other is a server's own (decision 0026). */
export function isMcpApproval(params: unknown): boolean {
  if (typeof params !== 'object' || params === null) return false;
  const meta = (params as { readonly _meta?: unknown })._meta;
  return typeof meta === 'object' && meta !== null && (meta as { readonly codex_approval_kind?: unknown }).codex_approval_kind === MCP_APPROVAL_KIND;
}

/** What a decision of a command's list would grant beyond the one use, by its name alone: a rule Codex would save, network access, or something fat-g does not know. */
function authorityOf(decision: unknown): AuthorityKind | null {
  if (typeof decision === 'string') return decision === 'accept' || decision === 'acceptForSession' || decision === 'decline' || decision === 'cancel' ? null : 'other';
  const [name] = typeof decision === 'object' && decision !== null && !Array.isArray(decision) ? Object.keys(decision) : [];
  if (name === undefined) return 'other';
  // Codex's amendment to its own rules, saved for every project of the account (K1): told, and never sent (C22).
  if (/execpolicy/i.test(name)) return 'saved-rule';
  return /network/i.test(name) ? 'network' : 'other';
}

/**
 * One of the three requests for leave (M22, C8; decision 0018): whose thread, turn and item it names
 * — an MCP tool's names no item — the action as the request has it, and what its decisions offer.
 * Null for one that is not such a request, or whose ids are not ids: it is refused.
 */
export function takeApprovalRequest(method: string, params: unknown): TakenApproval | null {
  if (method === MCP_ELICITATION) {
    const parsed = McpApproval.safeParse(params);
    if (!parsed.success) return null;
    const { threadId, turnId, serverName, _meta: meta } = parsed.data;
    const persist = meta.persist ?? [];
    const offered = persist.flatMap((value): AuthorityKind[] => (value === 'session' ? [] : value === 'always' ? ['saved-rule'] : ['other']));
    return { kind: 'mcp-tool', threadId, turnId, server: serverName, params: meta.tool_params ?? null, forSession: persist.includes('session'), authority: [...new Set(offered)] };
  }
  if (method === FILE_APPROVAL) {
    const parsed = FileApproval.safeParse(params);
    if (!parsed.success) return null;
    const { threadId, turnId, itemId, reason, grantRoot } = parsed.data;
    return { kind: 'file-change', threadId, turnId, itemId, reason: reason ?? null, grantRoot: grantRoot !== null && grantRoot !== undefined };
  }
  if (method !== COMMAND_APPROVAL) return null;
  const parsed = CommandApproval.safeParse(params);
  if (!parsed.success) return null;
  const { threadId, turnId, itemId, reason, command, cwd, commandActions, availableDecisions } = parsed.data;
  const listed = availableDecisions ?? [];
  const offered = listed.flatMap((decision) => { const kind = authorityOf(decision); return kind === null ? [] : [kind]; });
  // With no list, what the request proposes is what it would offer.
  if (availableDecisions === null || availableDecisions === undefined) {
    if (parsed.data.proposedExecpolicyAmendment !== null && parsed.data.proposedExecpolicyAmendment !== undefined) offered.push('saved-rule');
    if (Array.isArray(parsed.data.proposedNetworkPolicyAmendments) && parsed.data.proposedNetworkPolicyAmendments.length > 0) offered.push('network');
  }
  return {
    kind: 'command', threadId, turnId, itemId, reason: reason ?? null, command: command ?? null, cwd: cwd ?? null,
    paths: (commandActions ?? []).flatMap((action) => (typeof action.path === 'string' && action.path !== '' ? [action.path] : [])),
    forSession: listed.includes('acceptForSession'),
    authority: [...new Set(offered)],
  };
}

/** One file of a `fileChange` item, as the item has it (M22, C9, C48): its path, its kind, and its diff whole. */
export interface RawChange {
  readonly path: string;
  readonly kind: ChangeKind;
  readonly diff: string | null;
}

/** An MCP call as its `item/started` frame has it: what Codex's leave to run it is placed on, since the request names no item. */
export interface RawMcpCall {
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId: string;
  readonly server: string;
  readonly tool: string;
  readonly arguments: unknown;
}

/** An `mcpToolCall` item's frame: its thread, turn, server, tool and arguments. Null for a frame that cannot name its call. */
export function takeMcpCall(params: unknown): RawMcpCall | null {
  const frame = McpCallFrame.safeParse(params);
  if (!frame.success) return null;
  const { item } = frame.data;
  return { threadId: frame.data.threadId, turnId: frame.data.turnId, itemId: item.id, server: item.server, tool: item.tool, arguments: item.arguments ?? null };
}

/**
 * A `fileChange` item's changes as they came, from its `item/started` frame (M22, C9): what a
 * request for leave that names the item is shown from, uncut. Null for a frame of any other item.
 */
export function takeFileChange(params: unknown): { readonly threadId: string; readonly itemId: string; readonly changes: readonly RawChange[] } | null {
  const frame = FileChangeFrame.safeParse(params);
  if (!frame.success) return null;
  const changes = (frame.data.item.changes ?? []).map((change): RawChange => ({ path: change.path, kind: changeKind(change.kind), diff: change.diff ?? null }));
  return { threadId: frame.data.threadId, itemId: frame.data.item.id, changes };
}

/** The item an `item/started` or `item/completed` frame names, and nothing else of it: null for a frame with none. */
export function takeItemId(params: unknown): string | null {
  const frame = ItemIdFrame.safeParse(params);
  return frame.success ? frame.data.item.id : null;
}

export type TurnStatus = 'completed' | 'interrupted' | 'failed';
/** A turn's status as one of its three ends, or null for any other: a turn still running, or a status the adapter does not know. */
const takeStatus = (status: string | null | undefined): TurnStatus | null => (status === 'completed' || status === 'interrupted' || status === 'failed' ? status : null);

/** A number of the CLI's as a whole one, scaled — its seconds as milliseconds — or null when it gave none that is one. */
function takeWhole(value: number | null | undefined, scale = 1): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const whole = Math.round(value * scale);
  return Number.isSafeInteger(whole) ? whole : null;
}

export type TakenItem =
  | { readonly type: 'agentMessage'; readonly id: string; readonly phase: MessagePhase; readonly text: string; readonly questions: readonly AgentQuestion[]; readonly cut: boolean }
  /** `images` (M23, C24, C25): each `localImage` part's path, as the CLI returned it, in order; main matches it, and reads none. */
  | { readonly type: 'userMessage'; readonly id: string; readonly clientId: string | null; readonly text: string; readonly cut: boolean; readonly images: readonly string[] }
  /**
   * An action (C42): its kind, and for a read the file's name. `opens` (M19, C7): for an agent
   * message's `item/started`, the message it opens — its id, and the phase the frame names.
   */
  | { readonly type: 'action'; readonly kind: ActionKind; readonly file: string | null; readonly targets?: readonly string[]; readonly opens?: { readonly id: string; readonly phase: MessagePhase } }
  /**
   * `closing` for `completed` and `interrupted`; `interacted` and any other kind change nothing (C44).
   * `itemId`: the announcement's own id, which the worker item is known by (M20a, C23).
   */
  | { readonly type: 'worker'; readonly kind: 'started' | 'completed' | 'interrupted' | 'other'; readonly workerId: string; readonly itemId: string | null; /** The model it runs on, where the frame names one that is a key (M106, C15). */ readonly model: string | null }
  /**
   * A collab tool call that starts a sub-agent (M20a, K3): the other way Codex announces one, with
   * no `subAgentActivity`. `workerId`: the thread its completion names as started, null until then
   * and for a call that started none. `failed`: its status says it did not do what it was for.
   * `model` (M106, C15): the model it asked for, where it names one that is a key.
   */
  | { readonly type: 'spawn'; readonly workerId: string | null; readonly failed: boolean; readonly model: string | null }
  /**
   * A plan (M22b, C14): its id and its text — empty on its `item/started`, whole on its
   * `item/completed`, which is the authority. Bounded by the line alone (C60, C61).
   */
  | { readonly type: 'plan'; readonly id: string; readonly text: string };

export interface TakenItemFrame {
  readonly image?: ReturnedImage;
  readonly threadId: string;
  readonly turnId: string | null;
  /** Null for an item the adapter takes nothing of: its frame still says whose thread and turn it is. */
  readonly item: TakenItem | null;
  /** The item as an activity (M20a, C14): what its start says, and what its end adds. Null for a message, an echo and a worker's announcement, and for an item with no id. */
  readonly activity: TakenActivity | null;
  /** When Codex says the item began, on its started frame, or ended, on its completed one. Null when it gives none. */
  readonly at: number | null;
}

/** A message's questions, each title and option cut, those past the sixteenth and options past the eighth left out (C113). */
function takeQuestions(raw: readonly { title: string; options?: readonly string[] | null | undefined }[] | null | undefined): { questions: AgentQuestion[]; cut: boolean } {
  let cut = (raw?.length ?? 0) > MAX_QUESTIONS;
  const questions = (raw ?? []).slice(0, MAX_QUESTIONS).map((question) => {
    const title = cutTo(question.title, MAX_QUESTION_TEXT);
    const all = question.options ?? [];
    const options = all.slice(0, MAX_OPTIONS).map((option) => cutTo(option, MAX_QUESTION_TEXT));
    cut ||= title.cut || all.length > MAX_OPTIONS || options.some((option) => option.cut);
    return { title: title.text, options: options.map((option) => option.text) };
  });
  return { questions, cut };
}

/** Codex labels each agent message as it starts: `commentary`, or its final answer under any other name. */
const takePhase = (phase: string | null | undefined): MessagePhase => (phase === 'commentary' ? 'commentary' : 'final');

function takeAgentMessage(itemId: string, raw: unknown): TakenItem | null {
  const parsed = AgentMessage.safeParse(raw);
  if (!parsed.success) return null;
  const text = cutTo(parsed.data.text, MAX_MESSAGE_TEXT);
  const { questions, cut } = takeQuestions(parsed.data.questions);
  return { type: 'agentMessage', id: itemId, phase: takePhase(parsed.data.phase), text: text.text, questions, cut: text.cut || cut };
}

function takeUserMessage(itemId: string, raw: unknown): TakenItem | null {
  const parsed = UserMessage.safeParse(raw);
  if (!parsed.success) return null;
  const whole = (parsed.data.content ?? []).flatMap((part) => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : [])).join('\n');
  const text = cutTo(whole, MAX_MESSAGE_TEXT);
  const clientId = id.safeParse(parsed.data.clientId);
  // A `localImage`'s path as it came (M23, C25): kept only where it is one main may match, bounded and of no control character.
  const images = (parsed.data.content ?? []).flatMap((part) => (part.type === 'localImage' && typeof part.path === 'string' && part.path !== '' && part.path.length <= MAX_HISTORY_IMAGE_PATH && !/\p{Cc}/u.test(part.path) ? [part.path] : [])).slice(0, MAX_HISTORY_IMAGES);
  return { type: 'userMessage', id: itemId, clientId: clientId.success ? clientId.data : null, text: text.text, cut: text.cut, images };
}

/** The current action's kind from an item's type (C42). A command line is never taken. */
function takeAction(type: string, raw: unknown): Extract<TakenItem, { type: 'action' }> {
  switch (type) {
    case 'reasoning': return { type: 'action', kind: 'thinking', file: null };
    case 'agentMessage': return { type: 'action', kind: 'writing', file: null };
    case 'sleep': return { type: 'action', kind: 'waiting', file: null };
    case 'collabAgentToolCall': {
      const call = CollabCall.safeParse(raw);
      if (!call.success || call.data.tool !== 'wait') return { type: 'action', kind: 'tool', file: null };
      const targets = (call.data.receiverThreadIds ?? []).slice(0, 256).flatMap((value) => { const parsed = id.safeParse(value); return parsed.success ? [parsed.data] : []; });
      return { type: 'action', kind: 'waiting', file: null, targets };
    }
    case 'fileChange': return { type: 'action', kind: 'writing', file: null };
    case 'contextCompaction': return { type: 'action', kind: 'compacting', file: null };
    case 'commandExecution': {
      const first = Command.safeParse(raw).data?.commandActions?.[0];
      if (first?.type !== 'read') return { type: 'action', kind: 'running', file: null };
      const name = typeof first.name === 'string' ? cutLine(first.name) : '';
      return { type: 'action', kind: 'reading', file: name === '' ? null : name };
    }
    default: return { type: 'action', kind: 'tool', file: null };
  }
}

/**
 * An `item/started` or `item/completed` frame. `started` says which: a started item is the current
 * action (but a worker's announcement, and a user's echo, which is none); a completed one a message.
 * Null for a frame that is not one, or whose ids are not ids: it is dropped and counted.
 */
export function takeItemFrame(params: unknown, started: boolean): TakenItemFrame | null {
  const frame = ItemFrame.safeParse(params);
  if (!frame.success) return null;
  const raw = (params as { item: unknown }).item;
  const { type } = frame.data.item;
  const at = takeWhole(started ? frame.data.startedAtMs : frame.data.completedAtMs);
  // A plan is no activity (M22b, C14, C23): its line and its tab stand for it.
  if (type === 'plan') {
    const plan = PlanItem.safeParse(raw);
    if (frame.data.item.id === null || !plan.success) return null;
    return { threadId: frame.data.threadId, turnId: frame.data.turnId, activity: null, at, item: { type: 'plan', id: frame.data.item.id, text: plan.data.text } };
  }
  const activity = frame.data.item.id === null ? null : takeActivity(type, frame.data.item.id, raw);
  const base = { threadId: frame.data.threadId, turnId: frame.data.turnId, activity, at, ...(type === 'imageGeneration' && !started ? { image: takeReturnedImage(raw) } : {}) };
  if (type === 'subAgentActivity') {
    const worker = SubAgent.safeParse(raw);
    if (!worker.success) return null;
    // Both of its frames, started and completed, say the same: the mapper takes the first.
    const kind = worker.data.kind === 'started' || worker.data.kind === 'completed' || worker.data.kind === 'interrupted' ? worker.data.kind : 'other';
    return { ...base, item: { type: 'worker', kind, workerId: worker.data.agentThreadId, itemId: frame.data.item.id, model: modelKey(worker.data.model) } };
  }
  if (type === 'collabAgentToolCall') {
    const call = CollabCall.safeParse(raw);
    if (call.success && call.data.tool === 'spawnAgent') {
      const receiver = id.safeParse(call.data.receiverThreadIds?.[0]);
      return { ...base, item: { type: 'spawn', workerId: receiver.success ? receiver.data : null, failed: call.data.status === 'failed' || call.data.status === 'interrupted', model: modelKey(call.data.model) } };
    }
  }
  if (started) {
    if (type === 'userMessage') return { ...base, item: null };
    const action = takeAction(type, raw);
    // An agent message's start opens the message (M19, C7): the frame carries its id and its phase, and an empty text.
    if (type !== 'agentMessage' || frame.data.item.id === null) return { ...base, item: action };
    const opened = z.object({ phase: z.string().nullish() }).safeParse(raw);
    return { ...base, item: { ...action, opens: { id: frame.data.item.id, phase: takePhase(opened.success ? opened.data.phase : null) } } };
  }
  if (type !== 'agentMessage' && type !== 'userMessage') return { ...base, item: null };
  if (frame.data.item.id === null) return null;
  const item = type === 'agentMessage' ? takeAgentMessage(frame.data.item.id, raw) : takeUserMessage(frame.data.item.id, raw);
  return item === null ? null : { ...base, item };
}

/**
 * An `item/plan/delta` frame (M22b, C14): whose thread, turn and plan it names, and the text to
 * append, as it came. Null for one past what an event carries, which no line can be.
 */
export function takePlanDeltaFrame(params: unknown): { readonly threadId: string; readonly turnId: string | null; readonly itemId: string; readonly text: string } | null {
  const frame = DeltaFrame.safeParse(params);
  if (!frame.success || frame.data.delta.length > MAX_PLAN_TEXT) return null;
  return { threadId: frame.data.threadId, turnId: frame.data.turnId, itemId: frame.data.itemId, text: frame.data.delta };
}

/**
 * An `item/agentMessage/delta` frame (M19, C7, C8): whose thread, turn and item it names, and the
 * text to append, cut to a message's bound. Nothing else of it is read.
 */
export function takeDeltaFrame(params: unknown): { readonly threadId: string; readonly turnId: string | null; readonly itemId: string; readonly text: string } | null {
  const frame = DeltaFrame.safeParse(params);
  if (!frame.success) return null;
  return { threadId: frame.data.threadId, turnId: frame.data.turnId, itemId: frame.data.itemId, text: cutTo(frame.data.delta, MAX_MESSAGE_TEXT).text };
}

export interface TakenTurnFrame {
  readonly threadId: string;
  readonly turnId: string;
  /** Null for a status the adapter does not know. */
  readonly status: TurnStatus | null;
  /** The CLI's own message for a failed turn, cut (C39). */
  readonly detail: string | null;
}

/**
 * The CLI's own error text (C39): the inner `error.message` when the text is the API's JSON error,
 * as in T5, else the text; cut at 500 characters.
 */
export function errorDetail(message: string | null | undefined): string | null {
  if (typeof message !== 'string' || message.trim() === '') return null;
  let text = message;
  try {
    const parsed: unknown = JSON.parse(message);
    const inner = z.object({ error: z.object({ message: z.string().min(1) }) }).safeParse(parsed);
    if (inner.success) text = inner.data.error.message;
  } catch { /* not JSON: the text itself */ }
  return cutTo(text, MAX_NOTICE_DETAIL).text;
}

/** A `turn/started` or `turn/completed` frame. */
export function takeTurnFrame(params: unknown): TakenTurnFrame | null {
  const frame = TurnFrame.safeParse(params);
  if (!frame.success) return null;
  return { threadId: frame.data.threadId, turnId: frame.data.turn.id, status: takeStatus(frame.data.turn.status), detail: errorDetail(frame.data.turn.error?.message) };
}

export function takeErrorFrame(params: unknown): { readonly threadId: string; readonly turnId: string | null; readonly willRetry: boolean; readonly detail: string | null } | null {
  const frame = ErrorFrame.safeParse(params);
  if (!frame.success) return null;
  return { threadId: frame.data.threadId, turnId: frame.data.turnId, willRetry: frame.data.willRetry === true, detail: errorDetail(frame.data.error?.message) };
}

export function takeStatusFrame(params: unknown): { readonly threadId: string; readonly active: boolean } | null {
  const frame = StatusFrame.safeParse(params);
  return frame.success ? { threadId: frame.data.threadId, active: frame.data.status.type === 'active' } : null;
}

/**
 * A `thread/start`, `thread/resume` or `thread/fork` reply (C20, C21; M22, C4, C7, C65, C70): the
 * thread's id, and the policy it reports, whole — the sandbox as it came, with its type, its word
 * on the network, its other writable roots and its two exclusions of the temporary folders; the
 * approval policy; and the reviewer. Whether that is what was asked for is the session's to say,
 * by its mode (modes.ts). Its `model` and `reasoningEffort` are not read (C45).
 */
export function takeStartReply(reply: unknown): { readonly threadId: string; readonly policy: ReportedPolicy; readonly serviceTier: string | null } | null {
  const parsed = StartReply.safeParse(reply);
  if (!parsed.success) return null;
  const { sandbox, approvalPolicy, approvalsReviewer } = parsed.data;
  // As it came, unknown fields and all: a turn names it again unchanged (C7).
  const raw = sandbox === null || sandbox === undefined ? null : (reply as { sandbox: Record<string, unknown> }).sandbox;
  return {
    threadId: parsed.data.thread.id,
    policy: {
      sandbox: raw,
      sandboxType: sandbox?.type ?? null,
      networkAccess: sandbox?.networkAccess ?? null,
      writableRoots: (sandbox?.writableRoots ?? []).filter((root): root is string => typeof root === 'string'),
      excludeTmpdirEnvVar: sandbox?.excludeTmpdirEnvVar === true,
      excludeSlashTmp: sandbox?.excludeSlashTmp === true,
      approvalPolicy,
      approvalsReviewer: typeof approvalsReviewer === 'string' ? cutTo(approvalsReviewer, 64).text : null,
    },
    // The tier the thread took (decision 0018): a tier the model does not list is dropped to `null`.
    serviceTier: typeof parsed.data.serviceTier === 'string' ? cutTo(parsed.data.serviceTier, 64).text : null,
  };
}

const SteerReply = z.object({ turnId: id });

/** A `turn/steer` reply (M23, C38; K1): the id of the turn the message joined, or null for a reply that is not one. */
export function takeSteerReply(reply: unknown): string | null {
  const parsed = SteerReply.safeParse(reply);
  return parsed.success ? parsed.data.turnId : null;
}

export function takeTurnStartReply(reply: unknown): string | null {
  const parsed = TurnStartReply.safeParse(reply);
  return parsed.success ? parsed.data.turn.id : null;
}

/**
 * A `turn/plan/updated` frame (M20a, C24): whose thread and turn it names, and the whole list of
 * steps as it then reads. Null for a frame that is not one.
 */
export function takePlanFrame(params: unknown): { readonly threadId: string; readonly turnId: string | null; readonly steps: NonNullable<ReturnType<typeof takePlanSteps>> } | null {
  const frame = PlanFrame.safeParse(params);
  const steps = takePlanSteps(params);
  return frame.success && steps !== null ? { threadId: frame.data.threadId, turnId: frame.data.turnId, steps } : null;
}

export interface TakenHistoryTurn {
  readonly images: readonly { readonly itemId: string; readonly image: ReturnedImage }[];
  /** The CLI's id for the turn: the one a live turn's `turn/start` reply named (M18, C47). */
  readonly id: string;
  /** How the CLI says it ended (M18, C51). Null while it runs, and for a status the adapter does not know. */
  readonly status: TurnStatus | null;
  /** Milliseconds since the epoch, from the CLI's seconds. Null when it gives none. */
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly durationMs: number | null;
  /** Its messages, in the CLI's order. */
  readonly items: readonly TakenItem[];
  /** Each message's place among the turn's items, by the same index (M20a, C19). */
  readonly places: readonly number[];
  /** What the turn did between its messages (M20a, C19), each with its place among the turn's items. */
  readonly activities: readonly { readonly place: number; readonly activity: TakenActivity }[];
  /** The plans it wrote (M22b, C28), each with its place among the turn's items. */
  readonly plans: readonly { readonly place: number; readonly id: string; readonly text: string }[];
}

export interface TakenHistoryPage {
  /** Newest first, as the CLI sends them. */
  readonly turns: readonly TakenHistoryTurn[];
  readonly next: string | null;
}

/**
 * A page of the history read (C92; M18, C47, C51; M20a, C19): of each turn, its id, its status and
 * its times; its `userMessage` and `agentMessage` items, in the CLI's order; and its commands, file
 * changes, MCP calls, web searches and reasoning as activities, each with its place among them.
 */
export function takeHistoryPage(reply: unknown): TakenHistoryPage | null {
  const parsed = HistoryPage.safeParse(reply);
  if (!parsed.success) return null;
  const turns = parsed.data.data.map((turn): TakenHistoryTurn => {
    const items: TakenItem[] = [];
    const places: number[] = [];
    const activities: { place: number; activity: TakenActivity }[] = [];
    const images: { itemId: string; image: ReturnedImage }[] = [];
    const plans: { place: number; id: string; text: string }[] = [];
    for (const [place, raw] of (turn.items ?? []).entries()) {
      const item = z.object({ type: z.string().max(64), id }).safeParse(raw);
      if (!item.success) continue;
      if (item.data.type === 'imageGeneration') images.push({ itemId: item.data.id, image: takeReturnedImage(raw) });
      // A plan (M22b, C28): its whole text, as its completion gives it live.
      if (item.data.type === 'plan') {
        const plan = PlanItem.safeParse(raw);
        if (plan.success) plans.push({ place, id: item.data.id, text: plan.data.text });
        continue;
      }
      const message = item.data.type === 'agentMessage' ? takeAgentMessage(item.data.id, raw) : item.data.type === 'userMessage' ? takeUserMessage(item.data.id, raw) : null;
      if (message !== null) { items.push(message); places.push(place); continue; }
      const activity = takeHistoryActivity(item.data.type, item.data.id, raw);
      if (activity !== null) activities.push({ place, activity });
    }
    return { id: turn.id, status: takeStatus(turn.status), startedAt: takeWhole(turn.startedAt, 1000), completedAt: takeWhole(turn.completedAt, 1000), durationMs: takeWhole(turn.durationMs), items, places, activities, plans, images };
  });
  return { turns, next: parsed.data.nextCursor ?? null };
}
