// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A request for leave, as a card shows it (docs/planning/_archive/M22.md, Design 4, 5, 7; C8, C9, C21, C22,
// C48, C56, C68, C69; decision 0027): Codex's three approval requests read into the one bounded,
// provider-neutral view every layer above the adapter knows, and a user's choice written as Codex's
// own decision. A function of the request and of the item it names: it holds nothing, and reads no
// file to fill a change.
//
//   a command        its whole invocation, the folder it runs in, the paths Codex read out of it;
//                    a session grant only where its own list of decisions holds one (C68), which K1
//                    never saw
//   a file change    the `fileChange` item's changes, whole, as the session kept them: the request
//                    itself names no file. A session grant where it asks for these files alone,
//                    and none where it asks for a root (C68)
//   an MCP tool      its server and tool, from the `mcpToolCall` item the session placed it on, and
//                    the call's arguments whole, from the request (decision 0018). A session grant
//                    where its persistence offers one, which covers that tool of that server alone
//                    (spikes/codex-mcp); `always`, a rule Codex would keep, is told and never sent
//
// One that cannot be shown whole is refused, never shown cut (C9, C48): no command, no change, a
// change whose item the session does not hold, a path that is none, or a size past a bound — which
// the refusal's notice then names.
//
// What a card may answer is three things, and Codex's decision for each is fixed here (C13, C69):
// `accept`, `acceptForSession`, `decline`, or for an MCP tool the elicitation's `accept`, `accept` with
// the session's persistence, `decline`. Codex's amendment to its own rules, which it would save for
// every project of the account, and an MCP tool's `always` are told as an authority the request
// offers and are never among the choices (C22): nothing here can write them.
import { fileName } from '@shared/contracts/activity';
import type { AgentApprovalRaised } from '@shared/contracts/agent-events';
import { cutTo } from '@shared/contracts/cut';
import { type ApprovalAuthority, type ApprovalChoice, type ApprovalOverBound, approvalOverBound, type ApprovalRequest, ApprovalRequestSchema, MAX_APPROVAL_AUTHORITY, MAX_APPROVAL_REASON, MAX_APPROVAL_SUMMARY, MAX_GRANT_COVERS } from '@shared/contracts/interaction';
import type { RawChange, RawMcpCall, TakenCommandApproval, TakenFileApproval, TakenMcpApproval } from './session-schemas';

/** The CLI's own names for what asks (C8): the three item types. */
const TOOLS = { command: 'commandExecution', 'file-change': 'fileChange', mcp: 'mcpToolCall' } as const;

type Draft = Omit<ApprovalRequest, 'choices' | 'grant' | 'modeThatWouldStop' | 'cut' | 'outside'>;

export type BuiltApproval =
  /** As an `approval-raised` event carries it: within every bound, and never cut. */
  | { readonly ok: true; readonly request: AgentApprovalRaised['request'] }
  /** `over`: the bound it is past, where a size is why; null for one that names no action fat-g can show. */
  | { readonly ok: false; readonly over: ApprovalOverBound | null };

const REFUSED: BuiltApproval = { ok: false, over: null };

const reasonOf = (reason: string | null): string | null => (reason === null || reason.trim() === '' ? null : cutTo(reason, MAX_APPROVAL_REASON).text);
/** One line (C8): the first of the command that holds anything. */
const summaryOf = (text: string): string => cutTo(text.split(/\r?\n/).find((part) => part.trim() !== '') ?? '', MAX_APPROVAL_SUMMARY).text;

/** A session grant's own words, or null where they would not fit whole: a grant is never worded by a cut text. */
const covers = (text: string): { readonly covers: string } | null => (text !== '' && text.length <= MAX_GRANT_COVERS ? { covers: text } : null);

/**
 * The view of one request (C8). `changes`: for a file change, the changes of the item it names as
 * the session kept them, or undefined where it holds none — the request is then refused (C9).
 */
