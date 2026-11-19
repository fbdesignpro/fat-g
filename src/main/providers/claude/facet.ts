// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Claude's session facet (docs/planning/_archive/M16.md, Design 4, 6, 7; C10, C42, C48–C50; M22.md, Design 2,
// 3, 6; C2, C39, C43, C74, C85): what main asks of Claude's sessions, in session terms. Each session is a conversation on a process of its own,
// in the scope of the instance this adapter was made for; the usage and models-only sessions stay
// what they are, and run beside it.
//
// It has no `history` member, as Claude's descriptor says: fat-g opens no transcript of Claude's,
// and a resumed session sends nothing of its earlier conversation. A Claude chat shows what fat-g
// recorded itself.
//
// Its modes (M22): which of the descriptor's five an account can use, and how a chat's mode changes
// from one to another — on the live process between the three the CLI changes there, by a new
// process otherwise. Both are the mode table's to say (chat-modes.ts), and neither differs by
// account: Claude has no sandbox and no set-up step, so nothing ever changes what `modes` answers.
import type { ProviderContext } from '@shared/provider-kit/context';
import type { Executable } from '@shared/provider-kit/process';
import type { SessionFacet, SessionStart } from '@shared/provider-kit/sessions';
import { PLANS_AVAILABLE } from '@shared/contracts/plans';
import { INTERCEPTED_COMMANDS, interceptedCommand } from './chat-commands';
import { CHAT_TIMINGS, type ChatTimers, type ChatTimings } from './chat-launch';
import { claudeModeAvailability, claudeTransition } from './chat-modes';
import { type ClaudeChatSession, createClaudeChatSession } from './chat-session';
import { runClaudeSecretary } from './secretary';

export interface ClaudeFacetOptions {
  readonly context: ProviderContext;
  /** What the instance's detection found: undefined until it has. */
  readonly executable: () => Executable | undefined;
  readonly argsPrefix: readonly string[];
  /** Fixture overrides; production leaves them out. */
  readonly timings?: Partial<ChatTimings>;
  readonly timers?: ChatTimers;
}

export interface ClaudeFacet extends SessionFacet {
  /** Ends every session's process. The scope would end their trees anyway: this lets each say how it ended. */
  dispose(): Promise<void>;
}

export function createClaudeFacet(options: ClaudeFacetOptions): ClaudeFacet {
  const sessions = new Set<ClaudeChatSession>();
  const timings: ChatTimings = { ...CHAT_TIMINGS, ...options.timings };

  function make(start: SessionStart, reference: string | null): ClaudeChatSession {
    const session = createClaudeChatSession({
      context: options.context, executable: options.executable, argsPrefix: options.argsPrefix, timings,
      // The other folders are main's word (C61): what it checked, at this start or this resume. So is
      // the mode (M22, C2): the id main resolved for the chat, which the session maps to the CLI's
      // own words. The process key is main's alone: nothing here keeps or reads it (C81).
      start: { folder: start.folder, model: start.model, effort: start.effort, speed: start.speed, otherFolders: [...start.otherFolders], mode: start.mode, processKey: start.processKey },
      reference, ...(options.timers === undefined ? {} : { timers: options.timers }),
    });
    sessions.add(session);
    void session.closed.then(() => sessions.delete(session));
    return session;
  }

  return {
    start: (start) => make(start, null),
    resume: (resume) => make(resume, resume.reference),
    // The CLI's commands are on (decision 0023): the few that would change what fat-g tracks are answered by main, and never sent (M20b, C55).
    intercepts: interceptedCommand,
    // fat-g's own two first in the menu (M23, C62); the CLI's own are listed once a process ran (C61).
    interceptedCommands: INTERCEPTED_COMMANDS,
    commandsOnceStarted: true,
    modes: () => claudeModeAvailability(),
    transition: claudeTransition,
    // Nothing changes what an account can use (M22, C43): there is nothing to tell a listener.
    onModesChanged: () => () => undefined,
    // Every account's CLI takes a plan turn under the modes the descriptor lists (M22b, C2, C5): nothing it refuses changes that.
    plans: () => PLANS_AVAILABLE,
    // A process of its own for each request, beside the sessions and the usage reads (M26).
    secretary: (request, signal) => runClaudeSecretary({ context: options.context, executable: options.executable, argsPrefix: options.argsPrefix }, request, signal),
    async dispose() {
      await Promise.all([...sessions].map((session) => session.close()));
    },
  };
}
