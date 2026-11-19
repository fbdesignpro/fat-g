// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Codex's five modes (docs/planning/_archive/M22.md, Design 1, 7; C4, C7, C44, C55, C63–C65, C70, C85,
// C93–C96; decision 0027): fat-g's names for them, and the one place the module names Codex's own
// words for a sandbox, an approval policy and a reviewer. tests/architecture/codex-confinement.test.ts
// holds those words to this file.
//
// A mode is a triple a `thread/start`, a `thread/resume` and a `turn/start` name: the sandbox, the
// approval policy, and — where the policy asks someone — who answers (C70). Read only and Berserk
// ask no one and name no reviewer. Only a reply that named the sandbox says which one a thread has
// (K4), so every start and resume names all of its mode's, and each reply is checked against them
// before any prompt goes (C7).
//
//   mode            sandbox              approval policy   reviewer      a reply reports
//   Read only       read-only            never             —             readOnly, no network
//   Ask first       workspace-write      untrusted         user          workspaceWrite — or readOnly, on an
//                                                                        account with no sandbox (C4)
//   Sandbox ok      workspace-write      on-request        user          workspaceWrite
//   Auto reviewed   workspace-write      on-request        auto_review   workspaceWrite
//   Berserk         danger-full-access   never             —             dangerFullAccess
//
// Where a sandbox mode can write is read from the reply and never held as a constant (C65): the
// temporary folders unless it excludes them, any other root it lists, and its word on the network.
// What it reports beyond the folder and the temporary ones is the user's own Codex configuration,
// shown as such and not refused.
//
// Which modes an account can use (C43, C60, C85) is worked out here too, from what its CLI answered
// of its sandbox and what its last checked reply reported: nothing of it is a constant but
// `VALIDATED_MODES`, the modes a capture shows a turn under on this CLI version.
import { MAX_NOTICE_DETAIL } from '@shared/contracts/agent-events';
import { cutTo } from '@shared/contracts/cut';
import type { ModeAvailability, PermissionCapability, PermissionMode, SandboxReadiness, WritablePlaces } from '@shared/contracts/permissions';
import type { PlanCapability } from '@shared/contracts/plans';

export const CODEX_MODE_IDS = ['read-only', 'ask-first', 'sandbox-ok', 'auto-reviewed', 'berserk'] as const;
export type CodexModeId = (typeof CODEX_MODE_IDS)[number];

/** A mode in Codex's own words: what a start names, and what a reply reports for that sandbox. */
export interface CodexPolicy {
  readonly sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** A reply's `sandbox.type` for it. */
  readonly reports: 'readOnly' | 'workspaceWrite' | 'dangerFullAccess';
  readonly approvalPolicy: 'never' | 'untrusted' | 'on-request';
  /** Who answers what asks; null for a policy that asks no one, which names none (C70). */
  readonly approvalsReviewer: 'user' | 'auto_review' | null;
}

