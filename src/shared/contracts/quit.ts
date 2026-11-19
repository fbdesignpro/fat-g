// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The quit question's words (docs/planning/_archive/M14.md, Design 7; C76, C103): the same in the Main page's
// confirmation and in the native message box main opens when the page cannot ask.
import type { SessionEntry } from './sessions';

export interface QuitActivity {
  /** Active replies or sub-agents, excluding a reply only waiting for a plan decision. */
  readonly working: number;
  /** Chats whose saved plan is ready for the user's decision, including idle chats. */
  readonly planReady: number;
}

/** Use the same summary in the page and native fallback; never infer plan state from chat text. */
export function quitActivity(entries: readonly Pick<SessionEntry, 'summary'>[]): QuitActivity {
  let working = 0;
  let planReady = 0;
  for (const { summary } of entries) {
    const ready = summary.attention?.kind === 'plan';
    if (ready) planReady += 1;
    const waitingForPlan = ready && summary.action?.kind === 'plan-ready' && summary.activeWorkers === 0;
    if (summary.status === 'running' && !waitingForPlan) working += 1;
  }
  return { working, planReady };
}

export interface QuitWords {
  readonly title: string;
  readonly body: string;
  readonly confirm: string;
  /** The default button, in both. */
  readonly cancel: string;
}

/** Saved plan decisions survive a restart; active replies and sub-agents stop at quit. */
export function quitWords({ working, planReady }: QuitActivity): QuitWords {
  const parts: string[] = [];
  if (working > 0) parts.push(`${working === 1 ? '1 chat is' : `${working} chats are`} still working. Quitting stops ${working === 1 ? 'its current reply' : 'their current replies'} and any sub-agents.`);
  if (planReady > 0) parts.push(`${planReady === 1 ? '1 chat has a plan' : `${planReady} chats have plans`} ready for review. ${planReady === 1 ? 'Your saved plan will' : 'Your saved plans will'} still be ready for review when you return. Nothing will run automatically.`);
  const body = parts.length === 0 ? 'No chat is still working.' : parts.join('\n\n');
  return { title: 'Quit fat-g?', body, confirm: 'Quit', cancel: 'Cancel' };
}
