// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The CLI's own commands that fat-g answers itself (decision 0023; docs/planning/_archive/M20b.md, Design 3;
// C55–C57): a closed list, beside the launch that leaves the CLI's commands on. A prompt that starts
// with a listed command's name is never sent: main answers it as a turn of its own, in fat-g's
// words, and no model is called. Every other command, and every skill, passes as the user wrote it.
//
// The list holds the commands seen to change what fat-g tracks: `/clear` starts another
// conversation in the same process, `/model` changes the model a session runs on (K19), and `/fast`
// the speed fat-g asks for with each turn (decision 0023). It is
// reviewed with each CLI version the captures record: a command that belongs here and is missing is
// a defect of this list, and of nothing else.
import type { CommandNoticeKind } from '@shared/contracts/conversation';

export interface InterceptedCommand {
  /** The command's name, as the user writes it. */
  readonly name: string;
  /** The notice that answers it. */
  readonly kind: CommandNoticeKind;
}

export const INTERCEPTED_COMMANDS: readonly InterceptedCommand[] = Object.freeze([
  { name: '/clear', kind: 'command-clear' },
  { name: '/model', kind: 'command-model' },
  { name: '/fast', kind: 'command-fast' },
]);

/**
 * The listed command a prompt is, or null. A command is its name at the prompt's very start,
 * followed by the prompt's end or white space, as the CLI reads one: `/clear now` is the command,
 * `/clearance` is not, and a name later in the text is prose.
 */
export function interceptedCommand(prompt: string): CommandNoticeKind | null {
  for (const command of INTERCEPTED_COMMANDS) {
    if (!prompt.startsWith(command.name)) continue;
    const next = prompt.charAt(command.name.length);
    if (next === '' || /\s/.test(next)) return command.kind;
  }
  return null;
}
