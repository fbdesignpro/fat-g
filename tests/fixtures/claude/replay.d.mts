// What tests read of the replay (./replay.mjs), which is plain JavaScript so that the fake runs on
// Node alone. The rest of it is the fake's own.

/** A chat session's launch — its mode's word and its tools by name (M22) — and its per-session arguments, after the fixed list. */
export interface ChatArgs {
  readonly model: string;
  readonly effort: string | null;
  readonly resume: string | null;
  readonly addDirs: readonly string[];
  /** The word `--permission-mode` named. */
  readonly mode: string;
  /** The names `--tools` listed, in its order. */
  readonly tools: readonly string[];
}

/** One of the launches a chat session is started under (M22): a permission mode's word and a tool list, as the arguments spell them. */
export interface ChatLaunch {
  readonly mode: string;
  readonly tools: string;
}

/** The two tool lists a launch may name (M22), each as `--tools` spells it: M21's five, and the five with `Bash`, `Write` and `Edit`. */
export const READING_TOOLS: string;
export const EXECUTION_TOOLS: string;
/** The five launches, in order: `default` with the reading tools, then `default`, `acceptEdits`, `auto` and `bypassPermissions` with the eight. */
export const CHAT_LAUNCHES: readonly ChatLaunch[];
/** What a chat session's launch always carries, in this order (decision 0020), under that mode and that tool list: the reading launch's with no argument. Frozen. */
export const chatFixedArgs: (mode?: string, tools?: string) => readonly string[];
/** The reading launch's fixed list: `chatFixedArgs()`. */
export const CHAT_FIXED_ARGS: readonly string[];
/** Null for anything that is not a chat session's launch, under one of the five. */
export const parseChatArgs: (args: readonly string[]) => ChatArgs | null;
/** The captures a prompt can choose, each by its own prompt. */
export const TURN_CAPTURES: readonly string[];
/** K2's captures (M19), which hold a reply's stream events, and K20's that K2 did not take again, which hold whole messages alone. */
export const STREAM_CAPTURES: readonly string[];
export const WHOLE_CAPTURES: readonly string[];
/** K1's two turns (M20b): the one that gives a session something to hold, and the long one a side question is asked during. */
export const ASIDE_TURN_CAPTURES: readonly string[];
/** K2's seven commands (M20b), each a turn the CLI answers by itself. */
export const COMMAND_CAPTURES: readonly string[];
/** K1's side questions (M20b), each chosen by its own question. */
export const SIDE_CAPTURES: readonly string[];
/** K1's questions (M21), each a turn chosen by its own prompt. */
export const QUESTION_CAPTURES: readonly string[];
/** M100b's K1: a question the user skipped, declined by a `deny` in their name, chosen by its own prompt. */
export const DECLINE_CAPTURES: readonly string[];
/** M23's K2 turns (C23, C42, C43): images, a frame written during a turn, and the held frame a Stop drops. */
export const M23_CAPTURES: readonly string[];
/** A prompt frame's text: its content where that is text, and the text blocks of one that holds images (M23, C21). */
export function promptText(content: unknown): string | null;
/** K1's Stop with a question pending (M21): the tail of an interrupt that comes while a question waits. It shares its prompt with the first of the questions, and is no turn. */
export const QUESTION_STOP: string;
/** K1's kill with a question pending (M21): what `exitWhileAsking` replays for the same shared prompt. No turn. */
export const QUESTION_KILLED: string;
/** K2's captures that are turns (M22). One with several prompts has each of its turns chosen by that turn's own prompt; the session file names a second turn `<capture>#2`. */
export const APPROVAL_CAPTURES: readonly string[];
/** K2's resumed session, asked again (M22): it shares the second prompt of `m22-approve-session`, and is replayed for it in a process that does not hold the session rule for its command. No turn of its own. */
export const APPROVAL_RESUMED: string;
/** K2's mode changes with no turn running (M22): what a `set_permission_mode` is answered with. No turn. */
export const MODES_SET: string;
/** K5's captures that are turns (M22): four steps under `auto`, the same under `bypassPermissions`, and a sub-agent's two under `acceptEdits`. Each is one turn, chosen by its own prompt, and shows no request. */
export const MODE_CAPTURES: readonly string[];
/** M22b's K1: a plan turn under each launch, by the launch's mode and tools (C48). */
export const PLAN_CAPTURES: Readonly<{ reading: string; default: string; acceptEdits: string; auto: string; bypassPermissions: string }>;
/**
 * K5's two resumes of the session its `bypassPermissions` turn began (M22), by the word each was
 * launched under. No turn: a process that resumes a session once launched under `bypassPermissions`,
 * with the eight tools and under one of these words, answers `initialize` with that capture's reply,
 * and under `default` a set to `bypassPermissions` with its error reply.
 */
export const BYPASS_RESUMED: { readonly default: string; readonly acceptEdits: string };
