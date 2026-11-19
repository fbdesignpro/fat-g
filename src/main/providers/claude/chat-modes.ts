// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Claude's permission modes (decisions 0020, 0027, 0029; docs/planning/_archive/M22.md, Design 1, 6; C3, C5, C39,
// C44, C45, C47, C51, C63, C74, C85, C94, C96, C97; M22b.md, Design 4; C5, C7, C8, C51, C70): the five a chat may have, in fat-g's names, and
// the one place that says what each is in the CLI's own words — the word a launch and a change name,
// the words the CLI's reports use for it, and the tools a session under it is offered.
//
//   fat-g's mode                  the CLI's word        tools
//   Read only + allowed MCP       default               the five that read or ask; every request to act refused
//   Ask first                     default               the five, Bash, Write and Edit, WebFetch and WebSearch
//   Edits ok                      acceptEdits           the ten
//   Auto reviewed                 auto                  the ten
//   Berserk                       bypassPermissions     the ten; at launch alone, and with no other flag
//
// A plan turn (M22b, C1, C7): the CLI's own `plan`, set on the live process for one prompt under the
// chat's mode and set back after it, under every mode that acts — never Read only, whose tool list
// has no `Write` for the model's plan file (C70). Its tool list is the chat's mode's, `ExitPlanMode`
// among it, so the turn's `init` is held to the same list. Coming out of `plan`, and only then, the
// change may name the word the process was launched under, Berserk's included (C7, C51): a change
// never raises a process above its launch.
//
// Read only and Ask first share the CLI's word and differ by the tool list, so a move between them
// is a new process (C45). A change on the live process is the CLI's own, between Ask first, Edits ok
// and Auto reviewed alone (C5); into Berserk and out of it is a new process too, so that no process
// launched able to bypass permissions lives under another mode's name (C74). No flag that bypasses
// permissions is ever passed (C47; decision 0020, item 4): Berserk is the launch's mode argument and
// nothing more, which the installed CLI takes (K2, K5).
//
// No other file of this folder holds one of these words: the launch, the wire and the checks ask
// here (tests/architecture/claude-confinement.test.ts).
import type { ModeAvailability, ModeReason, ModeTransition, PermissionCapability, PermissionMode } from '@shared/contracts/permissions';
import type { PlanCapability } from '@shared/contracts/plans';

/**
 * The built-in tools a reading session is offered, as the launch spells them (M16, C14; M21, C16):
 * none that changes a file, runs a command or reaches the network. Four read, and the fifth asks
 * the user a question, whose answer comes from its card and grants nothing.
 */
export const READING_TOOLS = ['Read', 'Glob', 'Grep', 'Agent', 'AskUserQuestion'] as const;
/** The tool by which the model hands its plan over for the user's decision (M22b, C8, C9). */
export const PLAN_TOOL = 'ExitPlanMode';
/**
 * The two that reach the web through the CLI, under the user's account: a page fetched from this
 * computer, and a search run on the provider's side. Each asks as its mode has it, but the CLI fetches
 * from its own list of documentation sites with no request (Claude Code 2.1.302, read from its build).
 */
export const WEB_TOOLS = ['WebFetch', 'WebSearch'] as const;
/**
 * The same, and the three that act (M22, C5) and the two of the web: each of their uses asks first,
 * as its mode has it. And the plan's tool (M22b, C8), in every mode that takes a plan turn, which all
 * of these do: outside a plan turn its request is refused as any unknown request is.
 */
export const EXECUTION_TOOLS = [...READING_TOOLS, 'Bash', 'Write', 'Edit', ...WEB_TOOLS, PLAN_TOOL] as const;

/**
 * A tool as `init` lists it, where that is another name than the launch's (M16, C67): a launch that
 * asks for `Agent` is told of `Task`. Both are accepted while the name is in the middle of a change.
 */
const REPORTED_AS: Readonly<Record<string, readonly string[]>> = { Agent: ['Task', 'Agent'] };

const reportedTools = (tools: readonly string[]): ReadonlySet<string> => new Set(tools.flatMap((tool) => REPORTED_AS[tool] ?? [tool]));

export const CLAUDE_MODE_IDS = ['read-only', 'ask-first', 'edits-ok', 'auto-reviewed', 'berserk'] as const;
export type ClaudeModeId = (typeof CLAUDE_MODE_IDS)[number];

export interface ClaudeMode {
  readonly id: ClaudeModeId;
  /** The CLI's word for it: what the launch's mode argument and a change name. */
  readonly native: string;
  /** The words the CLI's reports name it by: the reply to `initialize`, a change's reply, a status frame, a turn's `init`. */
  readonly reported: ReadonlySet<string>;
  /** The launch's tool list. */
  readonly tools: readonly string[];
  /** Those tools as `init` lists them (C67). A tool of the user's own configuration is no part of it. */
  readonly reportedTools: ReadonlySet<string>;
  /** Every request to act is refused, as before there were modes (C45). */
  readonly reading: boolean;
  /** The CLI's plan mode, set for one prompt under the chat's mode (M22b, C7): never a chat's own. */
  readonly planning: boolean;
}

