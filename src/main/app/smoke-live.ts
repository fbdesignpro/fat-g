// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { checkProviderDiscovery } from './smoke-provider-discovery';
// The smoke run's live launches (docs/planning/_archive/M15.md, Design 16; B14, C75–C78, C118; M18.md, Design
// 11; V2; M16.md, Design 9; V20): the app with the demo source off, a Codex session and a Claude
// session run from the Main page, each against its replay fake — never an installed CLI.
// scripts/smoke.mjs launches it twice after the demo launch, with the same data folder and fakes,
// and says which half to run in FATG_SMOKE_LIVE_STAGE:
//
//   first  the live project is added, trusted, offered to both providers. A Codex session is
//          created and sent the saved thread's prompt; the page shows both sides and the capsule
//          reads READY; the prompt traced after it follows, so both turns of the fake's history
//          are fat-g's own; an answer streams as Markdown, part of it shown before it completes,
//          with its code block, that block's Copy button and its table (M19, V21); an answer made
//          hostile is drawn as the text it is; three answers that name a file, whose references open
//          the README and the source file at its line as tabs beside the chat, and an answer whose
//          references lead out: a file outside the project says so and opens nothing, an address
//          reaches the browser's stand-in and never a browser (M19b, V15); what each session did is
//          in its chat as groups: a read's row opens to its output, the file it names opens as a
//          tab, and a worker's row opens the worker's tab, which shows the worker's own work
//          (M20a, V14); T4's prompt is stopped;
//          the session is completed, and its process closes at once. Then a Claude session beside it:
//          T3's prompt, with the user's message, the commentary and the answer on the page; an answer
//          that streams as Markdown and one made hostile, as for Codex (M19, V21); the same three
//          answers, which name their file in a code span, one by a bare name that is looked up in
//          the project's folders (M19b, C55); each session's tabs its own; T4's, stopped; completed,
//          its process gone. Then, on a session of each provider made for it, what a session may do
//          (M22, V11, V12): a Claude command approved once from its card and the file made by the
//          fake, the same command asked again and granted for the session, the next turn running it
//          with no card, the grant ended by a change to Read only and the next turn asking again,
//          Edits ok taken on the live process and Read only by a new one; a Codex chat left blocked
//          by a start the fake refused and changed from the block's remedy, a file change approved
//          on an account with no sandbox and the next one denied, Codex's own setup declined and
//          then approved against the fake, and Sandbox ok chosen and confirmed.
//   next   the two permission sessions first (M22, V11): every card read from the store and drawn
//          inert, every grant ended, and no process started for it.
//          The Codex session is listed; its chat is read from the conversation store before
//          anything is asked of the fake (M18, V2); selected, the page shows it, the Markdown
//          answer and the hostile one drawn from the store as they were (M19, V21), with no session
//          process, and the history check asks for no turn's items; the pane begins with no tab, and
//          a reference in the stored chat opens its file again (M19b, C7); a prompt resumes it in a new
//          process; then T4's prompt. While that turn runs, the Claude session: listed, its chat
//          read from the store and shown with no chat process in the fake's ledger, and resumed
//          by a prompt in a new process. Then the app's own quit while the Codex turn runs,
//          answering M14's question in the page. The script reads what the quit left once the
//          app is gone.
//
// Both halves check that the Pet may read no chat and received no chat push (C76), and that it may
// read no file, show none in its folder and open no address (M19b, V15), and that it may change no
// chat's mode, decide no request to act and start no sandbox setup (M22, C28).
//
// With FATG_SMOKE_VISUAL_DIR, the next half also captures the chat area in both themes for the
// maintainer's review (M15, V25; M16, V22): Codex's conversation with both phases, a reply with
// questions, a notice, and a session's reason in place of the input; then Claude's, at the default
// and the minimum window size, with both phases, a notice and a reason, and the line for earlier
// messages that are not saved. The first half captures the artifact pane for M19b's review (V18):
// a Markdown file, a source file with its line marked, the line of a reference that did not open,
// in both themes and at the minimum window size.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app, type BrowserWindow } from 'electron';
import { CHAT_LINES } from '@shared/contracts/chat';
import { FIRST_INSTANCE_ID } from '@shared/contracts/instances';
import { APPROVAL_WORDS, OUTCOME_WORDS } from '@shared/contracts/interaction';
import { MODE_WORDS } from '@shared/contracts/permissions';
import type { PlanRead } from '@shared/contracts/plans';
import { defaultPreset, presetTiles } from '@shared/contracts/presets';
import type { SessionEntry } from '@shared/contracts/sessions';
import { RECORDS_FILE } from '../records/format';
import { normalizeRoot } from '../records/paths';
import type { PreferencesStore } from '../prefs/store';
import type { RecordsStore, StoredProject } from '../records/store';
import type { SessionService } from '../sessions/service';
import type { AppStateStore } from '../state/app-state-store';
import { pidAlive } from '../process/tree-kill';
import { MAIN_PLACEMENT } from '../windows/placement';
import type { WindowManager } from '../windows/window-manager';
import type { createShutdown } from './shutdown';
import type * as SmokeDialogs from './smoke-dialogs';

export interface LiveSmokeContext {
  readonly windows: WindowManager;
  readonly store: AppStateStore;
  readonly records: RecordsStore;
  readonly sessions: SessionService;
  readonly prefs: PreferencesStore;
  readonly shutdown: ReturnType<typeof createShutdown>;
  /**
   * Deletes the chat fat-g saved for a session while its record stays, as a user's own deletion of
   * the conversation store leaves it. For the visual captures alone: the line for earlier messages.
   */
  readonly removeChat: (sessionId: string) => void;
  /** What main counted of the files read and of the addresses it refused, by kind (M19b, C35, C44). */
  readonly fileCounts: () => Readonly<Record<string, number>>;
  readonly addressCounts: () => Readonly<Record<string, number>>;
  /** What main counted of the reads of a worker's items, by kind (M20a, C34). */
  readonly workerReads: () => Readonly<Record<string, number>>;
  /** What main counted of the asides, by channel and outcome (M20b, C33). */
  readonly asideCounts: () => Readonly<Record<string, number>>;
  /** The stand-ins this run was given, for their counts: the browser's and the file manager's (M19b, V15). */
  readonly dialogs: Pick<typeof SmokeDialogs, 'externalRequests' | 'showInFolderRequests'>;
}

/** The project the live launches use, beside the demo launch's own (Design 16). */
export const LIVE_PROJECT = 'Live project';
/** What the first half leaves for the next, beside the records in this throwaway data folder. */
export const LIVE_MARKER = 'smoke-live.json';
/** The live project is offered to both providers (M16, Design 9). */
const LIVE_PROVIDERS = ['codex', 'claude'];
// The Codex replay starts with no workspace sandbox, which Ask first supports.
const LIVE_MODES = { codex: 'ask-first', claude: 'ask-first' };

const WAIT_MS = 20_000;
const POLL_MS = 50;
const TIMEOUT_MS = 180_000;
/**
 * What no text of a conversation may become on the page (M19, C31–C33): an element that runs, loads
 * or opens something. The chat's list holds none of its own but its speaker bars' avatars (OWN).
 */
const FOREIGN = 'script, img, a, iframe, object, embed, form, input, svg, style, link, video, audio, source, base, meta';
/**
 * Where the chat's list draws images of its own: a speaker bar's avatar, its art from fat-g's media
 * route over its placeholder mark. No text draws a speaker bar: it stands between messages, outside
 * every message's body.
 */
const OWN = '[data-speaker]';
/**
 * The page's chat landmark: the chat window's, or — while the selected session is a draft no turn has
 * run — the new-chat screen's, which holds the same chat area (the maintainer). One of the
 * two stands at a time.
 */
const CHAT_MAIN = ':is(main[aria-label="Chat"], main[data-new-chat-screen])';
/** A question or a plan's feedback can have an earlier textarea: only this is the message composer. */
const COMPOSER_INPUT = `${CHAT_MAIN} textarea[aria-label^="Message to "]`;
/**
 * How many FOREIGN elements the element `list` names in the page holds, its speaker bars apart. A
 * question's card is the one thing of the chat's that has inputs of its own (M21, C47): its radios,
 * its boxes and its secret field, inside a question's group and in no form, are not counted. Any
 * other input is, and so is a form anywhere, a card's included.
 */
const foreignIn = (list: string): string => `[...${list}.querySelectorAll(${JSON.stringify(FOREIGN)})].filter((element) => element.closest(${JSON.stringify(OWN)}) === null && !(element.matches('input') && element.form === null && element.closest('article[data-interaction] fieldset') !== null)).length`;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Prompts {
  readonly saved: string; readonly resume: string; readonly interrupt: string; readonly question: string; readonly basic: string;
  /** M20a: Codex's prompt that starts a worker (T3), for its row and its tab. */
  readonly worker: string;
  /** M19: the prompt whose captured answer streams as Markdown, and the text an answer is replaced with for the hostile message. */
  readonly markdown: string; readonly hostile: string;
  /** Claude's captures' prompts: a worker (T3), an interrupt (T4), a basic turn (T1), and the answer that streams as Markdown (M19). */
  readonly claude: { readonly worker: string; readonly interrupt: string; readonly basic: string; readonly markdown: string; readonly line: string; readonly readme: string; readonly space: string; /** M20b: a command fat-g answers itself, and one that passes to the CLI. */ readonly cleared: string; readonly passed: string };
  /** M19b: the prompts whose captured answers name a file, by what they ask for. */
  readonly files: { readonly line: string; readonly readme: string; readonly space: string };
  /** What an answer is replaced with for the references that lead out, with the marker that finds it; and the files' own first headings. */
  readonly references: { readonly text: string; readonly marker: string };
  readonly headings: { readonly readme: string; readonly log: string };
  /** M20b: a question typed freely beside a session, and its follow-up. */
  readonly asides: { readonly free: string; readonly followUp: string };
  /**
   * M21: the prompts whose turns ask the user — Claude's through its question tool, Codex's in a
   * message, and a second of Codex's with two questions — with the option each capture was answered with.
   */
  readonly questions: { readonly claude: string; readonly claudeOption: string; readonly codex: string; readonly codexOption: string; readonly codexTwo: string };
  /**
   * M22: the prompts whose turns ask leave to act — Claude's command, and the same command asked
   * again; Codex's file, and that file's next change — with the name of the file each approved
   * request makes in the project. A name is conversation content: it is used to look for the file,
   * and never said.
   */
  readonly approvals: { readonly claude: string; readonly claudeAgain: string; readonly claudeMade: string; readonly codex: string; readonly codexAgain: string; readonly codexMade: string };
  /** M22b: a plan turn's prompt for each fake — Codex's any, since its fake plans under the chat's policy; Claude's its capture's. */
  readonly plans: { readonly codex: string; readonly claude: string };
}
interface Thread {
  readonly cwd: string | null; readonly turns: readonly string[]; readonly interrupts: readonly { readonly inputOpen: boolean }[]; readonly launches: readonly { readonly pid: number }[];
  /** Each history request the fake was sent for the thread: which view of a turn it asked for. */
  readonly historyReads?: readonly { readonly view: string }[];
  /** Each fork the fake was sent for the thread, and each question sent to a side thread of it (M20b). */
  readonly forks?: readonly unknown[]; readonly asides?: readonly unknown[];
  /** Each start and resume of the thread, each reply fat-g gave a request of its turns, and each change the fake made in its project for an accepted one (M22). */
  readonly opens?: readonly unknown[]; readonly replies?: readonly unknown[]; readonly changes?: readonly { readonly file: string; readonly kind: string }[];
}
/** A Claude session as its fake's session file has it. */
interface ChatSession {
  readonly cwd: string | null; readonly turns: readonly string[]; readonly interrupts: readonly unknown[];
  /** `tools` (M22): the tools the launch named. */
  readonly launches: readonly { readonly pid: number; readonly resume: string | null; readonly addDirs: readonly string[]; readonly tools?: readonly string[] }[];
  /** Each side question it was sent, with the history it carried (M20b). */
  readonly sides?: readonly { readonly history: unknown; readonly turn: boolean }[];
  /** Each answer fat-g gave a request of the CLI's: how it answered, and for an `allow` what it sent back (M21), with the permissions a session grant carried (M22). */
  readonly answers?: readonly { readonly behavior: string | null; readonly updatedInput?: { readonly answers?: Record<string, string> }; readonly updatedPermissions?: readonly unknown[] }[];
  /** Each change of mode it was sent on a live process, the session rules it recorded, and the paths it made or changed in its project (M22). */
  readonly modes?: readonly { readonly turn: boolean; readonly answered: string }[]; readonly grants?: readonly unknown[]; readonly writes?: readonly string[];
}
/** A permission session as the first half leaves it for the next (M22): its mode, each of its cards' outcomes in order, and how many grants it was sent. */
interface Permitted { readonly session: string; readonly reference: string; readonly mode: string; readonly approvals: readonly string[]; readonly grants: number }
/** A review as the first half leaves it for the next (M22e): its id, its reviewer, how many rounds it had, its marks and notes, and how it closed. */
interface Reviewed { readonly reviewId: string; readonly reviewer: string; readonly rounds: number; readonly marks: Readonly<Record<string, string>>; readonly notes: Readonly<Record<string, string>>; readonly closed: string | null; readonly integrated: boolean }
interface Left {
  session?: string; reference?: string | null; launches?: number;
  claude?: { session: string; reference: string; launches: number; chatProcesses: number };
  permissions?: { claude: Permitted; codex: Permitted };
  reviews?: { codex: Reviewed; claude: Reviewed };
}

function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, 'utf8')) as unknown; } catch { return null; }
}

