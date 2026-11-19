// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The session facet (docs/planning/_archive/M15.md, Design 3; C7, C8, C116, C121; M18.md, Design 1; M21.md,
// Design 2; C30; M22.md, Design 2, 3, 7; C39; M22b.md, Design 1; C2, C11, C13, C55): how
// main starts a provider's session, sends it a prompt, stops it and — where the provider can —
// reads its earlier conversation back. It speaks of sessions only, never of threads, processes or
// connections: how a provider runs one is its module's own, and nothing above an adapter may
// depend on it.
//
// A provider whose descriptor says `capabilities.sessions` has one, as `AgentProvider.sessions`.
import type { AgentEvent, HistoryActivity, HistoryMessage, HistoryPlan, HistoryTurn } from '../contracts/agent-events';
import type { HistoryReturnedImage } from '../contracts/returned-images';
import type { SteerState } from '../contracts/composer';
import type { CommandNoticeKind } from '../contracts/conversation';
import type { ApprovalChoice, GivenAnswer } from '../contracts/interaction';
import type { ModeAvailability, ModeTransition, SandboxSetupView, SetupAction } from '../contracts/permissions';
import type { PlanAvailability } from '../contracts/plans';
import type { CleanupResult } from './process';
import type { AttachmentMediaType } from '../contracts/attachments';

/**
 * An image of a prompt (M23, C21, C24; decision 0030), as main hands it to an adapter: its type, the
 * path of its file in fat-g's own images' folder — which main built from the image's hash and checked
 * — and its bytes, read and checked against that hash. A CLI that reads a path is handed the path; one
 * that takes the image inline is handed the bytes, which the adapter lets go once its line is written.
 * An adapter never resolves a path of its own, nor reads fat-g's folder.
 */
