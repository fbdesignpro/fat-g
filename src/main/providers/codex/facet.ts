// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Codex's session facet (docs/planning/_archive/M15.md, Design 3; C7, C8, C12, C121): what main asks of
// Codex's sessions, in session terms. Each session is a thread on a process of its own, in the
// scope of the instance this adapter was made for; the instance's existing connection runs no
// thread, and reads their earlier messages: the facet's `history` member, which Codex's descriptor
// says it has (docs/planning/_archive/M18.md, Design 1; C6, C25).
//
// What an account's sessions may run under (docs/planning/_archive/M22.md, Design 2, 3, 7; C4, C43, C55, C60,
// C64, C65, C73; decision 0027). `modes` answers, for each of the descriptor's five, whether this
// account can use it now, from two things kept for the run and in memory alone: what a fresh
// process answered of Codex's sandbox, which on Windows is asked when the modes are first listed
// (sandbox.ts), and what the account's start replies reported as each session held one to its mode.
// A setup's end drops both: neither says anything of the account after it. Every change of mode is
// a restart (C64): the process closed, and a checked resume in a fresh one. `sandbox`, Codex's own
// setup, is there on Windows alone; elsewhere nothing is asked, and a start reply decides (C62).
import type { ModeAvailability } from '@shared/contracts/permissions';
import type { ProviderContext } from '@shared/provider-kit/context';
import type { Executable } from '@shared/provider-kit/process';
import type { HistoryAnswer, HistoryFacet, HistoryRequest, SandboxFacet, SessionFacet, SessionStart } from '@shared/provider-kit/sessions';
import { PLANS_AVAILABLE } from '@shared/contracts/plans';
import { availability, type CheckedReply, type CodexModeId, type PolicyCheck, type ReportedPolicy, reportsNoSandbox } from './modes';
import { type CodexSandbox, createCodexSandbox, type SandboxTimings } from './sandbox';
import { runCodexSecretary } from './secretary';
import { type ListedSkill, takeSkills } from './skills';
import { createCodexSession, type CodexSession, type SessionTimers } from './session';
import { SESSION_TIMINGS, type SessionTimings } from './session-process';

export interface CodexFacetOptions {
  readonly context: ProviderContext;
  /** What the instance's detection found: undefined until it has. */
  readonly executable: () => Executable | undefined;
  readonly argsPrefix: readonly string[];
  readonly applicationVersion: string;
  /** Fixture overrides; production leaves them out. */
  readonly timings?: Partial<SessionTimings>;
  readonly timers?: SessionTimers;
  /** The history read over the instance's existing connection, or undefined while there is none. */
  readonly readHistory: (reference: string, page: HistoryRequest, signal: AbortSignal) => Promise<HistoryAnswer> | undefined;
  /** `skills/list` over the instance's existing connection (M23, C63), or undefined while there is none. */
  readonly listSkills?: (folder: string, signal: AbortSignal) => Promise<unknown> | undefined;
  /** The system fat-g runs on: Codex's sandbox setup is Windows' alone (M22, C62). Left out, this process's own. */
  readonly platform?: NodeJS.Platform;
  /** Fixture overrides of the sandbox connection's deadlines. */
  readonly sandboxTimings?: Partial<SandboxTimings>;
}

export interface CodexFacet extends SessionFacet {
  /** Always there: Codex's descriptor says `capabilities.history` (M18, C6). */
  readonly history: HistoryFacet;
  /** Always there: Codex's descriptor declares its modes (M22, C39). */
  readonly modes: () => readonly ModeAvailability[];
  readonly transition: NonNullable<SessionFacet['transition']>;
  readonly onModesChanged: NonNullable<SessionFacet['onModesChanged']>;
  /** The instance's existing connection became ready: earlier messages can be read again (C121), and so can the sandbox's readiness, where a read of it failed (M22, C73). */
  historyAvailable(): void;
  /** Ends every session's process. The scope would end their trees anyway: this lets each say how it ended. */
  dispose(): Promise<void>;
}

const same = (a: CheckedReply | undefined, b: CheckedReply): boolean => a !== undefined && a.unconfined === b.unconfined && JSON.stringify(a.places) === JSON.stringify(b.places);