export const CODEX_MODES: Readonly<Record<CodexModeId, CodexPolicy>> = Object.freeze({
  'read-only': { sandbox: 'read-only', reports: 'readOnly', approvalPolicy: 'never', approvalsReviewer: null },
  'ask-first': { sandbox: 'workspace-write', reports: 'workspaceWrite', approvalPolicy: 'untrusted', approvalsReviewer: 'user' },
  'sandbox-ok': { sandbox: 'workspace-write', reports: 'workspaceWrite', approvalPolicy: 'on-request', approvalsReviewer: 'user' },
  'auto-reviewed': { sandbox: 'workspace-write', reports: 'workspaceWrite', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' },
  berserk: { sandbox: 'danger-full-access', reports: 'dangerFullAccess', approvalPolicy: 'never', approvalsReviewer: null },
});

/**
 * The modes a capture shows a turn under on this CLI (C85, C94): Read only, Ask first and Sandbox
 * ok by K1's and K6's, Auto reviewed by `m22-codex-auto-review-main` and Berserk by
 * `m22-codex-berserk-main`, both. A start taken with no turn shows none (C93). A mode
 * left out of this list is listed unavailable, as unvalidated, until its capture exists.
 */
export const VALIDATED_MODES: readonly CodexModeId[] = Object.freeze(['read-only', 'ask-first', 'sandbox-ok', 'auto-reviewed', 'berserk']);

/**
 * The modes a capture shows a plan turn under (M22b, C5): all five — Read only by M21's capture
 * (`m21-codex-plan`), the other four by K2 (`m22b-codex-chain`, `-modes`), and again on codex-cli
 * 0.163.0 (K2 run again). A mode left out of it takes no plan turn.
 */
export const PLAN_MODES: readonly CodexModeId[] = Object.freeze(['read-only', 'ask-first', 'sandbox-ok', 'auto-reviewed', 'berserk']);

/** What the descriptor declares of Codex's plan turns (M22b, C2, C5). */
export const CODEX_PLANS: PlanCapability = Object.freeze({
  modes: PLAN_MODES,
  unavailable: 'This mode cannot plan with this version of Codex. Choose another mode to plan.',
});

const mode = (id: CodexModeId, label: string, description: string, asks: boolean): PermissionMode => ({ id, label, description, asks, reading: id === 'read-only', transitionsFrom: [] });

/**
 * What Codex's descriptor declares (C39, C63): the five in fat-g's names, each with one line on
 * what runs without asking, by the evidence (C3, C95, C96). No mode is reached from another on a
 * live process: a thread's policy changes by a checked resume in a fresh process alone (C64). What
 * is said of one account — no sandbox, the places a reply reported, the trust Codex records — is
 * its availability's, worded by the page.
 */
export const CODEX_PERMISSIONS: PermissionCapability = Object.freeze({
  modes: Object.freeze([
    // Named as Claude's is (decision 0027): Codex runs an MCP tool its server marks as safe with no request, under every mode.
    mode('read-only', 'Read only + allowed MCP', 'Reads files and runs nothing that changes them; every request is refused — an MCP tool its server marks as read-only, or as neither destructive nor reaching outside, still runs, and may act', false),
    mode('ask-first', 'Ask first', 'Each command asks before it runs, unless Codex holds it safe or a rule of your own configuration allows it, and so does each file change; an accepted command is held to the project’s folder and the temporary folders, and an accepted file change is written where it names; on Windows, Codex’s sandbox may ask for an administrator’s approval the first time it works in a project’s folder', true),
    mode('sandbox-ok', 'Sandbox ok', 'Changes in the project’s folder and the temporary folders run without asking; a file change outside them asks, and is written there once accepted; a command outside them is stopped by the sandbox; on Windows, Codex’s sandbox may ask for an administrator’s approval the first time it works in a project’s folder', true),
    mode('auto-reviewed', 'Auto reviewed', 'As Sandbox ok, with Codex’s own reviewer answering in your place what would ask, a change outside the folder among it, with no card here; on Windows, Codex’s sandbox may ask for an administrator’s approval the first time it works in a project’s folder', true),
    mode('berserk', 'Berserk', 'Everything runs without asking, outside the folder too: Codex’s Full access', false),
  ]),
  // A chat nothing chose a mode for: Auto reviewed, the maintainer's choice (decision 0027, item 7).
  fallback: 'auto-reviewed',
  // The setup's dialog, where it names Codex's doing and the system's (C60, C72): the vendor's own description of what its setup changes.
  setup: {
    changes: 'By OpenAI’s own description, Codex’s setup creates dedicated sandbox user accounts on this machine, and changes firewall rules and file permissions.',
    approval: 'Windows will ask for an administrator’s approval by itself.',
    waiting: 'Windows may be asking for your approval.',
  },
  inherited: 'Rules of your own Codex configuration act as it lets them, with no card here',
  rules: 'Codex lists its permission profiles and not its rules',
});

export function isCodexMode(value: unknown): value is CodexModeId {
  return typeof value === 'string' && (CODEX_MODE_IDS as readonly string[]).includes(value);
}

/**
 * The mode a session's process runs under, from what main handed its start. Main hands one of the
 * five; none, or an id that is none of them, is Read only, which grants nothing — and which the
 * confirmation then reports, so that main sees it is not the chat's.
 */
export function modeOfStart(given: string | null): CodexModeId {
  return isCodexMode(given) ? given : 'read-only';
}

/** What a `thread/start` and a `thread/resume` name for a mode (C7, C70): the reviewer only where the policy asks someone. */
export function startPolicy(id: CodexModeId): { readonly sandbox: string; readonly approvalPolicy: string; readonly approvalsReviewer?: string } {
  const { sandbox, approvalPolicy, approvalsReviewer } = CODEX_MODES[id];
  return { sandbox, approvalPolicy, ...(approvalsReviewer === null ? {} : { approvalsReviewer }) };
}

/** How many of a reply's other writable roots are kept to be told, and how long each may be: more, or longer, are the reply's still, and are not listed. */
export const MAX_REPORTED_ROOTS = 32;
export const MAX_REPORTED_ROOT = 2_048;

/** A start or resume reply's policy, as it was taken (session-schemas.ts). */
export interface ReportedPolicy {
  /** The reply's `sandbox` object as it came, or null where it gave none: what a turn names again, unchanged (C7). */
  readonly sandbox: Readonly<Record<string, unknown>> | null;
  readonly sandboxType: string | null;
  readonly networkAccess: boolean | null;
  readonly writableRoots: readonly string[];
  readonly excludeTmpdirEnvVar: boolean;
  readonly excludeSlashTmp: boolean;
  /** A string for the three policies fat-g names; anything else is kept only to be said. */
  readonly approvalPolicy: unknown;
  readonly approvalsReviewer: string | null;
}

/** What every `turn/start` of the session's thread names again (C7, C64): the last checked reply's own, and never another. */
export interface TurnPolicy {
  readonly approvalPolicy: unknown;
  readonly sandboxPolicy: Readonly<Record<string, unknown>>;
  readonly approvalsReviewer?: string;
}

export type PolicyCheck =
  /** `unconfined`: Ask first on an account with no sandbox (C4). `places`: where a sandbox mode can write beside the folder, null for a mode with none. */
  | { readonly ok: true; readonly unconfined: boolean; readonly turn: TurnPolicy; readonly places: WritablePlaces | null }
  /** `reported`: what the reply reported instead, in Codex's own words, bounded: a notice's detail. */
  | { readonly ok: false; readonly reported: string };

function reportedWords(reported: ReportedPolicy): string {
  const policy = typeof reported.approvalPolicy === 'string' ? reported.approvalPolicy : cutTo(JSON.stringify(reported.approvalPolicy ?? null), 100).text;
  const sandbox = reported.sandboxType === null ? 'none' : `${reported.sandboxType}${reported.networkAccess === true ? ', networkAccess' : ''}`;
  return cutTo(`sandbox: ${sandbox}; approvalPolicy: ${policy}; approvalsReviewer: ${reported.approvalsReviewer ?? 'none'}`, MAX_NOTICE_DETAIL).text;
}

/** Where a workspace sandbox can write beside the session's folder, as its reply says (C65). */
function placesOf(reported: ReportedPolicy): WritablePlaces {
  const roots = reported.writableRoots.filter((root) => root !== '' && root.length <= MAX_REPORTED_ROOT).slice(0, MAX_REPORTED_ROOTS);
  return { temporary: !(reported.excludeTmpdirEnvVar && reported.excludeSlashTmp), roots, network: reported.networkAccess === true };
}

/**
 * A start or resume reply held to the mode that was named (C4, C7, C46, C70): the policy the mode's,
 * the reviewer the mode's where it named one, the sandbox the mode's. One exception: Ask first
 * takes `readOnly` for its workspace sandbox, as an account with none reports it, and is then
 * unconfined — every write asks, and an accepted one runs outside any sandbox. Read only is held as
 * it always was, to no network access too.
 */
export function checkPolicy(id: CodexModeId, reported: ReportedPolicy): PolicyCheck {
  const wanted = CODEX_MODES[id];
  const refused: PolicyCheck = { ok: false, reported: reportedWords(reported) };
  const { sandbox } = reported;
  if (sandbox === null || reported.approvalPolicy !== wanted.approvalPolicy) return refused;
  if (wanted.approvalsReviewer !== null && reported.approvalsReviewer !== wanted.approvalsReviewer) return refused;
  const unconfined = id === 'ask-first' && reported.sandboxType === CODEX_MODES['read-only'].reports;
  if (reported.sandboxType !== wanted.reports && !unconfined) return refused;
  if (id === 'read-only' && reported.networkAccess !== false) return refused;
  const turn: TurnPolicy = { approvalPolicy: reported.approvalPolicy, sandboxPolicy: sandbox, ...(wanted.approvalsReviewer === null || reported.approvalsReviewer === null ? {} : { approvalsReviewer: reported.approvalsReviewer }) };
  return { ok: true, unconfined, turn, places: reported.sandboxType === CODEX_MODES['ask-first'].reports ? placesOf(reported) : null };
}

/** Whether a reply reports the read-only sandbox for a mode that asked for a workspace one: the account has no sandbox (C4, C60). */
export function reportsNoSandbox(id: CodexModeId, reported: ReportedPolicy): boolean {
  return CODEX_MODES[id].reports === CODEX_MODES['ask-first'].reports && reported.sandboxType === CODEX_MODES['read-only'].reports;
}

/** What an account's checked reply told of a mode, kept for the run (C65). */
export interface CheckedReply {
  readonly unconfined: boolean;
  readonly places: WritablePlaces | null;
}

/** What is known of one account in this run, since its last setup's end (C43, C60, C65, C73). */
export interface AccountPolicy {
  /** This system has Codex's own sandbox setup (C62): Windows. */
  readonly windows: boolean;
  /** What a fresh process last answered of the sandbox; null where none has, and on a system where nothing is asked. */
  readonly readiness: SandboxReadiness | null;
  /** Readiness is still to be known (M23, C89): the two sandbox modes then say `pending`, which a queue waits on. */
  readonly readinessPending?: boolean;
  /** What the account's last reply to a workspace mode showed: true for a workspace sandbox, false for none, null before any. */
  readonly sandboxSeen: boolean | null;
  /** Each mode's last checked reply. */
  readonly checked: ReadonlyMap<CodexModeId, CheckedReply>;
  /** Left out, `VALIDATED_MODES`. */
  readonly validated?: readonly CodexModeId[];
}

/**
 * Whether the account has a sandbox, as far as is known. A reply decides, where one has come (C4);
 * before that, on Windows, what Codex answered of its sandbox; elsewhere nothing is asked and
 * nothing is known until a reply.
 */
function hasSandbox(account: AccountPolicy): boolean | null {
  if (account.sandboxSeen !== null) return account.sandboxSeen;
  if (!account.windows || account.readiness === null) return null;
  return account.readiness === 'ready';
}

/**
 * Which of the five the account can use now, and why not (C43, C51, C60, C85): one entry a mode,
 * the unusable ones listed with their reason.
 *
 * Sandbox ok and Auto reviewed need the sandbox. On Windows they stand unavailable until Codex has
 * answered that it is ready, with the Set up control once it has answered that it is not (C60);
 * elsewhere they stand available and the start reply decides (C62). Ask first is available either
 * way, and says so where the account has none (C4). A start under Berserk, and under a workspace
 * mode on an account with a sandbox, makes Codex record the folder as trusted (C55).
 */
export function availability(account: AccountPolicy): ModeAvailability[] {
  const validated = account.validated ?? VALIDATED_MODES;
  const sandbox = hasSandbox(account);
  const usable = sandbox === true || (sandbox === null && !account.windows);
  return CODEX_MODE_IDS.map((id): ModeAvailability => {
    const none: ModeAvailability = { id, available: true, reason: null, setup: false, records: false, unconfined: false, places: null };
    if (!validated.includes(id)) return { ...none, available: false, reason: 'unvalidated' };
    const places = account.checked.get(id)?.places ?? null;
    switch (id) {
      case 'read-only':
        return none;
      case 'ask-first':
        return { ...none, records: usable, unconfined: sandbox === false, places: sandbox === false ? null : places };
      case 'sandbox-ok':
      case 'auto-reviewed':
        if (usable) return { ...none, records: true, places };
        // Not known yet, and still to be (M23, C89): a reason of its own, which settles into one of the others.
        if (account.windows && sandbox === null && account.readinessPending === true) return { ...none, available: false, reason: 'pending' };
        return { ...none, available: false, reason: 'needs-setup', setup: account.windows && account.readiness !== null && account.readiness !== 'ready' };
      case 'berserk':
        return { ...none, records: true };
    }
  });
}