export function buildApproval(taken: TakenCommandApproval | TakenFileApproval, changes: readonly RawChange[] | undefined): BuiltApproval {
  let draft: Draft;
  let grant: { readonly covers: string } | null;
  if (taken.kind === 'command') {
    const { command } = taken;
    // A request that names no command asks for something else — network access — which fat-g does not show.
    if (command === null || command.trim() === '') return REFUSED;
    const authority: ApprovalAuthority[] = taken.authority.slice(0, MAX_APPROVAL_AUTHORITY).map((kind) => ({ kind, mode: null }));
    draft = { kind: 'command', tool: TOOLS.command, summary: summaryOf(command), folder: taken.cwd === null || taken.cwd === '' ? null : taken.cwd, targets: taken.paths, reason: reasonOf(taken.reason), authority, detail: { kind: 'command', command } };
    // Only where its own list holds the session's decision (C68), and by the command itself.
    grant = taken.forSession ? covers(command) : null;
  } else {
    if (changes === undefined || changes.length === 0) return REFUSED;
    const [first] = changes;
    const summary = first === undefined ? '' : changes.length === 1 ? fileName(first.path) : `${fileName(first.path)} and ${String(changes.length - 1)} more`;
    draft = {
      kind: 'file-change', tool: TOOLS['file-change'], summary: cutTo(summary, MAX_APPROVAL_SUMMARY).text, folder: null, targets: changes.map((change) => change.path), reason: reasonOf(taken.reason),
      // A root it asks for is more than these files (C56): said, and no grant is made of it.
      authority: taken.grantRoot ? [{ kind: 'folder', mode: null }] : [],
      // Codex gives a diff, or a new file's content: no change of its is an edit by match.
      detail: { kind: 'changes', changes: changes.map((change) => ({ path: change.path, kind: change.kind, text: change.diff, replace: null, all: null })) },
    };
    // `acceptForSession` covers the files of this change (K1): worded by their paths.
    grant = taken.grantRoot ? null : covers(changes.map((change) => change.path).join(', '));
  }
  return finished(draft, grant);
}

/**
 * The view of Codex's leave to run an MCP tool (decision 0018), on the call the session placed it on:
 * headed by its server and tool as its activity is, its arguments whole as the request has them.
 * One whose arguments cannot be written out is refused.
 */
export function buildMcpApproval(taken: TakenMcpApproval, call: RawMcpCall): BuiltApproval {
  let text: string | undefined;
  try { text = JSON.stringify(taken.params ?? {}, null, 2); } catch { return REFUSED; }
  if (text === undefined) return REFUSED;
  const named = `${call.server}: ${call.tool}`;
  const authority: ApprovalAuthority[] = taken.authority.slice(0, MAX_APPROVAL_AUTHORITY).map((kind) => ({ kind, mode: null }));
  const draft: Draft = { kind: 'tool', tool: TOOLS.mcp, summary: cutTo(named, MAX_APPROVAL_SUMMARY).text, folder: null, targets: [], reason: null, authority, detail: { kind: 'input', text } };
  // Codex's session grant covers that tool of that server, and no other of it (spikes/codex-mcp).
  return finished(draft, taken.forSession ? covers(named) : null);
}

/** A view whole within every bound, with the choices its grant allows, or its refusal. */
function finished(draft: Draft, grant: { readonly covers: string } | null): BuiltApproval {
  const choices: ApprovalChoice[] = grant === null ? ['approve', 'deny'] : ['approve', 'approve-session', 'deny'];
  const over = approvalOverBound({ ...draft, choices });
  if (over !== null) return { ok: false, over };
  const request: ApprovalRequest = { ...draft, outside: false, choices, grant, modeThatWouldStop: null, cut: false };
  // What an event may carry, held here too: one that is not is refused, and never raised malformed.
  const parsed = ApprovalRequestSchema.safeParse(request);
  return parsed.success ? { ok: true, request: parsed.data } : REFUSED;
}

/** A card's choice as Codex's decision (C13, C69): fixed by the choice, whatever the request listed. */
export function decisionOf(choice: ApprovalChoice): { readonly decision: 'accept' | 'acceptForSession' | 'decline' } {
  return { decision: choice === 'approve' ? 'accept' : choice === 'approve-session' ? 'acceptForSession' : 'decline' };
}

/**
 * A card's choice as the answer to Codex's leave to run an MCP tool (decision 0018): `accept` alone
 * for once, with `_meta.persist` `session` for the session's grant, `decline` for a Deny. Never
 * `always`, whatever the request offered.
 */
export function elicitationOf(choice: ApprovalChoice): { readonly action: 'accept' | 'decline'; readonly content: null; readonly _meta: { readonly persist: 'session' } | null } {
  if (choice === 'deny') return { action: 'decline', content: null, _meta: null };
  return { action: 'accept', content: null, _meta: choice === 'approve-session' ? { persist: 'session' } : null };
}