/** The launch's own mode, as both reports name it; the CLI's help lists it as `manual` (M16, C21). */
const DEFAULT_WORDS: ReadonlySet<string> = new Set(['default', 'manual']);

function mode(id: ClaudeModeId, native: string, tools: readonly string[], reading = false): ClaudeMode {
  return Object.freeze({ id, native, reported: native === 'default' ? DEFAULT_WORDS : new Set([native]), tools, reportedTools: reportedTools(tools), reading, planning: false });
}

export const CLAUDE_MODES: Readonly<Record<ClaudeModeId, ClaudeMode>> = Object.freeze({
  'read-only': mode('read-only', 'default', READING_TOOLS, true),
  'ask-first': mode('ask-first', 'default', EXECUTION_TOOLS),
  'edits-ok': mode('edits-ok', 'acceptEdits', EXECUTION_TOOLS),
  'auto-reviewed': mode('auto-reviewed', 'auto', EXECUTION_TOOLS),
  berserk: mode('berserk', 'bypassPermissions', EXECUTION_TOOLS),
});

/** The CLI's word for its plan mode (M22b, C7): set before a plan turn's prompt, and set back after it. */
export const PLAN_WORD = 'plan';

/**
 * The chat's mode while a plan turn runs (M22b, C7, C8): its id and its tools, under the CLI's plan
 * word, which every report then names. Never confirmed as a chat's mode: no `in-force` names it.
 */
export function planVariant(of: ClaudeMode): ClaudeMode {
  return Object.freeze({ ...of, native: PLAN_WORD, reported: new Set([PLAN_WORD]), reading: false, planning: true });
}

/** The provider's reading mode (C45): what a start that names no mode, or one this build does not know, runs under. */
export const READING_MODE: ClaudeMode = CLAUDE_MODES['read-only'];

const isModeId = (id: unknown): id is ClaudeModeId => typeof id === 'string' && (CLAUDE_MODE_IDS as readonly string[]).includes(id);

/** The mode a start names. One it does not name, or does not know, is the reading mode: never one that acts. */
export function claudeMode(id: string | null | undefined): ClaudeMode {
  return isModeId(id) ? CLAUDE_MODES[id] : READING_MODE;
}

/** Whether a word one of the CLI's reports gave is this mode's (C5, C7). */
export function reportsMode(of: ClaudeMode, word: unknown): boolean {
  return typeof word === 'string' && of.reported.has(word);
}

/** Whether every built-in tool an `init` lists is one the mode's launch offered (C21, C67); a list that is none cannot be compared, which is a difference too. */
export function reportsTools(of: ClaudeMode, tools: readonly string[] | null): boolean {
  return tools !== null && tools.every((tool) => of.reportedTools.has(tool));
}

/**
 * The modes a change on the live process moves between (C5, C74): the wire's one change of mode
 * names one of these, from another of them, and nothing else — never the reading mode, which is
 * another tool list, and never Berserk, which is a launch's alone.
 */
const SETTABLE: readonly ClaudeModeId[] = ['ask-first', 'edits-ok', 'auto-reviewed'];
/** Their words, for the wire's own check: a change that names any other word is never written. */
export const SETTABLE_WORDS: ReadonlySet<string> = new Set(SETTABLE.map((id) => CLAUDE_MODES[id].native));

/**
 * Whether the wire's one change of mode may name a word (M22, C74; M22b, C7, C51): one of the three
 * words a change between modes names, the plan word, or — coming out of plan mode alone — the word
 * the process was launched under, Berserk's included, which no other change names.
 */
export function mayName(word: string, launch: string | null, restoring: boolean): boolean {
  return SETTABLE_WORDS.has(word) || word === PLAN_WORD || (restoring && launch !== null && word === launch);
}

/** How a chat's mode changes from one id to another (C2, C74): on the live process between the three, by a new process otherwise. */
export function claudeTransition(from: string, to: string): ModeTransition {
  return from !== to && isModeId(from) && isModeId(to) && SETTABLE.includes(from) && SETTABLE.includes(to) ? 'idle' : 'restart';
}

/**
 * fat-g's mode for a word the CLI names in one of its own offers (C8, C56): a session that is asked
 * runs with the tools that act, so the CLI's `default` is Ask first there. Null for a word that is no
 * mode of fat-g's — the CLI has more than these.
 */
export function modeIdOfWord(word: unknown): ClaudeModeId | null {
  if (typeof word !== 'string') return null;
  if (DEFAULT_WORDS.has(word)) return 'ask-first';
  return SETTABLE.concat('berserk').find((id) => CLAUDE_MODES[id].native === word) ?? null;
}

// ── What is exposed (C51, C85, C94) ───────────────────────────────────────────────────────────