export interface PromptAttachment {
  readonly mediaType: AttachmentMediaType;
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface SessionStart {
  /** Where the session runs: a folder main has checked (C30). */
  readonly folder: string;
  /** The catalog's key, as the record stores it (C22). */
  readonly model: string;
  /** Null for a model with no levels. Given again with each turn. */
  readonly effort: string | null;
  /**
   * The speed tier the record asks for, by the id the model lists for it (decision 0016); null for
   * standard speed. Given again with each turn: an adapter that names it at the start names it there.
   */
  readonly speed: string | null;
  /**
   * The project's other root folders that main has checked as it checks `folder` — registered,
   * trusted and present — and never `folder` itself (M16, C19, C61). Worked out at each start and
   * resume, and empty for a provider whose descriptor does not say `capabilities.otherFolders`. An
   * adapter never reads a project's record: this list is all it knows of the other roots.
   */
  readonly otherFolders: readonly string[];
  /**
   * The id of the mode the session's process is to run under (M22, C2, C39): one of the modes the
   * provider's descriptor declares, which main resolved for the chat and checked against the
   * account. The adapter maps it to its CLI's own words, names it at the start and checks what the
   * CLI reports before any prompt goes. Null for a provider whose descriptor declares no mode.
   */
  readonly mode: string | null;
  /**
   * Main's key for this process, unique across runs (M22, C81): made at each open. A session grant
   * names the process it was sent to by it. An adapter keeps and reads nothing of it.
   */
  readonly processKey: string;
}

export interface SessionResume extends SessionStart {
  /** What a `session-started` event of an earlier session carried. */
  readonly reference: string;
}

export interface TurnRequest {
  /** The runtime's id for the turn (C86): every event of the turn names it. */
  readonly turnId: string;
  readonly prompt: string;
  readonly effort: string | null;
  /**
   * The speed tier this turn asks for, by the model's id for it; null for standard speed (decision
   * 0016). An adapter asks for standard speed explicitly where its CLI would otherwise take the
   * user's own configuration.
   */
  readonly speed: string | null;
  /** The chat's id for the user's message, sent with the prompt so the provider's echo can be matched (C56). */
  readonly messageId: string;
  /**
   * The prompt's images, in their order (M23, C21): sent with its text in the one write the CLI takes.
   * Left out, or empty, for a prompt of text alone; a prompt of images alone has an empty text.
   */
  readonly attachments?: readonly PromptAttachment[];
  /**
   * A plan turn (M22b, C1, C2): the prompt is answered in the provider's plan mode, under the chat's
   * mode, which never changes for it. Only for a provider whose descriptor declares `plans`.
   */
  readonly plan?: boolean;
  /**
   * A plan turn of fat-g's ran on this session before (M22b, C55), as the conversation store records:
   * a provider whose plan mode outlives its turn is returned from it by every turn that is not one.
   */
  readonly plannedBefore?: boolean;
  /**
   * A skill the user chose from the menu (M23, C64, C87): its name and the adapter's own selector,
   * which the adapter resolves against its CLI's current list and sends as an input of its own. Main
   * checked the selector was listed just before; one the adapter no longer holds fails the start.
   */
  readonly skill?: { readonly name: string; readonly selector: string };
}

/**
 * A command or a skill as a CLI lists it (M23, C58–C64): its name, description and argument hint as
 * given, bounded by main. `selector`: the adapter's opaque id for a skill whose choice goes with the
 * prompt as an input of its own — never a path; null for a row whose choice is only its text.
 */
export interface ProviderCommand {
  readonly name: string;
  readonly description: string | null;
  readonly hint: string | null;
  readonly group: 'commands' | 'skills';
  readonly selector: string | null;
}

/**
 * A message sent into the running turn (M23, C36): the turn it joins, by the runtime's id, and the
 * message as a prompt carries it — the chat's id for it, its text and its images. The provider's own
 * id for the turn is the adapter's to know: nothing here can name one.
 */
export interface SteerRequest {
  readonly turnId: string;
  readonly messageId: string;
  readonly prompt: string;
  readonly attachments?: readonly PromptAttachment[];
}

/**
 * What became of a steer, as the adapter alone can tell (M23, C38–C40). `taken`: the provider named
 * the running turn as the message's. `handed`: written to the live process, which says later what it
 * did with it, by `delivery` and `held-turn-started` events. `turn-over`: refused because that turn
 * had ended, proven, and nothing of it delivered — main sends it as the next prompt. `refused`: any
 * other definite refusal, with the CLI's bounded word. `unknown`: no decisive word — a reply that
 * never came, a process lost. It never rejects.
 */
export type SteerOutcome =
  | { readonly kind: 'taken' }
  | { readonly kind: 'handed' }
  | { readonly kind: 'turn-over' }
  | { readonly kind: 'refused'; readonly detail: string | null }
  | { readonly kind: 'unknown' };

/**
 * A decision on a plan a request holds (M22b, C11): feedback with the user's words, which the CLI
 * takes as the request's refusal and revises from; Execute, the request allowed as it came; or
 * Cancel, which refuses it and ends the turn.
 */
export type PlanAnswer = { readonly kind: 'feedback'; readonly text: string } | { readonly kind: 'execute' } | { readonly kind: 'cancel' };

/** One exchange of an aside (M20b, C13, C22): a question as it was sent, and the answer it got. */
export interface AsideExchange {
  readonly question: string;
  readonly response: string;
}

/**
 * One question asked beside the session (docs/planning/_archive/M20b.md, Design 2; C26): answered against
 * what the session already holds, and adding nothing to it. It is no turn of the session's: it
 * waits for none and interrupts none, and every event of it names the aside.
 */
export interface AsideRequest {
  /** Main's id for the aside: every event of it names it. */
  readonly asideId: string;
  /** The runtime's id for this question's turn, a turn of the aside's own. */
  readonly turnId: string;
  /** The text to send: fat-g's seed question around a selection (C51), or a question as it was typed. */
  readonly text: string;
  /** The chat's id for the question's message. */
  readonly messageId: string;
  /**
   * The aside's earlier exchanges, oldest first (C13, C22): for a provider whose route keeps none of
   * them, which sends them again; one whose route keeps them reads this only when it has to begin anew.
   */
  readonly history: readonly AsideExchange[];
  /**
   * The provider's own id of the session's newest turn whose end the provider reported, or null
   * while none has one (C19, C69): for a provider that answers from a copy of the session's
   * conversation, which is taken through that turn. Main reads it from the conversation store.
   */
  readonly throughTurn: string | null;
  /** The session's effort now, as a turn carries it (C7). Null for a model with no levels. */
  readonly effort: string | null;
  /** The session's speed tier now, as a turn carries it (decision 0016). Null for standard speed. */
  readonly speed: string | null;
}

/** One session, good until `closed` resolves. Main then drops it, and the next prompt asks for a new one with `resume`. */
export interface ProviderSession {
  subscribe(listener: (event: AgentEvent) => void): () => void;
  /** Starts or resumes the provider's session if it has to, then sends the prompt. Every outcome is an event. */
  send(turn: TurnRequest): void;
  /** Stops the running turn, a turn still starting, or the workers left after one. */
  stop(): void;
  /**
   * Asks a question beside the session (M20b, C26), starting or resuming the provider's session if
   * it has to, with no turn of the session's. Every outcome is an event naming the aside. Present
   * exactly when the descriptor's `capabilities.asides` is not `none`.
   */
  ask?(aside: AsideRequest): void;
  /**
   * Stops an aside's turn and nothing else (M20b, C12, C70): never the session's turn, and never
   * the process its turns and its other asides run on. Present with `ask`.
   */
  stopAside?(asideId: string): void;
  /**
   * Answers a question the session asked as a request (M21, C30): `requestId` is what its
   * `question-raised` event carried, and `answers` one for each of its questions, by the question's
   * place, each chosen option by its place — the session encodes them by its provider's route, from
   * the request it holds as it came (C59). `null` refuses the request, as one the session cannot
   * show is refused, with its notice: main asks so for a request it cannot place (C11). Every
   * outcome is an event, as a send's is. Present exactly when the descriptor's
   * `capabilities.questions` is `blocking` or `both`.
   */
  answer?(requestId: string, answers: readonly GivenAnswer[] | null): void;
  /**
   * Declines a question the session asked as a request (M100b, C31): the user skipped it, and the
   * CLI is told so by its provider's route, the turn going on. Every outcome is an event, as an
   * answer's is: the CLI's word that it took the reply is `confirmed`, and a reply the process could
   * not take is `dropped`. Present exactly when the descriptor's `capabilities.declines` is true.
   */
  decline?(requestId: string): void;
  /**
   * Decides an action the session asked leave for (M22, C13, C21, C69): `requestId` is what its
   * `approval-raised` event carried, and `choice` one the request's view listed — the session
   * encodes the reply by its provider's route, from the request it holds as it came, a session
   * grant always as the CLI's own offer at the session's scope and never another. `null` refuses
   * the request with its notice, as main asks for one it cannot place. Every outcome is an event,
   * and the promise says one thing more, which no event does (C12, C92): it resolves true once the
   * reply's write to the process went, and false where the process did not take it — in which case
   * the session also says `dropped` and ends, as it does for an answer. It never rejects. Present
   * exactly when the descriptor declares a mode other than its reading one.
   */
  decide?(requestId: string, choice: ApprovalChoice | null): Promise<boolean>;
  /**
   * Changes the mode of the live process, with nothing running on it (M22, C2, C5, C90): only for a
   * change the facet's `transition` answers `idle`. Resolves once the CLI has confirmed it — or
   * refused it, or reported another — and never rejects; `detail` is the CLI's own word, bounded.
   * A change that is not confirmed leaves the process as it was, or ends it where what it reports
   * is no longer what was asked. Present exactly when some change of the provider's is `idle`.
   */
  setMode?(mode: string): Promise<ModeChange>;
  /**
   * Decides a plan the session raised as a request (M22b, C11): `requestId` is what its `plan-raised`
   * event carried. `null` refuses the request with its notice, as main asks for one it cannot place.
   * Resolves true once the reply's write went, and false where the process did not take it — the
   * session then says `dropped` and ends. It never rejects. Present exactly when the descriptor's
   * `capabilities.plans` is not null and its plans are raised as requests.
   */
  decidePlan?(requestId: string, answer: PlanAnswer | null): Promise<boolean>;
  /**
   * Whether a message can be sent into the turn running now (M23, C35, C43, C88). `open`: the
   * session's own turn, past its prompt's write, on this process, and — where the provider says so —
   * under the chat's own mode with no change of it waiting. `unsupported`: this process can never
   * take one, as its CLI said, so that Stop could not take a handed message back. `wait` otherwise:
   * no turn, workers alone, a Stop, a change of mode waiting, or the CLI not yet heard from. Each
   * change of it is said by a `steer-changed` event, unless another event of the change already
   * came. Present exactly when `steer` is.
   */
  steerState?(): SteerState;
  /**
   * Sends a message into the running turn (M23, C36): only while `steerState` says `open`, which main
   * checks in the step that records the message. Resolves with what became of it, and never rejects.
   */
  steer?(request: SteerRequest): Promise<SteerOutcome>;
  /**
   * What this process's CLI lists of its own commands and skills (M23, C60, C61): null until it has
   * said. Present for a provider whose list comes with its session's process.
   */
  commands?(): readonly ProviderCommand[] | null;
  /** Resolves once the session has ended, however it ended, with whether everything of it is confirmed gone (C116). */
  readonly closed: Promise<CleanupResult>;
  close(): Promise<CleanupResult>;
  /** After an end that was not confirmed: looks again, read-only, and answers whether it is confirmed now (C116). */
  recheck(): Promise<CleanupResult>;
}

/** What became of a change of mode on a live process (M22, C90). */
export type ModeChange = { readonly confirmed: true } | { readonly confirmed: false; readonly detail: string | null };

/**
 * The CLI's own sandbox setup, for a provider whose descriptor says `permissions.setup` (M22,
 * C60–C62, C72, C73): asked of one account, on a connection of its own, at the user's press alone.
 */
export interface SandboxFacet {
  /** Where the account's setup stands, and what a fresh process last answered. */
  state(): SandboxSetupView;
  /**
   * `start`: sends the CLI's one setup request, where none runs. `stop-waiting`: lets go of a setup
   * whose completion has not come, which is then of unknown outcome. Answers what it did.
   */
  act(action: SetupAction): 'started' | 'stopping' | 'running' | 'no-setup';
}

/** How much of each turn of history a read asks for (C102, C134): every item, the provider's own summary, or none. */
export type HistoryDetail = 'full' | 'summary' | 'none';

export interface HistoryRequest {
  /** Null for the newest page; else what the page before it answered. Opaque. */
  readonly cursor: string | null;
  /** In turns. */
  readonly size: number;
  readonly detail: HistoryDetail;
}

/**
 * `page`: the turns it covers and their messages, both oldest first, and the cursor to the next
 * older page, or null at the start of the conversation (M18, C47, C51). Each message names its
 * turn; a read with `detail: 'none'` has turns and no message. `activities`: what the session did
 * between those messages, where the provider's history gives it (M20a, C19) — each names its turn
 * and its place among that turn's items, as a message from such a history does. `dropped`: the
 * answer was too large to take, which the provider knows for a fact (C120). `failed`: anything
 * else, a timeout included.
 */
export type HistoryAnswer =
  | { readonly kind: 'page'; readonly turns: readonly HistoryTurn[]; readonly messages: readonly HistoryMessage[]; readonly activities?: readonly HistoryActivity[]; readonly plans?: readonly HistoryPlan[]; readonly images?: readonly HistoryReturnedImage[]; readonly next: string | null }
  | { readonly kind: 'dropped' }
  | { readonly kind: 'failed' };

/** Reading a session's earlier conversation back from its provider (M18, C6, C25). */
export interface HistoryFacet {
  /** Starts nothing: a read that cannot be made now answers `failed` (C57). */
  read(reference: string, page: HistoryRequest, signal: AbortSignal): Promise<HistoryAnswer>;
  /** History can be read again (C121): a read that failed may now succeed. */
  onAvailable(listener: () => void): () => void;
}

/**
 * One request of the secretary's (M26; decision 0028): a task's instruction and the text it works
 * on, answered by the instance's own CLI in a process of its own that offers no tool, thinks not
 * and keeps nothing of it. The text is conversation content: it reaches no log, and the adapter
 * keeps nothing of it or of the answer.
 */
export interface SecretaryRequest {
  readonly instructions: string;
  readonly text: string;
  /** The catalog's key, as a session's start names one. */
  readonly model: string;
  /** Null for a model with no levels. */
  readonly effort: string | null;
}

/**
 * `answered`: the reply's final text, whatever it says; the task reads it. `failed`: no answer —
 * `aborted` by the caller, `timeout` at the adapter's deadline, `unavailable` for anything else.
 */
export type SecretaryAnswer =
  | { readonly kind: 'answered'; readonly text: string }
  | { readonly kind: 'failed'; readonly reason: 'aborted' | 'timeout' | 'unavailable' };

export interface SessionFacet {
  /** Launches nothing yet: the session starts at its first prompt (C20). */
  start(options: SessionStart): ProviderSession;
  /** Launches nothing yet: the session is reopened at its next prompt (C24). */
  resume(options: SessionResume): ProviderSession;
  /**
   * Present exactly when the descriptor says `capabilities.history` (M18, C6). A provider without
   * it is asked nothing about an earlier conversation: its chats show what fat-g recorded.
   */
  readonly history?: HistoryFacet;
  /**
   * The provider's own commands that fat-g answers itself and never sends (M20b, C55; decision
   * 0023): given a prompt, the kind of notice that answers it, or null for a prompt that passes as
   * it was written. Left out by a provider whose prompts hold no command of its own.
   */
  readonly intercepts?: (prompt: string) => CommandNoticeKind | null;
  /**
   * Which of the descriptor's modes this account can use now, and why not (M22, C43, C51, C60,
   * C85): one for each declared mode, as far as the adapter knows — what a start reply reported, and
   * what its CLI answered of its sandbox. Asking it may begin a read whose answer comes later, as a
   * change. Present exactly when the descriptor's `capabilities.permissions` is not null.
   */
  readonly modes?: () => readonly ModeAvailability[];
  /** How a chat's mode changes from one id to another (M22, C2, C74): on the live process, or by a restart. Present with `modes`. */
  readonly transition?: (from: string, to: string) => ModeTransition;
  /** What `modes` or the setup's state would now answer has changed. Present with `modes`. */
  readonly onModesChanged?: (listener: () => void) => () => void;
  /** Present exactly when the descriptor says `permissions.setup` and this system has such a setup. */
  readonly sandbox?: SandboxFacet;
  /**
   * Whether this account's CLI takes a plan turn now (M22b, C13, C80): best effort, told by what its
   * CLI refused. A change is said by `onModesChanged`. Present exactly when the descriptor's
   * `capabilities.plans` is not null.
   */
  readonly plans?: () => PlanAvailability;
  /**
   * One request of the secretary's, answered in a process of its own started for it, in fat-g's
   * probe folder and never a project's (M26; decision 0028). Never throws: every end is an answer.
   * Left out by a provider that answers none: its sessions keep the names fat-g gives them.
   */
  readonly secretary?: (request: SecretaryRequest, signal: AbortSignal) => Promise<SecretaryAnswer>;
  /**
   * What the instance's CLI lists for a folder, with no session process (M23, C63): asked when the menu
   * opens and before a send that chose a skill. Null where it could not be asked or answered.
   */
  readonly commands?: (folder: string, signal: AbortSignal) => Promise<readonly ProviderCommand[] | null>;
  /**
   * The provider's own commands fat-g answers itself (M20b, C55; M23, C62), by name with their `/`,
   * first in the menu; the CLI's rows of the same names are left out.
   */
  readonly interceptedCommands?: readonly { readonly name: string; readonly kind: CommandNoticeKind }[];
  /** Its commands are listed once a session's process has run (M23, C61): before that the menu says so. */
  readonly commandsOnceStarted?: boolean;
}