export function createCodexFacet(options: CodexFacetOptions): CodexFacet {
  const sessions = new Set<CodexSession>();
  const listeners = new Set<() => void>();
  const modeListeners = new Set<() => void>();
  const timings: SessionTimings = { ...SESSION_TIMINGS, ...options.timings };
  const windows = (options.platform ?? process.platform) === 'win32';
  /** What the account's start replies reported in this run, since its last setup's end (C65). */
  const checked = new Map<CodexModeId, CheckedReply>();
  /** What its last reply to a workspace mode showed of a sandbox: null before any. */
  let sandboxSeen: boolean | null = null;
  /** The account's CLI refused what a plan turn needs, in this run (M22b, C13, C80): it plans nothing until fat-g restarts. */
  let plansRefused = false;
  /** What Codex listed last of its skills, by selector (M23, C64, C87): in memory alone, what a dispatch resolves a chosen skill against. */
  let skills: ReadonlyMap<string, ListedSkill> = new Map();

  function modesChanged(): void {
    for (const listener of [...modeListeners]) {
      try { listener(); } catch { /* a listener's failure is its own */ }
    }
  }

  // On Windows alone (C62): elsewhere Codex has no such request, and nothing is asked.
  const sandbox: CodexSandbox | undefined = !windows ? undefined : createCodexSandbox({
    context: options.context, executable: options.executable, argsPrefix: options.argsPrefix, applicationVersion: options.applicationVersion,
    ...(options.sandboxTimings === undefined ? {} : { timings: options.sandboxTimings }),
    onChanged: modesChanged,
    // What the replies said was of the account before the setup (C73): the next start says anew.
    onSetupEnded() { checked.clear(); sandboxSeen = null; },
  });

  /** A session held a start or resume reply to its mode (C4, C65): what the account is now known to have. */
  function onChecked(mode: CodexModeId, reported: ReportedPolicy, check: PolicyCheck): void {
    let changed = false;
    if (check.ok) {
      const reply: CheckedReply = { unconfined: check.unconfined, places: check.places };
      if (!same(checked.get(mode), reply)) { checked.set(mode, reply); changed = true; }
    }
    // A workspace mode's reply says whether the account has a sandbox, taken or not: read-only for a
    // workspace start is an account with none (C4).
    const seen = check.ok ? (check.places !== null ? true : check.unconfined ? false : null) : reportsNoSandbox(mode, reported) ? false : null;
    if (seen !== null && seen !== sandboxSeen) { sandboxSeen = seen; changed = true; }
    if (changed) modesChanged();
  }

  function make(start: SessionStart, reference: string | null): CodexSession {
    const session = createCodexSession({
      context: options.context, executable: options.executable, argsPrefix: options.argsPrefix, applicationVersion: options.applicationVersion,
      // Codex's stable protocol takes one folder (C26): its descriptor says so, main hands it no
      // other (M16, C61), and whatever a caller hands over all the same goes nowhere.
      timings, start: { folder: start.folder, model: start.model, effort: start.effort, speed: start.speed, otherFolders: [], mode: start.mode, processKey: start.processKey }, reference, onChecked, ...(options.timers === undefined ? {} : { timers: options.timers }),
      plansRefused: () => plansRefused,
      // A chosen skill, by its selector, as Codex listed it last (M23, C64): its name and path for the turn's input.
      skillOf: (selector) => skills.get(selector) ?? null,
      onPlansRefused() { if (plansRefused) return; plansRefused = true; modesChanged(); },
    });
    sessions.add(session);
    void session.closed.then(() => sessions.delete(session));
    return session;
  }

  const setup: SandboxFacet | undefined = sandbox === undefined ? undefined : { state: () => sandbox.view(), act: (action) => sandbox.act(action) };

  return {
    start: (start) => make(start, null),
    resume: (resume) => make(resume, resume.reference),
    history: {
      read: (reference, page, signal) => options.readHistory(reference, page, signal) ?? Promise.resolve({ kind: 'failed' }),
      onAvailable(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    // The first listing of a run asks Codex of its sandbox, on Windows (C73): the answer comes as a change.
    modes: () => availability({ windows, readiness: sandbox?.readiness() ?? null, readinessPending: sandbox?.pending() ?? false, sandboxSeen, checked }),
    // A thread's policy is changed in one way alone (C64): the process closed, and a checked resume in a fresh one.
    transition: () => 'restart',
    onModesChanged(listener) {
      modeListeners.add(listener);
      return () => modeListeners.delete(listener);
    },
    // Best effort (M22b, C13, C80): every account plans, until its CLI refuses what a plan turn needs.
    plans: () => (plansRefused ? { available: false, reason: 'cli-refuses' } : PLANS_AVAILABLE),
    ...(setup === undefined ? {} : { sandbox: setup }),
    // What Codex lists of its skills for a folder (M23, C63): asked on the instance's own connection, and held for the dispatch.
    async commands(folder, signal) {
      const reply = await options.listSkills?.(folder, signal);
      const taken = reply == null ? null : takeSkills(reply);
      if (taken === null) return null;
      skills = taken.bySelector;
      return taken.rows;
    },
    // A process of its own for each request, beside the sessions and the instance's connection (M26).
    secretary: (request, signal) => runCodexSecretary({ context: options.context, executable: options.executable, argsPrefix: options.argsPrefix, applicationVersion: options.applicationVersion }, request, signal),
    historyAvailable() {
      sandbox?.retry();
      for (const listener of [...listeners]) {
        try { listener(); } catch { /* a listener's failure is its own */ }
      }
    },
    async dispose() {
      listeners.clear();
      modeListeners.clear();
      await Promise.all([sandbox?.dispose(), ...[...sessions].map((session) => session.close())]);
    },
  };
}