/**
 * The modes a capture shows a turn under, on the CLI version the captures are of (C85): Read only +
 * allowed MCP since M16, Ask first and Edits ok by K2 (`m22-approve-once`, `m22-mode-accept-edits`),
 * Auto reviewed and Berserk by K5 (`m22-mode-auto`, `m22-mode-bypass-main`; C94). A
 * mode taken out of it is listed unavailable, as `unvalidated`, until a capture shows it again.
 */
export const VALIDATED_MODES: readonly ClaudeModeId[] = ['read-only', 'ask-first', 'edits-ok', 'auto-reviewed', 'berserk'];

/**
 * The modes the installed CLI takes only with a flag that bypasses permissions, which fat-g never
 * passes (C47): none on 2.1.268, which takes Berserk by the launch's mode argument alone (K2). A
 * mode listed here is unavailable, as `cli-refuses`.
 */
export const FLAG_ONLY_MODES: readonly ClaudeModeId[] = [];

/**
 * The modes a capture shows a plan turn under (M22b, C5): the four that act, by K1
 * (`m22b-plan-ask-first`, `-edits-ok`, `-auto-reviewed`, `-berserk`). Read only takes none: its tool
 * list has no `Write`, so the model cannot save its plan (C70; `m22b-plan-read-only`).
 */
export const PLAN_MODES: readonly ClaudeModeId[] = ['ask-first', 'edits-ok', 'auto-reviewed', 'berserk'];

/** What the descriptor declares of Claude's plan turns (M22b, C2, C5, C70). */
export const CLAUDE_PLANS: PlanCapability = Object.freeze({
  modes: PLAN_MODES,
  unavailable: 'Read only + allowed MCP cannot save a plan. Choose another mode to plan.',
});

/** Why an account cannot use a mode, or null where it can: what the two constants say, the flag's refusal first. */
export function modeReason(id: ClaudeModeId, validated: readonly ClaudeModeId[] = VALIDATED_MODES, flagOnly: readonly ClaudeModeId[] = FLAG_ONLY_MODES): ModeReason | null {
  if (flagOnly.includes(id)) return 'cli-refuses';
  return validated.includes(id) ? null : 'unvalidated';
}

/**
 * What every account can use (C43, C51): one for each declared mode. Claude has no sandbox, no
 * set-up step and records no trust at a start, and nothing here differs by account.
 */
export function claudeModeAvailability(validated: readonly ClaudeModeId[] = VALIDATED_MODES, flagOnly: readonly ClaudeModeId[] = FLAG_ONLY_MODES): ModeAvailability[] {
  return CLAUDE_MODE_IDS.map((id) => {
    const reason = modeReason(id, validated, flagOnly);
    return { id, available: reason === null, reason, setup: false, records: false, unconfined: false, places: null };
  });
}

// ── What the descriptor declares (C3, C39, C63) ───────────────────────────────────────────────

/** The ids a change with no restart reaches a mode from: the other two of the three, and none for the reading mode and Berserk. */
const transitionsFrom = (id: ClaudeModeId): readonly string[] => (SETTABLE.includes(id) ? SETTABLE.filter((other) => other !== id) : []);

const declared = (id: ClaudeModeId, label: string, description: string, asks: boolean): PermissionMode => ({ id, label, description, asks, reading: CLAUDE_MODES[id].reading, transitionsFrom: transitionsFrom(id) });

/**
 * Claude's modes in fat-g's names (C63), each with the one line that says what runs without asking,
 * by what K2 and K5 saw (C3, C96, C97); Berserk's names the CLI's own word for it. No line promises
 * a card before every action: the `inherited` line under the list says what the user's own
 * configuration lets act with none.
 */
export const CLAUDE_PERMISSIONS: PermissionCapability = Object.freeze({
  modes: Object.freeze([
    declared('read-only', 'Read only + allowed MCP', 'Reads and searches your files and asks you; every request to act is refused — the MCP tools your settings allow and your hooks still act', false),
    declared('ask-first', 'Ask first', 'Each command, file change, web search, fetch and other tool asks before it runs, unless a rule of your configuration allows it; Claude fetches its own list of documentation sites without asking', true),
    declared('edits-ok', 'Edits ok', 'File changes run without asking, and so do the commands Claude holds safe and fetches of its documentation sites, for its sub-agents too; other commands, searches and fetches ask', true),
    declared('auto-reviewed', 'Auto reviewed', 'Claude decides by itself what would ask, outside the project’s folders too, for its sub-agents too, with no card here', true),
    declared('berserk', 'Berserk', 'Everything runs without asking, for its sub-agents too: Claude’s Bypass permissions', false),
  ]),
  // A chat nothing chose a mode for: Auto reviewed, the maintainer's choice (decision 0027, item 7).
  fallback: 'auto-reviewed',
  setup: null,
  inherited: 'Rules, allowed MCP tools and hooks of your own configuration act as it lets them, with no card here',
  rules: 'Claude’s rules are not listed by this CLI version',
});