export function runLiveSmoke({ windows, store, records, sessions, prefs, shutdown, removeChat, fileCounts, addressCounts, workerReads, asideCounts, dialogs }: LiveSmokeContext): void {
  const problems: string[] = [];
  const report: Record<string, unknown> = {};
  const stage = process.env['FATG_SMOKE_LIVE_STAGE'] === 'next' ? 'next' : 'first';
  const prompts = readJson(process.env['FATG_SMOKE_LIVE_PROMPTS'] ?? '') as Prompts | null;
  const threadsFile = process.env['FATG_SMOKE_CODEX_THREADS'];
  const chatSessionsFile = process.env['FATG_SMOKE_CLAUDE_SESSIONS'];
  const claudeDirectory = process.env['FATG_SMOKE_CLAUDE_DIR'];
  const folder = process.env['FATG_SMOKE_PICK_FOLDER'];
  const marker = path.join(app.getPath('userData'), LIVE_MARKER);
  let finished = false;
  let quitting = false;

  const finish = (): void => {
    if (finished) return;
    finished = true;
    console.log(`[smoke] ${JSON.stringify({ live: stage, ok: problems.length === 0, ...report, problems })}`);
    if (problems.length > 0) void shutdown.cleanup().then(() => app.exit(1));
  };

  async function waitFor(what: string, condition: () => boolean | Promise<boolean>, timeoutMs = WAIT_MS): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try { if (await condition()) return true; } catch { /* not yet */ }
      if (Date.now() > deadline) { problems.push(`timed out waiting for ${what}`); return false; }
      await delay(POLL_MS);
    }
  }

  const threads = (): Record<string, Thread> => (readJson(threadsFile ?? '') as { threads?: Record<string, Thread> } | null)?.threads ?? {};
  const chatSessions = (): Record<string, ChatSession> => (readJson(chatSessionsFile ?? '') as { sessions?: Record<string, ChatSession> } | null)?.sessions ?? {};
  /** The chat processes Claude's fake recorded in its ledger, "<pid> <role> <started>" a line. */
  const chatProcesses = (): number[] => {
    try {
      return readFileSync(path.join(claudeDirectory ?? '', 'pids'), 'utf8').split(/\r?\n/).map((line) => line.split(' ')).filter((parts) => parts[1] === 'chat').map((parts) => Number(parts[0]));
    } catch { return []; }
  };
  /**
   * A fixture's process, by its PID and its own start time, as its fake's ledger has it. Windows
   * gives a PID again within one run, so a PID alone does not say which process it was: the ledger's
   * last line for a PID is the process that holds it, read while that process runs. `started` is
   * null where the ledger has no such line.
   */
  interface Fixture { readonly pid: number; readonly started: string | null }
  const ledgerLines = (file: string | undefined): string[][] => {
    try { return readFileSync(file ?? '', 'utf8').split(/\r?\n/).filter((line) => line !== '').map((line) => line.split(' ')); } catch { return []; }
  };
  /** Each fake's ledger, and the file its processes record their own end in ("<pid> <started>"): Claude's in its folder, Codex's by the path the run names. */
  const ledgers = {
    Claude: { started: () => path.join(claudeDirectory ?? '', 'pids'), ended: () => path.join(claudeDirectory ?? '', 'exited') },
    Codex: { started: () => process.env['FATG_SMOKE_PIDS'], ended: () => (process.env['FATG_SMOKE_PIDS'] === undefined ? undefined : `${process.env['FATG_SMOKE_PIDS']}.exited`) },
  };
  const fixtureOf = (who: 'Codex' | 'Claude', pid: number): Fixture => ({ pid, started: ledgerLines(ledgers[who].started()).filter((parts) => Number(parts[0]) === pid).at(-1)?.at(-1) ?? null });
  /** That process is over: its PID is no longer alive, or — where another process may hold the PID by now — it recorded its own end. */
  const fixtureGone = (who: 'Codex' | 'Claude', fixture: Fixture): boolean =>
    fixture.pid > 0 && (!pidAlive(fixture.pid) || (fixture.started !== null && ledgerLines(ledgers[who].ended()).some((parts) => Number(parts[0]) === fixture.pid && parts[1] === fixture.started)));
  const onDisk = (id: string) => (readJson(path.join(app.getPath('userData'), RECORDS_FILE)) as { sessions?: Record<string, unknown>[] } | null)?.sessions?.find((entry) => entry['id'] === id);
  const entryOf = (id: string): SessionEntry | undefined => sessions.snapshot().sessions.find((entry) => entry.record.id === id);
  const ask = async (main: BrowserWindow, channel: string, request: unknown): Promise<{ ok: boolean; value?: Record<string, unknown>; error?: string }> =>
    (await main.webContents.executeJavaScript(`window.fatg.invoke(${JSON.stringify(channel)}, ${JSON.stringify(request)}).catch(() => ({ ok: false, error: 'failed' }))`)) as never;

  /**
   * The chat as the Main page shows it: each message's label — its accessible name, whether or not
   * it draws one, a speaker bar naming its run — and its text, its first paragraph past its head.
   */
  const shown = async (main: BrowserWindow): Promise<{ label: string; phase: string | null; text: string }[]> =>
    (await main.webContents.executeJavaScript(`[...document.querySelectorAll('${CHAT_MAIN} [data-chat-list] article:not([data-role="activity"])')].map((article) => ({
      label: article.getAttribute('aria-label') ?? '', phase: article.getAttribute('data-phase'), text: [...article.querySelectorAll('p')].find((paragraph) => paragraph.closest('[data-head]') === null)?.textContent ?? '',
    }))`)) as never;

  /**
   * Types into the Main page's composer and presses its button, as the user would. Not before the
   * page shows that session as the selected one: until then the composer is another session's. Its
   * chat says so: a session never prompted has no capsule until something is typed (M26, round 2).
   */
  const typeAndSend = (main: BrowserWindow, id: string, text: string): Promise<boolean> =>
    main.webContents.executeJavaScript(`(() => {
      const shown = (document.querySelector('[data-chat-session="' + ${JSON.stringify(id)} + '"]') !== null || [...document.querySelectorAll('[data-selected]')].some((element) => element.getAttribute('data-session-id') === ${JSON.stringify(id)} || element.getAttribute('data-thin-session') === ${JSON.stringify(id)}));
      if (!shown) return false;
      const area = document.querySelector(${JSON.stringify(COMPOSER_INPUT)});
      if (area === null) return false;
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      set.call(area, ${JSON.stringify(text)});
      area.dispatchEvent(new Event('input', { bubbles: true }));
      const button = [...document.querySelectorAll('${CHAT_MAIN} button')].find((element) => element.textContent === 'Send');
      if (button === undefined || button.disabled) return false;
      button.click();
      return true;
    })()`) as Promise<boolean>;
  /** Why the composer took nothing: whether the session is the shown one, the text area, and the buttons the chat holds. */
  const composerState = (main: BrowserWindow, id: string): Promise<unknown> =>
    main.webContents.executeJavaScript(`(() => ({
      shown: (document.querySelector('[data-chat-session="' + ${JSON.stringify(id)} + '"]') !== null || [...document.querySelectorAll('[data-selected]')].some((element) => element.getAttribute('data-session-id') === ${JSON.stringify(id)} || element.getAttribute('data-thin-session') === ${JSON.stringify(id)})),
      area: document.querySelector(${JSON.stringify(COMPOSER_INPUT)}) !== null,
      fields: [...document.querySelectorAll('${CHAT_MAIN} textarea')].map((area) => ({ message: area.matches('[aria-label^="Message to "]'), plan: area.closest('[data-plan-panel]') !== null, question: area.closest('[data-kind="question"]') !== null, disabled: area.disabled, readOnly: area.readOnly })),
      primary: [...document.querySelectorAll('${CHAT_MAIN} button[data-primary]')].map((button) => ({ send: button.textContent === 'Send', plan: button.textContent === 'Plan', disabled: button.disabled })),
      session: ${JSON.stringify({ status: entryOf(id)?.summary.status ?? null, block: entryOf(id)?.block ?? null, attention: entryOf(id)?.summary.attention?.kind ?? null })},
      buttons: [...document.querySelectorAll('${CHAT_MAIN} button')].slice(0, 30).map((element) => (element.textContent ?? '').slice(0, 24) + (element.disabled ? ' (disabled)' : '')),
      chat: document.querySelector('${CHAT_MAIN}') !== null,
      selected: [...document.querySelectorAll('[data-selected]')].map((element) => element.getAttribute('data-session-id') ?? element.getAttribute('data-thin-session') ?? element.getAttribute('data-detached-chat') ?? element.tagName),
      listed: [...document.querySelectorAll('[data-session-id], [data-thin-session]')].map((element) => element.getAttribute('data-session-id') ?? element.getAttribute('data-thin-session')),
      wanted: ${JSON.stringify(id)},
    }))()`) as Promise<unknown>;
  const press = (main: BrowserWindow, label: string): Promise<boolean> =>
    main.webContents.executeJavaScript(`(() => {
      const button = [...document.querySelectorAll('${CHAT_MAIN} button')].find((element) => element.textContent === ${JSON.stringify(label)});
      button?.click();
      return button !== undefined;
    })()`) as Promise<boolean>;

  /** Sends a prompt from the page once the session can take one, and waits until it is running or has run. */
  async function send(main: BrowserWindow, id: string, prompt: string, what: string): Promise<boolean> {
    const before = (onDisk(id)?.['lastTurn'] as { startedAt?: number } | null)?.startedAt ?? 0;
    if (!(await waitFor(`the composer to take ${what}`, () => typeAndSend(main, id, prompt)))) {
      problems.push(`live: the composer stood as ${JSON.stringify(await composerState(main, id))}, main selecting ${String(sessions.snapshot().selectedId)}`);
      return false;
    }
    if (await waitFor(`${what} to be accepted`, () => entryOf(id)?.summary.status === 'running' || ((onDisk(id)?.['lastTurn'] as { startedAt?: number } | null)?.startedAt ?? 0) > before)) return true;
    // Why not: what the same Send is answered now, which is a status and a reason's kind.
    const answer = await ask(main, 'chat:send', { sessionId: id, prompt });
    problems.push(`live: ${what} is answered ${JSON.stringify(answer.value ?? answer.error ?? null)}`);
    return false;
  }
  const ended = (id: string, what: string, timeoutMs = WAIT_MS) => waitFor(`${what} to end`, () => entryOf(id)?.summary.status === 'idle' && ((onDisk(id)?.['lastTurn'] as { endedAt?: number | null } | null)?.endedAt ?? null) !== null, timeoutMs);

  /** C76: the Pet reads no chat, of either provider's session, and none was pushed to it. M19b: nor a file, a folder or an address. */
  async function checkPet(pet: BrowserWindow, ids: readonly string[]): Promise<void> {
    const refusedForPet: unknown[] = [];
    for (const [channel, request] of [
      ['files:read', { sessionId: ids[0] ?? '', target: 'README.md' }],
      ['files:showInFolder', { sessionId: ids[0] ?? '', path: path.join(folder ?? '', 'README.md') }],
      ['files:locate', { sessionId: ids[0] ?? '', target: 'README.md' }],
      ['files:openFolder', { sessionId: ids[0] ?? '', target: '.' }],
      ['shell:openAddress', { address: 'https://example.invalid/' }],
      // M20b (C33): nor anything of a question asked beside a session.
      ['chat:ask', { sessionId: ids[0] ?? '', asideId: ids[0] ?? '', text: 'a question' }],
      ['chat:readAside', { sessionId: ids[0] ?? '', asideId: ids[0] ?? '' }],
      ['chat:stopAside', { sessionId: ids[0] ?? '', asideId: ids[0] ?? '' }],
      ['chat:removeAside', { sessionId: ids[0] ?? '', asideId: ids[0] ?? '' }],
      // M21 (C31, C34): nor an answer to a question a session asks, or its dismissal.
      ['chat:answer', { sessionId: ids[0] ?? '', itemId: ids[0] ?? '', answers: [{ question: 0, options: [0], text: null }] }],
      ['chat:dismiss', { sessionId: ids[0] ?? '', itemId: ids[0] ?? '' }],
      // M22 (C28): nor a chat's mode, a decision on a request to act, or an account's sandbox setup.
      ['chat:setMode', { sessionId: ids[0] ?? '', mode: 'read-only' }],
      ['chat:decide', { sessionId: ids[0] ?? '', itemId: ids[0] ?? '', choice: 'approve' }],
      ['instances:setupSandbox', { providerId: 'codex', instanceId: FIRST_INSTANCE_ID, action: 'start' }],
      ['files:refresh', { sessionId: ids[0] ?? '', path: path.join(folder ?? '', 'README.md'), revision: null }],
    ] as const) {
      const answer = (await pet.webContents.executeJavaScript(`window.fatg.invoke(${JSON.stringify(channel)}, ${JSON.stringify(request)}).then((r) => r.ok ? 'ok' : r.error, () => 'failed')`)) as unknown;
      if (answer !== 'forbidden') problems.push(`pet: ${channel} answered ${String(answer)}, expected forbidden`);
      refusedForPet.push(answer);
    }
    const reads: unknown[] = [];
    for (const id of ids) {
      const read = (await pet.webContents.executeJavaScript(`window.fatg.invoke('chat:read', { sessionId: ${JSON.stringify(id)} }).then((r) => r.ok ? 'ok' : r.error, () => 'failed')`)) as unknown;
      if (read !== 'forbidden') problems.push(`pet: chat:read answered ${String(read)}, expected forbidden`);
      reads.push(read);
    }
    const pushes = (await pet.webContents.executeJavaScript('window.__fatgChatPushes ?? -1')) as number;
    if (pushes !== 0) problems.push(`pet: received ${pushes} chat:message push(es)`);
    report['pet'] = { chatRead: reads, pushes, files: refusedForPet };
  }

  /** How much of the message that is being written the page shows: -1 when none is. */
  const writing = (main: BrowserWindow): Promise<number> =>
    main.webContents.executeJavaScript(`(() => {
      const article = document.querySelector('${CHAT_MAIN} [data-chat-list] article[data-state="streaming"]');
      return article === null ? -1 : (article.children[1]?.textContent ?? '').length;
    })()`) as Promise<number>;

  interface Drawn {
    readonly state: string | null; readonly units: number; readonly headings: number; readonly code: number; readonly copyCode: number; readonly copyMessage: number; readonly copyAnswer: number; readonly rows: number;
    /** Whether its text shows the markup a hostile answer is made of, as text. */
    readonly markup: boolean;
    /** In the whole list: messages still being written, elements no text may become, and attributes that run or load something. */
    readonly streaming: number; readonly foreign: number; readonly active: number;
    readonly title: string; readonly pageShown: boolean;
  }
  /** The chat's assistant message that `pick` finds, as the page draws it, with what the whole list holds that it must not. */
  const drawn = (main: BrowserWindow, pick: 'last' | 'with-code' | 'with-markup'): Promise<Drawn | null> =>
    main.webContents.executeJavaScript(`(() => {
      const list = document.querySelector('${CHAT_MAIN} [data-chat-list]');
      if (list === null) return null;
      const answers = [...list.querySelectorAll('article[data-role="assistant"]')];
      const body = (article) => article.children[1]?.textContent ?? '';
      const pick = ${JSON.stringify(pick)};
      const article = pick === 'last' ? answers.at(-1) : pick === 'with-code' ? answers.find((entry) => entry.querySelector('pre code') !== null) : answers.find((entry) => body(entry).includes('<script>'));
      if (article === undefined) return null;
      const named = (label) => [...article.querySelectorAll('button')].filter((button) => button.getAttribute('aria-label') === label).length;
      // Its answer's foot, after its last entry and before the next speaker's bar: the Copy button for all of its text.
      const foot = (() => { for (let at = article.nextElementSibling; at !== null; at = at.nextElementSibling) { if (at.hasAttribute('data-run-foot')) return at; if (at.hasAttribute('data-speaker')) return null; } return null; })();
      return {
        state: article.getAttribute('data-state'), units: body(article).length, headings: article.querySelectorAll('h1, h2, h3').length,
        code: article.querySelectorAll('pre code').length, copyCode: named('Copy code'), copyMessage: named(${JSON.stringify(CHAT_LINES.copyPart)}), copyAnswer: foot === null ? 0 : [...foot.querySelectorAll('button')].filter((button) => button.getAttribute('aria-label') === ${JSON.stringify(CHAT_LINES.copyAnswer)}).length, rows: article.querySelectorAll('tbody tr').length,
        markup: body(article).includes('<script>') && body(article).includes('javascript:') && body(article).includes('<img '),
        streaming: list.querySelectorAll('article[data-state="streaming"]').length,
        foreign: ${foreignIn('list')},
        active: [...list.querySelectorAll('*')].filter((element) => element.closest(${JSON.stringify(OWN)}) === null && [...element.attributes].some((attribute) => /^on/i.test(attribute.name) || ['href', 'src', 'srcset', 'action', 'formaction', 'srcdoc'].includes(attribute.name))).length,
        title: document.title, pageShown: getComputedStyle(document.body).display !== 'none',
      };
    })()`) as Promise<Drawn | null>;
  /** Nothing a text asked for is on the page: no element of FOREIGN, no attribute that runs or loads, the title and the page as they were. */
  const inert = (what: string, found: Drawn): void => {
    if (found.foreign !== 0 || found.active !== 0) problems.push(`live: ${what}: the chat's list holds ${found.foreign} element(s) and ${found.active} attribute(s) a text may not become`);
    if (found.title.includes('pwned') || !found.pageShown) problems.push(`live: ${what}: a text changed the page`);
  };

  /**
   * M19 (V21; C7, C9, C28): an answer that streams. Part of it shows before it completes, and it
   * grows; complete, it is Markdown — headings, a code block with its Copy button, a table.
   */
  async function streamedAnswer(main: BrowserWindow, id: string, prompt: string, who: 'Codex' | 'Claude'): Promise<boolean> {
    if (!(await send(main, id, prompt, `${who}’s Markdown prompt`))) return false;
    let first = 0;
    let later = 0;
    if (!(await waitFor('part of the answer to show before it completes', async () => { first = await writing(main); return first > 0; }))) return false;
    await waitFor('the answer to grow as it is written', async () => { later = await writing(main); return later > first || later === -1; });
    if (later <= first) problems.push(`live: ${who}’s answer completed before the page showed it growing`);
    if (!(await ended(id, `${who}’s Markdown turn`, 90_000))) return false;
    await waitFor('the page to show the answer complete', async () => (await drawn(main, 'last'))?.state === 'complete');
    const found = await drawn(main, 'last');
    if (found === null) { problems.push(`live: the page shows no answer to ${who}’s Markdown prompt`); return false; }
    if (found.state !== 'complete' || found.streaming !== 0) problems.push(`live: ${who}’s Markdown answer reads ${String(found.state)} after its turn, with ${found.streaming} message(s) still being written`);
    if (found.units <= later) problems.push(`live: ${who}’s complete answer is no longer than the part shown while it was written`);
    if (found.headings < 2 || found.code < 1 || found.rows < 10) problems.push(`live: ${who}’s Markdown answer is drawn with ${found.headings} heading(s), ${found.code} code block(s) and ${found.rows} table row(s)`);
    // A part has a Copy button of its own only where its answer has more than one (the maintainer); the answer's foot always has one.
    if (found.copyCode !== found.code || found.copyMessage > 1 || found.copyAnswer !== 1) problems.push(`live: ${who}’s Markdown answer has ${found.copyCode} Copy button(s) for ${found.code} code block(s), ${found.copyMessage} for its part and ${found.copyAnswer} at its answer's foot`);
    inert(`${who}’s Markdown answer`, found);
    report[who === 'Codex' ? 'streamed' : 'claudeStreamed'] = { shownWhileWritten: first, then: later, complete: found.units, headings: found.headings, codeBlocks: found.code, copyCode: found.copyCode, tableRows: found.rows };
    return true;
  }

  /**
   * M19 (V21; C28, C31–C33): an answer made of everything a text could ask the page for. It is
   * drawn as the text it is; the violations counted at the half's end stay at zero.
   */
  async function hostileAnswer(main: BrowserWindow, id: string, prompt: string, who: 'Codex' | 'Claude'): Promise<boolean> {
    // Each fake's own control file: the answer of the turn it replays next is the text given.
    const control = who === 'Codex' ? process.env['FATG_SMOKE_CODEX_CONTROL'] : claudeDirectory === undefined ? undefined : path.join(claudeDirectory, 'control.json');
    if (prompts === null || control === undefined) { problems.push('live: the fake’s control file is not named'); return false; }
    writeFileSync(control, JSON.stringify({ answerText: prompts.hostile }));
    const ran = await send(main, id, prompt, `${who}’s prompt answered with the hostile text`) && await ended(id, `${who}’s hostile turn`);
    writeFileSync(control, '{}');
    if (!ran) return false;
    await waitFor('the page to show the hostile answer', async () => (await drawn(main, 'with-markup'))?.state === 'complete');
    const found = await drawn(main, 'with-markup');
    if (found === null || !found.markup) { problems.push(`live: the page does not show ${who}’s hostile answer as text`); return false; }
    inert(`${who}’s hostile answer`, found);
    // Counts alone: nothing of its text is said here.
    report[who === 'Codex' ? 'hostile' : 'claudeHostile'] = { shownAsText: found.markup, foreignElements: found.foreign, activeAttributes: found.active, pageChanged: found.title.includes('pwned') || !found.pageShown };
    return true;
  }

  // ── M19b: a reference in an answer, and the artifact pane (V15) ──────────────────────────────

  interface Pane {
    /** Each tab's title, in order, and the selected one's. */
    readonly tabs: readonly string[]; readonly selected: string | null;
    /** The selected tab's body: its first heading, view, marked line, and full path in the folder tooltip. */
    readonly heading: string | null; readonly view: string | null; readonly outcome: string | null; readonly marked: string | null; readonly path: string | null;
    /** In the whole region: elements no file's text may become, and attributes that run or load something. */
    readonly foreign: number; readonly active: number;
  }
  /** The artifact region as the Main page shows it. */
  const pane = (main: BrowserWindow): Promise<Pane> =>
    main.webContents.executeJavaScript(`(() => {
      const region = document.querySelector('section[aria-label="Artifacts"]');
      const panel = region?.querySelector('[role="tabpanel"]') ?? null;
      const content = panel?.querySelector('[data-source-kind="file"]') ?? null;
      const folderButton = panel?.querySelector('button[aria-label="Show in folder"]');
      const folderTip = document.getElementById(folderButton?.getAttribute('aria-describedby') ?? '');
      const title = (tab) => tab?.querySelector('[data-tab-title]')?.textContent ?? '';
      return {
        tabs: [...(region?.querySelectorAll('[role="tab"]') ?? [])].map(title),
        selected: region?.querySelector('[role="tab"][aria-selected="true"]') ? title(region.querySelector('[role="tab"][aria-selected="true"]')) : null,
        heading: panel?.querySelector('h1')?.textContent ?? null,
        view: panel?.querySelector('[data-file-view]')?.getAttribute('data-file-view') ?? null,
        outcome: panel?.querySelector('[data-file-outcome]')?.getAttribute('data-file-outcome') ?? null,
        marked: panel?.querySelector('[data-line-mark]')?.textContent ?? null,
        path: folderTip?.firstElementChild?.textContent ?? null,
        foreign: content?.querySelectorAll(${JSON.stringify(FOREIGN)}).length ?? 0,
        active: [...(content?.querySelectorAll('*') ?? [])].filter((element) => [...element.attributes].some((attribute) => /^on/i.test(attribute.name) || ['href', 'src', 'srcset', 'action', 'formaction', 'srcdoc'].includes(attribute.name))).length,
      };
    })()`) as Promise<Pane>;

  interface References {
    /** Each control of the answer: what it is, and its text. */
    readonly controls: readonly { readonly kind: string; readonly text: string }[];
    /** What a control says beside itself, for a moment, when it did not open. */
    readonly said: readonly string[];
    /** The answer's text as a selection of all of it reads: what a copy would take. */
    readonly selected: string;
  }
  /** The reference controls of the chat's assistant message that holds `needle`, the last one unless said; `press` presses the one at that place. */
  const references = (main: BrowserWindow, needle: string | null, press: number | null = null): Promise<References | null> =>
    main.webContents.executeJavaScript(`(() => {
      const answers = [...document.querySelectorAll('${CHAT_MAIN} [data-chat-list] article[data-role="assistant"]')];
      const needle = ${JSON.stringify(needle)};
      const article = needle === null ? answers.at(-1) : answers.findLast((entry) => (entry.children[1]?.textContent ?? '').includes(needle));
      if (article === undefined) return null;
      const buttons = [...article.querySelectorAll('[data-reference] > button')];
      const press = ${JSON.stringify(press)};
      if (press !== null) buttons[press]?.click();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(article.children[1]);
      selection.removeAllRanges();
      selection.addRange(range);
      const selected = selection.toString();
      selection.removeAllRanges();
      return {
        controls: buttons.map((button) => ({ kind: button.parentElement.getAttribute('data-reference') ?? '', text: button.textContent ?? '' })),
        said: [...article.querySelectorAll('[data-reference] > [aria-hidden="true"]')].map((line) => (line.textContent ?? '').trim()),
        selected,
      };
    })()`) as Promise<References | null>;

  /**
   * For the maintainer's review only (M19b, V18): the window as it is, in both themes, and at the
   * minimum size in the theme it had. Nothing is captured unless a folder is named for it.
   */
  async function capturePane(main: BrowserWindow, name: string): Promise<void> {
    const directory = process.env['FATG_SMOKE_VISUAL_DIR'];
    if (directory === undefined || !path.isAbsolute(directory)) return;
    mkdirSync(directory, { recursive: true });
    const before = prefs.getSnapshot().values.appearance.theme;
    const shot = async (suffix: string): Promise<void> => {
      await delay(350);
      writeFileSync(path.join(directory, `pane-${name}-${suffix}.png`), (await main.webContents.capturePage()).toPNG());
    };
    for (const theme of ['light', 'dark'] as const) {
      prefs.patch({ appearance: { theme } });
      await shot(theme);
    }
    prefs.patch({ appearance: { theme: before } });
    const bounds = main.getBounds();
    main.setBounds({ ...bounds, ...MAIN_PLACEMENT.minSize });
    await shot('min');
    main.setBounds(bounds);
    await delay(150);
  }

  /** A file's reference, pressed in the answer that holds `needle`: its tab opens and shows what `shows` asks. */
  async function opens(main: BrowserWindow, who: string, what: string, needle: string | null, control: string, shows: (found: Pane) => boolean): Promise<Pane | null> {
    const found = await references(main, needle);
    const at = found?.controls.findIndex((entry) => entry.kind === 'local' && entry.text.includes(control)) ?? -1;
    if (found === null || found === undefined || at === -1) { problems.push(`live: ${who}’s answer holds no control for ${what} (${JSON.stringify(found?.controls ?? null)})`); return null; }
    // What a copy of the whole answer takes still holds the reference's own words: a control is text too (AGENTS.md).
    if (!found.selected.includes(control)) problems.push(`live: a selection of ${who}’s answer leaves out the words of its reference to ${what}`);
    await references(main, needle, at);
    let shown: Pane | null = null;
    if (!(await waitFor(`${who}’s ${what} to open as a tab`, async () => { shown = await pane(main); return shows(shown); }))) {
      problems.push(`live: ${who}’s ${what} shows ${JSON.stringify(await pane(main))}`);
      return null;
    }
    return shown;
  }

  /**
   * M19b (V15, V24; C19, C22, C36, C40, C46, C55, C64, C65): an answer names a file, and a press on
   * the reference opens it beside the chat — a Markdown file drawn with its own heading, a source
   * file at the line the answer gives. Codex writes a link with an absolute address; Claude a code
   * span, twice by a bare name, once for a file that lies in a subfolder, which Codex names in bold.
   * Then an answer whose references lead out: a file outside the project says so and opens nothing,
   * an address goes to the browser's stand-in; and a name in bold with its line said in words after
   * it, as another model answers, opens its file at that line.
   */
  async function fileReferences(main: BrowserWindow, id: string, who: 'Codex' | 'Claude'): Promise<boolean> {
    if (prompts === null) return false;
    const files = who === 'Codex' ? prompts.files : prompts.claude;
    const before = { external: dialogs.externalRequests.count, shown: dialogs.showInFolderRequests.count };

    // The README: its tab shows the file's own first heading.
    if (!(await send(main, id, files.readme, `${who}’s prompt about the README`)) || !(await ended(id, `${who}’s README turn`))) return false;
    await waitFor(`${who}’s README answer to show complete`, async () => (await drawn(main, 'last'))?.state === 'complete');
    const readme = await opens(main, who, 'README', null, who === 'Codex' ? 'README' : 'README.md', (found) => found.heading === prompts.headings.readme && found.view === 'markdown');
    if (readme === null) return false;
    if (readme.selected !== 'README.md' || readme.tabs.at(-1) !== 'README.md') problems.push(`live: ${who}’s README tab is titled ${JSON.stringify(readme.tabs)}`);
    if (readme.path !== path.join(folder ?? '', 'README.md')) problems.push(`live: ${who}’s README folder tooltip has the wrong path`);
    const loaded = await ask(main, 'files:read', { sessionId: id, target: readme.path });
    const refreshed = await ask(main, 'files:refresh', { sessionId: id, path: readme.path, revision: loaded.value?.['revision'] ?? null });
    if (!refreshed.ok || refreshed.value?.['outcome'] !== 'unchanged') problems.push(`live: ${who}’s unchanged README did not pass checked refresh`);
    const reread = await ask(main, 'files:refresh', { sessionId: id, path: readme.path, revision: null });
    if (!reread.ok || reread.value?.['outcome'] !== 'text' || reread.value['text'] !== loaded.value?.['text']) problems.push(`live: ${who}’s refresh did not return the checked README text`);
    report['fileRefresh'] = 'Main-only checked refresh, unchanged metadata and stable text reread';
    await capturePane(main, `${who.toLowerCase()}-markdown`);

    // The source file, at the line the answer gives: plain text, that line marked.
    if (!(await send(main, id, files.line, `${who}’s prompt about the function`)) || !(await ended(id, `${who}’s function turn`))) return false;
    await waitFor(`${who}’s function answer to show complete`, async () => (await drawn(main, 'last'))?.state === 'complete');
    const source = await opens(main, who, 'source file', null, 'src/tides.js:12', (found) => found.selected === 'tides.js' && found.view === 'plain' && (found.marked ?? '').includes('nextHighTide'));
    if (source === null) return false;
    await capturePane(main, `${who.toLowerCase()}-source-line`);

    // The file in the folder with a space. Each names it by its name alone, Claude in a code span and
    // Codex in bold (C64), and it is looked up (C55).
    if (!(await send(main, id, files.space, `${who}’s prompt about the log`)) || !(await ended(id, `${who}’s log turn`))) return false;
    await waitFor(`${who}’s log answer to show complete`, async () => (await drawn(main, 'last'))?.state === 'complete');
    const log = await opens(main, who, 'log', null, 'harbour-log.md', (found) => found.heading === prompts.headings.log && found.selected === 'harbour-log.md');
    if (log === null) return false;

    // Show in folder: the file manager's stand-in is asked once, and nothing is opened.
    const showed = (await main.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('section[aria-label="Artifacts"] [role="tabpanel"] button[aria-label="Show in folder"]');
      button?.click();
      return button !== null;
    })()`)) as boolean;
    if (!showed || !(await waitFor('Show in folder to reach the file manager’s stand-in', () => dialogs.showInFolderRequests.count === before.shown + 1))) problems.push(`live: ${who}’s Show in folder reached the stand-in ${dialogs.showInFolderRequests.count - before.shown} time(s)`);

    // An answer whose references lead out of the project, and to a site.
    const control = who === 'Codex' ? process.env['FATG_SMOKE_CODEX_CONTROL'] : claudeDirectory === undefined ? undefined : path.join(claudeDirectory, 'control.json');
    if (control === undefined) { problems.push('live: the fake’s control file is not named'); return false; }
    writeFileSync(control, JSON.stringify({ answerText: prompts.references.text }));
    const ran = await send(main, id, who === 'Codex' ? prompts.basic : prompts.claude.basic, `${who}’s prompt answered with references that lead out`) && await ended(id, `${who}’s references turn`);
    writeFileSync(control, '{}');
    if (!ran) return false;
    const marker = prompts.references.marker;
    if (!(await waitFor('the answer with references to show', async () => ((await references(main, marker))?.controls.length ?? 0) >= 5))) { problems.push(`live: ${who}’s answer with references shows ${JSON.stringify(await references(main, marker))}`); return false; }
    const out = await references(main, marker);
    const kinds = out?.controls.map((entry) => entry.kind) ?? [];
    if (JSON.stringify(kinds) !== JSON.stringify(['local', 'local', 'external', 'external', 'local'])) problems.push(`live: ${who}’s references are drawn as ${JSON.stringify(out?.controls ?? null)}`);
    const tabsBefore = (await pane(main)).tabs;
    const refusedBefore = fileCounts()['read:refused:outside'] ?? 0;
    // The file outside the project: by its link, then by its code span. Each says so, and no tab opens.
    for (const at of [0, 1]) {
      await references(main, marker, at);
      if (!(await waitFor('the reference outside the project to say so', async () => ((await references(main, marker))?.said ?? []).includes('Outside the project’s folders.')))) problems.push(`live: ${who}’s reference outside the project says ${JSON.stringify((await references(main, marker))?.said ?? null)}`);
      // For the review: the line as it stands beside its reference, which it does for a moment.
      if (at === 0 && process.env['FATG_SMOKE_VISUAL_DIR'] !== undefined && path.isAbsolute(process.env['FATG_SMOKE_VISUAL_DIR'])) {
        mkdirSync(process.env['FATG_SMOKE_VISUAL_DIR'], { recursive: true });
        writeFileSync(path.join(process.env['FATG_SMOKE_VISUAL_DIR'], `pane-${who.toLowerCase()}-refused.png`), (await main.webContents.capturePage()).toPNG());
      }
      // Its line is taken back before the next is pressed.
      await waitFor('the line to be taken back', async () => ((await references(main, marker))?.said.length ?? 1) === 0, 5_000);
    }
    if (JSON.stringify((await pane(main)).tabs) !== JSON.stringify(tabsBefore)) problems.push(`live: a reference outside the project opened a tab for ${who}`);
    if ((fileCounts()['read:refused:outside'] ?? 0) !== refusedBefore + 2) problems.push(`live: main counted ${(fileCounts()['read:refused:outside'] ?? 0) - refusedBefore} read(s) refused as outside, expected two`);
    // The address: handed to the browser's stand-in at once, by its link and by itself, and never to a browser.
    for (const at of [2, 3]) await references(main, marker, at);
    if (!(await waitFor('both addresses to reach the browser’s stand-in', () => dialogs.externalRequests.count === before.external + 2))) problems.push(`live: ${dialogs.externalRequests.count - before.external} address(es) reached the browser’s stand-in for ${who}, expected two`);
    if (Object.keys(addressCounts()).length !== 0) problems.push(`live: main refused an address: ${JSON.stringify(addressCounts())}`);

    // A file's name in bold and its line in words after it (C64, C65): the file's tab, at that line.
    await references(main, marker, 4);
    let spoken: Pane | null = null;
    if (!(await waitFor('the name in bold to open its file at the line said in words', async () => { spoken = await pane(main); return spoken.selected === 'tides.js' && (spoken.marked ?? '').includes('parseTime'); }))) problems.push(`live: ${who}’s name in bold, with its line in words, shows ${JSON.stringify(await pane(main))}`);

    // Codex's session goes on with two files' tabs and Claude's with three, so that each is known for its
    // own when the other is selected: the log's tab is closed by its × (C10). Each keeps its Sub-agents
    // tab first, which its worker's turn opened and which cannot be closed (M106, C2).
    if (who === 'Codex') {
      await main.webContents.executeJavaScript(`document.querySelector('section[aria-label="Artifacts"] [role="tab"] button[aria-label="Close harbour-log.md"]')?.click()`);
      if (!(await waitFor('the log’s tab to close by its button', async () => JSON.stringify((await pane(main)).tabs) === JSON.stringify(CODEX_TABS)))) problems.push(`live: after the log’s tab was closed, Codex’s session shows the tabs ${JSON.stringify((await pane(main)).tabs)}`);
    }

    const last = await pane(main);
    if (last.foreign !== 0 || last.active !== 0) problems.push(`live: the artifact pane holds ${last.foreign} element(s) and ${last.active} attribute(s) a file’s text may not become`);
    report[who === 'Codex' ? 'files' : 'claudeFiles'] = {
      readme: readme.heading, source: (source.marked ?? '').trim().slice(0, 40), log: log.heading, spokenLine: ((spoken as Pane | null)?.marked ?? '').trim().slice(0, 40), tabs: last.tabs,
      outside: 'said so twice, no tab', external: dialogs.externalRequests.count - before.external, shownInFolder: dialogs.showInFolderRequests.count - before.shown,
      foreignElements: last.foreign, activeAttributes: last.active,
    };
    return true;
  }

  // ── M20a: what a session did, in the chat, and a worker's tab (V14) ───────────────────────────

  /** A function body run in the Main page, answering what it returns. */
  const inPage = <T>(main: BrowserWindow, body: string): Promise<T> => main.webContents.executeJavaScript(`(() => { ${body} })()`) as Promise<T>;
  /** The Codex session's tabs once its files are opened: its Sub-agents tab, which cannot close (M106, C2), and two files'. */
  const CODEX_TABS = ['Sub-agents', 'README.md', 'tides.js'];
  /** The chat's own list, and the list of the sub-agent's thread unfolded in the Sub-agents tab (M106, C4). */
  const CHAT_LIST = `document.querySelector('${CHAT_MAIN} [data-chat-list]')`;
  const WORKER_LIST = `document.querySelector('section[aria-label="Artifacts"] [role="tabpanel"] [data-agent-thread] [data-worker-list]')`;
  /** Opens every group of a list that stands closed: its rows are drawn only then (C44). Answers how many groups it has. */
  const openGroups = (main: BrowserWindow, list: string): Promise<number> => inPage(main, `
    const groups = [...(${list}?.querySelectorAll('article[data-role="activity"]') ?? [])];
    for (const group of groups) { const head = group.firstElementChild; if (head?.getAttribute('aria-expanded') === 'false') head.click(); }
    return groups.length;`);
  /** The last row of a list that reads `name`, by its kind. */
  const rowOf = (list: string, type: string, name: string): string => `[...(${list}?.querySelectorAll('[data-activity="${type}"]') ?? [])].filter((row) => row.firstElementChild?.textContent.includes(${JSON.stringify(name)})).at(-1)`;
  interface ReadDetail { readonly output: number; readonly holds: boolean; readonly copies: number; readonly controls: number }
  /**
   * A read's row, opened: its output as text with its Copy buttons, and no control made of what the
   * output holds. Then the file its row names, pressed: its tab opens beside the chat.
   */
  async function readOpens(main: BrowserWindow, who: string, list: string, file: string, needle: string): Promise<ReadDetail | null> {
    const row = rowOf(list, 'read', file);
    if (!(await waitFor(`${who}’s read of ${file} to show as a row`, () => inPage<boolean>(main, `return ${row} !== undefined;`)))) return null;
    await inPage(main, `const toggle = ${row}?.querySelector('button[aria-controls]'); if (toggle?.getAttribute('aria-expanded') === 'false') toggle.click(); return true;`);
    let detail: ReadDetail | null = null;
    const read = (): Promise<ReadDetail | null> => inPage(main, `
      const row = ${row};
      const output = row?.querySelector('pre[aria-label="Output"]');
      if (!output) return null;
      return {
        output: output.textContent.length, holds: output.textContent.includes(${JSON.stringify(needle)}),
        copies: [...row.querySelectorAll('button')].filter((button) => /^Copy (input|output)$/.test(button.getAttribute('aria-label') ?? '')).length,
        controls: row.querySelectorAll('pre button, pre [data-reference], pre a').length,
      };`);
    if (!(await waitFor(`${who}’s read of ${file} to open to its output`, async () => { detail = await read(); return detail !== null; }))) { problems.push(`live: ${who}’s read of ${file} did not open to an output`); return null; }
    const found = detail as ReadDetail | null;
    if (found === null || !found.holds || found.copies !== 2 || found.controls !== 0) problems.push(`live: ${who}’s read of ${file} opened to ${JSON.stringify(found)}`);
    // The file's control, beside the row's disclosure: its tab opens, and shows the file's own text.
    await inPage(main, `${row}?.querySelector('[data-reference="local"] button')?.click(); return true;`);
    if (!(await waitFor(`${who}’s ${file} to open as a tab from the read’s row`, async () => { const shown = await pane(main); return shown.selected === file && shown.outcome === 'text'; }))) {
      problems.push(`live: the file control of ${who}’s read of ${file} shows ${JSON.stringify(await pane(main))}`);
      return null;
    }
    return found;
  }
  interface WorkerTab { readonly worker: string | null; readonly status: string | null; readonly entries: number; readonly groups: number; readonly inputs: number; readonly title: string }
  /** The thread unfolded in the Sub-agents tab, which the worker's own tab was until M106 (C4). */
  const workerTab = (main: BrowserWindow): Promise<WorkerTab | null> => inPage(main, `
    const region = document.querySelector('section[aria-label="Artifacts"]');
    const body = region?.querySelector('[role="tabpanel"] [data-agent-thread]');
    if (!body) return null;
    const list = body.querySelector('[data-worker-list]');
    return {
      worker: body.getAttribute('data-agent-thread'), status: body.getAttribute('data-worker-status'),
      entries: list ? list.querySelectorAll('article').length : 0, groups: list ? list.querySelectorAll('article[data-role="activity"]').length : 0,
      inputs: body.querySelectorAll('textarea, input').length,
      title: region.querySelector('[role="tab"][aria-selected="true"]')?.querySelector('[data-tab-title]')?.textContent ?? '',
    };`);
  /**
   * Every tab of the pane that closes, closed by its own button: the checks after this one find the
   * pane as they expect it. The Sub-agents tab has none, and stays (M106, C2).
   */
  async function closeTabs(main: BrowserWindow): Promise<void> {
    const closers = `document.querySelectorAll('section[aria-label="Artifacts"] [role="tab"] button[aria-label^="Close "]')`;
    await waitFor('the tabs opened for the activity to close', async () => {
      await inPage(main, `${closers}[0]?.click(); return true;`);
      return (await inPage<number>(main, `return ${closers}.length;`)) === 0;
    });
  }

  /**
   * M20a (V14; C36–C40, C44, C47, C48): what a session did between its messages is in its chat as
   * groups. A group opens to its rows; a read's row opens to its output, as text with its Copy
   * buttons; the file the row names opens as a tab beside the chat; and a worker's row opens the
   * worker's tab, which shows the worker's own work in the same way, and takes no prompt.
   */
  async function activity(main: BrowserWindow, id: string, who: 'Codex' | 'Claude'): Promise<boolean> {
    if (prompts === null) return false;
    // A worker's turn for Codex: Claude's first turn was one.
    if (who === 'Codex' && !(await send(main, id, prompts.worker, 'Codex’s worker prompt') && await ended(id, 'Codex’s worker turn', 60_000))) return false;
    if (!(await waitFor(`${who}’s activity to show as groups`, () => inPage<boolean>(main, `return (${CHAT_LIST}?.querySelectorAll('article[data-role="activity"]').length ?? 0) > 0;`)))) { problems.push(`live: ${who}’s chat shows no group of activity`); return false; }
    // Unopened, nothing of an input or an output is drawn (C44), and nothing of a group is an element a text may not become.
    const before = await inPage<{ details: number; foreign: number }>(main, `
      const list = ${CHAT_LIST};
      return { details: list.querySelectorAll('article[data-role="activity"] pre').length, foreign: ${foreignIn('list')} };`);
    if (before.details !== 0 || before.foreign !== 0) problems.push(`live: before any row was opened, ${who}’s chat draws ${before.details} detail(s) and ${before.foreign} element(s) a text may not become`);
    const groups = await openGroups(main, CHAT_LIST);

    // The session's own read: T1's, of the sample file, whose line the answer quotes.
    const read = await readOpens(main, who, CHAT_LIST, 'sample.txt', 'Biscuit');
    if (read === null) return false;

    // Its worker's row: the Open button opens the worker's tab, titled with the worker's label.
    const readsBefore = workerReads()['read:window'] ?? 0;
    const opened = await inPage<string | null>(main, `const open = [...(${CHAT_LIST}?.querySelectorAll('[data-open-worker]') ?? [])].at(-1); open?.click(); return open?.getAttribute('data-open-worker') ?? null;`);
    if (opened === null) { problems.push(`live: ${who}’s chat shows no worker row with an Open button`); return false; }
    let tab: WorkerTab | null = null;
    if (!(await waitFor(`${who}’s worker tab to show the worker’s work`, async () => { tab = await workerTab(main); return tab !== null && tab.worker === opened && tab.entries > 0; }))) {
      problems.push(`live: ${who}’s worker tab shows ${JSON.stringify(await workerTab(main))}`);
      return false;
    }
    const shown = tab as WorkerTab | null;
    if (shown === null || shown.status !== 'completed' || shown.groups < 1 || shown.inputs !== 0 || shown.title === '') problems.push(`live: ${who}’s worker tab reads ${JSON.stringify(shown)}`);
    // In it, the worker's own read, opened the same way, and the file it names.
    await openGroups(main, WORKER_LIST);
    const theirs = await readOpens(main, `${who}’s worker`, WORKER_LIST, 'notes-3.txt', 'blue drawer');
    if (theirs === null) return false;
    // None of the worker's items is in the session's own chat.
    const leaked = await inPage<boolean>(main, `return ${rowOf(CHAT_LIST, 'read', 'notes-3.txt')} !== undefined;`);
    if (leaked) problems.push(`live: ${who}’s chat shows a row of its worker’s`);
    const tabs = (await pane(main)).tabs;
    await closeTabs(main);
    // Main says of the worker's reads their kinds and how many (C34): its window was read, at each showing of its tab, and none was refused.
    const counted = workerReads();
    const windows = (counted['read:window'] ?? 0) - readsBefore;
    if (windows < 1 || Object.keys(counted).some((kind) => kind.startsWith('refused:'))) problems.push(`live: main counted ${JSON.stringify(counted)} of ${who}’s worker reads`);
    report[who === 'Codex' ? 'activity' : 'claudeActivity'] = {
      groups, readOutput: read.output, workerTab: shown?.title ?? '', workerEntries: shown?.entries ?? 0, workerReadOutput: theirs.output, tabs, workerReads: windows,
    };
    return true;
  }


  // ── M20b: a question beside a session (V14) ──────────────────────────────────────────────────

  const ASIDE_BODY = `document.querySelector('section[aria-label="Artifacts"] [role="tabpanel"] [data-aside]')`;
  interface AsideTab {
    readonly id: string | null; readonly running: boolean; readonly title: string; readonly focused: boolean;
    /** Each entry of its list: whose it is, its state, and how long its text is. */
    readonly entries: readonly { readonly role: string | null; readonly state: string | null; readonly units: number }[];
    /** How long the passage it shows is, and how many controls or source marks its own answers carry: none (C40). */
    readonly excerpt: number; readonly sources: number;
  }
  /** The aside's tab that is shown, as the Main page draws it. */
  const asideTab = (main: BrowserWindow): Promise<AsideTab | null> => inPage(main, `
    const region = document.querySelector('section[aria-label="Artifacts"]');
    const body = ${ASIDE_BODY};
    if (!body) return null;
    const list = body.querySelector('[data-aside-list]');
    return {
      id: body.getAttribute('data-aside'), running: body.hasAttribute('data-aside-running'),
      title: region.querySelector('[role="tab"][aria-selected="true"]')?.querySelector('[data-tab-title]')?.textContent ?? '',
      focused: document.activeElement === body.querySelector('textarea'),
      entries: [...(list?.querySelectorAll('article') ?? [])].map((article) => ({ role: article.getAttribute('data-role'), state: article.getAttribute('data-state'), units: (article.children[1]?.textContent ?? '').length })),
      excerpt: (body.querySelector('blockquote')?.textContent ?? '').length,
      sources: body.querySelectorAll('[data-explain], [data-aside-marker], [data-md-control], [data-source-kind]').length,
    };`);
  /** The shown aside's tab once it holds `answers` complete answers, none still being written; null, with a problem said, where it never does. */
  async function asideAnswered(main: BrowserWindow, who: string, what: string, answers: number, other: string | null = null): Promise<AsideTab | null> {
    let tab: AsideTab | null = null;
    const done = (found: AsideTab | null): boolean => found !== null && found.id !== other && !found.running && found.entries.filter((entry) => entry.role === 'assistant' && entry.state === 'complete' && entry.units > 0).length === answers && found.entries.every((entry) => entry.state !== 'streaming');
    if (!(await waitFor(`${who}’s aside ${what} to be answered`, async () => { tab = await asideTab(main); return done(tab); }, 60_000))) {
      problems.push(`live: ${who}’s aside ${what} shows ${JSON.stringify(await asideTab(main))}`);
      return null;
    }
    return tab;
  }
  /** fat-g's own menu on a selection, as the page shows it: its items' words, and the one that has the focus. */
  const selectionMenu = (main: BrowserWindow, press: string | null = null): Promise<{ items: string[]; focused: string | null } | null> => inPage(main, `
    const menu = document.querySelector('[role="menu"][aria-label="Selection"]');
    if (!menu) return null;
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    const found = { items: items.map((item) => item.textContent ?? ''), focused: menu.contains(document.activeElement) ? document.activeElement.textContent : null };
    const press = ${JSON.stringify(press)};
    if (press !== null) items.find((item) => item.textContent === press)?.click();
    return found;`);
  /** How many ranges the page has painted as asides' passages, through the platform's own registry: -1 where it has none. */
  const painted = (main: BrowserWindow): Promise<number> => inPage(main, `return typeof CSS === 'undefined' || !CSS.highlights ? -1 : (CSS.highlights.get('aside')?.size ?? 0);`);
  /** Types a question into the shown aside's field and presses its Send, as the user would. */
  const askInTab = (main: BrowserWindow, text: string): Promise<boolean> => inPage(main, `
    const body = ${ASIDE_BODY};
    const area = body?.querySelector('textarea');
    if (!area || area.disabled) return false;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, ${JSON.stringify(text)});
    area.dispatchEvent(new Event('input', { bubbles: true }));
    const button = [...body.querySelectorAll('button')].find((element) => element.textContent === 'Send');
    if (!button || button.disabled) return false;
    button.click();
    return true;`);
  /** Closes the tab that is selected, by its own button. */
  const closeSelectedTab = (main: BrowserWindow): Promise<boolean> => inPage(main, `
    const close = document.querySelector('section[aria-label="Artifacts"] [role="tab"][aria-selected="true"] button[aria-label^="Close "]');
    close?.click();
    return close !== null;`);
  const selectTab = (main: BrowserWindow, title: string): Promise<boolean> => inPage(main, `
    const tab = [...document.querySelectorAll('section[aria-label="Artifacts"] [role="tab"]')].find((entry) => (entry.querySelector('[data-tab-title]')?.textContent ?? '') === ${JSON.stringify(title)});
    (tab?.firstElementChild ?? tab)?.click();
    return tab !== undefined;`);
  /** What the session's read lists of its asides: each one's id, title and source, as main answers it. */
  const listed = async (main: BrowserWindow, id: string): Promise<{ id: string; title: string; source: Record<string, unknown> | null }[]> =>
    ((await ask(main, 'chat:read', { sessionId: id })).value?.['asides'] ?? []) as never;

  /**
   * M20b (V14; C5, C36–C48, C50, C53, C73–C75): a question asked beside a session, through the real
   * page. Explain this from fat-g's own menu on a selection in an answer, on a
   * selection in an activity's output, and from a file's tab by the keyboard; then a question typed
   * freely from the toolbar, a follow-up, and a removal. Each has a tab of its own beside the chat,
   * and its answer; the session's turn, its record and its status are as they were. Unclosed
   * questions stay saved for the next launch.
   */
  async function asides(main: BrowserWindow, id: string, who: 'Codex' | 'Claude'): Promise<boolean> {
    if (prompts === null) return false;
    const before = { tabs: (await pane(main)).tabs, record: JSON.stringify(onDisk(id)?.['lastTurn'] ?? null), counts: { ...asideCounts() }, items: (((await ask(main, 'chat:read', { sessionId: id })).value?.['items'] ?? []) as unknown[]).length };
    const held = onDisk(id)?.['reference'];
    const reference = typeof held === 'string' ? held : '';
    const asked = (): number => (who === 'Codex' ? threads()[reference]?.asides?.length : chatSessions()[reference]?.sides?.length) ?? 0;
    const asksBefore = asked();
    const turnsBefore = JSON.stringify((who === 'Codex' ? threads()[reference]?.turns : chatSessions()[reference]?.turns) ?? []);
    if ((await listed(main, id)).length !== 0) problems.push(`live: ${who}’s session lists asides before any was asked`);

    // 1: select a block of an answer. Standalone Explain buttons are hidden; the menu asks about it.
    const selectedMessage = await inPage<boolean>(main, `
      const block = ${CHAT_LIST}?.querySelector('article[data-role="assistant"] [data-source-kind="message"] p');
      if (!block) return false;
      const range = document.createRange();
      range.selectNodeContents(block);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const box = block.getBoundingClientRect();
      return !block.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: box.left + 4, clientY: box.top + 4 }));`);
    const messageMenu = await selectionMenu(main, 'Explain this in a side chat');
    if (!selectedMessage || !messageMenu?.items.includes('Explain this in a side chat')) { problems.push(`live: ${who}’s answer offers no selection explanation`); return false; }
    const fromMessage = await asideAnswered(main, who, 'from a message selection', 1);
    if (fromMessage === null) return false;
    if (fromMessage.excerpt === 0 || fromMessage.sources !== 0 || fromMessage.entries[0]?.role !== 'assistant' || fromMessage.title === '' || fromMessage.focused) problems.push(`live: ${who}’s aside from the message selection reads ${JSON.stringify(fromMessage)}`);
    // Its block now carries a marker, and its passage is painted where it was taken.
    if (!(await waitFor(`${who}’s marker to show beside its block`, () => inPage<boolean>(main, `return (${CHAT_LIST}?.querySelectorAll('[data-aside-marker]').length ?? 0) === 1;`)))) problems.push(`live: ${who}’s chat shows no marker for its aside`);
    const paintedOne = await painted(main);
    if (paintedOne < 1) problems.push(`live: ${who}’s aside’s passage is not painted (${paintedOne})`);
    // The marker selects its tab again, without asking another question.
    await inPage(main, `${CHAT_LIST}.querySelector('[data-aside-marker]').click(); return true;`);
    const reopened = await asideAnswered(main, who, 'reopened from its marker', 1);
    if (reopened?.id !== fromMessage.id || asked() !== asksBefore + 1) problems.push(`live: ${who}’s marker did not reopen its aside (${String(reopened?.id)} for ${String(fromMessage.id)}, ${asked() - asksBefore} asked)`);

    // 2: fat-g's own menu on a selection in an activity's output, opened by the right button.
    await openGroups(main, CHAT_LIST);
    const row = rowOf(CHAT_LIST, 'read', 'sample.txt');
    await inPage(main, `const toggle = ${row}?.querySelector('button[aria-controls]'); if (toggle?.getAttribute('aria-expanded') === 'false') toggle.click(); return true;`);
    if (!(await waitFor(`${who}’s read to show its output again`, () => inPage<boolean>(main, `return ${row}?.querySelector('pre[aria-label="Output"]') != null;`)))) return false;
    const taken = await inPage<boolean>(main, `
      const output = ${row}.querySelector('pre[aria-label="Output"]');
      const range = document.createRange();
      range.selectNodeContents(output.querySelector('code') ?? output);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      const box = output.getBoundingClientRect();
      return !output.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: box.left + 4, clientY: box.top + 4 }));`);
    const outputMenu = await selectionMenu(main);
    if (!taken || JSON.stringify(outputMenu?.items) !== JSON.stringify(['Copy', 'Explain this in a side chat', 'Send to new side chat'])) problems.push(`live: the menu on a selection in ${who}’s output holds ${JSON.stringify(outputMenu?.items ?? null)}`);
    await selectionMenu(main, 'Explain this in a side chat');
    const fromOutput = await asideAnswered(main, who, 'from an output', 1, fromMessage.id);
    if (fromOutput === null) return false;
    if (fromOutput.excerpt === 0) problems.push(`live: ${who}’s aside from an output shows no passage`);
    if (!(await waitFor(`${who}’s output to carry its marker`, () => inPage<boolean>(main, `return (${row}?.querySelectorAll('[data-aside-marker]').length ?? 0) === 1 && ${row}.querySelectorAll('pre [data-aside-marker]').length === 0;`)))) problems.push(`live: ${who}’s output carries no marker in its head row`);

    // 3: a file's tab, by the keyboard: Shift+F10 on a selection of its heading, then Down to the item.
    if (!(await selectTab(main, 'README.md')) || !(await waitFor(`${who}’s README tab to show again`, async () => { const shown = await pane(main); return shown.selected === 'README.md' && shown.outcome === 'text'; }))) { problems.push(`live: ${who}’s README tab is not there to ask about`); return false; }
    const byKeyboard = await inPage<boolean>(main, `
      const source = document.querySelector('section[aria-label="Artifacts"] [role="tabpanel"] [data-source-kind="file"]');
      const heading = source?.querySelector('h1');
      if (!heading) return false;
      const range = document.createRange();
      range.selectNodeContents(heading);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      source.focus();
      return !source.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));`);
    // Opened from the keyboard, the menu takes the focus at its first item; Down then goes to the second.
    const tookFocus = await waitFor(`the menu in ${who}’s file tab to take the focus`, async () => (await selectionMenu(main))?.focused === 'Copy');
    await inPage(main, `document.querySelector('[role="menu"][aria-label="Selection"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); return true;`);
    const fileMenu = await selectionMenu(main);
    if (!byKeyboard || !tookFocus || fileMenu?.focused !== 'Explain this in a side chat') problems.push(`live: the menu opened by the keyboard in ${who}’s file tab reads ${JSON.stringify(fileMenu)}`);
    await selectionMenu(main, 'Explain this in a side chat');
    const fromFile = await asideAnswered(main, who, 'from a file', 1, fromOutput.id);
    if (fromFile === null) return false;
    if (fromFile.title !== `Explained: ${prompts.headings.readme}`) problems.push(`live: ${who}’s aside from a file is titled ${JSON.stringify(fromFile.title)}`);
    // The file's tab lists it above the text, and paints its passage.
    await selectTab(main, 'README.md');
    if (!(await waitFor(`${who}’s README tab to list its aside`, () => inPage<boolean>(main, `return document.querySelectorAll('section[aria-label="Artifacts"] [role="tabpanel"] [data-file-aside]').length === 1;`)))) problems.push(`live: ${who}’s README tab lists no aside`);

    // 4: a question typed freely, from the prompt-type bar's Side question (M100, C39): a new, empty tab with the focus in its field.
    await inPage(main, `document.querySelector('${CHAT_MAIN} [role="toolbar"] button[data-tool="side-question"]')?.click(); return true;`);
    const direct = await inPage<boolean>(main, `return document.querySelector('[role="menu"][aria-label="Side questions"]') === null;`);
    let fresh: AsideTab | null = null;
    if (!(await waitFor(`${who}’s new side question’s tab to take the focus`, async () => { fresh = await asideTab(main); return fresh !== null && fresh.title === 'New aside' && fresh.focused && fresh.entries.length === 0; }))) { problems.push(`live: ${who}’s new side question’s tab reads ${JSON.stringify(await asideTab(main))}`); return false; }
    const freeId = (fresh as AsideTab | null)?.id ?? null;
    if (!(await askInTab(main, prompts.asides.free))) { problems.push(`live: ${who}’s aside tab took no question`); return false; }
    const free = await asideAnswered(main, who, 'asked freely', 1);
    if (free === null) return false;
    if (free.id !== freeId || free.excerpt !== 0 || free.title !== prompts.asides.free.slice(0, 60).trimEnd()) problems.push(`live: ${who}’s free aside reads ${JSON.stringify(free)}`);
    // A follow-up, in the same tab: a second question and a second answer of the same aside.
    if (!(await askInTab(main, prompts.asides.followUp))) { problems.push(`live: ${who}’s aside tab took no follow-up`); return false; }
    const followed = await asideAnswered(main, who, 'followed up', 2);
    if (followed === null) return false;
    if (followed.entries.filter((entry) => entry.role === 'user').length !== 2) problems.push(`live: ${who}’s follow-up left ${JSON.stringify(followed.entries)}`);

    // Four asides, five questions; the session's own turn, record and chat are as they were.
    const now = await listed(main, id);
    if (now.length !== 4 || now.some((aside) => aside.source !== null && 'excerpt' in aside.source) || now.filter((aside) => aside.source === null).length !== 1) problems.push(`live: ${who}’s session lists ${JSON.stringify(now.map((aside) => aside.source?.['kind'] ?? null))}`);
    if (asked() !== asksBefore + 5) problems.push(`live: ${who}’s fake was asked ${asked() - asksBefore} side question(s), expected five`);
    if (JSON.stringify((who === 'Codex' ? threads()[reference]?.turns : chatSessions()[reference]?.turns) ?? []) !== turnsBefore) problems.push(`live: an aside ran a turn of ${who}’s session`);
    if (who === 'Codex' && (threads()[reference]?.forks?.length ?? 0) !== 4) problems.push(`live: Codex was sent ${threads()[reference]?.forks?.length ?? 0} fork(s) for four asides`);
    if (who === 'Claude' && JSON.stringify(chatSessions()[reference]?.sides?.slice(-2).map((side) => (Array.isArray(side.history) ? side.history.length : 0))) !== JSON.stringify([0, 1])) problems.push('live: Claude’s follow-up was not sent with the aside’s one earlier exchange');
    if (JSON.stringify(onDisk(id)?.['lastTurn'] ?? null) !== before.record || entryOf(id)?.summary.status !== 'idle') problems.push(`live: an aside changed ${who}’s session’s record or status`);
    const itemsNow = (((await ask(main, 'chat:read', { sessionId: id })).value?.['items'] ?? []) as unknown[]).length;
    if (itemsNow !== before.items) problems.push(`live: ${who}’s chat went from ${before.items} items to ${itemsNow} with its asides`);

    // Explicitly closing the free question removes its conversation, without a second confirmation.
    await closeSelectedTab(main);
    if (!(await waitFor(`${who}’s removed aside’s tab to close`, async () => (await asideTab(main))?.id !== freeId && (await listed(main, id)).length === 3))) problems.push(`live: ${who}’s aside was not removed (${JSON.stringify((await pane(main)).tabs)})`);
    const gone = await ask(main, 'chat:readAside', { sessionId: id, asideId: freeId ?? '' });
    if (gone.value?.['reason'] !== 'unknown-aside') problems.push(`live: ${who}’s removed aside still reads ${JSON.stringify(gone.value ?? gone.error)}`);

    // What main said of it all: kinds and counts, and no refusal.
    const counted = asideCounts();
    const more = (kind: string): number => (counted[kind] ?? 0) - (before.counts[kind] ?? 0);
    if (more('explain:accepted') !== 3 || more('question:accepted') !== 2 || more('remove:removed') !== 1 || Object.keys(counted).some((kind) => kind.includes(':refused:') && kind !== 'read:refused:unknown-aside' && more(kind) > 0)) problems.push(`live: main counted ${JSON.stringify(counted)} of ${who}’s asides`);
    // Leave the other three open: a restart restores them until their tabs are explicitly closed.
    const opened = (await pane(main)).tabs;
    report[who === 'Codex' ? 'asides' : 'claudeAsides'] = { selectedMessage, painted: paintedOne, tabs: opened.length - before.tabs.length, asked: asked() - asksBefore, listed: 3, menu: outputMenu?.items ?? [], byKeyboard, direct, answers: [fromMessage, fromOutput, fromFile, followed].map((tab) => tab.entries.filter((entry) => entry.role === 'assistant').length) };
    return true;
  }

  /**
   * M20b (V14; C30, C32, C38): after a restart a session's asides are read from the store — listed
   * with no text of them, their marker in the chat reopening the tab with its question and its
   * answer — and no process is started for any of it.
   */
  async function asidesFromStore(main: BrowserWindow, id: string, who: 'Codex' | 'Claude'): Promise<void> {
    const kept = await listed(main, id);
    if (kept.length !== 3 || kept.some((aside) => aside.source === null || 'excerpt' in aside.source)) problems.push(`live: after the restart ${who}’s session lists ${JSON.stringify(kept.map((aside) => aside.source?.['kind'] ?? null))}`);
    const restored = await waitFor(`${who}’s saved questions to restore their tabs`, async () => {
      const tabs = (await pane(main)).tabs;
      return kept.every((question) => tabs.includes(question.title || 'New aside'));
    });
    if (!(await waitFor(`${who}’s marker to show in the chat read from the store`, () => inPage<boolean>(main, `return (${CHAT_LIST}?.querySelectorAll('[data-aside-marker]').length ?? 0) >= 1;`)))) { problems.push(`live: ${who}’s stored chat shows no marker`); return; }
    await inPage(main, `${CHAT_LIST}.querySelector('[data-aside-marker]').click(); return true;`);
    const tab = await asideAnswered(main, who, 'read from the store', 1);
    const shownPassage = await painted(main);
    if (tab !== null && (tab.excerpt === 0 || tab.entries[0]?.role !== 'assistant' || !kept.some((aside) => aside.id === tab.id))) problems.push(`live: ${who}’s aside read from the store shows ${JSON.stringify(tab)}`);
    await closeSelectedTab(main);
    const removed = await waitFor(`${who}’s stored aside to be removed by closing its tab`, async () => (await listed(main, id)).length === kept.length - 1);
    report[who === 'Codex' ? 'asidesFromStore' : 'claudeAsidesFromStore'] = { listed: kept.length, restored, removed, reopened: tab !== null, answers: tab?.entries.filter((entry) => entry.role === 'assistant').length ?? 0, painted: shownPassage };
  }

  /**
   * M20b (V14; C54–C58): the CLI's own commands, written as prompts. A listed one is answered by
   * fat-g, in a turn of its own, and never reaches the CLI; another is written as it is, and the
   * CLI's own answer is the turn's message.
   */
  async function commands(main: BrowserWindow, id: string): Promise<boolean> {
    if (prompts === null) return false;
    const held = onDisk(id)?.['reference'];
    const reference = typeof held === 'string' ? held : '';
    const turnsBefore = chatSessions()[reference]?.turns.length ?? 0;
    if (!(await send(main, id, prompts.claude.cleared, 'the command fat-g answers')) || !(await ended(id, 'the command’s own turn'))) return false;
    let notice = '';
    if (!(await waitFor('fat-g’s answer to the command to show', async () => { notice = (await shown(main)).at(-1)?.text ?? ''; return (await shown(main)).at(-1)?.label === 'fat-g'; }))) problems.push('live: a listed command was not answered by fat-g');
    if (!notice.includes(prompts.claude.cleared) || (chatSessions()[reference]?.turns.length ?? 0) !== turnsBefore) problems.push(`live: the listed command reached the CLI, or its notice does not name it (${(chatSessions()[reference]?.turns.length ?? 0) - turnsBefore} turn(s))`);
    if (lastOutcome(id) !== 'completed') problems.push(`live: the command fat-g answered is written ${JSON.stringify(onDisk(id)?.['lastTurn'])}`);
    if (!(await send(main, id, prompts.claude.passed, 'the command that passes')) || !(await ended(id, 'the passed command’s turn'))) return false;
    let answer = '';
    await waitFor('the CLI’s own answer to the passed command to show', async () => { const last = (await shown(main)).at(-1); answer = last?.text ?? ''; return last !== undefined && last.label !== 'You' && last.label !== 'fat-g'; });
    const turns = chatSessions()[reference]?.turns ?? [];
    if (turns.length !== turnsBefore + 1 || turns.at(-1) !== 'm20b-cmd-exit' || !answer.includes(prompts.claude.passed)) problems.push(`live: the passed command ran ${JSON.stringify(turns.slice(turnsBefore))} and showed ${answer.length} character(s)`);
    report['commands'] = { answeredByFatg: prompts.claude.cleared, passed: prompts.claude.passed, cliAnswered: answer.includes(prompts.claude.passed) };
    // M23 (V10; C58–C62): the menu's rows in the build under test — fat-g's two first, then what the
    // CLI listed once its process ran, each a single token — read over the Main window's channel.
    const listed = await ask(main, 'chat:commands', { sessionId: id });
    const rows = (listed.value as { rows?: { name: string; group: string }[] } | undefined)?.rows ?? [];
    if (rows[0]?.name !== 'clear' || rows[1]?.name !== 'model' || rows.slice(0, 2).some((row) => row.group !== 'fat-g') || rows.some((row) => /\s/.test(row.name))) problems.push(`live: the command menu listed ${JSON.stringify(rows.slice(0, 4))}`);
    // M23 (V9; C47, C48): a message queued while the session is idle goes at once, through the send path, and leaves the queue empty.
    const turnsQueued = chatSessions()[reference]?.turns.length ?? 0;
    const queued = await ask(main, 'chat:queue', { sessionId: id, op: 'append', prompt: prompts.claude.basic, revision: 1_000_000, attachments: [], intent: { plan: false, skill: null } });
    if ((queued.value as { status?: string } | undefined)?.status !== 'saved') problems.push(`live: queuing was answered ${JSON.stringify(queued.value ?? queued.error ?? null)}`);
    const released = await waitFor('the queued message to run', () => (chatSessions()[reference]?.turns.length ?? 0) > turnsQueued) && await ended(id, 'the queued message’s turn');
    const after = await ask(main, 'chat:read', { sessionId: id });
    const left = (after.value as { composer?: { queue?: { entries?: unknown[] } } } | undefined)?.composer?.queue?.entries?.length ?? -1;
    if (!released || left !== 0) problems.push(`live: the queued message ran ${String(released)}, and ${left} stayed queued`);
    report['busyInput'] = { menuRows: rows.length, ownFirst: rows[0]?.name === 'clear', queuedReleased: released, leftQueued: left };
    return true;
  }

  const liveProject = (): StoredProject | undefined => records.getView().projects.find((entry): entry is StoredProject => entry.kind === 'project' && entry.name === LIVE_PROJECT);
  const lastOutcome = (id: string): string | undefined => (onDisk(id)?.['lastTurn'] as { outcome?: string } | null)?.outcome;

  // ── M21: a question a session asks, answered from its card (V12) ──────────────────────────────

  interface CardShown {
    readonly mode: string | null; readonly outcome: string | null;
    /** Each question: how long its text is, its options' labels, and how many of them are chosen. */
    readonly questions: readonly { readonly units: number; readonly options: readonly string[]; readonly chosen: number }[];
    /** What of it can be acted on: its inputs, its text fields, Submit — enabled or not, null where it has none — and Decline (M100b, C21); and how many of those stand in a form, which must be none. */
    readonly inputs: number; readonly fields: number; readonly submit: boolean | null; readonly decline: boolean; readonly inForm: number;
    /** That it says the model waits; what it says became of it; and whether its text holds each of `holds`. */
    readonly waits: boolean; readonly words: string; readonly held: readonly boolean[];
    readonly folded: boolean;
  }
  /** The chat's question cards as the page draws them, oldest first. Nothing of a question's text is answered but what `holds` asks after. */
  const cards = (main: BrowserWindow, holds: readonly string[] = []): Promise<CardShown[]> => inPage(main, `
    return [...(${CHAT_LIST}?.querySelectorAll('article[data-interaction]') ?? [])].map((card) => {
      // A content check opens recorded answers through their disclosure, as a reader does.
      if (${holds.length > 0}) card.querySelector('button[aria-expanded="false"]')?.click();
      const submit = card.querySelector('[data-card-submit]');
      return {
        mode: card.getAttribute('data-mode'), outcome: card.getAttribute('data-outcome'),
        questions: [...card.querySelectorAll('fieldset')].map((group) => ({
          units: (group.querySelector('legend')?.textContent ?? '').length,
          options: [...group.querySelectorAll('label')].filter((label) => label.querySelector('input[type="radio"], input[type="checkbox"]') !== null).map((label) => label.querySelector('span:not([aria-hidden])')?.firstChild?.textContent ?? ''),
          chosen: group.querySelectorAll('input:checked').length,
        })),
        inputs: card.querySelectorAll('input').length, fields: card.querySelectorAll('textarea').length,
        submit: submit === null ? null : !submit.disabled, decline: card.querySelector('[data-card-decline]') !== null,
        inForm: card.querySelectorAll('form').length + [...card.querySelectorAll('input, textarea, button')].filter((control) => control.form !== null).length,
        waits: (card.getAttribute('aria-label') ?? '').endsWith(' asks a question'), words: card.querySelector('[data-card-outcome]')?.textContent ?? '',
        folded: card.getAttribute('data-outcome') === 'answered' && card.querySelector('[data-card-header][data-folded] button[aria-expanded="false"]') !== null,
        held: ${JSON.stringify(holds)}.map((text) => (card.textContent ?? '').includes(text)),
      };
    });`);
  /** The chat's newest card that waits for an answer, in the page. */
  const WAITING_CARD = `[...(${CHAT_LIST}?.querySelectorAll('article[data-interaction]') ?? [])].filter((entry) => ['pending', 'open'].includes(entry.getAttribute('data-outcome') ?? '')).at(-1)`;
  /** Chooses in that card, for each of its questions in turn, the option labelled so, as a press on it would. */
  const choose = (main: BrowserWindow, labels: readonly string[]): Promise<boolean> => inPage(main, `
    const groups = [...(${WAITING_CARD}?.querySelectorAll('fieldset') ?? [])];
    return ${JSON.stringify(labels)}.every((wanted, index) => {
      const input = [...(groups[index]?.querySelectorAll('label') ?? [])].find((label) => label.querySelector('span:not([aria-hidden])')?.firstChild?.textContent === wanted)?.querySelector('input');
      input?.click();
      return input !== null && input !== undefined;
    });`);
  /** Presses that card's Submit, or its Decline. */
  const pressCard = (main: BrowserWindow, control: 'submit' | 'decline'): Promise<boolean> => inPage(main, `
    const button = ${WAITING_CARD}?.querySelector('[data-card-${control}]');
    if (button === null || button === undefined || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
    button.click();
    return true;`);
  interface StoredCard { readonly mode?: string; readonly outcome?: string; readonly confirmedAt?: number | null; readonly answeredBy?: string | null }
  /** A session's question cards as main reads them, oldest first, and what of the session still waits for an answer. */
  const storedCards = async (main: BrowserWindow, id: string): Promise<{ readonly cards: StoredCard[]; readonly waiting: number }> => {
    const read = (await ask(main, 'chat:read', { sessionId: id })).value;
    const items = (read?.['items'] ?? []) as { kind?: string; interaction?: StoredCard | null }[];
    return { cards: items.filter((item) => item.kind === 'interaction').map((item) => item.interaction ?? {}), waiting: ((read?.['waiting'] ?? []) as unknown[]).length };
  };
  /** A card as a problem may say it: its mode, its outcome and counts, never a text of it. */
  const cardSaid = (card: CardShown | undefined): string => JSON.stringify(card === undefined ? null : { mode: card.mode, outcome: card.outcome, questions: card.questions.map((question) => [question.options.length, question.chosen]), inputs: card.inputs, fields: card.fields, submit: card.submit, decline: card.decline, inForm: card.inForm, waits: card.waits, words: card.words.length, held: card.held });
  /** A settled card takes no answer (C39): no input, no field, no Submit or Decline; answered cards may be folded under their outcome header. */
  const isInert = (card: CardShown | undefined): boolean => card !== undefined && card.inputs === 0 && card.fields === 0 && card.submit === null && !card.decline && card.inForm === 0 && (card.words !== '' || card.folded);

  /**
   * M21 (V12; C15, C17, C37–C39, C47, C62): Claude asks through its question tool, and its turn
   * waits. The card stands in the chat with nothing chosen and nothing sent; the session's attention
   * counts one question and its capsule says so; the option the capture was answered with is chosen
   * and Submit pressed, and the turn goes on to its read and its answer, the CLI confirming the answer.
   */
  async function claudeQuestion(main: BrowserWindow, id: string): Promise<boolean> {
    if (prompts === null) return false;
    const held = onDisk(id)?.['reference'];
    const reference = typeof held === 'string' ? held : '';
    const before = { answers: chatSessions()[reference]?.answers?.length ?? 0, turns: chatSessions()[reference]?.turns.length ?? 0 };
    const option = prompts.questions.claudeOption;
    if (!(await send(main, id, prompts.questions.claude, 'Claude’s prompt that asks'))) return false;
    let card: CardShown | undefined;
    if (!(await waitFor('Claude’s question to show as a card that waits', async () => { card = (await cards(main)).at(-1); return card?.outcome === 'pending'; }))) return false;
    const asked = card?.questions[0];
    if (card === undefined || asked === undefined || card.mode !== 'blocking' || card.questions.length !== 1 || !asked.options.includes(option) || asked.chosen !== 0 || card.inputs !== asked.options.length || card.submit !== true || !card.decline || !card.waits || card.inForm !== 0) problems.push(`live: Claude’s card, waiting, reads ${cardSaid(card)}`);
    // The turn waits on it: the attention counts one question, in fat-g's words, and the capsule says so.
    const summary = entryOf(id)?.summary;
    if (summary?.status !== 'running' || summary.attention?.kind !== 'question' || summary.attention.count !== 1 || summary.action?.kind !== 'asking' || summary.action.label !== 'Asking a question') problems.push(`live: while Claude’s question waits its session reads ${JSON.stringify({ status: summary?.status, attention: summary?.attention ?? null, action: summary?.action?.kind ?? null })}`);
    // The page draws it from the state's next push: waited for, as the card was.
    let capsule: string | null = null;
    if (!(await waitFor('the capsule of a session whose question waits to say so', async () => { capsule = await inPage<string | null>(main, `return document.querySelector('[data-attention="question"]')?.textContent ?? null;`); return capsule === '1 Question'; }))) problems.push(`live: the capsule of a session whose question waits reads ${JSON.stringify(capsule)}`);
    // The card's own controls apart, the chat's list holds nothing a text may not become.
    const foreign = await inPage<number>(main, `const list = ${CHAT_LIST}; return list === null ? -1 : ${foreignIn('list')};`);
    if (foreign !== 0) problems.push(`live: with Claude’s card waiting the chat's list holds ${foreign} element(s) a text may not become`);
    // Nothing is sent until Submit is pressed (C38): choosing an option answers nothing.
    if (!(await choose(main, [option])) || !(await waitFor('the chosen option to show in Claude’s card', async () => (await cards(main)).at(-1)?.questions[0]?.chosen === 1))) { problems.push('live: Claude’s card took no choice'); return false; }
    if ((chatSessions()[reference]?.answers?.length ?? 0) !== before.answers || (await storedCards(main, id)).cards.at(-1)?.outcome !== 'pending') problems.push('live: Claude’s question was answered before Submit was pressed');
    if (!(await pressCard(main, 'submit'))) { problems.push('live: Claude’s card has no Submit to press'); return false; }
    if (!(await ended(id, 'Claude’s turn that asked'))) return false;
    if (lastOutcome(id) !== 'completed' || entryOf(id)?.summary.attention?.kind !== 'ready') problems.push(`live: Claude’s turn that asked is written ${JSON.stringify(onDisk(id)?.['lastTurn'])}, its attention ${String(entryOf(id)?.summary.attention?.kind)}`);
    let settled: CardShown | undefined;
    await waitFor('Claude’s card to read answered', async () => { settled = (await cards(main, [option])).at(-1); return settled?.outcome === 'answered' && settled.words === 'Answered'; });
    if (!isInert(settled) || settled?.held[0] !== true) problems.push(`live: Claude’s card, answered, reads ${cardSaid(settled)}`);
    // The turn went on to what the answer asked for: its answer is the chat's last message.
    if (!(await waitFor('the answer of Claude’s turn that asked to show', async () => (await shown(main)).at(-1)?.phase === 'final'))) problems.push('live: Claude’s turn that asked showed no answer after its card');
    // The fake was answered once, by `allow`, with the one option chosen; and it ran that one turn.
    const answers = (chatSessions()[reference]?.answers ?? []).slice(before.answers);
    if (answers.length !== 1 || answers[0]?.behavior !== 'allow' || JSON.stringify(Object.values(answers[0].updatedInput?.answers ?? {})) !== JSON.stringify([option])) problems.push(`live: Claude’s fake was answered ${JSON.stringify(answers.map((answer) => [answer.behavior, Object.keys(answer.updatedInput?.answers ?? {}).length]))}`);
    const turns = chatSessions()[reference]?.turns ?? [];
    if (turns.length !== before.turns + 1 || turns.at(-1) !== 'm21-question-one') problems.push(`live: Claude’s question ran ${JSON.stringify(turns.slice(before.turns))}`);
    // In the store: answered, with the CLI's own word that it took the answer (C62), and nothing waiting.
    const stored = await storedCards(main, id);
    const kept = stored.cards.at(-1);
    if (stored.cards.length !== 1 || kept?.mode !== 'blocking' || kept.outcome !== 'answered' || typeof kept.confirmedAt !== 'number' || stored.waiting !== 0) problems.push(`live: Claude’s question is stored ${JSON.stringify({ cards: stored.cards.map((entry) => [entry.mode, entry.outcome, typeof entry.confirmedAt]), waiting: stored.waiting })}`);
    report['claudeQuestion'] = { card: card?.mode ?? null, options: asked?.options.length ?? 0, capsule, answered: settled?.outcome === 'answered', confirmed: typeof kept?.confirmedAt === 'number', foreignElements: foreign };
    return true;
  }

  /**
   * M21 (V12; C26, C37–C41, C68): Codex asks in a message and ends its turn. The card follows the
   * message and waits for nothing; answered from the card, the answer is a prompt of the session's
   * in fat-g's words, whose turn the provider takes; a second card, of two questions, is dismissed,
   * and nothing is sent for that.
   */
  async function codexQuestions(main: BrowserWindow, id: string): Promise<boolean> {
    if (prompts === null) return false;
    const held = onDisk(id)?.['reference'];
    const reference = typeof held === 'string' ? held : '';
    const ran = (): number => threads()[reference]?.turns.length ?? 0;
    const turnsBefore = ran();
    const option = prompts.questions.codexOption;
    if (!(await send(main, id, prompts.questions.codex, 'Codex’s prompt that asks')) || !(await ended(id, 'Codex’s turn that asked'))) return false;
    let card: CardShown | undefined;
    // Its Submit is held while the page still shows the turn running (C38): the card is read once the page has the turn's end.
    if (!(await waitFor('Codex’s question to show as a card that can be answered', async () => { card = (await cards(main)).at(-1); return card?.outcome === 'open' && card.submit === true; }))) return false;
    const asked = card?.questions[0];
    if (card === undefined || asked === undefined || card.mode !== 'async' || card.questions.length !== 1 || !asked.options.includes(option) || asked.chosen !== 0 || card.submit !== true || !card.decline || card.waits || card.inForm !== 0) problems.push(`live: Codex’s card, open, reads ${cardSaid(card)}`);
    // It waits for nothing (C5): the turn ended as any does, and no question is counted.
    if (lastOutcome(id) !== 'completed' || entryOf(id)?.summary.attention?.kind !== 'ready') problems.push(`live: Codex’s turn that asked is written ${JSON.stringify(onDisk(id)?.['lastTurn'])}, its attention ${String(entryOf(id)?.summary.attention?.kind)}`);
    const foreign = await inPage<number>(main, `const list = ${CHAT_LIST}; return list === null ? -1 : ${foreignIn('list')};`);
    if (foreign !== 0) problems.push(`live: with Codex’s card open the chat's list holds ${foreign} element(s) a text may not become`);
    // Answered from the card: one more turn, the answer's own, which the fake knows by fat-g's words for it.
    if (!(await choose(main, [option])) || !(await waitFor('the chosen option to show in Codex’s card', async () => (await cards(main)).at(-1)?.questions[0]?.chosen === 1))) { problems.push('live: Codex’s card took no choice'); return false; }
    if (ran() !== turnsBefore + 1) problems.push('live: Codex’s question was answered before Submit was pressed');
    if (!(await pressCard(main, 'submit'))) { problems.push('live: Codex’s card has no Submit to press'); return false; }
    if (!(await waitFor('the turn that answers Codex’s question to run', () => ran() === turnsBefore + 2)) || !(await ended(id, 'the turn that answered Codex’s question'))) return false;
    let settled: CardShown | undefined;
    await waitFor('Codex’s card to read answered', async () => { settled = (await cards(main, [option])).at(-1); return settled?.outcome === 'answered' && settled.words === 'Answered'; });
    if (!isInert(settled) || settled?.held[0] !== true) problems.push(`live: Codex’s card, answered, reads ${cardSaid(settled)}`);
    if (lastOutcome(id) !== 'completed' || !(await waitFor('the answer to Codex’s answered question to show', async () => (await shown(main)).at(-1)?.phase === 'final'))) problems.push(`live: the turn that answered Codex’s question is written ${JSON.stringify(onDisk(id)?.['lastTurn'])}`);
    const first = await storedCards(main, id);
    if (first.cards.length !== 1 || first.cards[0]?.mode !== 'async' || first.cards[0].outcome !== 'answered' || typeof first.cards[0].answeredBy !== 'string' || typeof first.cards[0].confirmedAt !== 'number') problems.push(`live: Codex’s answered question is stored ${JSON.stringify(first.cards.map((entry) => [entry.mode, entry.outcome, typeof entry.answeredBy, typeof entry.confirmedAt]))}`);

    // A second, of two questions, dismissed: the card folds away and Codex is told nothing.
    if (!(await send(main, id, prompts.questions.codexTwo, 'Codex’s prompt that asks twice')) || !(await ended(id, 'Codex’s turn that asked twice'))) return false;
    let second: CardShown | undefined;
    if (!(await waitFor('Codex’s second card to show', async () => { second = (await cards(main)).at(-1); return second?.outcome === 'open'; }))) return false;
    if (second?.questions.length !== 2 || second.mode !== 'async') problems.push(`live: Codex’s second card reads ${cardSaid(second)}`);
    const beforeDismissal = ran();
    if (!(await pressCard(main, 'decline'))) { problems.push('live: Codex’s second card has no Decline to press'); return false; }
    let dismissed: CardShown[] = [];
    await waitFor('Codex’s second card to read dismissed', async () => { dismissed = await cards(main); return dismissed.at(-1)?.outcome === 'dismissed'; });
    if (dismissed.length !== 2 || dismissed[0]?.outcome !== 'answered' || !isInert(dismissed.at(-1)) || dismissed.at(-1)?.words !== OUTCOME_WORDS.dismissed) problems.push(`live: after the dismissal Codex’s cards read ${JSON.stringify(dismissed.map((entry) => entry.outcome))}, the last ${cardSaid(dismissed.at(-1))}`);
    if (ran() !== beforeDismissal || beforeDismissal !== turnsBefore + 3 || entryOf(id)?.summary.status !== 'idle') problems.push(`live: Codex ran ${ran() - turnsBefore} turn(s) for two questions asked, one answered and one dismissed, expected three`);
    report['codexQuestions'] = { card: card?.mode ?? null, answered: settled?.outcome === 'answered', confirmed: typeof first.cards[0]?.confirmedAt === 'number', second: second?.questions.length ?? 0, dismissed: dismissed.at(-1)?.outcome === 'dismissed', turns: ran() - turnsBefore, foreignElements: foreign };
    return true;
  }

  /**
   * M21 (V12; C39, C61): after a restart a session's cards are read from the store as they were
   * settled, and drawn inert: nothing waits, and nothing can be answered again.
   */
  async function questionsFromStore(main: BrowserWindow, id: string, who: 'Codex' | 'Claude', outcomes: readonly string[]): Promise<void> {
    const stored = await storedCards(main, id);
    if (JSON.stringify(stored.cards.map((card) => card.outcome)) !== JSON.stringify(outcomes) || stored.waiting !== 0 || entryOf(id)?.summary.attention?.kind === 'question') problems.push(`live: after the restart ${who}’s questions are stored ${JSON.stringify(stored.cards.map((card) => card.outcome))}, with ${stored.waiting} waiting`);
    let drawnCards: CardShown[] = [];
    if (!(await waitFor(`${who}’s cards to show in the chat read from the store`, async () => { drawnCards = await cards(main); return drawnCards.length === outcomes.length; }))) return;
    if (JSON.stringify(drawnCards.map((card) => card.outcome)) !== JSON.stringify(outcomes) || !drawnCards.every(isInert)) problems.push(`live: ${who}’s cards read from the store are drawn ${drawnCards.map(cardSaid).join(', ')}`);
    report[who === 'Codex' ? 'questionsFromStore' : 'claudeQuestionsFromStore'] = { cards: drawnCards.length, outcomes: drawnCards.map((card) => card.outcome), inert: drawnCards.every(isInert) };
  }
  const firstAction = (id: string, what: string) => waitFor(`${what}’s first action`, () => entryOf(id)?.summary.action !== null && entryOf(id)?.summary.action !== undefined);

  // ── M22: what a session may do — its mode, its approvals, its grants (V11, V12) ───────────────

  /** What `read` last answered, once `passes` took it; `ok` is false where it never did within the wait, which has then said so. */
  async function until<T>(what: string, read: () => T | Promise<T>, passes: (value: T) => boolean, timeoutMs = WAIT_MS): Promise<{ readonly ok: boolean; readonly last: T | undefined }> {
    let last: T | undefined;
    const ok = await waitFor(what, async () => { last = await read(); return passes(last); }, timeoutMs);
    return { ok, last };
  }

  /** Completes a permission session, as the two before it were: its process closes at once (M15, C85), and the first half leaves none of them running. */
  async function completePermitted(main: BrowserWindow, id: string, who: 'Codex' | 'Claude', pid: number): Promise<void> {
    const running = fixtureOf(who, pid);
    const completed = await ask(main, 'sessions:complete', { id });
    if (completed.value?.['status'] !== 'saved') problems.push(`live: completing ${who}’s permission session answered ${JSON.stringify(completed.value ?? completed.error)}`);
    await waitFor(`the process of ${who}’s completed permission session to end`, () => fixtureGone(who, running), 10_000);
  }

  /** Whether the Main page shows that session as the selected one: its header, its mode control and its grants are then that session's. Its chat says so where it has no capsule yet (M26, round 2). */
  const shownSelected = (main: BrowserWindow, id: string): Promise<boolean> =>
    inPage(main, `return document.querySelector('[data-chat-session="' + ${JSON.stringify(id)} + '"]') !== null || [...document.querySelectorAll('[data-selected]')].some((element) => element.getAttribute('data-session-id') === ${JSON.stringify(id)} || element.getAttribute('data-thin-session') === ${JSON.stringify(id)});`);

  /** An approval's card as the page draws it. Nothing of its request's text is answered: a command, a path and what a grant covers are conversation content. */
  interface ApprovalShown {
    readonly kind: string | null; readonly outcome: string | null;
    /** Its choices by name, in order; Stop; the disclosure of the whole action; and how much that disclosure shows, nothing while it is closed. */
    readonly choices: readonly string[]; readonly stop: boolean; readonly disclosure: boolean; readonly detail: number;
    /** What it says became of it, as which of fat-g's own words it is: the words themselves name what a grant covers. */
    readonly said: 'none' | 'approved' | 'denied' | 'session' | 'session-ended' | 'other';
    /** How long its one line is, and how many of its controls stand in a form: none may. */
    readonly summary: number; readonly inForm: number;
  }
  /** The chat's approval cards as the page draws them, oldest first. */
  const approvalCards = (main: BrowserWindow): Promise<ApprovalShown[]> => inPage(main, `
    const words = ${JSON.stringify({ approved: APPROVAL_WORDS.approved, denied: APPROVAL_WORDS.denied, session: `${APPROVAL_WORDS.approvedSession}: `, ended: `; ${APPROVAL_WORDS.grantEnded}` })};
    return [...(${CHAT_LIST}?.querySelectorAll('article[data-kind="approval"]') ?? [])].map((card) => {
      const outcome = card.querySelector('[data-card-outcome]')?.textContent ?? null;
      const disclosure = card.querySelector('[data-approval-detail]');
      const shown = disclosure?.getAttribute('aria-expanded') === 'true' ? document.getElementById(disclosure.getAttribute('aria-controls') ?? '') : null;
      return {
        kind: card.getAttribute('data-approval'), outcome: card.getAttribute('data-outcome'),
        choices: [...card.querySelectorAll('[data-approval-choice]')].map((button) => button.getAttribute('data-approval-choice') ?? ''),
        stop: card.querySelector('[data-approval-stop]') !== null, disclosure: disclosure !== null, detail: (shown?.textContent ?? '').length,
        said: outcome === null ? 'none' : outcome === words.approved ? 'approved' : outcome === words.denied ? 'denied' : !outcome.startsWith(words.session) ? 'other' : outcome.endsWith(words.ended) ? 'session-ended' : 'session',
        summary: (card.querySelector('[data-approval-summary]')?.textContent ?? '').length,
        inForm: card.querySelectorAll('form').length + [...card.querySelectorAll('button, input, textarea')].filter((control) => control.form !== null).length,
      };
    });`);
  /** A settled card is inert (C13): no choice and no Stop, its outcome in words, and its whole action still behind its disclosure. */
  const settledAs = (card: ApprovalShown | undefined, outcome: string, said: ApprovalShown['said']): boolean => card !== undefined && card.outcome === outcome && card.said === said && card.choices.length === 0 && !card.stop && card.disclosure && card.inForm === 0;
  /** Presses a control of the chat's newest card that waits for a decision: one of its choices, or the disclosure of its whole action. */
  const pressApproval = (main: BrowserWindow, control: 'approve' | 'approve-session' | 'deny' | 'detail'): Promise<boolean> => inPage(main, `
    const card = [...(${CHAT_LIST}?.querySelectorAll('article[data-kind="approval"][data-outcome="pending"]') ?? [])].at(-1);
    const button = card?.querySelector(${JSON.stringify(control === 'detail' ? '[data-approval-detail]' : `[data-approval-choice="${control}"]`)});
    if (button === null || button === undefined || button.disabled) return false;
    button.click();
    return true;`);
  interface StoredApproval { readonly kind?: string; readonly outcome?: string; readonly delivered?: boolean | null; readonly confirmedAt?: number | null; readonly grant?: { readonly live?: boolean } | null }
  interface StoredPermissions {
    /** The session's approvals as main reads them, oldest first; the grants fat-g sent, by whether the CLI confirmed each and whether it is live; what still waits; and the chat's saved mode. */
    readonly approvals: StoredApproval[]; readonly grants: { readonly confirmed: boolean; readonly live: boolean }[]; readonly waiting: number; readonly mode: { readonly id?: string; readonly source?: string } | null;
  }
  const permissionsOf = async (main: BrowserWindow, id: string): Promise<StoredPermissions> => {
    const read = (await ask(main, 'chat:read', { sessionId: id })).value;
    const items = (read?.['items'] ?? []) as { kind?: string; interaction?: StoredApproval | null }[];
    return {
      approvals: items.filter((item) => item.kind === 'interaction' && item.interaction?.kind === 'approval').map((item) => item.interaction ?? {}),
      grants: ((read?.['grants'] ?? []) as { confirmed?: boolean; live?: boolean }[]).map((grant) => ({ confirmed: grant.confirmed === true, live: grant.live === true })),
      waiting: ((read?.['waiting'] ?? []) as unknown[]).length, mode: read?.['mode'] ?? null,
    };
  };
  /** An approval as a problem may say it: what was decided and what is known of the decision, never its request. */
  const storedSaid = (stored: StoredPermissions): string => JSON.stringify({ approvals: stored.approvals.map((entry) => [entry.outcome, entry.delivered, typeof entry.confirmedAt, entry.grant?.live ?? null]), grants: stored.grants, waiting: stored.waiting, mode: stored.mode });

  interface GrantsShown { readonly listed: boolean; readonly live: number; readonly confirmed: number; readonly ended: number }
  /** The selected session's grants as the page lists them, the ended ones unfolded: counts, and never what one covers. */
  const grantsShown = (main: BrowserWindow): Promise<GrantsShown> => inPage(main, `
    // The grants fold under one line in the Sub-agents tab (M106, C31): unfolded first.
    const fold = document.querySelector('[data-grants-fold]');
    if (fold !== null && fold.getAttribute('aria-expanded') === 'false') fold.click();
    const list = document.querySelector('[data-grants]');
    if (list === null) return { listed: false, live: 0, confirmed: 0, ended: 0 };
    const rows = [...list.querySelectorAll('[data-grant]')];
    return { listed: true, live: rows.filter((row) => row.hasAttribute('data-live')).length, confirmed: rows.filter((row) => row.hasAttribute('data-confirmed')).length, ended: rows.filter((row) => !row.hasAttribute('data-live')).length };`);

  interface ModeShown { readonly saved: string | null; readonly source: string | null; readonly pending: boolean }
  /** The mode control in the selected session's header: the chat's saved mode, where it came from, and whether it still waits for a process to confirm it. */
  const modeShown = (main: BrowserWindow): Promise<ModeShown | null> => inPage(main, `
    const control = document.querySelector('[data-session-mode]');
    return control === null ? null : { saved: control.getAttribute('data-session-mode'), source: control.getAttribute('data-mode-source'), pending: control.hasAttribute('data-mode-pending') };`);
  interface ModeItem {
    readonly id: string; readonly chosen: boolean; readonly disabled: boolean;
    /** Why its account cannot use it, and whether a Set up control stands under it. */
    readonly unavailable: string | null; readonly setup: boolean;
    /** What it says the change would do, in fat-g's words: restart the process, end the session's grants; and that its account has no sandbox. */
    readonly restarts: boolean; readonly endsGrants: boolean; readonly unconfined: boolean;
  }
  interface ModeMenuShown { readonly held: boolean; readonly inherited: number; readonly items: ModeItem[] }
  /** The mode menu while it stands open, or null: `liveGrants` is the count its line on the grants a restart ends would name. */
  const modeMenu = (main: BrowserWindow, liveGrants = 0): Promise<ModeMenuShown | null> => inPage(main, `
    const menu = document.querySelector('[data-mode-menu]');
    if (menu === null) return null;
    const words = ${JSON.stringify({ restarts: MODE_WORDS.restarts, ends: MODE_WORDS.endsGrants(liveGrants), unconfined: MODE_WORDS.unconfined })};
    return {
      held: menu.querySelector('[data-mode-held]') !== null, inherited: (menu.querySelector('[data-mode-inherited]')?.textContent ?? '').length,
      items: [...menu.querySelectorAll('[role="menuitemradio"][data-mode]')].map((item) => {
        const id = item.getAttribute('data-mode') ?? '';
        const text = item.textContent ?? '';
        return {
          id, chosen: item.getAttribute('aria-checked') === 'true', disabled: item.getAttribute('aria-disabled') === 'true',
          unavailable: item.getAttribute('data-unavailable'), setup: menu.querySelector('[data-mode-setup="' + id + '"]') !== null,
          restarts: text.includes(words.restarts), endsGrants: text.includes(words.ends), unconfined: text.includes(words.unconfined),
        };
      }),
    };`);
  /** Opens the mode control's menu from its button in the session's header, unless it stands open already. */
  async function openModeMenu(main: BrowserWindow, id: string, who: string): Promise<boolean> {
    if (!(await waitFor(`${who}’s permission session to show as the selected one`, () => shownSelected(main, id)))) return false;
    const pressed = await inPage<boolean>(main, `
      if (document.querySelector('[data-mode-menu]') !== null) return true;
      const button = document.querySelector('[data-session-mode] button[aria-haspopup="menu"]');
      button?.click();
      return button !== null;`);
    if (!pressed) { problems.push(`live: ${who}’s header shows no mode control`); return false; }
    return waitFor(`${who}’s mode menu to open`, async () => (await modeMenu(main)) !== null);
  }
  /** Closes the mode menu by the keyboard, as Escape does. */
  const closeModeMenu = (main: BrowserWindow): Promise<boolean> => waitFor('the mode menu to close', async () => {
    await inPage(main, `document.querySelector('[data-mode-menu]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return true;`);
    return (await modeMenu(main)) === null;
  });
  /**
   * Chooses a mode in the menu, as a press on its item does, once the item can be chosen, and waits
   * until main has taken the change. Answers the item as the menu showed it before the press: what
   * it said the change would do.
   */
  async function chooseMode(main: BrowserWindow, id: string, mode: string, who: string, liveGrants = 0): Promise<ModeItem | null> {
    if (!(await openModeMenu(main, id, who))) return null;
    const offered = await until(`${who}’s menu to offer ${mode}`, async () => { const menu = await modeMenu(main, liveGrants); return menu === null || menu.held ? undefined : menu.items.find((entry) => entry.id === mode); }, (item) => item !== undefined && !item.disabled);
    if (!offered.ok || offered.last === undefined) { problems.push(`live: ${who}’s mode menu shows ${JSON.stringify(await modeMenu(main, liveGrants))}`); return null; }
    await inPage(main, `document.querySelector('[data-mode-menu] [role="menuitemradio"][data-mode=${JSON.stringify(mode)}]')?.click(); return true;`);
    if (!(await waitFor(`${who}’s chat to have the mode ${mode}`, () => entryOf(id)?.mode?.id === mode && entryOf(id)?.mode?.source === 'chat' && entryOf(id)?.changingMode === false))) {
      // What main says of the chat, and how much the control says of a refusal: its words are fat-g's, their length is enough here.
      const said = await inPage<number>(main, `return (document.querySelector('[data-session-mode] [role="status"]')?.textContent ?? '').length;`);
      problems.push(`live: after ${mode} was pressed ${who}’s chat reads ${JSON.stringify({ mode: entryOf(id)?.mode ?? null, changing: entryOf(id)?.changingMode ?? null, block: entryOf(id)?.block ?? null })}, and its control says ${said} character(s)`);
      return null;
    }
    return offered.last;
  }
  /** What the Pet's state holds that it may not (C28): the sessions, an account's modes or its sandbox setup, and a name of the conversation's. */
  const petHolds = async (pet: BrowserWindow, name: string): Promise<string[]> => (await pet.webContents.executeJavaScript(`window.fatg.invoke('state:getSnapshot', null).then((r) => !r.ok ? ['unread'] : [
    ...('sessions' in r.value ? ['sessions'] : []), ...(r.value.providers.some((provider) => 'modes' in provider) ? ['modes'] : []),
    ...(r.value.providers.some((provider) => 'sandboxSetup' in provider) ? ['sandboxSetup'] : []), ...(JSON.stringify(r.value).includes(${JSON.stringify(name)}) ? ['a name'] : []),
    // Its own view lists the session that waits by its name and state alone: no action's words, no mode (decision 0010).
    ...(/"label"|"detail"|"mode"|"agents"|"context"/.test(JSON.stringify(r.value.pet ?? {})) ? ['a session’s detail'] : []),
  ], () => ['unread'])`)) as string[];
  /** The capsule of a session whose approval waits, as the page reads it. */
  const approvalCapsule = (main: BrowserWindow) => until('the capsule of a session whose approval waits to say so', () => inPage<string | null>(main, `return document.querySelector('[data-attention="approval"]')?.textContent ?? null;`), (text) => text === '1 Approval');
  /** How many times the Main page's policy was violated so far, as the page itself counted: '0' for none. Read while the page stands, since the next half ends by quitting. */
  const violations = async (main: BrowserWindow, what: string): Promise<string | null> => {
    const count = await inPage<string | null>(main, `return document.querySelector('[data-smoke-page]')?.getAttribute('data-smoke-csp') ?? null;`).catch(() => null);
    if (count !== '0') problems.push(`main: CSP violations after ${what}: ${String(count)}`);
    return count;
  };
  /** How many elements the chat's list holds that a text may not become: -1 with no list. */
  const foreignInChat = (main: BrowserWindow): Promise<number> => inPage(main, `const list = ${CHAT_LIST}; return list === null ? -1 : ${foreignIn('list')};`);

  /**
   * M22 (V11, V12; C1, C2, C5, C8, C12, C13, C21, C45, C48, C56, C57, C69, C74, C75, C78, C82, C86): what a
   * Claude session may do, on a session made for it — the first one's single process and single
   * answer stay what they were. Ask first is chosen explicitly for this approval check.
   * A command asks leave: its card stands in the chat, the capsule counts one approval, and nothing
   * runs until Approve once is pressed; the fake then makes the file. The same command asks again
   * and is granted for the session; the next turn runs it with no card, and the grants list shows
   * the grant live. Read only, chosen from the menu, closes the process and ends the grant; back
   * under Ask first the next turn asks again, in a new process, and is granted again. Edits ok is
   * then taken on that live process, with no restart and the grant still live; Read only closes it,
   * every grant ended, and the next prompt runs on the reading launch.
   */
  // ── M22b: a plan (V7; C1, C10–C15, C24, C25, C27, C64) ──────────────────────────────────────

  /** Types into the composer and presses its primary button, whatever it reads: Send, or Plan while the next prompt is a plan turn. */
  const typeAndPress = (main: BrowserWindow, id: string, text: string): Promise<boolean> => inPage(main, `
    const shown = (document.querySelector('[data-chat-session="' + ${JSON.stringify(id)} + '"]') !== null || [...document.querySelectorAll('[data-selected]')].some((element) => element.getAttribute('data-session-id') === ${JSON.stringify(id)} || element.getAttribute('data-thin-session') === ${JSON.stringify(id)}));
    const area = document.querySelector(${JSON.stringify(COMPOSER_INPUT)});
    if (!shown || area === null) return false;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, ${JSON.stringify(text)});
    area.dispatchEvent(new Event('input', { bubbles: true }));
    const button = document.querySelector('${CHAT_MAIN} [data-primary]');
    if (button === null || button.disabled || button.textContent !== 'Plan') return false;
    button.click();
    return true;`);
  interface PlanShown { readonly panel: string | null; readonly lines: readonly { readonly plan: string | null; readonly outcome: string | null; readonly came: string | null }[]; readonly tab: string | null; readonly send: string | null }
  const planShown = (main: BrowserWindow): Promise<PlanShown> => inPage(main, `
    const chat = document.querySelector('${CHAT_MAIN}');
    const panel = chat?.querySelector('[data-plan-panel]') ?? null;
    return {
      panel: panel?.getAttribute('data-plan-panel') ?? null,
      lines: [...(chat?.querySelectorAll('[data-plan-line]') ?? [])].map((line) => ({ plan: line.getAttribute('data-plan-line'), outcome: line.getAttribute('data-outcome'), came: line.getAttribute('data-came') })),
      tab: document.querySelector('[data-plan-tab]')?.getAttribute('data-plan-tab') ?? null,
      send: chat?.querySelector('[data-primary]')?.textContent ?? null,
    };`);
  /** Presses Plan where it is not pressed: true once it is. */
  const pressPlanToggle = (main: BrowserWindow): Promise<boolean> => inPage(main, `
    const button = document.querySelector('${CHAT_MAIN} [data-tool="plan"]');
    if (button === null || button.getAttribute('aria-disabled') === 'true') return false;
    if (button.getAttribute('aria-pressed') !== 'true') button.click();
    return button.getAttribute('aria-pressed') === 'true';`);
  const pressPlanPanel = (main: BrowserWindow, control: 'execute' | 'cancel' | 'leave'): Promise<boolean> => inPage(main, `
    const button = document.querySelector('${CHAT_MAIN} [data-plan-panel] [data-plan-${control}]');
    if (button === null || button.disabled) return false;
    button.click();
    return true;`);
  /** Denies each card that waits while the session runs (what a plan's execution asks leave for), until its turn has ended. */
  const deniedToEnd = (main: BrowserWindow, id: string, what: string): Promise<boolean> =>
    waitFor(what, async () => { await pressApproval(main, 'deny'); return entryOf(id)?.summary.status === 'idle' && ((onDisk(id)?.['lastTurn'] as { endedAt?: number | null } | null)?.endedAt ?? null) !== null; }, WAIT_MS * 2);
  const lineOutcome = async (main: BrowserWindow, planId: string): Promise<string | null> => (await planShown(main)).lines.filter((line) => line.plan === planId).at(-1)?.outcome ?? null;

  /** The plan status line above the shown chat's input (decision 0029): implementing, interrupted or implemented. */
  const planStatus = (main: BrowserWindow): Promise<string | null> => inPage(main, `return document.querySelector('${CHAT_MAIN} [data-plan-status]')?.getAttribute('data-plan-status') ?? null;`);
  /** How many plans the store keeps, of the listed sessions' projects. */
  const planCount = async (main: BrowserWindow): Promise<number | null> => {
    const storage = await ask(main, 'plans:storage', null);
    return typeof storage.value?.['count'] === 'number' ? storage.value['count'] : null;
  };

  /**
   * A plan turn of the provider's in a session made for it, under the chat's mode: Plan pressed,
   * Send reading Plan, the plan's line in the chat, its tab opened by itself, PLAN READY, the
   * decision panel in the input's place — and Execute, whose leave asked for is denied, the line
   * reading executed and the chat saying the plan was implemented in it (0029). Answers the session and the plan.
   */
  async function planOn(main: BrowserWindow, project: StoredProject, who: 'Codex' | 'Claude', prompt: string): Promise<{ readonly id: string; readonly planId: string } | undefined> {
    const waiting = await planWaiting(main, project, who, prompt);
    if (waiting === undefined) return undefined;
    const { id, planId } = waiting;
    if (!(await pressPlanPanel(main, 'execute'))) { problems.push(`live: ${who}’s plan panel has no Execute to press`); return undefined; }
    if (!(await deniedToEnd(main, id, `${who}’s executed plan’s turn to end`))) return undefined;
    const executed = await until(`${who}’s plan line to read executed`, () => lineOutcome(main, planId), (outcome) => outcome === 'executed');
    if (!executed.ok) problems.push(`live: ${who}’s executed plan’s line reads ${String(executed.last)}`);
    const implemented = await until(`${who}’s chat to say its plan was implemented`, () => planStatus(main), (status) => status === 'implemented');
    if (!implemented.ok) problems.push(`live: ${who}’s executed plan’s status line reads ${String(implemented.last)}`);
    return { id, planId };
  }

  /** A plan turn of the provider's in a session made for it, its plan waiting for its decision in the panel (M22b; M22e). */
  async function planWaiting(main: BrowserWindow, project: StoredProject, who: 'Codex' | 'Claude', prompt: string): Promise<{ readonly id: string; readonly planId: string } | undefined> {
    const ref = [{ providerId: who === 'Codex' ? 'codex' : 'claude', instanceId: FIRST_INSTANCE_ID }];
    const created = await ask(main, 'sessions:create', { projectId: project.id, preset: defaultPreset(presetTiles(store.getSnapshot().catalog, ref)) });
    const id = typeof created.value?.['id'] === 'string' ? created.value['id'] : '';
    if (created.value?.['status'] !== 'saved' || !(await waitFor(`${who}’s plan session to take a prompt`, () => entryOf(id)?.block === null))) { problems.push(`live: creating ${who}’s plan session answered ${JSON.stringify(created.value ?? created.error)}`); return undefined; }
    if (!(await waitFor(`${who}’s plan session to be shown`, () => shownSelected(main, id)))) return undefined;
    if (!(await waitFor(`${who}’s Plan to be pressed`, () => pressPlanToggle(main)))) return undefined;
    if (!(await waitFor(`${who}’s Send to read Plan`, async () => (await planShown(main)).send === 'Plan'))) return undefined;
    if (!(await waitFor(`the composer to take ${who}’s plan prompt`, () => typeAndPress(main, id, prompt)))) return undefined;
    // The plan's line waits for its decision: a request's while its turn runs (Claude), an item's once its turn ended (Codex).
    const waiting = await until(`${who}’s plan to wait for its decision`, () => planShown(main), (shown) => shown.panel !== null && shown.lines.at(-1)?.outcome === 'pending');
    if (!waiting.ok || waiting.last?.panel == null) { problems.push(`live: ${who}’s plan shows ${JSON.stringify(waiting.last ?? null)}`); return undefined; }
    const planId = waiting.last.panel;
    const tab = await until(`${who}’s plan tab to open by itself`, () => planShown(main), (shown) => shown.tab === planId);
    if (!tab.ok) problems.push(`live: ${who}’s plan tab is ${String(tab.last?.tab)}`);
    if (who === 'Codex' && !(await waitFor('Codex’s plan turn to end', () => entryOf(id)?.summary.status === 'idle'))) return undefined;
    if (entryOf(id)?.summary.attention?.kind !== 'plan' || entryOf(id)?.planPending !== true) problems.push(`live: ${who}’s plan waits with attention ${String(entryOf(id)?.summary.attention?.kind)} and planPending ${String(entryOf(id)?.planPending)}`);
    return { id, planId };
  }

  // ── M22e: a plan's review (V5; C1, C2, C7–C11, C28–C31, C39) ──────────────────────────────────

  /** A review's view as main answers it to the page. */
  interface ReviewRead { readonly state?: string; readonly closed?: string | null; readonly staleBy?: number | null; readonly rounds?: readonly { readonly marks: Record<string, string>; readonly notes: Record<string, string>; readonly findings: readonly { readonly id: string; readonly was?: string }[] }[]; readonly integrations?: readonly { readonly state: string; readonly produced: number | null }[] }
  const reviewRead = async (main: BrowserWindow, reviewId: string): Promise<ReviewRead | null> => {
    const answer = await ask(main, 'reviews:read', { reviewId });
    return answer.value?.['status'] === 'read' ? (answer.value['review'] as ReviewRead) : null;
  };
  /** Presses a control of the shown chat by its attribute: true where it stood and was pressed. */
  const pressIn = (main: BrowserWindow, selector: string): Promise<boolean> => inPage(main, `
    const control = document.querySelector('${CHAT_MAIN} ' + ${JSON.stringify(selector)}) ?? document.querySelector(${JSON.stringify(selector)});
    if (control === null || control.disabled || control.getAttribute('aria-disabled') === 'true') return false;
    control.click();
    return true;`);

  /**
   * A review on one provider, through the page (M22e, V5): a plan waiting in a session made for it,
   * started through IPC while its entry points are hidden, the reviewer selected and its round drawn as a list;
   * a mark, a note typed into its field and Send notes, the settling note's round carrying the mark;
   * every finding accepted by its tier's Accept all; and Integrate into the plan's own chat, whose
   * next version settles the integration. Answers what the next launch checks.
   */
  async function reviewOn(main: BrowserWindow, project: StoredProject, who: 'Codex' | 'Claude', prompt: string): Promise<Reviewed | undefined> {
    const plan = await planWaiting(main, project, who, prompt);
    if (plan === undefined) return undefined;
    // Review entry points are intentionally hidden; still exercise the retained workflow through Main-only IPC.
    if (await inPage<boolean>(main, `return document.querySelector('[data-review-by-model], [data-tool="review"]') !== null;`)) problems.push(`live: ${who}’s hidden review entry points are visible`);
    const read = (await ask(main, 'plans:read', { planId: plan.planId, start: 0, length: 1 })).value as unknown as PlanRead | undefined;
    const preset = defaultPreset(presetTiles(store.getSnapshot().catalog, [{ providerId: who === 'Codex' ? 'codex' : 'claude', instanceId: FIRST_INSTANCE_ID }]));
    if (read?.status !== 'read' || preset === null) { problems.push(`live: ${who}’s plan could not be read for review`); return undefined; }
    const started = await ask(main, 'reviews:start', { sessionId: plan.id, planId: plan.planId, version: read.version, revision: read.workflow.revision, preset });
    if (started.value?.['status'] !== 'started') { problems.push(`live: ${who}’s review could not start`); return undefined; }
    // The reviewer is made and selected (C39).
    const reviewer = await until(`${who}’s reviewer to be selected`, () => sessions.snapshot().selectedId, (selected) => selected !== null && selected !== plan.id);
    const reviewerId = reviewer.last ?? '';
    if (!reviewer.ok) { problems.push(`live: ${who}’s reviewer was not selected`); return undefined; }
    const own = await ask(main, 'reviews:read', { sessionId: reviewerId });
    const held: unknown = own.value?.['review'];
    const reviewId = typeof held === 'object' && held !== null && typeof (held as { reviewId?: unknown }).reviewId === 'string' ? (held as { reviewId: string }).reviewId : '';
    const drawn = await until(`${who}’s first round to be drawn`, () => inPage<number>(main, `return document.querySelectorAll('${CHAT_MAIN} [data-findings][data-live] [data-finding]').length;`), (rows) => rows > 2, WAIT_MS * 2);
    if (!drawn.ok || reviewId === '') { problems.push(`live: ${who}’s review drew ${String(drawn.last)} finding row(s)`); return undefined; }
    if (!(await waitFor(`${who}’s reviewer to come to rest`, () => entryOf(reviewerId)?.summary.status === 'idle'))) return undefined;
    const first = await reviewRead(main, reviewId);
    const ids = first?.rounds?.[0]?.findings.map((finding) => finding.id) ?? [];
    // A mark by its control, and a note typed into its field and left (C28, C30).
    await pressIn(main, `[data-finding="${ids[0] ?? ''}"] [data-finding-accept]`);
    await pressIn(main, `[data-finding="${ids[1] ?? ''}"] [data-finding-note]`);
    const typed = await waitFor(`${who}’s note field`, () => inPage<boolean>(main, `
      const field = document.querySelector('[data-note-field="${ids[1] ?? ''}"]');
      if (field === null) return false;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, 'This is minor.');
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
      field.blur();
      return true;`));
    const noted = typed && await waitFor(`${who}’s note to be written`, async () => (await reviewRead(main, reviewId))?.rounds?.[0]?.notes[ids[1] ?? ''] === 'This is minor.');
    if (!noted) problems.push(`live: ${who}’s note was not written`);
    if (!(await waitFor(`${who}’s Send notes`, () => pressIn(main, '[data-review-panel] [data-review-send]')))) { problems.push(`live: ${who}’s triage panel offers no Send notes`); return undefined; }
    const settled = await until(`${who}’s settling note’s round`, () => reviewRead(main, reviewId), (read) => (read?.rounds?.length ?? 0) === 2, WAIT_MS * 2);
    const second = settled.last?.rounds?.[1];
    if (!settled.ok || second?.marks[ids[0] ?? ''] !== 'accepted' || !second.findings.some((finding) => finding.was !== undefined && finding.was !== finding.id)) problems.push(`live: ${who}’s second round reads ${JSON.stringify(second ?? null)}`);
    if (!(await waitFor(`${who}’s reviewer to rest after Send notes`, () => entryOf(reviewerId)?.summary.status === 'idle'))) return undefined;
    // Every finding decided, by each tier's Accept all (C28).
    await waitFor(`${who}’s tiers to be accepted`, async () => {
      await inPage(main, `for (const button of document.querySelectorAll('${CHAT_MAIN} [data-findings][data-live] button[aria-label^="Accept all"]')) button.click(); return true;`);
      const read = await reviewRead(main, reviewId);
      return Object.values(read?.rounds?.at(-1)?.marks ?? { none: 'open' }).every((mark) => mark !== 'open');
    });
    const before = await reviewRead(main, reviewId);
    const kept: Reviewed = { reviewId, reviewer: reviewerId, rounds: before?.rounds?.length ?? 0, marks: before?.rounds?.at(-1)?.marks ?? {}, notes: before?.rounds?.[0]?.notes ?? {}, closed: before?.closed ?? null, integrated: false };
    // Integrate into the plan's own chat (C9–C11): its line's feedback.
    if (!(await waitFor(`${who}’s Integrate`, () => pressIn(main, '[data-review-panel] [data-review-integrate]')))) { problems.push(`live: ${who}’s triage panel offers no Integrate`); return kept; }
    if (!(await waitFor(`${who}’s target to be chosen`, () => pressIn(main, `[data-integrate-popup] [data-target="${plan.id}"] input`))) || !(await waitFor(`${who}’s Integrate to be confirmed`, () => pressIn(main, '[data-integrate-popup] [data-integrate-confirm]')))) { problems.push(`live: ${who}’s target popup offers no route into the plan’s chat`); return kept; }
    const settledIn = await until(`${who}’s integration to settle`, async () => { await pressApproval(main, 'deny'); return reviewRead(main, reviewId); }, (read) => read?.integrations?.[0]?.state !== undefined && read.integrations[0].state !== 'sent', WAIT_MS * 3);
    const integration = settledIn.last?.integrations?.[0];
    // The hand-off closed the review (0029): no other chat holds the plan while v2 is written.
    if (integration?.state !== 'integrated' || integration.produced !== 2 || settledIn.last?.staleBy !== 2 || settledIn.last.closed !== 'handed') problems.push(`live: ${who}’s integration reads ${JSON.stringify(integration ?? null)}, the review stale by ${String(settledIn.last?.staleBy)} and closed ${String(settledIn.last?.closed)}`);
    // v2 waits in the plan's chat: on Claude in the request its turn holds, which Leave plan mode closes so the
    // turn ends, the plan and its review kept for the next launch (0029); a Discard would delete them.
    if (who === 'Claude') {
      await ask(main, 'sessions:select', { id: plan.id });
      if (!(await waitFor('Claude’s plan chat to be shown again', () => shownSelected(main, plan.id))) || !(await waitFor('Claude’s v2 to be left', () => pressPlanPanel(main, 'leave')))) problems.push('live: Claude’s v2 panel has no Leave plan mode, keep plan');
    }
    await waitFor(`${who}’s plan chat to come to rest`, () => entryOf(plan.id)?.summary.status === 'idle', WAIT_MS * 2);
    return { ...kept, closed: settledIn.last?.closed ?? null, integrated: integration?.state === 'integrated' };
  }

  /** M22e (V5): a review on each provider, through the page. */
  async function reviews(main: BrowserWindow, project: StoredProject): Promise<{ readonly codex: Reviewed; readonly claude: Reviewed } | undefined> {
    if (prompts === null) return undefined;
    const codex = await reviewOn(main, project, 'Codex', prompts.plans.codex);
    if (codex === undefined) return undefined;
    const claude = await reviewOn(main, project, 'Claude', prompts.plans.claude);
    if (claude === undefined) return undefined;
    const storage = await ask(main, 'plans:storage', null);
    if (typeof storage.value?.['reviews'] !== 'number' || storage.value['reviews'] < 2) problems.push(`live: the plans' storage counts ${JSON.stringify(storage.value?.['reviews'] ?? storage.error)} reviews`);
    report['reviews'] = { codex: { rounds: codex.rounds, integrated: codex.integrated }, claude: { rounds: claude.rounds, integrated: claude.integrated }, stored: storage.value?.['reviews'] ?? null };
    return { codex, claude };
  }

  /** M22e (V5): each review as this launch finds it: its rounds, marks and notes kept, closed as it was by its hand-off, its integration settled. */
  async function reviewsFromStore(main: BrowserWindow, kept: Reviewed, who: string): Promise<void> {
    const read = await reviewRead(main, kept.reviewId);
    const marks = read?.rounds?.at(-1)?.marks ?? {};
    if (read === null || (read.rounds?.length ?? 0) !== kept.rounds || JSON.stringify(marks) !== JSON.stringify(kept.marks) || JSON.stringify(read.rounds?.[0]?.notes ?? {}) !== JSON.stringify(kept.notes) || (read.closed ?? null) !== kept.closed || (kept.integrated && read.integrations?.[0]?.state !== 'integrated')) {
      problems.push(`live: ${who}’s review was read back as ${JSON.stringify(read === null ? null : { rounds: read.rounds?.length, marks, closed: read.closed ?? null, integration: read.integrations?.[0]?.state })}`);
    }
  }

  /**
   * M22b (V7), under the shared workflow (decision 0029): a plan on each provider, executed and so
   * deleted; one of Codex's discarded, and deleted too; and one of Codex's kept by Leave plan mode,
   * brought into Claude's chat and executed there. None of the four is left in the store.
   */
  async function plans(main: BrowserWindow, project: StoredProject): Promise<boolean> {
    if (prompts === null) return false;
    const storedBefore = await planCount(main);
    const codex = await planOn(main, project, 'Codex', prompts.plans.codex);
    if (codex === undefined) return false;
    // Discard plan: another plan turn in Codex's chat, discarded from its panel; Codex is sent nothing for it.
    const turnsOf = (all: Record<string, Thread>): number => Object.values(all).reduce((sum, thread) => sum + thread.turns.length, 0);
    /** Another plan turn in Codex's chat, waiting for its decision once the turn has ended. */
    const another = async (which: string, earlier: readonly string[]): Promise<string | undefined> => {
      if (!(await waitFor('Codex’s Plan to stay pressed', () => pressPlanToggle(main))) || !(await waitFor(`the composer to take Codex’s ${which} plan prompt`, () => typeAndPress(main, codex.id, prompts.plans.codex)))) return undefined;
      const shown = await until(`Codex’s ${which} plan to wait`, () => planShown(main), (now) => now.panel !== null && !earlier.includes(now.panel) && entryOf(codex.id)?.summary.status === 'idle');
      return shown.ok ? (shown.last?.panel ?? undefined) : undefined;
    };
    const second = await another('second', [codex.planId]);
    if (second === undefined) return false;
    const ranBefore = turnsOf(threads());
    if (!(await pressPlanPanel(main, 'cancel'))) { problems.push('live: Codex’s second plan panel has no Discard plan'); return false; }
    const cancelled = await until('Codex’s second plan to read discarded', () => lineOutcome(main, second), (outcome) => outcome === 'cancelled');
    if (!cancelled.ok || turnsOf(threads()) !== ranBefore || entryOf(codex.id)?.summary.attention?.kind === 'plan') problems.push(`live: Codex’s discarded plan reads ${String(cancelled.last)}, ${turnsOf(threads()) - ranBefore} turn(s) run for it`);
    // Leave plan mode, keep plan: a third, which Codex's chat leaves and the store keeps; Codex is sent nothing for it either.
    const kept = await another('third', [codex.planId, second]);
    if (kept === undefined) return false;
    const ranBeforeLeave = turnsOf(threads());
    if (!(await pressPlanPanel(main, 'leave'))) { problems.push('live: Codex’s third plan panel has no Leave plan mode, keep plan'); return false; }
    const leftIt = await until('Codex’s third plan to read left', () => lineOutcome(main, kept), (outcome) => outcome === 'left');
    if (!leftIt.ok || turnsOf(threads()) !== ranBeforeLeave || entryOf(codex.id)?.summary.attention?.kind === 'plan') problems.push(`live: Codex’s left plan reads ${String(leftIt.last)}, ${turnsOf(threads()) - ranBeforeLeave} turn(s) run for it`);
    const keptCount = await until('the executed and the discarded plans to be deleted', () => planCount(main), (count) => storedBefore !== null && count === storedBefore + 1);
    if (!keptCount.ok) problems.push(`live: with one plan kept the store counts ${String(keptCount.last)} plan(s), ${String(storedBefore)} before`);
    const claude = await planOn(main, project, 'Claude', prompts.plans.claude);
    if (claude === undefined) return false;
    // Brought (C64, C65): entry points are hidden, so bring the retained plan through Main-only IPC.
    const listedPlans = await ask(main, 'plans:list', { projectId: project.id });
    const listed = listedPlans.value?.['plans'] as { planId?: string }[] | undefined;
    if (!listed?.some((entry) => entry.planId === kept)) { problems.push('live: the project did not list its kept plan'); return false; }
    const read = (await ask(main, 'plans:read', { planId: kept, start: 0, length: 1 })).value as unknown as PlanRead | undefined;
    if (read?.status !== 'read') { problems.push('live: the kept plan could not be read'); return false; }
    const answer = await ask(main, 'plans:bring', { sessionId: claude.id, planId: kept, version: read.version, hash: read.hash });
    if (answer.value?.['status'] !== 'brought') { problems.push('live: the kept plan could not be brought'); return false; }
    const brought = await until('the kept plan to stand brought in Claude’s chat', () => planShown(main), (shown) => shown.panel === kept && shown.lines.some((line) => line.plan === kept && line.came === 'brought' && line.outcome === 'pending'));
    if (!brought.ok) { problems.push(`live: the brought plan shows ${JSON.stringify(brought.last ?? null)}`); return false; }
    // Every chat of a ready plan reads PLAN READY, a brought one's too (0029; the maintainer).
    const readyHere = await until('the brought plan to read PLAN READY', () => entryOf(claude.id)?.summary.attention?.kind ?? null, (kind) => kind === 'plan');
    if (!readyHere.ok) problems.push(`live: a brought plan reads ${String(readyHere.last)}, not PLAN READY`);
    if (!(await pressPlanPanel(main, 'execute')) || !(await deniedToEnd(main, claude.id, 'the brought plan’s turn to end'))) return false;
    const done = await until('the brought plan to read executed', async () => (await planShown(main)).lines.filter((line) => line.came === 'brought').at(-1)?.outcome ?? null, (outcome) => outcome === 'executed');
    if (!done.ok) problems.push(`live: the brought plan reads ${String(done.last)}`);
    // Every plan executed or discarded is deleted (0029): the store is back to what it held before.
    const after = await until('the plans to be deleted', () => planCount(main), (count) => count !== null && count === storedBefore);
    if (!after.ok) problems.push(`live: after the plans the store counts ${String(after.last)} plan(s), ${String(storedBefore)} before`);
    report['plans'] = { codex: codex.planId !== '', claude: claude.planId !== '', discarded: cancelled.ok, left: leftIt.ok, brought: done.ok, deleted: after.ok };
    return true;
  }

  async function claudePermissions(main: BrowserWindow, pet: BrowserWindow, project: StoredProject): Promise<Permitted | undefined> {
    if (prompts === null || folder === undefined) return undefined;
    const claude = [{ providerId: 'claude', instanceId: FIRST_INSTANCE_ID }];
    const created = await ask(main, 'sessions:create', { projectId: project.id, preset: defaultPreset(presetTiles(store.getSnapshot().catalog, claude)) });
    const id = typeof created.value?.['id'] === 'string' ? created.value['id'] : '';
    if (created.value?.['status'] !== 'saved' || sessions.snapshot().selectedId !== id) { problems.push(`live: creating Claude’s permission session answered ${JSON.stringify(created.value ?? created.error)}`); return undefined; }
    const chosen = await ask(main, 'chat:setMode', { sessionId: id, mode: 'ask-first' });
    if (chosen.value?.['status'] !== 'set') { problems.push(`live: choosing Claude’s approval mode answered ${JSON.stringify(chosen.value ?? chosen.error)}`); return undefined; }
    if (!(await waitFor('Claude’s permission session to take a prompt', () => entryOf(id)?.block === null))) { problems.push(`live: Claude’s permission session's reason is ${String(entryOf(id)?.block)}`); return undefined; }
    // The explicit choice is said in its header, to apply at the first prompt.
    const header = await until('Claude’s permission session to show its mode', async () => ((await shownSelected(main, id)) ? modeShown(main) : null), (shown) => shown?.saved === 'ask-first');
    if (header.last?.source !== 'chat' || !header.last.pending || entryOf(id)?.mode?.source !== 'chat') problems.push(`live: Claude’s new session shows the mode ${JSON.stringify(header.last ?? null)}, and main says ${JSON.stringify(entryOf(id)?.mode ?? null)}`);
    const { claude: once, claudeAgain: again, claudeMade } = prompts.approvals;
    const made = path.join(folder, claudeMade);
    if (existsSync(made)) problems.push('live: the file Claude’s command makes is in the project before the command was approved');

    // 1: the command asks leave (C8, C13): a card its turn waits on, with its request's choices and Stop, nothing chosen and nothing sent.
    if (!(await send(main, id, once, 'Claude’s prompt that runs a command'))) return undefined;
    const waiting = await until('Claude’s command to show as a card that waits', async () => (await approvalCards(main)).at(-1), (card) => card?.outcome === 'pending');
    if (!waiting.ok) return undefined;
    const card = waiting.last;
    if (card === undefined || card.kind !== 'command' || JSON.stringify(card.choices) !== JSON.stringify(['approve', 'approve-session', 'deny']) || !card.stop || !card.disclosure || card.detail !== 0 || card.said !== 'none' || card.summary === 0 || card.inForm !== 0) problems.push(`live: Claude’s card, waiting, reads ${JSON.stringify(card ?? null)}`);
    if (!(await waitFor('the reference of Claude’s permission session', () => typeof onDisk(id)?.['reference'] === 'string'))) return undefined;
    const reference = String(onDisk(id)?.['reference']);
    const fake = (): ChatSession | undefined => chatSessions()[reference];
    // The turn waits on it (C78): one approval counted, fat-g's own line for it, under the mode its process confirmed; and the capsule says so.
    const summary = entryOf(id)?.summary;
    if (summary?.status !== 'running' || summary.attention?.kind !== 'approval' || summary.attention.count !== 1 || summary.action?.kind !== 'approving' || summary.action.label !== APPROVAL_WORDS.waiting || summary.mode !== 'ask-first') problems.push(`live: while Claude’s approval waits its session reads ${JSON.stringify({ status: summary?.status, attention: summary?.attention ?? null, action: summary?.action?.kind ?? null, mode: summary?.mode ?? null })}`);
    const capsule = await approvalCapsule(main);
    if (!capsule.ok) problems.push(`live: the capsule of Claude’s session whose approval waits reads ${JSON.stringify(capsule.last ?? null)}`);
    // The whole action is drawn only once its disclosure is opened (C48), as text: with it shown, the chat's list holds nothing a text may not become.
    const opened = await pressApproval(main, 'detail') && (await until('Claude’s card to show the whole action', async () => (await approvalCards(main)).at(-1), (shown) => (shown?.detail ?? 0) > 0)).ok;
    const foreign = await foreignInChat(main);
    if (!opened || foreign !== 0) problems.push(`live: with Claude’s card waiting and its action ${opened ? 'shown' : 'not shown'}, the chat's list holds ${foreign} element(s) a text may not become`);
    // Nothing is decided until a choice is pressed (C13): the fake was answered nothing and made nothing, on the one process Ask first's launch started; and the Pet's state holds none of it (C28).
    const before = fake();
    if ((before?.answers?.length ?? 0) !== 0 || existsSync(made) || (await permissionsOf(main, id)).approvals.at(-1)?.outcome !== 'pending') problems.push('live: Claude’s command was decided, or ran, before a choice was pressed');
    if (before?.launches.length !== 1 || before.launches[0]?.resume !== null || before.launches[0].tools?.length !== 11) problems.push(`live: Claude’s permission session was launched ${before?.launches.length ?? 0} time(s), its first with ${before?.launches[0]?.tools?.length ?? 0} tool(s), expected once with Ask first’s eleven`);
    const inPet = await petHolds(pet, claudeMade);
    if (inPet.length !== 0) problems.push(`pet: while an approval waits its state holds ${JSON.stringify(inPet)}`);

    // Approve once: the turn goes on, the CLI confirms the decision, and the fake makes the file — nothing but the request's own input was sent back.
    if (!(await pressApproval(main, 'approve'))) { problems.push('live: Claude’s card has no Approve once to press'); return undefined; }
    if (!(await ended(id, 'Claude’s turn that asked leave'))) return undefined;
    const approved = await until('Claude’s card to read approved once', async () => (await approvalCards(main)).at(-1), (shown) => settledAs(shown, 'approved', 'approved'));
    if (!approved.ok) problems.push(`live: Claude’s card, approved, reads ${JSON.stringify(approved.last ?? null)}`);
    if (lastOutcome(id) !== 'completed' || entryOf(id)?.summary.attention?.kind !== 'ready') problems.push(`live: Claude’s turn that asked leave is written ${JSON.stringify(onDisk(id)?.['lastTurn'])}, its attention ${String(entryOf(id)?.summary.attention?.kind)}`);
    const afterOnce = fake();
    if (afterOnce?.answers?.length !== 1 || afterOnce.answers[0]?.behavior !== 'allow' || afterOnce.answers[0].updatedPermissions !== undefined || (afterOnce.grants?.length ?? 0) !== 0) problems.push(`live: for Approve once Claude’s fake was answered ${JSON.stringify((afterOnce?.answers ?? []).map((answer) => [answer.behavior, answer.updatedPermissions?.length ?? null]))}, and recorded ${afterOnce?.grants?.length ?? 0} rule(s)`);
    const fileMade = existsSync(made) && afterOnce?.writes?.length === 1;
    if (!fileMade) problems.push(`live: the file of Claude’s approved command is ${existsSync(made) ? 'there' : 'not there'}, and the fake made ${afterOnce?.writes?.length ?? 0} file(s)`);
    const storedOnce = await permissionsOf(main, id);
    const keptOnce = storedOnce.approvals.at(-1);
    if (storedOnce.approvals.length !== 1 || keptOnce?.outcome !== 'approved' || keptOnce.delivered !== true || typeof keptOnce.confirmedAt !== 'number' || (keptOnce.grant ?? null) !== null || storedOnce.grants.length !== 0 || storedOnce.waiting !== 0) problems.push(`live: Claude’s approved command is stored ${storedSaid(storedOnce)}`);

    // 2: the same command, asked again — leave given once is one use — and granted for the session (C21, C56, C69): the CLI's own rule, sent for this session alone.
    if (!(await send(main, id, again, 'Claude’s prompt that runs the command again'))) return undefined;
    if (!(await until('Claude’s command to ask again', () => approvalCards(main), (shown) => shown.length === 2 && shown.at(-1)?.outcome === 'pending')).ok) return undefined;
    if (!(await pressApproval(main, 'approve-session'))) { problems.push('live: Claude’s second card has no session grant to press'); return undefined; }
    if (!(await ended(id, 'Claude’s turn that was granted'))) return undefined;
    const granted = await until('Claude’s second card to read approved for the session', async () => (await approvalCards(main)).at(-1), (shown) => settledAs(shown, 'approved-session', 'session'));
    if (!granted.ok) problems.push(`live: Claude’s card, granted, reads ${JSON.stringify(granted.last ?? null)}`);
    const afterGrant = fake();
    if (afterGrant?.answers?.length !== 2 || afterGrant.answers[1]?.behavior !== 'allow' || afterGrant.answers[1].updatedPermissions?.length !== 1 || afterGrant.grants?.length !== 1 || afterGrant.launches.length !== 1) problems.push(`live: for the session grant Claude’s fake was answered ${JSON.stringify((afterGrant?.answers ?? []).map((answer) => [answer.behavior, answer.updatedPermissions?.length ?? null]))}, and recorded ${afterGrant?.grants?.length ?? 0} rule(s)`);

    // 3: the next turn runs the command with no card, on the process that holds the grant; the grants list shows it live, confirmed by the CLI.
    if (!(await send(main, id, again, 'Claude’s prompt that runs the granted command')) || !(await ended(id, 'Claude’s turn that ran unasked'))) return undefined;
    const unasked = fake();
    const cardsAfter = await approvalCards(main);
    const ranUnasked = lastOutcome(id) === 'completed' && unasked?.answers?.length === 2 && unasked.turns.length === 3 && cardsAfter.length === 2 && cardsAfter.every((shown) => shown.outcome !== 'pending');
    if (!ranUnasked) problems.push(`live: the granted command’s next turn is written ${JSON.stringify(onDisk(id)?.['lastTurn'])}, with ${unasked?.answers?.length ?? 0} answer(s) and ${cardsAfter.length} card(s)`);
    const live = await until('the grants list to show Claude’s grant live', () => grantsShown(main), (shown) => shown.listed && shown.live === 1 && shown.confirmed === 1 && shown.ended === 0);
    const storedLive = await permissionsOf(main, id);
    if (!live.ok || JSON.stringify(storedLive.grants) !== JSON.stringify([{ confirmed: true, live: true }]) || storedLive.approvals.at(-1)?.grant?.live !== true) problems.push(`live: Claude’s live grant is listed ${JSON.stringify(live.last ?? null)}, and stored ${storedSaid(storedLive)}`);

    // 4: Read only, from the menu (C2, C45, C86): it says it restarts the process and ends the grant; the process is closed, nothing is launched, and the grant reads ended.
    const firstProcess = fixtureOf('Claude', unasked?.launches[0]?.pid ?? 0);
    const toReading = await chooseMode(main, id, 'read-only', 'Claude', 1);
    if (toReading === null) return undefined;
    if (!toReading.restarts || !toReading.endsGrants) problems.push(`live: before the press, Read only was listed for Claude as ${JSON.stringify(toReading)}`);
    await waitFor('the process of Claude’s session to end at the change to Read only', () => entryOf(id)?.summary.mode === null && fixtureGone('Claude', firstProcess));
    const ended1 = await until('the grants list to show Claude’s grant ended', () => grantsShown(main), (shown) => shown.listed && shown.live === 0 && shown.ended === 1);
    const endedCard = await until('Claude’s granted card to say its grant ended', async () => (await approvalCards(main)).at(-1), (shown) => settledAs(shown, 'approved-session', 'session-ended'));
    const storedEnded = await permissionsOf(main, id);
    const pendingReading = await until('Claude’s header to show Read only, to apply at the next prompt', () => modeShown(main), (shown) => shown?.saved === 'read-only' && shown.source === 'chat' && shown.pending);
    if (!ended1.ok || !endedCard.ok || !pendingReading.ok || storedEnded.grants.some((grant) => grant.live) || storedEnded.mode?.id !== 'read-only' || fake()?.launches.length !== 1) problems.push(`live: after the change to Read only Claude’s grants are listed ${JSON.stringify(ended1.last ?? null)} and stored ${storedSaid(storedEnded)}, its card reads ${JSON.stringify(endedCard.last ?? null)}, its header ${JSON.stringify(pendingReading.last ?? null)}, after ${fake()?.launches.length ?? 0} launch(es)`);
    // And back (C75): saved at once, with no process to restart, and nothing launched until a prompt.
    const back = await chooseMode(main, id, 'ask-first', 'Claude');
    if (back === null) return undefined;
    if (back.restarts || fake()?.launches.length !== 1 || entryOf(id)?.summary.mode !== null) problems.push(`live: the change back to Ask first, with no process, was listed ${JSON.stringify(back)} and left ${fake()?.launches.length ?? 0} launch(es)`);

    // 5: the next turn asks again (C21, C86): a new process holds no rule of the one that ended. Granted again, for what follows.
    if (!(await send(main, id, again, 'Claude’s prompt that runs the command after the restart'))) return undefined;
    const askedAgain = (await until('Claude’s command to ask again after the restart', () => approvalCards(main), (shown) => shown.length === 3 && shown.at(-1)?.outcome === 'pending')).ok;
    if (!askedAgain) return undefined;
    const resumed = fake();
    if (resumed?.launches.length !== 2 || resumed.launches[1]?.resume !== reference || resumed.launches[1].tools?.length !== 11 || resumed.answers?.length !== 2) problems.push(`live: after the restart Claude’s session ran on ${resumed?.launches.length ?? 0} launch(es) and was answered ${resumed?.answers?.length ?? 0} time(s), expected a second launch that resumed it and no answer yet`);
    if (!(await pressApproval(main, 'approve-session'))) { problems.push('live: Claude’s third card has no session grant to press'); return undefined; }
    if (!(await ended(id, 'Claude’s turn that was granted again'))) return undefined;
    const second = await until('the grants list to show Claude’s second grant live beside the ended one', () => grantsShown(main), (shown) => shown.live === 1 && shown.ended === 1);
    if (!second.ok) problems.push(`live: after the second grant Claude’s grants are listed ${JSON.stringify(second.last ?? null)}`);

    // 6: Edits ok, on the live process (C5, C74): no restart is said and none is made — the same process, one change of mode written to it, the CLI's own confirmation — and the grant stays live.
    const secondProcess = fixtureOf('Claude', fake()?.launches[1]?.pid ?? 0);
    const toEdits = await chooseMode(main, id, 'edits-ok', 'Claude', 1);
    if (toEdits === null) return undefined;
    const editsHeader = await until('Claude’s header to show Edits ok, confirmed', () => modeShown(main), (shown) => shown?.saved === 'edits-ok' && !shown.pending);
    const onEdits = fake();
    const editsGrants = await grantsShown(main);
    const editsConfirmed = entryOf(id)?.summary.mode === 'edits-ok' && editsHeader.ok && onEdits?.modes?.length === 1 && onEdits.modes[0]?.answered === 'success' && !onEdits.modes[0].turn;
    const noRestart = !toEdits.restarts && !toEdits.endsGrants && onEdits?.launches.length === 2 && !fixtureGone('Claude', secondProcess) && editsGrants.live === 1;
    if (!noRestart || !editsConfirmed) problems.push(`live: Edits ok was listed for Claude as ${JSON.stringify(toEdits)}; after it main says ${String(entryOf(id)?.summary.mode)}, the header ${JSON.stringify(editsHeader.last ?? null)}, the fake ${onEdits?.launches.length ?? 0} launch(es) and ${JSON.stringify(onEdits?.modes ?? null)}, and the grants ${JSON.stringify(editsGrants)}`);

    // 7: and Read only again, with a restart (C45, C86): the process closed, every grant ended, and the next prompt started on the reading launch, which confirms the mode.
    const toReadingAgain = await chooseMode(main, id, 'read-only', 'Claude', 1);
    if (toReadingAgain === null) return undefined;
    await waitFor('the process of Claude’s session to end at the second change to Read only', () => entryOf(id)?.summary.mode === null && fixtureGone('Claude', secondProcess));
    const allEnded = await until('the grants list to show both of Claude’s grants ended', () => grantsShown(main), (shown) => shown.listed && shown.live === 0 && shown.ended === 2);
    const endedCards = await until('both of Claude’s granted cards to say their grant ended', () => approvalCards(main), (shown) => shown.length === 3 && settledAs(shown[0], 'approved', 'approved') && settledAs(shown[1], 'approved-session', 'session-ended') && settledAs(shown[2], 'approved-session', 'session-ended'));
    if (!toReadingAgain.restarts || !toReadingAgain.endsGrants || !allEnded.ok || !endedCards.ok || fake()?.modes?.length !== 1) problems.push(`live: Read only was listed for Claude as ${JSON.stringify(toReadingAgain)}; after it the grants are listed ${JSON.stringify(allEnded.last ?? null)}, the cards read ${JSON.stringify(endedCards.last ?? null)}, and the fake was sent ${fake()?.modes?.length ?? 0} change(s) of mode`);
    if (!(await send(main, id, prompts.claude.basic, 'Claude’s prompt under Read only')) || !(await ended(id, 'Claude’s turn under Read only'))) return undefined;
    const reading = fake();
    const readingHeader = await until('Claude’s header to show Read only, confirmed', () => modeShown(main), (shown) => shown?.saved === 'read-only' && !shown.pending);
    const restarted = lastOutcome(id) === 'completed' && entryOf(id)?.summary.mode === 'read-only' && reading?.launches.length === 3 && reading.launches[2]?.resume === reference && reading.launches[2].tools?.length === 5 && reading.answers?.length === 3;
    if (!restarted || !readingHeader.ok) problems.push(`live: under Read only Claude’s turn is written ${JSON.stringify(onDisk(id)?.['lastTurn'])}, main says ${String(entryOf(id)?.summary.mode)}, the header ${JSON.stringify(readingHeader.last ?? null)}, and the fake ${reading?.launches.length ?? 0} launch(es), the last with ${reading?.launches.at(-1)?.tools?.length ?? 0} tool(s), and ${reading?.answers?.length ?? 0} answer(s)`);
    const stored = await permissionsOf(main, id);
    const outcomes = ['approved', 'approved-session', 'approved-session'];
    if (JSON.stringify(stored.approvals.map((entry) => entry.outcome)) !== JSON.stringify(outcomes) || stored.approvals.some((entry) => entry.delivered !== true || typeof entry.confirmedAt !== 'number') || JSON.stringify(stored.grants) !== JSON.stringify([{ confirmed: true, live: false }, { confirmed: true, live: false }]) || stored.waiting !== 0) problems.push(`live: Claude’s approvals are stored ${storedSaid(stored)}`);

    // Counts and fat-g's own words alone: nothing of a command, a path or what a grant covers is said here.
    report['claudeApprovals'] = {
      card: card?.kind ?? null, choices: card?.choices ?? [], capsule: capsule.last ?? null, approvedOnce: approved.ok, fileMade, granted: granted.ok, ranUnasked, liveGrant: live.ok,
      endedByReadOnly: ended1.ok && endedCard.ok, askedAgain, foreignElements: foreign, petHolds: inPet,
    };
    report['claudeModes'] = { atStart: [header.last?.saved ?? null, header.last?.source ?? null], editsOk: { restart: !noRestart, confirmed: editsConfirmed, liveGrants: editsGrants.live }, readOnly: { restart: restarted, liveGrants: allEnded.last?.live ?? -1, endedGrants: allEnded.last?.ended ?? -1 }, launches: reading?.launches.length ?? 0, changesOnLiveProcess: reading?.modes?.length ?? 0 };
    await completePermitted(main, id, 'Claude', reading?.launches.at(-1)?.pid ?? 0);
    return { session: id, reference, mode: 'read-only', approvals: outcomes, grants: 2 };
  }

  /** The first Codex account as main's state has it: which modes it can use, and where its sandbox setup stands. */
  const codexAccount = () => store.getSnapshot().providers.find((provider) => provider.id === 'codex' && provider.instanceId === FIRST_INSTANCE_ID);
  /** How many times the Codex fake was asked to set up the first account's sandbox, by what it noted beside its threads; and the state a setup left there. */
  const sandboxNoted = (): { readonly setups: number; readonly state: string | null } => {
    const noted = (readJson(threadsFile ?? '') as { sandbox?: Record<string, { state?: string; asked?: { method?: string }[] }> } | null)?.sandbox?.['default'];
    return { setups: (noted?.asked ?? []).filter((entry) => typeof entry.method === 'string' && entry.method.endsWith('/setupStart')).length, state: noted?.state ?? null };
  };
  interface SetupShown { readonly open: boolean; readonly state: string | null; readonly actions: readonly string[] }
  /** The setup's dialog as the page shows it: its state, and the actions that can be pressed. Its words are the provider's and fat-g's, and none is read. */
  const setupShown = (main: BrowserWindow): Promise<SetupShown> => inPage(main, `
    const dialog = document.querySelector('dialog[data-sandbox-setup]');
    return {
      open: dialog?.open === true, state: dialog?.querySelector('[data-setup-state]')?.getAttribute('data-setup-state') ?? null,
      actions: [...(dialog?.querySelectorAll('[data-setup-action]') ?? [])].filter((button) => !button.disabled && button.getAttribute('aria-disabled') !== 'true').map((button) => button.getAttribute('data-setup-action') ?? ''),
    };`);
  /** Presses the dialog's Set up — which is Try again once a setup has failed — or the button that closes it. */
  const pressSetup = (main: BrowserWindow, control: 'start' | 'close'): Promise<boolean> => inPage(main, `
    const button = document.querySelector(${JSON.stringify(`dialog[data-sandbox-setup][open] ${control === 'start' ? '[data-setup-action="start"]' : 'footer button:not([data-setup-action])'}`)});
    if (button === null || button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
    button.click();
    return true;`);

  /**
   * M22 (V11, V12; C4, C7, C8, C13, C43, C46, C60–C62, C64, C72, C76, C89): what a Codex session may
   * do, on a session made for it, on the first account, which has no sandbox. Its first start is one
   * the fake refuses — the reply reports another approval policy than Ask first's — so its turn
   * fails, nothing is sent, and the chat is left blocked; the block's own remedy opens the mode
   * menu, Read only is chosen there, and the next prompt is sent and runs — the saved thread's, with
   * the one traced after it, so that this thread's history too is turns fat-g ran. Back under Ask first, a
   * file change asks leave: approved from its card, the fake makes the file; that file's next change
   * asks again, is denied, and its activity reads declined. Sandbox ok stands unavailable, with its
   * Set up control: the setup is pressed and declined, pressed again and approved — against the
   * fake, which changes nothing of the machine — and Sandbox ok is then chosen, and confirmed by the
   * next prompt's start.
   *
   * Codex's setup is Windows' alone (C62). On another system the menu offers no Set up control, and
   * the step ends there, saying so: the session stays under Ask first.
   */
  async function codexPermissions(main: BrowserWindow, pet: BrowserWindow, project: StoredProject): Promise<Permitted | undefined> {
    const control = process.env['FATG_SMOKE_CODEX_CONTROL'];
    if (prompts === null || folder === undefined || control === undefined) { problems.push('live: the fake’s control file is not named'); return undefined; }
    const codex = [{ providerId: 'codex', instanceId: FIRST_INSTANCE_ID }];
    const created = await ask(main, 'sessions:create', { projectId: project.id, preset: defaultPreset(presetTiles(store.getSnapshot().catalog, codex)) });
    const id = typeof created.value?.['id'] === 'string' ? created.value['id'] : '';
    if (created.value?.['status'] !== 'saved' || sessions.snapshot().selectedId !== id) { problems.push(`live: creating Codex’s permission session answered ${JSON.stringify(created.value ?? created.error)}`); return undefined; }
    const chosen = await ask(main, 'chat:setMode', { sessionId: id, mode: 'ask-first' });
    if (chosen.value?.['status'] !== 'set') { problems.push(`live: choosing Codex’s approval mode answered ${JSON.stringify(chosen.value ?? chosen.error)}`); return undefined; }
    if (!(await waitFor('Codex’s permission session to take a prompt', () => entryOf(id)?.block === null))) { problems.push(`live: Codex’s permission session's reason is ${String(entryOf(id)?.block)}`); return undefined; }
    if (entryOf(id)?.mode?.id !== 'ask-first' || entryOf(id)?.mode?.source !== 'chat') problems.push(`live: Codex’s new session has the mode ${JSON.stringify(entryOf(id)?.mode ?? null)}`);

    // 1: a start the fake refuses (C7, C46): its reply reports another approval policy than the mode's. The turn fails, no prompt goes, and Send is blocked.
    writeFileSync(control, JSON.stringify({ startOtherPolicy: 1 }));
    // A session whose first start failed holds no conversation of the provider's: its turn is over once it no longer runs and its end is written.
    const refused = await send(main, id, prompts.saved, 'Codex’s prompt whose start is refused')
      && await waitFor('the turn whose start was refused to end', () => entryOf(id)?.summary.status !== 'running' && ((onDisk(id)?.['lastTurn'] as { endedAt?: number | null } | null)?.endedAt ?? null) !== null);
    writeFileSync(control, '{}');
    if (!refused) return undefined;
    if (lastOutcome(id) !== 'failed' || entryOf(id)?.block !== 'mode-unconfirmed' || typeof onDisk(id)?.['reference'] === 'string' || entryOf(id)?.summary.mode !== null) problems.push(`live: after a start the fake refused, Codex’s session reads ${JSON.stringify({ lastTurn: lastOutcome(id) ?? null, block: entryOf(id)?.block ?? null, started: typeof onDisk(id)?.['reference'] === 'string', mode: entryOf(id)?.summary.mode ?? null })}`);
    // The page: the reason stands in the input's place, with its remedy (C89).
    const blocked = await until('the block of a start that was not confirmed to show with its remedy', () => inPage<{ block: string | null; remedy: boolean; input: boolean }>(main, `
      const chat = document.querySelector('${CHAT_MAIN}');
      const reason = chat?.querySelector('[data-chat-block]') ?? null;
      return { block: reason?.getAttribute('data-chat-block') ?? null, remedy: reason !== null && reason.querySelector('[data-change-mode]') !== null, input: chat?.querySelector('textarea') != null };`), (shown) => shown.block === 'mode-unconfirmed' && shown.remedy && !shown.input);
    if (!blocked.ok) { problems.push(`live: Codex’s blocked chat shows ${JSON.stringify(blocked.last ?? null)}`); return undefined; }
    // The remedy: Change mode opens the mode control's menu, and a mode chosen there is taken under the block.
    await inPage(main, `document.querySelector('${CHAT_MAIN} [data-chat-block] [data-change-mode]')?.click(); return true;`);
    if (!(await waitFor('Change mode to open the mode menu', async () => (await modeMenu(main)) !== null))) return undefined;
    if ((await chooseMode(main, id, 'read-only', 'Codex')) === null) return undefined;
    if (!(await waitFor('the block to lift once a mode was chosen', () => entryOf(id)?.block === null))) { problems.push(`live: after the remedy Codex’s chat is still blocked: ${String(entryOf(id)?.block)}`); return undefined; }
    // Its next prompt is sent, and runs under the mode that was chosen: this start's reply confirms it.
    if (!(await send(main, id, prompts.saved, 'Codex’s prompt after the block')) || !(await ended(id, 'Codex’s turn after the block'))) return undefined;
    const reference = typeof onDisk(id)?.['reference'] === 'string' ? String(onDisk(id)?.['reference']) : '';
    const fake = (): Thread | undefined => threads()[reference];
    const sentAfter = lastOutcome(id) === 'completed' && entryOf(id)?.summary.mode === 'read-only' && fake()?.turns.length === 1 && fake()?.opens?.length === 1;
    if (!sentAfter) problems.push(`live: the prompt after the block is written ${JSON.stringify(onDisk(id)?.['lastTurn'])}, under ${String(entryOf(id)?.summary.mode)}, on a thread of ${fake()?.turns.length ?? 0} turn(s) and ${fake()?.opens?.length ?? 0} start(s)`);
    report['blockedStart'] = { block: blocked.last?.block ?? null, remedy: blocked.last?.remedy ?? false, chose: 'read-only', sent: sentAfter };
    // That prompt was the saved thread's, and the one traced after it follows on the same process, as in the first
    // session: the fake's history of this thread is then two turns fat-g ran, and the next launch's check reads no item of it (M18, C51).
    if (!(await send(main, id, prompts.resume, 'Codex’s second prompt under Read only')) || !(await ended(id, 'Codex’s second turn under Read only'))) return undefined;
    if (lastOutcome(id) !== 'completed' || fake()?.turns.length !== 2 || fake()?.launches.length !== 1) problems.push(`live: Codex’s second turn under Read only is written ${JSON.stringify(onDisk(id)?.['lastTurn'])}, on a thread of ${fake()?.turns.length ?? 0} turn(s) and ${fake()?.launches.length ?? 0} launch(es)`);

    // 2: back under Ask first (C64): on Codex every change of mode is a new process, and the menu says so before the press.
    const firstProcess = fixtureOf('Codex', fake()?.launches[0]?.pid ?? 0);
    const toAsking = await chooseMode(main, id, 'ask-first', 'Codex');
    if (toAsking === null) return undefined;
    await waitFor('the process of Codex’s session to end at the change of mode', () => entryOf(id)?.summary.mode === null && fixtureGone('Codex', firstProcess));
    if (!toAsking.restarts || fake()?.launches.length !== 1) problems.push(`live: Ask first was listed for Codex as ${JSON.stringify(toAsking)}, and the change left ${fake()?.launches.length ?? 0} launch(es)`);

    // 3: a file change asks leave (C8, C13): a card its turn waits on. Nothing is written until Approve once is pressed.
    const { codex: change, codexAgain: changeAgain, codexMade } = prompts.approvals;
    const made = path.join(folder, codexMade);
    if (existsSync(made)) problems.push('live: the file Codex’s change makes is in the project before the change was approved');
    if (!(await send(main, id, change, 'Codex’s prompt that changes a file'))) return undefined;
    const waiting = await until('Codex’s file change to show as a card that waits', async () => (await approvalCards(main)).at(-1), (card) => card?.outcome === 'pending');
    if (!waiting.ok) return undefined;
    const card = waiting.last;
    if (card === undefined || card.kind !== 'file-change' || card.choices[0] !== 'approve' || card.choices.at(-1) !== 'deny' || !card.stop || !card.disclosure || card.detail !== 0 || card.said !== 'none' || card.summary === 0 || card.inForm !== 0) problems.push(`live: Codex’s card, waiting, reads ${JSON.stringify(card ?? null)}`);
    const summary = entryOf(id)?.summary;
    if (summary?.status !== 'running' || summary.attention?.kind !== 'approval' || summary.attention.count !== 1 || summary.action?.kind !== 'approving' || summary.action.label !== APPROVAL_WORDS.waiting || summary.mode !== 'ask-first') problems.push(`live: while Codex’s approval waits its session reads ${JSON.stringify({ status: summary?.status, attention: summary?.attention ?? null, action: summary?.action?.kind ?? null, mode: summary?.mode ?? null })}`);
    const capsule = await approvalCapsule(main);
    if (!capsule.ok) problems.push(`live: the capsule of Codex’s session whose approval waits reads ${JSON.stringify(capsule.last ?? null)}`);
    // The whole change, shown (C48): each file with its text, as text.
    const opened = await pressApproval(main, 'detail') && (await until('Codex’s card to show the whole change', async () => (await approvalCards(main)).at(-1), (shown) => (shown?.detail ?? 0) > 0)).ok;
    const foreign = await foreignInChat(main);
    if (!opened || foreign !== 0) problems.push(`live: with Codex’s card waiting and its change ${opened ? 'shown' : 'not shown'}, the chat's list holds ${foreign} element(s) a text may not become`);
    if ((fake()?.replies?.length ?? 0) !== 0 || existsSync(made) || fake()?.launches.length !== 2) problems.push(`live: Codex’s change was decided, or made, before a choice was pressed (${fake()?.replies?.length ?? 0} reply, ${fake()?.launches.length ?? 0} launch(es))`);
    if (!(await pressApproval(main, 'approve'))) { problems.push('live: Codex’s card has no Approve once to press'); return undefined; }
    if (!(await ended(id, 'Codex’s turn that asked leave'))) return undefined;
    const approved = await until('Codex’s card to read approved once', async () => (await approvalCards(main)).at(-1), (shown) => settledAs(shown, 'approved', 'approved'));
    if (!approved.ok) problems.push(`live: Codex’s card, approved, reads ${JSON.stringify(approved.last ?? null)}`);
    const afterApproval = fake();
    const fileMade = existsSync(made) && afterApproval?.changes?.length === 1 && afterApproval.changes[0]?.file === codexMade && afterApproval.replies?.length === 1;
    if (!fileMade || lastOutcome(id) !== 'completed') problems.push(`live: the file of Codex’s approved change is ${existsSync(made) ? 'there' : 'not there'}; the fake made ${afterApproval?.changes?.length ?? 0} change(s) for ${afterApproval?.replies?.length ?? 0} reply, and the turn is written ${JSON.stringify(onDisk(id)?.['lastTurn'])}`);

    // 4: that file's next change asks again — leave given once is one use — and is denied (C13, C76): nothing is written, and its activity reads declined.
    if (!(await send(main, id, changeAgain, 'Codex’s prompt that changes the file again'))) return undefined;
    if (!(await until('Codex’s next change to ask', () => approvalCards(main), (shown) => shown.length === 2 && shown.at(-1)?.outcome === 'pending')).ok) return undefined;
    if (!(await pressApproval(main, 'deny'))) { problems.push('live: Codex’s second card has no Deny to press'); return undefined; }
    if (!(await ended(id, 'Codex’s turn that was denied'))) return undefined;
    const denied = await until('Codex’s second card to read denied', async () => (await approvalCards(main)).at(-1), (shown) => settledAs(shown, 'denied', 'denied'));
    if (!denied.ok) problems.push(`live: Codex’s card, denied, reads ${JSON.stringify(denied.last ?? null)}`);
    // Its row, in its turn's group, which is opened as a press on it does.
    const declined = await until('the denied change’s activity to read declined', async () => { await openGroups(main, CHAT_LIST); return inPage<string[]>(main, `return [...(${CHAT_LIST}?.querySelectorAll('[data-activity][data-status="declined"]') ?? [])].map((row) => row.getAttribute('data-activity') ?? '');`); }, (rows) => rows.length === 1);
    const afterDenial = fake();
    if (!declined.ok || afterDenial?.changes?.length !== 1 || afterDenial.replies?.length !== 2 || lastOutcome(id) !== 'completed') problems.push(`live: after the denial Codex’s chat shows the declined rows ${JSON.stringify(declined.last ?? null)}; the fake made ${afterDenial?.changes?.length ?? 0} change(s) for ${afterDenial?.replies?.length ?? 0} replies, and the turn is written ${JSON.stringify(onDisk(id)?.['lastTurn'])}`);
    const stored = await permissionsOf(main, id);
    const outcomes = ['approved', 'denied'];
    if (JSON.stringify(stored.approvals.map((entry) => entry.outcome)) !== JSON.stringify(outcomes) || stored.approvals.some((entry) => entry.delivered !== true || typeof entry.confirmedAt !== 'number' || (entry.grant ?? null) !== null) || stored.grants.length !== 0 || stored.waiting !== 0) problems.push(`live: Codex’s approvals are stored ${storedSaid(stored)}`);
    report['codexApprovals'] = { card: card?.kind ?? null, choices: card?.choices ?? [], capsule: capsule.last ?? null, approvedOnce: approved.ok, fileMade, denied: denied.ok, declinedRows: declined.last ?? [], foreignElements: foreign };

    // 5: Sandbox ok (C4, C43, C60): this account has no sandbox, so Ask first says every write asks and an accepted one runs unconfined, and Sandbox ok is listed and cannot be chosen.
    if (!(await openModeMenu(main, id, 'Codex'))) return undefined;
    const listed = await until('Codex’s menu to say what this account can use', () => modeMenu(main), (menu) => menu !== null && !menu.held && menu.items.find((item) => item.id === 'sandbox-ok')?.unavailable === 'needs-setup');
    const asking = listed.last?.items.find((item) => item.id === 'ask-first');
    const sandboxOk = listed.last?.items.find((item) => item.id === 'sandbox-ok');
    const account = codexAccount()?.modes?.find((mode) => mode.id === 'sandbox-ok');
    if (!listed.ok || asking === undefined || !asking.chosen || !asking.unconfined || sandboxOk === undefined || !sandboxOk.disabled || (listed.last?.inherited ?? 0) === 0 || account?.available !== false || account.reason !== 'needs-setup') problems.push(`live: on an account with no sandbox Codex’s menu shows ${JSON.stringify(listed.last ?? null)}, and main says ${JSON.stringify(account ?? null)}`);
    if (sandboxOk?.setup !== true) {
      // A system other than Windows has no setup of Codex's own (C62): no control is offered, nothing is asked, and the session stays as it is.
      if (process.platform === 'win32' || account?.setup === true || sandboxNoted().setups !== 0) problems.push(`live: Codex’s menu offers no Set up control for Sandbox ok (main says ${String(account?.setup)}, ${sandboxNoted().setups} setup(s) asked)`);
      await closeModeMenu(main);
      report['codexSetup'] = { offered: false, unavailable: sandboxOk?.unavailable ?? null, unconfined: asking?.unconfined ?? false, requests: sandboxNoted().setups };
      await completePermitted(main, id, 'Codex', fake()?.launches.at(-1)?.pid ?? 0);
      return { session: id, reference, mode: 'ask-first', approvals: outcomes, grants: 0 };
    }
    // The Set up control opens the setup's dialog, and nothing is asked of Codex before the dialog's own press (C60).
    await inPage(main, `document.querySelector('[data-mode-menu] [data-mode-setup="sandbox-ok"]')?.click(); return true;`);
    const dialog = await until('the setup’s dialog to open', () => setupShown(main), (shown) => shown.open && shown.state === 'idle' && shown.actions.length === 1);
    if (!dialog.ok || sandboxNoted().setups !== 0) { problems.push(`live: the setup’s dialog shows ${JSON.stringify(dialog.last ?? null)}, with ${sandboxNoted().setups} setup(s) asked before its press`); return undefined; }
    // Declined, as a cancelled Windows prompt is (C61): the setup failed with Codex's own reason, the account released, and the mode as unavailable as it was, its control still there.
    writeFileSync(control, JSON.stringify({ setupOutcome: 'declined' }));
    const pressedOnce = await pressSetup(main, 'start');
    const failed = await until('the declined setup to show as failed', () => setupShown(main), (shown) => shown.state === 'failed' && shown.actions.includes('start') && codexAccount()?.sandboxSetup?.readiness === 'not-configured');
    writeFileSync(control, '{}');
    const afterDecline = codexAccount();
    const stillUnavailable = afterDecline?.modes?.find((mode) => mode.id === 'sandbox-ok');
    const declinedSetup = pressedOnce && failed.ok && afterDecline?.sandboxSetup?.state === 'failed' && (afterDecline.sandboxSetup.error ?? '') !== '' && stillUnavailable?.available === false && stillUnavailable.setup && sandboxNoted().setups === 1 && sandboxNoted().state === null;
    if (!declinedSetup) { problems.push(`live: after the declined setup the dialog shows ${JSON.stringify(failed.last ?? null)}; main says ${JSON.stringify({ state: afterDecline?.sandboxSetup?.state ?? null, reason: (afterDecline?.sandboxSetup?.error ?? '').length, readiness: afterDecline?.sandboxSetup?.readiness ?? null, available: stillUnavailable?.available ?? null, setup: stillUnavailable?.setup ?? null })}, and the fake noted ${JSON.stringify(sandboxNoted())}`); return undefined; }
    // Neither what an account can use nor where its setup stands is in the Pet's state (C28).
    const inPet = await petHolds(pet, codexMade);
    if (inPet.length !== 0) problems.push(`pet: after a setup failed its state holds ${JSON.stringify(inPet)}`);
    // Try again, approved (C61): Codex's word alone is not taken — a fresh process says ready — and the modes that needed the sandbox are available.
    const pressedAgain = await pressSetup(main, 'start');
    const completed = await until('the approved setup to show as completed', () => setupShown(main), (shown) => shown.state === 'completed' && codexAccount()?.modes?.find((mode) => mode.id === 'sandbox-ok')?.available === true, 60_000);
    const afterSetup = codexAccount();
    const approvedSetup = pressedAgain && completed.ok && afterSetup?.sandboxSetup?.state === 'completed' && afterSetup.sandboxSetup.readiness === 'ready' && sandboxNoted().setups === 2 && sandboxNoted().state === 'ready';
    if (!approvedSetup) { problems.push(`live: after the approved setup the dialog shows ${JSON.stringify(completed.last ?? null)}; main says ${JSON.stringify({ state: afterSetup?.sandboxSetup?.state ?? null, readiness: afterSetup?.sandboxSetup?.readiness ?? null })}, and the fake noted ${JSON.stringify(sandboxNoted())}`); return undefined; }
    if (!(await pressSetup(main, 'close')) || !(await waitFor('the setup’s dialog to close', async () => !(await setupShown(main)).open))) problems.push('live: the setup’s dialog did not close by its button');

    // 6: Sandbox ok, chosen (C64, C75): saved at once, the session's process closed, and confirmed by the reply of the next prompt's start, which now reports a workspace sandbox.
    const toSandbox = await chooseMode(main, id, 'sandbox-ok', 'Codex');
    if (toSandbox === null) return undefined;
    const pendingSandbox = await until('Codex’s header to show Sandbox ok, to apply at the next prompt', () => modeShown(main), (shown) => shown?.saved === 'sandbox-ok' && shown.source === 'chat' && shown.pending);
    if (!(await send(main, id, prompts.basic, 'Codex’s prompt under Sandbox ok')) || !(await ended(id, 'Codex’s turn under Sandbox ok'))) return undefined;
    const confirmedHeader = await until('Codex’s header to show Sandbox ok, confirmed', () => modeShown(main), (shown) => shown?.saved === 'sandbox-ok' && !shown.pending);
    const confirmed = toSandbox.restarts && pendingSandbox.ok && confirmedHeader.ok && lastOutcome(id) === 'completed' && entryOf(id)?.summary.mode === 'sandbox-ok' && fake()?.launches.length === 3 && fake()?.opens?.length === 3 && sandboxNoted().setups === 2;
    if (!confirmed) problems.push(`live: Sandbox ok was listed for Codex as ${JSON.stringify(toSandbox)}; after its prompt main says ${String(entryOf(id)?.summary.mode)}, the header ${JSON.stringify(confirmedHeader.last ?? null)}, the turn is written ${JSON.stringify(onDisk(id)?.['lastTurn'])}, and the thread had ${fake()?.launches.length ?? 0} launch(es)`);
    report['codexSetup'] = { offered: true, unavailable: sandboxOk.unavailable, unconfined: asking?.unconfined ?? false, declined: declinedSetup, approved: approvedSetup, requests: sandboxNoted().setups, chose: 'sandbox-ok', confirmed, petHolds: inPet };
    await completePermitted(main, id, 'Codex', fake()?.launches.at(-1)?.pid ?? 0);
    return { session: id, reference, mode: 'sandbox-ok', approvals: outcomes, grants: 0 };
  }

  /**
   * M22 (V11; C12, C13, C40, C57, C77, C81, C86): after a restart a permission session's cards are
   * read from the store as they were decided and drawn inert, every grant it was sent reads ended,
   * its chat has the mode it was left with, still to be confirmed, and nothing waits — with no
   * process started for any of it.
   */
  async function permissionsFromStore(main: BrowserWindow, held: Permitted, who: 'Codex' | 'Claude'): Promise<void> {
    const launches = (): number => (who === 'Codex' ? threads()[held.reference]?.launches.length : chatSessions()[held.reference]?.launches.length) ?? 0;
    const launchesBefore = launches();
    if (entryOf(held.session) === undefined) { problems.push(`live: the first half’s ${who} permission session is not listed`); return; }
    // Read from the store, before the session is shown.
    const stored = await permissionsOf(main, held.session);
    if (JSON.stringify(stored.approvals.map((entry) => entry.outcome)) !== JSON.stringify(held.approvals) || stored.waiting !== 0 || stored.grants.length !== held.grants || stored.grants.some((grant) => grant.live) || stored.approvals.some((entry) => entry.grant?.live === true)
      || stored.mode?.id !== held.mode || stored.mode.source !== 'chat' || entryOf(held.session)?.summary.attention?.kind === 'approval' || entryOf(held.session)?.summary.mode !== null) problems.push(`live: after the restart ${who}’s approvals are stored ${storedSaid(stored)}, its process’s mode ${String(entryOf(held.session)?.summary.mode)}`);
    const selected = await ask(main, 'sessions:select', { id: held.session });
    if (selected.value?.['status'] !== 'saved' || !(await waitFor(`${who}’s permission session to show`, () => shownSelected(main, held.session)))) { problems.push(`live: selecting ${who}’s permission session answered ${JSON.stringify(selected.value ?? selected.error)}`); return; }
    const said = (outcome: string): ApprovalShown['said'] => (outcome === 'approved' ? 'approved' : outcome === 'denied' ? 'denied' : 'session-ended');
    const drawn = await until(`${who}’s cards to show in the chat read from the store`, () => approvalCards(main), (cards) => cards.length === held.approvals.length && cards.every((card, index) => settledAs(card, held.approvals[index] ?? '', said(held.approvals[index] ?? ''))));
    if (!drawn.ok) problems.push(`live: ${who}’s cards read from the store are drawn ${JSON.stringify(drawn.last ?? null)}`);
    // The Sub-agents tab, which holds the grants list, opens for a live grant alone (M100, round 8; C78): one that ended in a run
    // before is listed only once something opens the tab. So none is shown live, and where the list stands every grant in it reads ended.
    const listed = await until(`${who}’s grants to show none live`, () => grantsShown(main), (shown) => shown.live === 0 && (!shown.listed || shown.ended === held.grants));
    const header = await until(`${who}’s header to show the mode its chat was left with`, () => modeShown(main), (shown) => shown?.saved === held.mode && shown.source === 'chat' && shown.pending);
    if (!listed.ok || !header.ok) problems.push(`live: after the restart ${who}’s grants are listed ${JSON.stringify(listed.last ?? null)}, and its header shows ${JSON.stringify(header.last ?? null)}`);
    const foreign = await foreignInChat(main);
    if (foreign !== 0) problems.push(`live: ${who}’s chat read from the store holds ${foreign} element(s) a text may not become`);
    // Shown, its earlier conversation is checked where its provider keeps one (M18, C51): the fake's history of the thread is turns fat-g ran, so it lists them and asks for no turn's items.
    const history = await until(`${who}’s history check to end`, async () => ((await ask(main, 'chat:read', { sessionId: held.session })).value?.['history'] as { state?: string } | undefined)?.state, (state) => state === (who === 'Codex' ? 'checked' : 'unsupported'));
    const views = who === 'Codex' ? (threads()[held.reference]?.historyReads ?? []).map((read) => read.view) : [];
    if (!history.ok || views.some((view) => view !== 'notLoaded') || (who === 'Codex' && views.length === 0)) problems.push(`live: the history check of ${who}’s permission session read ${String(history.last)}, and asked for ${JSON.stringify(views)}`);
    if (launches() !== launchesBefore) problems.push(`live: showing ${who}’s permission session started a process`);
    report[who === 'Codex' ? 'approvalsFromStore' : 'claudeApprovalsFromStore'] = { cards: drawn.last?.length ?? 0, outcomes: (drawn.last ?? []).map((card) => card.outcome), inert: drawn.ok, grants: held.grants, liveGrants: stored.grants.filter((grant) => grant.live).length, endedListed: listed.last?.ended ?? -1, mode: header.last?.saved ?? null, foreignElements: foreign, launched: launches() - launchesBefore };
  }

  /**
   * The first half's Claude session (M16, Design 9): created beside the Codex one, T3's prompt
   * answered through a worker, T4's stopped, and completed. Answers what the next half needs.
   */
  async function firstClaude(main: BrowserWindow, project: StoredProject, root: string, codexId: string): Promise<Left['claude'] | undefined> {
    if (prompts === null) return undefined;
    const claude = [{ providerId: 'claude', instanceId: FIRST_INSTANCE_ID }];
    if (!(await waitFor('Claude to report its models', () => presetTiles(store.getSnapshot().catalog, claude).length > 0))) return undefined;
    const created = await ask(main, 'sessions:create', { projectId: project.id, preset: defaultPreset(presetTiles(store.getSnapshot().catalog, claude)) });
    const id = typeof created.value?.['id'] === 'string' ? created.value['id'] : '';
    if (created.value?.['status'] !== 'saved' || sessions.snapshot().selectedId !== id) { problems.push(`live: creating the Claude session answered ${JSON.stringify(created.value ?? created.error)}`); return undefined; }
    if (!(await waitFor('the Claude session to take a prompt', () => entryOf(id)?.block === null))) { problems.push(`live: the Claude session's reason is ${String(entryOf(id)?.block)}`); return undefined; }
    const before = chatProcesses().length;

    // T3: a sub-agent does the reading. The page shows the user's message, the commentary and the answer.
    if (!(await send(main, id, prompts.claude.worker, 'Claude’s first prompt')) || !(await ended(id, 'Claude’s first turn'))) return undefined;
    if (entryOf(id)?.summary.attention?.kind !== 'ready') problems.push(`live: Claude’s first turn ended with ${String(entryOf(id)?.summary.attention?.kind)}, expected READY`);
    await waitFor('the page to show Claude’s answer', async () => {
      const messages = await shown(main);
      return messages.some((message) => message.label === 'You' && message.text === prompts.claude.worker) && messages.some((message) => message.label !== 'You' && message.label !== 'fat-g' && message.phase === 'final');
    });
    if (!(await shown(main)).some((message) => message.label !== 'You' && message.label !== 'fat-g' && message.phase === 'commentary')) problems.push('live: the page shows no commentary of Claude’s');
    // The reference came with the session's first frame from a model (C87), and is on disk.
    const record = onDisk(id);
    const reference = typeof record?.['reference'] === 'string' ? record['reference'] : null;
    if (reference === null || typeof record?.['name'] !== 'string') { problems.push('live: records.json holds no reference or no name for the Claude session'); return undefined; }
    const session = chatSessions()[reference];
    if (session === undefined || normalizeRoot(session.cwd ?? '', process.platform) !== root) problems.push('live: the Claude session did not start in the live project’s folder');
    if (session?.launches.length !== 1 || session.launches[0]?.resume !== null || session.launches[0].addDirs.length !== 0) problems.push('live: the Claude session’s first launch was not a plain start in one folder');

    // M19 (V21): Claude's answer as it is written, as Markdown, then one made hostile, on the same process.
    if (!(await streamedAnswer(main, id, prompts.claude.markdown, 'Claude')) || !(await hostileAnswer(main, id, prompts.claude.basic, 'Claude'))) return undefined;

    // M20a (V14): what Claude did is in its chat: a read's output, the file it names, its worker's tab.
    if (!(await activity(main, id, 'Claude'))) return undefined;

    // M19b (V15): Claude's answers name a file in a code span; each opens beside the chat.
    if (!(await fileReferences(main, id, 'Claude'))) return undefined;
    // Tabs are a session's (C6): the Codex session's are shown when it is selected, and Claude's again when it is.
    const mine = (await pane(main)).tabs;
    const codexTabs = [...CODEX_TABS, ...(await listed(main, codexId)).map((aside) => aside.title || 'New aside')];
    await ask(main, 'sessions:select', { id: codexId });
    if (!(await waitFor('the Codex session’s own tabs to show', async () => JSON.stringify((await pane(main)).tabs) === JSON.stringify(codexTabs)))) problems.push(`live: the Codex session, selected again, shows the tabs ${JSON.stringify((await pane(main)).tabs)}`);
    await ask(main, 'sessions:select', { id });
    // Its Sub-agents tab and its three files' (M106, C2).
    if (mine.length !== 4 || mine[0] !== 'Sub-agents') problems.push(`live: the Claude session holds the tabs ${JSON.stringify(mine)}`);
    if (!(await waitFor('the Claude session’s own tabs to show again', async () => JSON.stringify((await pane(main)).tabs) === JSON.stringify(mine)))) problems.push(`live: the Claude session, selected again, shows the tabs ${JSON.stringify((await pane(main)).tabs)}, expected ${JSON.stringify(mine)}`);
    // Side-question titles can contain conversation text; diagnostics report counts alone.
    report['tabsBySession'] = { codex: codexTabs.length, claude: mine.length };

    // M20b (V14): questions asked beside Claude's session, on its one process; then a command fat-g answers, and one that passes.
    if (!(await asides(main, id, 'Claude')) || !(await commands(main, id))) return undefined;

    // M21 (V12): a question Claude asks through its tool, answered from its card, on the same process.
    if (!(await claudeQuestion(main, id))) return undefined;

    // T4, stopped from the page: the CLI's own interrupted end, on the same process.
    if (!(await send(main, id, prompts.claude.interrupt, 'Claude’s T4 prompt')) || !(await firstAction(id, 'Claude’s T4'))) return undefined;
    if (!(await press(main, 'Stop'))) problems.push('live: the composer has no Stop button while Claude’s turn runs');
    if (!(await ended(id, 'Claude’s stopped turn'))) return undefined;
    if (lastOutcome(id) !== 'interrupted') problems.push(`live: Claude’s stopped turn is written ${JSON.stringify(onDisk(id)?.['lastTurn'])}`);
    const after = chatSessions()[reference];
    if (after?.interrupts.length !== 1 || after.launches.length !== 1) problems.push('live: Claude’s Stop did not reach the one process as one interrupt');
    // K2's T4 was writing a text when it was stopped: the CLI's frame completed it, and the page shows no message left open (M19, C13).
    const stopped = await drawn(main, 'last');
    if (stopped === null || stopped.streaming !== 0) problems.push('live: Claude’s stopped turn left a message being written on the page');

    // Completed: its process closes at once (C45; M15, C85).
    const pids = (after?.launches ?? []).map((launch) => launch.pid);
    const completed = await ask(main, 'sessions:complete', { id });
    if (completed.value?.['status'] !== 'saved') problems.push(`live: completing the Claude session answered ${JSON.stringify(completed.value ?? completed.error)}`);
    await waitFor('the completed Claude session’s process to end', () => pids.length > 0 && pids.every((pid) => !pidAlive(pid)), 10_000);
    if (chatProcesses().length !== before + 1) problems.push(`live: the Claude session ran on ${chatProcesses().length - before} chat process(es), expected one`);
    report['firstClaude'] = { session: 'started, answered through a worker, stopped and completed', launches: pids.length };
    return { session: id, reference, launches: pids.length, chatProcesses: chatProcesses().length };
  }

  async function first(main: BrowserWindow, pet: BrowserWindow): Promise<void> {
    if (folder === undefined || !path.isAbsolute(folder) || prompts === null || threadsFile === undefined) {
      problems.push('live: the live project folder, the prompts or the thread file is missing');
      return;
    }
    const root = normalizeRoot(folder, process.platform);
    if (root === null) { problems.push('live: the live project’s folder is not an absolute path'); return; }
    // The live project: added on a first run and brought up to date when reusing an earlier run.
    const earlier = liveProject();
    if (earlier === undefined) {
      const pick = await ask(main, 'projects:pickFolder', { projectId: null, roots: [] });
      if (pick.value?.['status'] !== 'picked') { problems.push(`live: the picker answered ${JSON.stringify(pick.value ?? pick.error)}`); return; }
      const added = await ask(main, 'projects:add', { name: LIVE_PROJECT, color: 'blue', roots: [{ path: root, trust: 'trusted' }], providers: LIVE_PROVIDERS, permissionModes: LIVE_MODES });
      if (added.value?.['status'] !== 'saved') { problems.push(`live: adding the live project answered ${JSON.stringify(added.value ?? added.error)}`); return; }
    } else if (LIVE_PROVIDERS.some((provider) => !earlier.providers.includes(provider)) || Object.entries(LIVE_MODES).some(([provider, mode]) => earlier.permissionModes[provider] !== mode)) {
      const roots = earlier.roots.map((entry) => ({ path: entry.path, trust: entry.trust ?? 'trusted' }));
      await ask(main, 'projects:pickFolder', { projectId: earlier.id, roots: [] });
      const updated = await ask(main, 'projects:update', { id: earlier.id, name: LIVE_PROJECT, roots, providers: LIVE_PROVIDERS, permissionModes: LIVE_MODES });
      if (updated.value?.['status'] !== 'saved') { problems.push(`live: updating the live project answered ${JSON.stringify(updated.value ?? updated.error)}`); return; }
    }
    const project = liveProject();
    if (project === undefined || project.roots[0]?.trust !== 'trusted') { problems.push('live: the live project is missing, or not trusted'); return; }
    // What an earlier invocation left goes first, so the project holds this run's session alone.
    for (const entry of sessions.snapshot().sessions.filter((candidate) => candidate.record.projectId === project.id)) {
      const removed = await ask(main, 'sessions:remove', { id: entry.record.id });
      if (removed.value?.['status'] !== 'saved') problems.push(`live: removing an earlier session answered ${JSON.stringify(removed.value ?? removed.error)}`);
    }
    if (!(await waitFor('Codex to report its models', () => presetTiles(store.getSnapshot().catalog, [{ providerId: 'codex', instanceId: FIRST_INSTANCE_ID }]).length > 0))) return;
    const preset = defaultPreset(presetTiles(store.getSnapshot().catalog, [{ providerId: 'codex', instanceId: FIRST_INSTANCE_ID }]));
    const created = await ask(main, 'sessions:create', { projectId: project.id, preset });
    const id = typeof created.value?.['id'] === 'string' ? created.value['id'] : '';
    if (created.value?.['status'] !== 'saved' || sessions.snapshot().selectedId !== id) { problems.push(`live: creating the session answered ${JSON.stringify(created.value ?? created.error)}`); return; }
    if (!(await waitFor('the session to take a prompt', () => entryOf(id)?.block === null))) { problems.push(`live: the session's reason is ${String(entryOf(id)?.block)}`); return; }

    // 1: the saved thread's prompt — the history the next half reads is this conversation's.
    let sawRunning = false;
    const stopWatching = store.subscribe(() => { if (entryOf(id)?.summary.status === 'running') sawRunning = true; });
    if (!(await send(main, id, prompts.saved, 'the first prompt')) || !(await ended(id, 'the first turn'))) { stopWatching(); return; }
    stopWatching();
    if (!sawRunning) problems.push('live: the capsule never read running');
    if (entryOf(id)?.summary.attention?.kind !== 'ready') problems.push(`live: the first turn ended with ${String(entryOf(id)?.summary.attention?.kind)}, expected READY`);
    await waitFor('the page to show both sides', async () => {
      const messages = await shown(main);
      return messages.some((message) => message.label === 'You' && message.text === prompts.saved) && messages.some((message) => message.label !== 'You' && message.label !== 'fat-g' && message.phase === 'final');
    });
    const messages = await shown(main);
    if (!messages.some((message) => message.phase === 'commentary')) problems.push('live: the page shows no commentary');
    const record = onDisk(id);
    const reference = typeof record?.['reference'] === 'string' ? record['reference'] : null;
    if (reference === null || typeof record?.['name'] !== 'string') problems.push('live: records.json holds no reference or no name for the session');
    const thread = reference === null ? undefined : threads()[reference];
    if (thread === undefined || normalizeRoot(thread.cwd ?? '', process.platform) !== root) problems.push('live: the thread did not start in the live project’s folder');

    // The turn traced after it, on the same process: the fake's history holds these two turns, and
    // both are now ones fat-g ran and recorded (M18).
    if (!(await send(main, id, prompts.resume, 'the second prompt')) || !(await ended(id, 'the second turn'))) return;

    // M19: an answer that streams as Markdown, then one made hostile.
    if (!(await streamedAnswer(main, id, prompts.markdown, 'Codex')) || !(await hostileAnswer(main, id, prompts.basic, 'Codex'))) return;

    // M20a (V14): what Codex did is in its chat: a read's output, the file it names, its worker's tab.
    if (!(await activity(main, id, 'Codex'))) return;

    // M19b (V15): Codex's answers name a file by a link with an absolute address; each opens beside the chat.
    if (!(await fileReferences(main, id, 'Codex'))) return;

    // M20b (V14): questions asked beside Codex's session, each on a side thread of its own.
    if (!(await asides(main, id, 'Codex'))) return;

    // M21 (V12): a question Codex asks in a message, answered from its card, and a second one dismissed.
    if (!(await codexQuestions(main, id))) return;

    // 2: T4's prompt, stopped from the page.
    if (!(await send(main, id, prompts.interrupt, 'T4’s prompt'))) return;
    if (!(await firstAction(id, 'T4'))) return;
    if (!(await press(main, 'Stop'))) problems.push('live: the composer has no Stop button while the turn runs');
    if (!(await ended(id, 'the stopped turn'))) return;
    if ((onDisk(id)?.['lastTurn'] as { outcome?: string } | null)?.outcome !== 'interrupted') problems.push(`live: the stopped turn is written ${JSON.stringify(onDisk(id)?.['lastTurn'])}`);

    // 3: completed, its process closes at once (C85).
    const pids = (reference === null ? [] : threads()[reference]?.launches ?? []).map((launch) => launch.pid);
    const completed = await ask(main, 'sessions:complete', { id });
    if (completed.value?.['status'] !== 'saved') problems.push(`live: completing the session answered ${JSON.stringify(completed.value ?? completed.error)}`);
    await waitFor('the completed session’s process to end', () => pids.length > 0 && pids.every((pid) => !pidAlive(pid)), 10_000);
    report['first'] = { session: 'started, answered, stopped and completed', launches: pids.length, sawRunning };

    // 4: a Claude session beside it (M16).
    const claude = await firstClaude(main, project, root, id);
    if (claude === undefined) { if (problems.length === 0) problems.push('live: the Claude session did not run'); return; }

    // 5: what a session may do (M22, V11, V12), on a session of each provider made for it: the two
    // above ran on one process each and were answered one question, and stay so.
    const claudePermitted = await claudePermissions(main, pet, project);
    if (claudePermitted === undefined) { if (problems.length === 0) problems.push('live: Claude’s permission session did not run'); return; }
    const codexPermitted = await codexPermissions(main, pet, project);
    if (codexPermitted === undefined) { if (problems.length === 0) problems.push('live: Codex’s permission session did not run'); return; }
    report['permissions'] = { csp: await violations(main, 'the permission sessions') };

    // 6: a plan on each provider (M22b, V7; 0029): made, shown, executed, discarded or left, and the one left brought into the other's chat.
    if (!(await plans(main, project))) { if (problems.length === 0) problems.push('live: the plans did not run'); return; }

    // 7: a review on each provider (M22e, V5): started, a round, a mark, a note and Send notes, then integrated into the plan's own chat.
    const reviewed = await reviews(main, project);
    if (reviewed === undefined) { if (problems.length === 0) problems.push('live: the reviews did not run'); return; }

    await checkPet(pet, [id, claude.session]);
    // The chat processes the fake recorded are counted here, with the permission session's among them: the next half starts none to show a chat.
    const left: Left = { session: id, reference, launches: pids.length, claude: { ...claude, chatProcesses: chatProcesses().length }, permissions: { claude: claudePermitted, codex: codexPermitted }, reviews: reviewed };
    writeFileSync(marker, JSON.stringify(left));
  }

  /**
   * For the maintainer's review only (V25): a reply with questions and a notice are added to the
   * conversation, and the chat is captured in both themes, then with a reason in its input's place.
   * The theme is put back.
   */
  async function captureVisuals(main: BrowserWindow, id: string): Promise<void> {
    const directory = process.env['FATG_SMOKE_VISUAL_DIR'];
    const control = process.env['FATG_SMOKE_CODEX_CONTROL'];
    if (directory === undefined || prompts === null) return;
    if (!path.isAbsolute(directory) || control === undefined) { problems.push('live: the visual capture folder must be an absolute path'); return; }
    mkdirSync(directory, { recursive: true });
    if (!(await send(main, id, prompts.question, 'T6’s prompt')) || !(await ended(id, 'T6’s turn'))) return;
    // A process lost during its turn: the notice, in fat-g's words. The next prompt resumes in a new one.
    writeFileSync(control, JSON.stringify({ exitDuringTurn: 1 }));
    if (!(await send(main, id, prompts.basic, 'a prompt whose process is lost')) || !(await ended(id, 'the lost turn'))) return;
    writeFileSync(control, '{}');
    const before = prefs.getSnapshot().values.appearance.theme;
    const capture = async (name: string): Promise<void> => {
      const bounds = main.getBounds();
      main.setBounds({ ...bounds, width: bounds.width + 1 });
      await delay(50);
      main.setBounds(bounds);
      await delay(400);
      writeFileSync(path.join(directory, `${name}.png`), (await main.webContents.capturePage()).toPNG());
    };
    for (const theme of ['light', 'dark'] as const) {
      prefs.patch({ appearance: { theme } });
      await delay(300);
      await capture(`chat-${theme}`);
    }
    // A reason in place of the input: the project no longer offered to Codex, for a moment.
    await withReason(main, id, 'claude', () => capture('chat-reason'));
    prefs.patch({ appearance: { theme: before } });
    report['visuals'] = directory;
  }

  /** Runs `work` while the live project is offered to `only` alone, so the session of the other provider shows its reason. */
  async function withReason(main: BrowserWindow, id: string, only: string, work: () => Promise<void>): Promise<void> {
    const project = liveProject();
    if (project === undefined) return;
    const roots = project.roots.map((root) => ({ path: root.path, trust: root.trust ?? 'trusted' }));
    await ask(main, 'projects:pickFolder', { projectId: project.id, roots: [] });
    await ask(main, 'projects:update', { id: project.id, name: LIVE_PROJECT, roots, providers: [only] });
    if (await waitFor('the reason to show in place of the input', () => entryOf(id)?.block === 'not-offered')) await work();
    await ask(main, 'projects:update', { id: project.id, name: LIVE_PROJECT, roots, providers: LIVE_PROVIDERS });
    await waitFor('the session to take a prompt again', () => entryOf(id)?.block === null);
  }

  /**
   * For the maintainer's review only (M16, V22): Claude's conversation in both themes, at the
   * default and the minimum window size, with both phases and a notice; a reason in place of its
   * input; and, on a session of its own, the line for earlier messages that are not saved.
   */
  async function captureClaudeVisuals(main: BrowserWindow, id: string): Promise<void> {
    const directory = process.env['FATG_SMOKE_VISUAL_DIR'];
    if (directory === undefined || prompts === null || claudeDirectory === undefined || !path.isAbsolute(directory)) return;
    const project = liveProject();
    if (project === undefined) return;
    mkdirSync(directory, { recursive: true });
    const control = path.join(claudeDirectory, 'control.json');
    // A process lost during its turn: the notice, in fat-g's words, naming Claude. The next prompt resumes.
    writeFileSync(control, JSON.stringify({ exitDuringTurn: 1 }));
    if (!(await send(main, id, prompts.claude.basic, 'a Claude prompt whose process is lost')) || !(await ended(id, 'Claude’s lost turn'))) return;
    writeFileSync(control, '{}');
    const before = prefs.getSnapshot().values.appearance.theme;
    const bounds = main.getBounds();
    const capture = async (name: string): Promise<void> => {
      await delay(400);
      writeFileSync(path.join(directory, `${name}.png`), (await main.webContents.capturePage()).toPNG());
    };
    const inBothThemes = async (name: string): Promise<void> => {
      for (const theme of ['light', 'dark'] as const) {
        prefs.patch({ appearance: { theme } });
        await delay(300);
        await capture(`${name}-${theme}`);
      }
    };
    await inBothThemes('claude-chat');
    main.setBounds({ ...bounds, ...MAIN_PLACEMENT.minSize });
    await inBothThemes('claude-chat-min');
    main.setBounds(bounds);
    await withReason(main, id, 'codex', () => inBothThemes('claude-reason'));

    // Earlier messages that are not saved: a session of its own, started, whose saved chat is then
    // deleted while its record stays — what deleting the conversation store by hand leaves.
    const claude = [{ providerId: 'claude', instanceId: FIRST_INSTANCE_ID }];
    const created = await ask(main, 'sessions:create', { projectId: project.id, preset: defaultPreset(presetTiles(store.getSnapshot().catalog, claude)) });
    const other = typeof created.value?.['id'] === 'string' ? created.value['id'] : '';
    if (created.value?.['status'] === 'saved' && await waitFor('the second Claude session to take a prompt', () => entryOf(other)?.block === null)
      && await send(main, other, prompts.claude.basic, 'the second Claude session’s prompt') && await ended(other, 'the second Claude session’s turn')) {
      removeChat(other);
      // Selected again, the chat is read again: nothing of it is saved, and the line says so. The
      // page is waited for at each step, since it reads a chat when it comes to show it.
      const pageShows = (text: string): Promise<boolean> => main.webContents.executeJavaScript(`(document.querySelector('${CHAT_MAIN}')?.textContent ?? '').includes(${JSON.stringify(text)})`) as Promise<boolean>;
      await ask(main, 'sessions:select', { id });
      await waitFor('the page to show the first Claude session again', () => pageShows(prompts.claude.worker));
      await ask(main, 'sessions:select', { id: other });
      if (await waitFor('the line for earlier messages', () => pageShows(CHAT_LINES.earlierMissing))
        // The next prompt resumes the conversation, and what follows the line is recorded and shown.
        && await send(main, other, prompts.claude.basic, 'the prompt after the line') && await ended(other, 'the turn after the line')
        && await waitFor('the answer after the line', async () => (await shown(main)).some((message) => message.phase === 'final'))) await inBothThemes('claude-earlier-not-saved');
      await ask(main, 'sessions:remove', { id: other });
      await ask(main, 'sessions:select', { id });
    } else problems.push('live: the second Claude session, for the visual capture, did not run');
    prefs.patch({ appearance: { theme: before } });
  }

  /**
   * The next half's Claude session (M16, Design 9), while a Codex turn runs: listed, read from the
   * conversation store and shown with no chat process started, then resumed by a prompt.
   */
  async function nextClaude(main: BrowserWindow, left: NonNullable<Left['claude']>, codexId: string): Promise<boolean> {
    if (prompts === null) return false;
    const { session: id, reference } = left;
    const entry = entryOf(id);
    if (entry === undefined) { problems.push('live: the first half’s Claude session is not listed'); return false; }
    if (entry.record.completedAt === null) problems.push('live: the first half’s Claude session is not back completed');
    // Read from the store, before it is selected: Claude has no history to read back (C49), and no process is started for it (C48).
    const fromStore = await ask(main, 'chat:read', { sessionId: id });
    const stored = (fromStore.value?.['items'] ?? []) as { role: string | null; phase: string | null; blocks: { text: string }[]; kind?: string; workerId?: string | null; activity?: { type?: string; status?: string } | null }[];
    const history = fromStore.value?.['history'] as { state?: string; earlierMissing?: boolean } | undefined;
    // M20a (V14): what the session did is read from the store with what it said, none of it running, and none of it a worker's.
    const did = stored.filter((item) => item.kind === 'activity');
    if (did.length === 0 || did.some((item) => item.activity?.status === 'running' || (item.workerId ?? null) !== null) || !did.some((item) => item.activity?.type === 'worker')) problems.push(`live: the Claude chat read from the store holds ${did.length} activities: ${JSON.stringify(did.map((item) => [item.activity?.type, item.activity?.status]))}`);
    if (!stored.some((item) => item.role === 'user' && item.blocks[0]?.text === prompts.claude.worker) || !stored.some((item) => item.role === 'user' && item.blocks[0]?.text === prompts.claude.interrupt)
      // Ten answers: T3's, the Markdown one and the hostile one (M19), the three that name a file and
      // the one whose references lead out (M19b), the CLI's own to the command that passed (M20b), and
      // the one that followed the answered question (M21), and the one a message queued on the idle
      // session brought (M23); T4 was stopped, and named none, and the command fat-g answered has its
      // notice, which is no answer.
      || !stored.some((item) => item.phase === 'commentary') || stored.filter((item) => item.phase === 'final').length !== 10) {
      problems.push(`live: the first half’s Claude chat was not read from the store (${stored.length} items)`);
    }
    if (history?.state !== 'unsupported' || history.earlierMissing !== false) problems.push(`live: the Claude chat's history read ${JSON.stringify(history ?? null)}, expected unsupported with nothing missing`);
    const selected = await ask(main, 'sessions:select', { id });
    if (selected.value?.['status'] !== 'saved') { problems.push(`live: selecting the Claude session answered ${JSON.stringify(selected.value ?? selected.error)}`); return false; }
    if (!(await waitFor('Claude’s earlier conversation to show', async () => {
      const messages = await shown(main);
      return messages.some((message) => message.label === 'You' && message.text === prompts.claude.worker) && messages.some((message) => message.label !== 'You' && message.label !== 'fat-g' && message.phase === 'final');
    }))) return false;
    // M19 (V21): the same chat again, from the store, with no process — the Markdown answer with its code
    // block and that block's Copy button, the hostile one as text.
    const code = await drawn(main, 'with-code');
    const hostile = await drawn(main, 'with-markup');
    if (code === null || code.state !== 'complete' || code.copyCode !== code.code || code.rows < 10) problems.push(`live: Claude’s Markdown answer read from the store is drawn ${JSON.stringify(code === null ? null : { state: code.state, code: code.code, copyCode: code.copyCode, rows: code.rows })}`);
    if (hostile === null || hostile.state !== 'complete') problems.push('live: Claude’s hostile answer read from the store is not shown as text');
    if (code !== null) inert('Claude’s chat read from the store', code);
    report['claudeFromStore'] = { codeBlocks: code?.code ?? 0, copyCode: code?.copyCode ?? 0, tableRows: code?.rows ?? 0, hostileAsText: hostile?.markup ?? false, foreignElements: code?.foreign ?? -1 };
    // M20b (V14): its asides, read from the store, and one reopened from its marker: the ledger below shows no process was started for it.
    await asidesFromStore(main, id, 'Claude');
    // M21 (V12): and its question, answered in the first half: there, inert, with no process started for it.
    await questionsFromStore(main, id, 'Claude', ['answered']);
    // The fake's ledger: no chat process since the first half's one, which is gone.
    const processes = chatProcesses();
    // Force-killed fixtures cannot record their end, and Windows can already have reassigned
    // their PIDs to unrelated processes. Check new launches here; scripts/smoke.mjs independently
    // verifies every fixture's PID AND birth time after these launches, including forced ends.
    if (processes.length !== left.chatProcesses) problems.push(`live: showing Claude’s chat started a process (${processes.length} recorded, ${left.chatProcesses} expected)`);
    if ((chatSessions()[reference]?.launches.length ?? 0) !== left.launches) problems.push('live: showing Claude’s chat launched its session');

    // A prompt resumes it, in a new process, while the Codex turn runs.
    if (!(await send(main, id, prompts.claude.basic, 'Claude’s resuming prompt')) || !(await ended(id, 'Claude’s resumed turn'))) return false;
    const after = chatSessions()[reference];
    if (after?.launches.length !== left.launches + 1 || after.launches.at(-1)?.resume !== reference) problems.push(`live: Claude’s resume launched ${(after?.launches.length ?? 0) - left.launches} process(es), or named another session`);
    if (after?.turns.at(-1) !== 'm19-t1-basic') problems.push('live: Claude’s resumed session did not run the prompt it was sent');
    if (onDisk(id)?.['reference'] !== reference) problems.push('live: the resume changed the Claude session’s reference');
    if (lastOutcome(id) !== 'completed') problems.push(`live: Claude’s resumed turn is written ${JSON.stringify(onDisk(id)?.['lastTurn'])}`);
    const resumed = (((await ask(main, 'chat:read', { sessionId: id })).value?.['items'] ?? []) as { role: string | null; kind?: string }[]);
    // Nothing of the earlier conversation came back with the resume (C50): one more prompt, the read its turn ran (M20a) and one more answer.
    const said = (list: readonly { kind?: string }[]): number => list.filter((item) => item.kind !== 'activity').length;
    if (said(resumed) !== said(stored) + 2 || resumed.length !== stored.length + 3) problems.push(`live: Claude’s resume changed the chat from ${stored.length} items to ${resumed.length} (${said(stored)} to ${said(resumed)} messages), expected a prompt, a read and an answer more`);
    if (entryOf(codexId)?.summary.status !== 'running') problems.push('live: the Codex turn was not running while Claude’s session resumed');
    report['nextClaude'] = { listed: true, chat: 'read from the store with no chat process', history: 'unsupported', resumed: 'in a new process, while a Codex turn ran' };
    return true;
  }

  async function next(main: BrowserWindow, pet: BrowserWindow): Promise<void> {
    const left = readJson(marker) as Left | null;
    const id = left?.session;
    const reference = left?.reference ?? null;
    const claude = left?.claude;
    if (id === undefined || reference === null || claude === undefined || prompts === null) { problems.push('live: the first half left no session'); return; }
    // M22 (V11): first, the two permission sessions as this launch finds them — every card read from
    // the store and inert, every grant ended, no process started. The sessions below are not shown yet.
    // Codex's first, then Claude's: Codex's chat begins with the saved thread's prompt, as the session
    // below does, and the page must not still be showing it when that session's own chat is waited for.
    if (left?.permissions === undefined) { problems.push('live: the first half left no permission session'); return; }
    await permissionsFromStore(main, left.permissions.codex, 'Codex');
    await permissionsFromStore(main, left.permissions.claude, 'Claude');
    report['permissionsFromStore'] = { csp: await violations(main, 'the permission sessions were read from the store') };
    // M22e (V5): each review as this launch finds it, from the plan store alone.
    if (left?.reviews === undefined) problems.push('live: the first half left no review');
    else { await reviewsFromStore(main, left.reviews.codex, 'Codex'); await reviewsFromStore(main, left.reviews.claude, 'Claude'); }
    // 4: listed, and selected it shows the earlier conversation, read with no session process.
    const entry = entryOf(id);
    if (entry === undefined) { problems.push('live: the first half’s session is not listed'); return; }
    if (entry.record.completedAt === null) problems.push('live: the first half’s session is not back completed');
    // M18 (V2): a chat written by one launch is read by the next, from the conversation store, before
    // anything is asked of the provider — the session is not selected yet, and no history was read.
    const fromStore = await ask(main, 'chat:read', { sessionId: id });
    const stored = (fromStore.value?.['items'] ?? []) as { role: string | null; phase: string | null; blocks: { text: string }[]; kind?: string; workerId?: string | null; activity?: { type?: string; status?: string } | null }[];
    const storedHistory = fromStore.value?.['history'] as { state?: string } | undefined;
    // M20a (V14): what the session did is read from the store with what it said, none of it running, and none of it a worker's.
    const did = stored.filter((item) => item.kind === 'activity');
    if (did.length === 0 || did.some((item) => item.activity?.status === 'running' || (item.workerId ?? null) !== null) || !did.some((item) => item.activity?.type === 'worker')) problems.push(`live: the chat read from the store holds ${did.length} activities: ${JSON.stringify(did.map((item) => [item.activity?.type, item.activity?.status]))}`);
    if (!stored.some((item) => item.role === 'user' && item.blocks[0]?.text === prompts.saved) || !stored.some((item) => item.role === 'user' && item.blocks[0]?.text === prompts.resume) || stored.filter((item) => item.phase === 'final').length < 2) {
      problems.push(`live: the first half’s chat was not read from the store (${stored.length} items)`);
    }
    if (storedHistory?.state !== 'not-checked') problems.push(`live: the chat's history read ${String(storedHistory?.state)} before it was selected, expected not-checked`);
    if ((threads()[reference]?.historyReads?.length ?? 0) !== 0) problems.push('live: the fake was asked for history before the chat was shown');
    const selected = await ask(main, 'sessions:select', { id });
    if (selected.value?.['status'] !== 'saved') { problems.push(`live: selecting the session answered ${JSON.stringify(selected.value ?? selected.error)}`); return; }
    const launchesBefore = threads()[reference]?.launches.length ?? 0;
    if (!(await waitFor('the earlier conversation to show', async () => {
      const messages = await shown(main);
      return messages.some((message) => message.label === 'You' && message.text === prompts.saved) && messages.some((message) => message.phase === 'final');
    }))) return;
    if ((threads()[reference]?.launches.length ?? 0) !== launchesBefore) problems.push('live: reading the earlier messages started a session process');
    // A restart restores Sub-agents and saved side questions. File tabs still open at the user's press.
    const savedQuestions = await listed(main, id);
    const expectedTabs = ['Sub-agents', ...savedQuestions.map((aside) => aside.title || 'New aside')];
    await waitFor('the saved side-question tabs to restore', async () => JSON.stringify((await pane(main)).tabs) === JSON.stringify(expectedTabs));
    const restarted = await pane(main);
    const agents = entryOf(id)?.summary.agents ?? [];
    if (JSON.stringify(restarted.tabs) !== JSON.stringify(expectedTabs) || agents.length === 0 || agents.some((agent) => agent.state === 'running')) {
      problems.push(`live: the pane begins a new run with the tabs ${JSON.stringify(restarted.tabs)}, the session listing ${JSON.stringify(agents.map((agent) => [agent.number, agent.state]))}`);
    }
    const reopened = await opens(main, 'Codex', 'README, read from the store', prompts.headings.readme, 'README', (found) => found.heading === prompts.headings.readme && found.view === 'markdown');
    if ((threads()[reference]?.launches.length ?? 0) !== launchesBefore) problems.push('live: opening a file from the stored chat started a session process');
    report['tabsAfterRestart'] = { atStart: restarted.tabs.length, subAgentsListed: agents.length, reopened: reopened?.heading ?? null };
    // M20b (V14): its asides are read from the store too, and a marker reopens one, with no session process.
    await asidesFromStore(main, id, 'Codex');
    if ((threads()[reference]?.launches.length ?? 0) !== launchesBefore) problems.push('live: reopening an aside from the stored chat started a session process');
    // M21 (V12): its two questions, as the first half settled them: there, inert, and nothing waiting.
    await questionsFromStore(main, id, 'Codex', ['answered', 'dismissed']);
    // M19 (V21): the same chat again, from the store — the Markdown answer with its code block and that
    // block's Copy button, the hostile one as text, and no message left open.
    const code = await drawn(main, 'with-code');
    const hostile = await drawn(main, 'with-markup');
    if (code === null || code.state !== 'complete' || code.copyCode !== code.code || code.rows < 10) problems.push(`live: the Markdown answer read from the store is drawn ${JSON.stringify(code === null ? null : { state: code.state, code: code.code, copyCode: code.copyCode, rows: code.rows })}`);
    if (hostile === null || hostile.state !== 'complete') problems.push('live: the hostile answer read from the store is not shown as text');
    if (code !== null) inert('the chat read from the store', code);
    report['fromStore'] = { codeBlocks: code?.code ?? 0, copyCode: code?.copyCode ?? 0, tableRows: code?.rows ?? 0, hostileAsText: hostile?.markup ?? false, foreignElements: code?.foreign ?? -1 };
    // The history check listed the turns, found both in the store, and asked for no turn's items (M18, C51).
    if (!(await waitFor('the history check to end', async () => ((await ask(main, 'chat:read', { sessionId: id })).value?.['history'] as { state?: string } | undefined)?.state === 'checked'))) return;
    const views = (threads()[reference]?.historyReads ?? []).map((read) => read.view);
    if (views.length === 0 || views.some((view) => view !== 'notLoaded')) problems.push(`live: the history check asked for ${JSON.stringify(views)}, expected the turns alone`);
    const afterCheck = ((await ask(main, 'chat:read', { sessionId: id })).value?.['items'] ?? []) as unknown[];
    if (afterCheck.length !== stored.length) problems.push(`live: the history check changed the chat from ${stored.length} items to ${afterCheck.length}`);

    // A new prompt resumes it, in a new process.
    if (!(await send(main, id, prompts.basic, 'the resuming prompt')) || !(await ended(id, 'the resumed turn'))) return;
    const after = threads()[reference];
    if ((after?.launches.length ?? 0) !== launchesBefore + 1) problems.push(`live: the resume launched ${(after?.launches.length ?? 0) - launchesBefore} process(es), expected one`);
    if (onDisk(id)?.['reference'] !== reference) problems.push('live: the resume changed the session’s reference');
    if (Object.keys(threads()).filter((key) => key === reference).length !== 1) problems.push('live: the thread is not the one the first half started');

    await captureVisuals(main, id);

    // 6: T4's prompt, and the app's own quit while its turn runs. The script reads the rest.
    if (!(await send(main, id, prompts.interrupt, 'T4’s prompt'))) return;
    if (!(await firstAction(id, 'T4'))) return;
    // 7: meanwhile the Claude session, read from the store and resumed (M16).
    if (!(await nextClaude(main, claude, id))) return;
    await checkPet(pet, [id, claude.session]);
    await captureClaudeVisuals(main, claude.session);
    if (entryOf(id)?.summary.status !== 'running') { problems.push('live: the Codex turn ended before the quit'); return; }
    writeFileSync(marker, JSON.stringify({ ...left, quitDuring: id, interruptsBefore: after?.interrupts.length ?? 0 }));
    report['next'] = { listed: true, chat: 'read from the store before any history request', history: `checked with ${views.length} request(s), no turn's items`, resumed: 'in a new process', quitDuringTurn: true };
    const answer = await ask(main, 'app:quit', null);
    if (!answer.ok) { problems.push(`live: app:quit answered ${String(answer.error)}`); return; }
    const quitButton = `(() => {
      const dialog = [...document.querySelectorAll('dialog[open]')].find((element) => element.querySelector('h2')?.textContent === 'Quit fat-g?');
      return [...(dialog?.querySelectorAll('button') ?? [])].find((element) => element.textContent === 'Quit') !== undefined;
    })()`;
    // The state says the question is asked a moment before the page has drawn it.
    if (!(await waitFor('the quit question to show in the Main page', async () => store.getSnapshot().quitQuestion === true && (await main.webContents.executeJavaScript(quitButton)) === true))) return;
    quitting = true;
    // The question's own Quit button, after the report: the app's quit path does the rest.
    finish();
    await main.webContents.executeJavaScript(`(() => {
      const dialog = [...document.querySelectorAll('dialog[open]')].find((element) => element.querySelector('h2')?.textContent === 'Quit fat-g?');
      [...(dialog?.querySelectorAll('button') ?? [])].find((element) => element.textContent === 'Quit')?.click();
    })()`);
  }

  void (async () => {
    const main = windows.get('main');
    const pet = windows.get('pet');
    if (main === undefined || pet === undefined) { problems.push('live: a window is missing'); finish(); return; }
    // A page's error is a problem of the run, as in the demo launch (smoke.ts): the first lines of each, the fixtures' words alone.
    for (const [kind, contents] of [['main', main.webContents], ['pet', pet.webContents]] as const) {
      contents.on('console-message', (event) => { if (event.level === 'error') problems.push(`live: ${kind}: console error: ${event.message.slice(0, 300)}`); });
    }
    await waitFor('both pages to load', async () => !main.webContents.isLoading() && !pet.webContents.isLoading()
      && (await main.webContents.executeJavaScript(`document.querySelector('[data-smoke-page]') !== null`)) === true
      && (await pet.webContents.executeJavaScript(`document.querySelector('[data-smoke-page]') !== null`)) === true);
    // Counts what the Pet is pushed on the chat channel: it must be nothing.
    await pet.webContents.executeJavaScript(`window.__fatgChatPushes = 0; window.fatg.on('chat:message', () => { window.__fatgChatPushes += 1; }); true`);
    try {
      await checkProviderDiscovery(main, pet);
      if (stage === 'first') await first(main, pet);
      else await next(main, pet);
    } catch (error) {
      problems.push(`live: ${error instanceof Error ? error.name : 'failure'}`);
    }
    const csp = (await main.webContents.executeJavaScript(`document.querySelector('[data-smoke-page]')?.getAttribute('data-smoke-csp') ?? null`).catch(() => null)) as unknown;
    if (csp !== '0' && !quitting) problems.push(`main: CSP violations: ${String(csp)}`);
    if (quitting) return;
    finish();
    // Nothing runs at the end of the first half: the quit asks nothing.
    if (problems.length === 0) await ask(main, 'app:quit', null).catch(() => undefined);
  })();
  setTimeout(() => { if (!finished) { problems.push('live: the run timed out'); finish(); } }, TIMEOUT_MS).unref();
}
