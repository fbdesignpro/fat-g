// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The replay (docs/planning/_archive/M16.md, Design 8; C51, C53, C79, C80): how the fake Claude CLI runs a
// chat session. Every frame it sends is a received frame of a capture under ./captures, with three
// substitutions: ids (each alias becomes an id, one per alias; the prompt's own and a request's are
// the ones fat-g sent), times, and the folder (`<scratch>` becomes the folder it was started in). A
// fault is a captured frame with one named change. tests/fakes/claude-replay.test.ts holds it to that.
// M22 adds a fourth substitution, the launch: the permission mode and the tools a process reports
// are its own launch's, as said below.
//
// Only a capture whose prompt carries an id is replayed as a turn (C79): the CLI's
// `command_lifecycle` frames name that id, and they are what bounds a turn. A prompt equal to such
// a capture's own replays it, and any other replays T1.
//
// A chat session is started with `--include-partial-messages` (docs/planning/_archive/M19.md, Design 9; C55),
// so the turns replayed are M19's K2 captures, which hold a reply's `stream_event` frames beside
// its `assistant` frames: the five whose prompts are M16's own (T1, T3, T4, T5, the refused
// command) in place of K20's, and three of their own — the Markdown answer, and the two prompts of
// a first answer cut by force. K20's captures that K2 did not take again hold whole messages
// alone, and are replayed as they are: they are the whole-message cases.
//
// M19b's K2 captures join them (docs/planning/_archive/M19b.md, Design 10; C46), each by its own prompt: three
// answers that name a file, in a code span each time — `src/tides.js:12`, `README.md`, and
// `harbour-log.md` for a file that lies in a subfolder. Claude's answers hold no folder.
//
// M20b's K1 and K2 captures join them (docs/planning/_archive/M20b.md, Design 9; C61). A chat session is
// started without `--disable-slash-commands` from here on (decision 0023): a launch that carries it
// is not the app's, and exits as any other argument line does. K2's seven commands are turns, each
// chosen by its own prompt, the CLI's own line its answer. K1's side questions are no turns: a
// `side_question` request is answered whenever it comes — while a turn is replayed, or while none
// is, any number at once — with the progress frame and the reply its capture shows, chosen by the
// question's text, and K1's idle one for any other. The capture of a question that was cancelled
// shows no answer: the fake sends its progress frame and waits for the cancel, which it answers
// with that capture's error reply, as it answers the cancel of any question that still waits.
//
// M21's K1 captures join them (docs/planning/_archive/M21.md, Design 8; C50, C51). A chat session is started
// with five tools from here on, the fifth the one that asks the user. Five of the seven are turns,
// each by its own prompt: the question answered from an option, the one that takes several, the two
// in one request, the worker told to ask, and the prompt that resumed a session whose process was
// killed. The other two share the first one's prompt and are no turn. The capture of the Stop is
// the tail of an interrupt that comes while a question waits: its cancel frame, its error result,
// its `result` and its closing frame, the request and the tool use they name being this turn's
// own. The capture of the kill is a fault: under `exitWhileAsking` it is what the shared prompt
// replays, and the process ends where its frames do, with the request pending. At a question's
// request the fake waits for fat-g's reply, as it waits at any request's, and then plays the
// capture's frames after it; the reply's `updatedInput` is noted in the session file.
//
// M22's K2 captures join them (docs/planning/_archive/M22.md, Design 6 and 11; C5, C7, C21, C35). A chat
// session is started under one of five launches from here on, and under no other: a permission
// mode's word and a tool list, at the two places where the fixed list held `default` and M21's five
// tools. They are the reading launch, which is M21's own, and `default`, `acceptEdits`, `auto` and
// `bypassPermissions`, each with the tools that act: the five, `Bash`, `Write`, `Edit`, `WebFetch`,
// `WebSearch` and the plan's tool. What a process
// reports is its launch's, the fourth substitution: `initialize` answers `current_permission_mode`
// with the launch's word, and every `init` names the mode in force and the launch's tools as the
// CLI reports them — the capture's built-in names replaced by `Task`, `AskUserQuestion`, `Glob`,
// `Grep`, `Read`, or by those with `Bash`, `Edit`, `ExitPlanMode`, `WebFetch`, `WebSearch` and
// `Write` among them in the captures' own order, and the capture's `mcp__` names kept after them.
//
// `set_permission_mode` is answered whenever it comes, as `m22-modes-set` shows: the reply `{ mode }`
// and the `system/status` frame that names `permissionMode`, the two in one write, and the mode in
// force is that word for the rest of the process. A set to the mode in force gets the reply and no
// frame. `bypassPermissions` in a process not launched with it gets the capture's error reply and
// changes nothing. A word no capture shows set — one other than `default`, `acceptEdits`, `auto`,
// `dontAsk`, `plan` and `bypassPermissions` — is not answered: it is marked as a request a chat
// session never sends.
//
// Six of the captures are turns. One with several prompts has each of its turns chosen by that
// turn's own prompt, in any process, a turn being the frames from its prompt to the closing frame
// that names it; the session file names a capture's second turn `<capture>#2`. A seventh,
// `m22-approve-resumed`, was taken with the second prompt of `m22-approve-session`: that prompt
// replays `-session`'s second turn, which shows no request, in a process that holds the session
// rule for its command, and `-resumed`'s turn, which shows the request again, in one that does not.
//
// K5's captures join them too (docs/planning/_archive/M22.md, round 3; C74, C94, C96, C97). Three are turns,
// each one turn chosen by its own prompt: the four steps under `auto` and the same four under
// `bypassPermissions`, each with a file written outside every root, and a sub-agent's file and
// command under `acceptEdits`. None of them shows a request, so the fake sends none and waits for
// nothing; replayed under the launch it was taken under, each frame is its capture's. As for every
// turn that runs with no request, the fake changes no file for them. The other two hold no prompt
// and are no turn: they are the two resumes of the session the `bypassPermissions` turn began — one
// under `default`, which names `default` and refuses a set to `bypassPermissions`, and one under
// `acceptEdits`, which names that. A process that resumes a session one of whose earlier processes
// was launched under `bypassPermissions`, itself launched under one of those two words with the
// tools that act, answers `initialize` with the reply of the capture taken under its word, and — under
// `default` — a set to `bypassPermissions` with that capture's own error reply. Every other
// process answers both as it did.
//
// At a request for a tool other than the question tool the fake waits for fat-g's reply — under
// every launch and whatever mode is in force: the mode changes what a process reports, and nothing
// of what a turn asks — and then goes by the reply, whatever the capture's own answer was:
//   allow    the frames an allowed request is followed by: the capture's own where its answer was
//            an allow, and otherwise the tool's result and the turn's end from another capture —
//            `m22-approve-once`'s first turn, with `m22-approve-files`' result for a `Write`, which
//            then names the file and the content this request did — under this turn's ids. And the
//            change is made, from the input the reply sent back, or the request's where it sent
//            none: a `Write` writes `content` to `file_path`, an `Edit` replaces `old_string` by
//            `new_string`, the first of them or all under `replace_all`, and a `Bash` command of the
//            form `touch <name>` makes that file where there is none. Only inside the folder the
//            fake was started in: a path outside it writes nothing. No other tool use writes
//            anything: one a capture shows running with no request changes no file.
//   allow, with `updatedPermissions` of exactly one `{ type: 'addRules', rules, behavior: 'allow',
//            destination: 'session' }`: its rules are this process's from then on, and a request
//            whose own `addRules` suggestion names rules this process holds is not sent — the turn
//            goes on as an allowed one does, and the change is made. A new process holds none.
//            Anything else under that key — another destination, a second entry, another type, a
//            rule that is not `{ toolName, ruleContent }` — records nothing and writes the marker
//            `unexpected-permission-update`; the request is allowed all the same.
//   deny     (or any reply that is no allow) the frames a denied request is followed by: the
//            capture's own where its answer was a deny, and otherwise those of `m22-approve-once`'s
//            second turn under this turn's ids — the error result, the model's line, the `result`,
//            the closing frame — which end the turn there; the denial that `result` counts is that
//            capture's own but for the tool use it names. A worker's request is the exception: its
//            turn goes on as captured, with that error result, naming the worker, in place of the
//            tool's own. The result's text is the reply's `message` where it has one, as the CLI
//            echoes it.
//   Stop     an interrupt while the request waits is answered with the tail `m22-mode-accept-edits`
//            shows: the cancel frame naming the request, the interrupt's reply, the error result,
//            the `result` and the closing frame, under this turn's ids.
// Whatever a reply decides, the ends of the reply the model was writing when the request went out —
// its `content_block_stop`, `message_delta` and `message_stop` — come as this turn's capture has
// them: no frame another capture lends repeats them.
//
// FATG_SMOKE_CLAUDE_SESSIONS    a JSON file of the sessions the fakes started, so another process,
//                               in the same run or the next, resumes what the first began (C53). A
//                               session's entry also notes what was asked of it, for a test to
//                               read: its launches — each with its `mode` and its `tools` — its
//                               turns, its interrupts, its efforts, the answers fat-g gave its
//                               requests — an `allow`'s with the input it sent back, and with its
//                               `updatedPermissions` where it carried one — the side questions it
//                               was sent and their cancels; and from M22 its `modes`, one entry a
//                               `set_permission_mode` received, `{ mode, turn, answered }`, `turn`
//                               whether one was running and `answered` `success`, `error` or
//                               `none`; its `grants`, the session rules recorded, by whichever of
//                               its processes; its `writes`, the paths the fake made or changed,
//                               in order; and from decision 0033 its `contexts`, the `detail` of
//                               each `get_context_usage` received. Without it, they are kept in memory.
// FATG_SMOKE_CLAUDE_GAP_MS      the longest gap between two frames, 50 ms unless given (C79).
// FATG_SMOKE_CLAUDE_DESCENDANT  1: a chat session's process starts one child that records itself and
//                               ends when its input closes. `ignore`: the child is detached and
//                               ignores its closed input. `hold`: the child keeps the fake's output
//                               open after the fake has ended.
//
// Controls come through the fake's control file. A number is a count of times, taken one at a time;
// a word, or a number of milliseconds, stays until the file is rewritten.
//   exitDuringLaunch, exitDuringTurn, exitWithWorker, exitAfterTurnWithWorker   the process ends there
//   launchFails                        the process exits with code 1 and nothing on stdout
//   resumeMissing                      the captured frame of a session Claude no longer has, and exit 1
//   otherMode: reply | init            that report names another permission mode than its own — the
//                                      launch's for the reply, the one in force for an `init`:
//                                      `acceptEdits`, or `default` where its own is `acceptEdits`
//   otherTool                          the `init`'s tool list gains a tool outside the launch's:
//                                      `Write`, or `NotebookEdit` where the launch has `Write`
//   hang: initialize | effort | started | stop | side | cancel | mode    that step never answers:
//                                      `side`, a side question gets its progress frame and no reply;
//                                      `cancel`, a cancel is not answered, and the question's own
//                                      reply still comes — a reply after a Stop; `mode`, a
//                                      `set_permission_mode` is noted and changes nothing
//   sideRefused                        a side question is answered with the error reply at once (M20b, C62)
//   sideReply: null | synthetic | fallback    its reply holds no answer, is marked a placeholder,
//                                      or names another model as the one that answered
//   holdSide: ms                       its reply is held back that long
//   strayProgress                      a progress frame for a request nobody made follows its own
//   turnNeverEnds                      `result` and the closing frame are withheld
//   holdResult: ms                     `result` is held back that long, as a Stop hook holds it
//   workerNoClose, workerFailed        a worker's closing frames withheld, or naming a failed status
//   oversize: toolResult | result      that frame padded past a session's line limit, 4 MiB (M20a, C16): a tool's
//                                      result with quotes, which JSON's escaping doubles on the line
//   longText                           a text padded past its bound, its frame under the line limit;
//                                      `toolResult`: the turn's first tool result padded past its own
// And for what a session does between its messages (M20a, C52), each on the turn's first tool use of
// the session's own:
//   quotedResult                       its result is a megabyte of quotes: a line of over two, which a session takes
//   toolUnknown                        its tool's name is one the adapter does not know
//   noToolResult                       its result is withheld: the turn ends with the item open
//   toolError                          its result carries the error flag
// And for a reply as it is written (M19, C56), each on the turn's last text of the session's own,
// its answer:
//   wholeDiffers                       its `assistant` frame's text is another than its deltas brought
//   noCompletion                       its `assistant` frame is withheld: the turn ends with the message open
//   exitBetweenDeltas                  the process ends after its second text delta
//   deltaOfWorker                      every text delta of it names a worker's tool use: none is the session's
//   deltaAfterComplete                 its last text delta is sent again after its `assistant` frame
//   deltasPastBound                    every text delta of it is padded to 20 000 units: they pass the bound
//   noDeltas                           its reply's stream events are withheld: it arrives whole
//   answerText: "…"                    its text is the one given: its first text delta brings all of it, the
//                                      others are withheld, and its `assistant` frame holds the same
// Claude's stream events name no turn and no session of another: the Codex fake's deltas of another
// thread and of another turn have no frame here to be made of, and `deltaOfWorker` stands for them.
// And for a question (M21, C51), each on the turn's request for the question tool, or on its result:
//   questionTwice                      the request is delivered again, under the same id
//   questionWorker                     the request names a worker, by an id no worker has
//   questionLate                       the request is sent after the turn's `result`, and nothing waits for its reply
//   questionCancel                     the cancel frame K1's Stop shows, naming the request, in place of
//                                      the wait for a reply: the CLI took it back, and the turn goes on
//   questionResultError                the question's tool result carries the error flag
//   questionsTwenty                    the request holds 20 questions: its first, numbered
//   optionsNine                        its first question holds nine options: its own, and numbered ones
//   exitWhileAsking                    a count: K1's kill is replayed for the prompt it shares with the
//                                      answered question, and the process ends with the request pending
//   exitAtAnswer                       a count: the process ends as the answer is written. Its request's
//                                      input carries 900 000 units of padding, which an answer sends back
//                                      with it, so the answer's line is more than a pipe takes at once; and
//                                      the process ends at the first bytes written to it once it has asked,
//                                      with the rest of that line still to come
//   workerAsks: during | after | unconfirmed   an open worker asks, which K1 did not see (C21): the
//                                      answered question's tool use, request and result, each naming the
//                                      worker — the first and the last by the `Agent` tool use that
//                                      started it, the request by its task id — before the turn's
//                                      `result`, or after it; the result follows fat-g's reply,
//                                      whenever that comes. Under `unconfirmed`, which asks after the
//                                      `result`, it never does: K17's progress frame for that worker
//                                      follows the reply in its place, as a worker that goes on sends one
// The M20a controls above fall on a question too where it is the turn's first tool use, as it is in
// K1's captures: `noToolResult` withholds the question's result, so nothing confirms the answer.
// And for a request for a tool other than the question tool (M22, C35), each on every such request
// of the turn that is sent, unless said otherwise:
//   approvalTwice                      the request is delivered again, identical, under the same id
//   approvalChanged                    the request is delivered again under the same id with another
//                                      `input`: another `command`, `content` or `new_string`, or
//                                      one key more for a tool that has none of them
//   approvalWorker                     the request names a worker, by an id no worker has
//   approvalLate                       the request is sent after the turn's `result`, and nothing waits
//                                      for its reply: the turn goes on as its capture does, and no
//                                      change is made
//   approvalCancel                     the cancel frame `m22-mode-accept-edits` shows, naming the
//                                      request, in place of the wait for a reply: the turn goes on as
//                                      its capture does, and no change is made
//                                      (`approvalLate` and `approvalCancel` act where the capture
//                                      shows the request answered: not on the turn whose capture
//                                      shows a Stop in an answer's place)
//   exitWhileApproving                 a count: the process ends once the request is out, with it pending
//   exitAtDecision                     a count: as `exitAtAnswer` — the request's input carries 900 000
//                                      units of padding, and the process ends at the first bytes
//                                      written to it once it has asked
//   targetsForty                       the request becomes a `MultiEdit` of one file with forty `edits`:
//                                      the file the request names, or `approval-fault.txt` in the
//                                      project where it names none, as for the next three
//   writeOverBound                     the request becomes a `Write` whose `content` is 1 048 577 units;
//                                      a `Write`'s own keeps its file
//   requestOverLine                    the request becomes a `Write` whose content makes its line longer
//                                      than a session's limit, 4 MiB, the line's keys in the CLI's own
//                                      order: `{"type":…,"request_id":…,"request":{…}}`
//   requestOverLineNoId                the same line with `request_id` written after `request`: the id
//                                      is past the line's first 512 bytes
//   grantSuggestsOther                 the request's `addRules` suggestion names `userSettings` as its
//                                      destination
//   deniedByRule                       in place of the request, K2's `system/permission_denied` frame
//                                      (`m22-inherited`) naming this turn's tool use and its tool, then
//                                      the error result that capture shows after it; no request is
//                                      sent, no other result names that tool use, and the turn goes on
//                                      as a denied one does
// And for the mode a process reports (M22, C35):
//   initOtherMode                      a count: the next `init` names another permission mode than the
//                                      one in force, as `otherMode: init` does for every one
//   modeReplyOther                     a set's reply names `plan` in place of the mode asked for; its
//                                      status frame names the mode asked for, as captured
//   statusApart                        a set's reply and its status frame in two writes, the frame
//                                      250 ms after the reply, or the number of milliseconds given
//   statusFirst                        the status frame before the reply, in one write
//   statusOther                        the status frame names `plan`; the reply is as captured
//   modeRefused                        a count: a set is answered with the capture's error reply,
//                                      whatever the mode, and changes nothing
// Under the four that change a frame the mode in force still becomes the word asked for: the fault is
// in what is reported. None of them acts on a set to the mode in force but `modeReplyOther` and
// `modeRefused`, since that set has no status frame.
// And for how full the context is (decision 0033): a `get_context_usage` of the summary detail is
// answered with M10's discovery reply (`discovery-idle`), under fat-g's id; one of any other detail
// writes the marker `unexpected-chat-request`, and is answered all the same.
//   hang: context                      it is noted and never answered
//   contextRefused                     it is answered with the error reply a CLI that has no such request gives
//   contextPrivate                     its reply holds the private sentinel in every path and name the
//                                      adapter must never read: the memory files' paths, the MCP tools'
//                                      and their servers' names, the agents', the skills' and the
//                                      messages' tools' and attachments' names
// And for a plan's request (M22b, C48), in a plan turn — one a process in plan mode replays, by its
// launch, from `PLAN_CAPTURES`; each decision goes on as the turn's own capture shows it, or as the
// capture that took that decision does:
//   planWithheld                       the CLI never asks: the request and its wait are passed over,
//                                      and the turn goes on as captured
//   planEmpty                          the request's `input` is empty: no plan, as under Read only
//   planMiB                            the plan is padded to 1 048 576 units
//   planOverLine                       the plan is padded past a session's limit, 4 MiB, the line's keys
//                                      in the CLI's own order
//   exitWhilePlanning                  a count: the process ends once the request is out, with it pending
//
// A review (docs/planning/_archive/M22e.md, Design 9; C42, C46, C48). K2's capture, `m22e-claude-rounds`, is one
// session's four turns: the review, Send notes that settled a point, Send notes that only asked, and
// the review sent again unchanged. Its prompts were sent with no id, so no `command_lifecycle` frame
// of the CLI's bounds them: each turn — its prompt to its `result` — is replayed between T1's own
// lifecycle frames, lent under this turn's prompt, `queued` and `started` after it and `completed`
// after its `result`, as T1 shows them. A review prompt of fat-g's — its instruction's first sentence,
// and `"const": 2` in its schema — plays the review; each Send notes in a session plays the next of
// the other three, the last again from then on. An integration's plan turn plays M22b's plan turn of
// the launch, as any plan-mode prompt no capture holds does. The faults change one thing of a turn,
// each a count taken one at a time:
//   review-v1                          a review prompt plays K1's review (`m22e-claude-review`), whose block names version 1
//   review-no-block, review-invalid, review-set-aside, review-two-blocks, review-long, review-unclosed
//                                      the review's answer, one named change (tests/fixtures/review-faults.mjs)
//   review-prose-only, review-drop, review-renumber, review-ambiguous
//                                      a Send notes answer, one named change
//   review-plain-block                 a plain prompt in a session that was reviewed plays the asking note's turn: prose
//                                      above a block that checks, for a prompt that is no review's
//   review-lost                        the process ends after the review's first text delta
// Claude's questions block their turn (0026): a reviewer that asks first needs no fault of its own here.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { faulted, FIRST_ANSWER_FAULTS, isReviewPrompt, isSendNotes, LATER_ANSWER_FAULTS, unmarked } from '../review-faults.mjs';

const CAPTURES = path.join(import.meta.dirname, 'captures');
const MIB = 1024 * 1024;
/** A session's line limit (M20a, C16): what an oversize fault pads a frame past. */
const LINE = 4 * MIB;
/** A tool result's bound (M20a, C5): what `longText: toolResult` pads one past. */
const OUTPUT_BOUND = 20_000;

/** The two tool lists a launch may name (M22, C45): M21's five, and the five with the three that act, the two of the web and the plan's tool (M22b, C8). */
export const READING_TOOLS = 'Read,Glob,Grep,Agent,AskUserQuestion';
export const EXECUTION_TOOLS = `${READING_TOOLS},Bash,Write,Edit,WebFetch,WebSearch,ExitPlanMode`;
/**
 * The five launches a chat session is started under (M22, C5, C47), each a permission mode's word
 * and a tool list: the reading launch first, then the four with the eleven tools.
 */
export const CHAT_LAUNCHES = Object.freeze([
  { mode: 'default', tools: READING_TOOLS },
  { mode: 'default', tools: EXECUTION_TOOLS },
  { mode: 'acceptEdits', tools: EXECUTION_TOOLS },
  { mode: 'auto', tools: EXECUTION_TOOLS },
  { mode: 'bypassPermissions', tools: EXECUTION_TOOLS },
].map((launch) => Object.freeze(launch)));
/**
 * A launch's tools as an `init` reports them, in the captures' own order (K1 of M21, K2 of M22, K1 of
 * M22b); the two of the web where Claude Code 2.1.302 listed them, by name between `Read` and `Write`.
 */
const REPORTED_TOOLS = {
  [READING_TOOLS]: ['Task', 'AskUserQuestion', 'Glob', 'Grep', 'Read'],
  [EXECUTION_TOOLS]: ['Task', 'AskUserQuestion', 'Bash', 'Edit', 'ExitPlanMode', 'Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch', 'Write'],
};

/**
 * What a chat session's launch always carries, in this order (decision 0020), under one mode and one
 * tool list. The per-session arguments follow: `--model`, then an optional `--effort`, an optional
 * `--resume` and any number of `--add-dir`. The fake starts a chat session for exactly that, under
 * one of the five launches, and nothing else.
 */
export function chatFixedArgs(mode = 'default', tools = READING_TOOLS) {
  return Object.freeze([
    '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
    '--setting-sources', 'user,project,local',
    '--permission-mode', mode, '--permission-prompt-tool', 'stdio',
    '--tools', tools,
    '--include-partial-messages',
  ]);
}
/** The reading launch's list: M21's own. */
export const CHAT_FIXED_ARGS = chatFixedArgs();
const MODE_AT = CHAT_FIXED_ARGS.indexOf('--permission-mode') + 1;
const TOOLS_AT = CHAT_FIXED_ARGS.indexOf('--tools') + 1;

/**
 * A chat session's launch — its mode's word, its tools by name — and its per-session arguments, or
 * null for anything that is not a chat session's launch.
 */
export function parseChatArgs(args) {
  const launch = CHAT_LAUNCHES.find((candidate) => candidate.mode === args[MODE_AT] && candidate.tools === args[TOOLS_AT]);
  if (launch === undefined) return null;
  const fixed = chatFixedArgs(launch.mode, launch.tools);
  if (args.length < fixed.length || !fixed.every((arg, index) => args[index] === arg)) return null;
  const rest = args.slice(fixed.length);
  let at = 0;
  const take = (flag) => {
    if (rest[at] !== flag || typeof rest[at + 1] !== 'string') return undefined;
    at += 2;
    return rest[at - 1];
  };
  const model = take('--model');
  if (model === undefined) return null;
  const effort = take('--effort') ?? null;
  const resume = take('--resume') ?? null;
  const addDirs = [];
  for (let dir = take('--add-dir'); dir !== undefined; dir = take('--add-dir')) addDirs.push(dir);
  return at === rest.length ? { model, effort, resume, addDirs, mode: launch.mode, tools: launch.tools.split(',') } : null;
}

/**
 * The captures a prompt can choose (C79; M19, C55), each by its own prompt: every one of them carries
 * an id on it. K2's first, taken under the launch a chat session now has; then K20's that K2 did
 * not take again, which hold whole messages alone.
 */
export const STREAM_CAPTURES = ['m19-t1-basic', 'm19-t3-subagent', 'm19-t4-interrupt', 'm19-t5-error', 'm19-command-refused', 'm19-markdown', 'm19-cut-cut', 'm19-cut-resumed', 'm19b-line', 'm19b-readme', 'm19b-space'];
export const WHOLE_CAPTURES = ['m16-chat-early-interrupt', 'm16-self-turn', 'm16-chat-request'];
/** K1's turns (M20b, C61): the one that gives a session something to hold, and the long one a side question is asked during. */
export const ASIDE_TURN_CAPTURES = ['m20b-seed', 'm20b-during'];
/** K2's commands (M20b, C61), each a turn the CLI answers as its capture shows: six it refuses by itself, and `/compact`. */
export const COMMAND_CAPTURES = ['m20b-cmd-exit', 'm20b-cmd-quit', 'm20b-cmd-resume', 'm20b-cmd-login', 'm20b-cmd-logout', 'm20b-cmd-btw', 'm20b-cmd-compact'];
/** K1's questions (M21, C50), each a turn chosen by its own prompt: one answered from an option, one that takes several, two in one request, the worker told to ask, and the prompt that resumed a killed session. */
export const QUESTION_CAPTURES = ['m21-question-one', 'm21-question-multi', 'm21-question-two', 'm21-question-worker', 'm21-question-killed-resumed'];
/**
 * K2's captures that are turns (M22, C35): a command allowed once and then denied, one allowed for
 * the session and then run unasked, four file changes, a worker's command, a turn under Accept edits
 * and the Stop of a pending request, and what the configuration's own rules do with no request. One
 * with several prompts has each of its turns chosen by that turn's own prompt.
 */
export const APPROVAL_CAPTURES = ['m22-approve-once', 'm22-approve-session', 'm22-approve-files', 'm22-approve-worker', 'm22-mode-accept-edits', 'm22-inherited'];
/**
 * K5's captures that are turns (M22, C94, C96, C97), each one turn chosen by its own prompt: four
 * steps under `auto`, the same four under `bypassPermissions`, and a sub-agent's two under
 * `acceptEdits`. None shows a request: what its mode lets run, runs.
 */
export const MODE_CAPTURES = ['m22-mode-auto', 'm22-mode-bypass-main', 'm22-mode-worker'];
/** M100b's K1 (C31): a question the user skipped, declined by a `deny` in their name, the turn going on to its end. */
export const DECLINE_CAPTURES = ['m100b-question-decline'];
/**
 * M23's K2 captures (docs/planning/_archive/M23.md, Design 11; C23, C42, C43, C72), each a turn by its own
 * prompt's text: an image with its text (the one at the 5 MiB bound shares its prompt, and is no turn), a frame written during a turn of text
 * alone — run as the CLI's next turn — and one written during tool calls, folded into the turn. Each of
 * the last three awaits fat-g's second frame where the capture shows it written, and names it by fat-g's
 * id from then on; `m23-claude-stop-held` awaits the Stop after it too, whose interrupt asks
 * `cancel_queued` and is answered with the held frame dropped.
 */
export const M23_CAPTURES = ['m23-claude-image', 'm23-claude-steer-text', 'm23-claude-steer-tool', 'm23-claude-stop-held'];

/** A prompt frame's text (M23, C21): its content where that is text, and the text blocks of one that holds images. */
export function promptText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts = content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text);
  return texts.join('\n');
}
/**
 * M22b's K1 (C48): a plan turn under each launch, chosen by the launch's mode and tools while the
 * process is in plan mode — the five share one prompt. Each is one turn, from its prompt to its end.
 */
export const PLAN_CAPTURES = Object.freeze({ reading: 'm22b-plan-read-only', default: 'm22b-plan-ask-first', acceptEdits: 'm22b-plan-edits-ok', auto: 'm22b-plan-auto-reviewed', bypassPermissions: 'm22b-plan-berserk' });
const PLAN_CAPTURE_NAMES = Object.values(PLAN_CAPTURES);
/**
 * Where a decision's frames come from where the turn's own capture shows another (C48), each a
 * capture and which of its plan requests: K1's feedback under `auto`, its Cancel under the reading
 * launch, and its Execute under each mode that executed — under `default` for a mode that did not.
 */
const PLAN_FEEDBACK = ['m22b-plan-auto-reviewed', 0];
const PLAN_CANCEL = ['m22b-plan-read-only', 1];
const PLAN_EXECUTE = { default: ['m22b-plan-ask-first', 0], acceptEdits: ['m22b-plan-edits-ok', 0], auto: ['m22b-plan-auto-reviewed', 1] };
/** K1's Stop with a plan pending (C6): the tail of an interrupt that comes while a plan waits. */
const PLAN_STOP = 'm22b-plan-berserk';
const PLAN_TOOL = 'ExitPlanMode';
export const TURN_CAPTURES = [...STREAM_CAPTURES, ...WHOLE_CAPTURES, ...ASIDE_TURN_CAPTURES, ...COMMAND_CAPTURES, ...QUESTION_CAPTURES, ...APPROVAL_CAPTURES, ...MODE_CAPTURES, ...DECLINE_CAPTURES, ...M23_CAPTURES];
/**
 * K5's two resumes of the session its `bypassPermissions` turn began (M22, C74), by the word each
 * was launched under: what such a resume answers `initialize` with, and — under `default` — a set
 * to `bypassPermissions`. Neither holds a prompt: no turn.
 */
export const BYPASS_RESUMED = Object.freeze({ default: 'm22-mode-bypass-resumed-default', acceptEdits: 'm22-mode-bypass-resumed-acceptEdits' });
/** The word a session's first launch carries where it can bypass permissions: what K5's resumes followed. */
const BYPASS = 'bypassPermissions';
/**
 * K2's resumed session, asked again (M22, C21): taken with the second prompt of the capture below,
 * and replayed for it in a process that does not hold the session rule for its command. No turn of
 * its own.
 */
export const APPROVAL_RESUMED = 'm22-approve-resumed';
const APPROVAL_SESSION = 'm22-approve-session';
/** K2's mode changes with no turn running (M22, C5): a set's reply, its status frame, and the error reply `bypassPermissions` gets. No turn. */
export const MODES_SET = 'm22-modes-set';
/** The captures the branches of a request are made of: an allowed command and a denied one, an allowed `Write`, the Stop of a pending request, and a request a rule denied. */
const APPROVAL_ONCE = 'm22-approve-once';
const APPROVAL_FILES = 'm22-approve-files';
const APPROVAL_STOP = 'm22-mode-accept-edits';
const DENIED_BY_RULE = 'm22-inherited';
/** M22e's K2 (C42): a review and its three later rounds in one session; and K1's review, whose block names version 1, the fault `review-v1`. */
export const REVIEW_CAPTURES = Object.freeze({ rounds: 'm22e-claude-rounds', v1: 'm22e-claude-review' });
/** The capture whose lifecycle frames a review's turn is replayed between: T1's. */
const LIFECYCLE_DONOR = 'm19-t1-basic';
/** The alias a review's prompt is given, which the lent lifecycle frames name: the captures sent it with none. */
const LENT_PROMPT = '<uuid-990001>';
/** The words the captures show set by `set_permission_mode`: any other is a request a chat session never sends. */
const SET_WORDS = new Set(['default', 'acceptEdits', 'auto', 'dontAsk', 'plan', 'bypassPermissions']);
/** How many edits `targetsForty` puts in a request, and how many units of content `writeOverBound`: one past a change's bound (M22, C48). */
const FORTY = 40;
const CONTENT_BOUND = 1_048_576;
/** How long after a set's reply `statusApart` sends its status frame, unless the control gives a number. */
const APART_MS = 250;
/** The question answered from an option: the turn for the prompt K1's Stop and K1's kill share with it, and the frames a worker's question is made of. */
const QUESTION_TURN = 'm21-question-one';
/** K1's Stop with a question pending: the tail of an interrupt that comes while a question waits. No turn. */
export const QUESTION_STOP = 'm21-question-stop';
/** K1's kill with a question pending: what `exitWhileAsking` replays, to the end of its process. No turn. */
export const QUESTION_KILLED = 'm21-question-killed-first';
/** K17, whose worker outlives its turn: its first progress frame is what a worker that goes on unconfirmed sends. */
const WORKER_PROGRESS = 'm16-self-turn';
/** K1's side questions (M20b, C61), each chosen by its own question: idle, during a turn, two at once, a follow-up, and one that was cancelled. */
export const SIDE_CAPTURES = ['m20b-idle', 'm20b-during', 'm20b-two', 'm20b-followup', 'm20b-cancel'];
const DEFAULT_SIDE = 'm20b-idle';
/** The capture whose side question was cancelled: its error reply is what a cancel is answered with. */
const CANCELLED_SIDE = 'm20b-cancel';
const DEFAULT_TURN = 'm19-t1-basic';
/** A capture whose process was ended by force during its turn (K2): the replay's process ends where its frames do. */
const ENDS_WITH_PROCESS = new Set(['m19-cut-cut', QUESTION_KILLED]);
/** How many questions `questionsTwenty` puts in a request, and how many options `optionsNine` in its first question: past what a card draws (M21, C60). */
const TWENTY = 20;
const NINE = 9;
/**
 * What `exitAtAnswer` pads a request's input with: more than any system's pipe holds, so a reply
 * that sends the input back is not written whole before the process ends, and under the megabyte
 * the process layer lets one write queue.
 */
const ANSWER_PADDING = 900_000;
/** What `deltasPastBound` pads each of the answer's text deltas to: six of them pass a message's bound. */
const PADDED_DELTA = 20_000;
/** A new session's `initialize` reply, a resumed one's (K2), and the reply to an effort change (K4). */
const LAUNCH = 'm16-t1-basic';
const RESUME = 'm16-resume';
const EFFORT = 'm16-effort-change';
/** The reply to a context request (M10's discovery, decision 0033), and the sentinel a private one carries. */
const CONTEXT = 'discovery-idle';
const SENTINEL = JSON.parse(readFileSync(path.join(import.meta.dirname, 'fake-cli-constants.json'), 'utf8')).sentinel;
/** The frame of a session Claude no longer has (K3). */
const MISSING = 'm16-resume-failures-missing';
/** An interrupt during a turn (T4), one before its `init` (K22), and a worker's two closing frames at one (K11). */
const INTERRUPT = 'm16-t4-interrupt';
const EARLY_INTERRUPT = 'm16-chat-early-interrupt';
const WORKER_INTERRUPT = 'm16-worker-interrupt';

const ALIAS = /<[a-z][a-z-]*-\d+>/g;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Times as numbers, in milliseconds since the epoch. */
const TIME_KEYS = new Set(['end_time', 'start_time', 'request_sent_wall_ms']);
const CLOSING_STATUSES = new Set(['completed', 'failed', 'killed', 'stopped']);

const loaded = new Map();
function capture(name) {
  if (!loaded.has(name)) {
    // A review capture's reads, its file markers made neutral (review-faults.mjs).
    const text = readFileSync(path.join(CAPTURES, `${name}.json`), 'utf8');
    const data = JSON.parse(Object.values(REVIEW_CAPTURES).includes(name) ? unmarked(text) : text);
    const frames = data.frames;
    const first = frames.find((entry) => entry.dir === 'send' && entry.frame.type === 'user') ?? null;
    loaded.set(name, {
      name, frames, date: Date.parse(data.date), answer: answerOf(frames),
      session: data.sessionIds?.[0] ?? null,
      first, prompt: promptText(first?.frame.message?.content), promptId: first?.frame.uuid ?? null,
      reply: Number.isInteger(data.sessionStart?.replyIndex) ? frames.find((entry) => entry.index === data.sessionStart.replyIndex) ?? null : null,
    });
  }
  return loaded.get(name);
}

/**
 * A capture's turns. One of K2's (M22) has a turn a prompt: the frames from that prompt to the
 * closing frame that names it, so that what the spike sent between two turns — a mode set — is no
 * part of either. Any other capture is one turn, whole from its first prompt on, as it always was.
 * A turn has the capture's own shape, and is replayed as one; `key` is its name in the session file.
 */
const split = new Map();
function turnsOf(name) {
  if (!split.has(name)) {
    const entry = capture(name);
    if (!APPROVAL_CAPTURES.includes(name) && name !== APPROVAL_RESUMED && !PLAN_CAPTURE_NAMES.includes(name)) split.set(name, [{ ...entry, key: name }]);
    else {
      const prompts = entry.frames.filter((item) => item.dir === 'send' && item.frame.type === 'user' && typeof item.frame.uuid === 'string');
      split.set(name, prompts.map((first, n) => {
        const closing = entry.frames.find((item) => item.index > first.index && item.dir === 'recv' && isLifecycle(item.frame) && item.frame.command_uuid === first.frame.uuid && (item.frame.state === 'completed' || item.frame.state === 'cancelled'));
        const frames = entry.frames.filter((item) => item.index >= first.index && item.index <= closing.index);
        return { ...entry, key: n === 0 ? name : `${name}#${n + 1}`, frames, first, prompt: promptText(first.frame.message.content), promptId: first.frame.uuid, answer: answerOf(frames) };
      }));
    }
  }
  return split.get(name);
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * A review capture's turns (M22e, C42): each from its prompt to its `result`, between T1's lifecycle
 * frames, lent under the prompt's alias — what a turn of a capture with ids on its prompts holds.
 */
const reviewSplit = new Map();
function reviewTurnsOf(name) {
  if (!reviewSplit.has(name)) {
    const entry = capture(name);
    const donor = capture(LIFECYCLE_DONOR);
    const life = (state) => donor.frames.find((item) => item.dir === 'recv' && isLifecycle(item.frame, state));
    const prompts = entry.frames.filter((item) => item.dir === 'send' && item.frame.type === 'user');
    reviewSplit.set(name, prompts.map((first, n) => {
      const result = entry.frames.find((item) => item.index > first.index && item.dir === 'recv' && item.frame.type === 'result');
      const body = entry.frames.filter((item) => item.index > first.index && item.index <= result.index && item.dir === 'recv');
      const lend = (state, index, ms, alias) => { const lent = life(state); return { ...lent, index, ms, frame: { ...lent.frame, command_uuid: LENT_PROMPT, uuid: alias, session_id: entry.session ?? lent.frame.session_id } }; };
      const prompt = { ...first, frame: { ...first.frame, uuid: LENT_PROMPT } };
      const frames = [prompt, lend('queued', first.index + 0.1, first.ms + 10, `<uuid-99${n}2>`), lend('started', first.index + 0.2, first.ms + 22, `<uuid-99${n}3>`), ...body, lend('completed', result.index + 0.5, result.ms + 1, `<uuid-99${n}4>`)];
      return { ...entry, key: n === 0 ? name : `${name}#${n + 1}`, frames, first: prompt, prompt: promptText(first.frame.message.content), promptId: LENT_PROMPT, answer: answerOf(frames) };
    }));
  }
  return reviewSplit.get(name);
}

/** A turn's answer as captured: the text of its last `assistant` frame of the session's own. */
function answerTextOf(entry) {
  const frame = [...entry.answer.roles].find(([, role]) => role === 'frame');
  const found = frame === undefined ? undefined : entry.frames.find((item) => item.index === frame[0]);
  return String(found?.frame.message?.content?.map((part) => part.text ?? '').join('') ?? '');
}

/**
 * Which of a capture's frames are its answer's (M19, C56): the turn's last text of the session's
 * own. By frame index: the stream events of that text's reply, each by what it is — the reply's
 * start, the text block's start, one of its text deltas, or another event of the reply — and the
 * `assistant` frame that completes it. A stream event carries no reply id but the reply's start, so
 * a reply is the events from one start of the session's own to the next.
 */
function answerOf(frames) {
  const own = (frame) => frame.parent_tool_use_id === null || frame.parent_tool_use_id === undefined;
  const texts = frames.filter((entry) => entry.dir === 'recv' && entry.frame.type === 'assistant' && own(entry.frame) && entry.frame.message?.content?.[0]?.type === 'text');
  const last = texts.at(-1);
  const roles = new Map();
  if (last === undefined) return { roles, deltas: 0 };
  roles.set(last.index, 'frame');
  const replyId = last.frame.message.id;
  let current = null;
  let block = null;
  let deltas = 0;
  for (const entry of frames) {
    if (entry.dir !== 'recv' || entry.frame.type !== 'stream_event' || !own(entry.frame)) continue;
    const event = entry.frame.event ?? {};
    if (event.type === 'message_start') { current = event.message?.id ?? null; block = null; }
    if (current !== replyId) continue;
    if (event.type === 'message_start') roles.set(entry.index, 'reply');
    else if (event.type === 'content_block_start' && event.content_block?.type === 'text') { block = event.index; roles.set(entry.index, 'block'); }
    else if (event.type === 'content_block_delta' && event.index === block && event.delta?.type === 'text_delta') { roles.set(entry.index, 'delta'); deltas += 1; }
    else roles.set(entry.index, 'other');
  }
  return { roles, deltas };
}
const pad = (value, length) => (value.length >= length ? value : value + ' '.repeat(length - value.length));
/** `value` with quotes after it, so many that its JSON is `bytes` long at least: each is two on the line (M20a, C16). */
const quoted = (value, bytes) => value + '"'.repeat(Math.ceil(bytes / 2));
const received = (entry, match) => entry.frames.filter((item) => item.dir === 'recv' && match(item.frame));
const isSideRequest = (item) => item.dir === 'send' && item.frame.type === 'control_request' && item.frame.request?.subtype === 'side_question';

/**
 * The side questions a capture holds (M20b, C61): each with the frames that name its request — its
 * progress frames, and its reply — and how long after the request each came. A question that was
 * cancelled has an error for its reply, and no answer.
 */
function sidesOf(name) {
  const entry = capture(name);
  return entry.frames.filter(isSideRequest).map((sent) => {
    const id = sent.frame.request_id;
    const progress = entry.frames.filter((item) => item.dir === 'recv' && isSystem(item.frame, 'control_request_progress') && item.frame.request_id === id);
    const reply = entry.frames.find((item) => item.dir === 'recv' && item.frame.type === 'control_response' && item.frame.response?.request_id === id) ?? null;
    const answered = reply !== null && reply.frame.response.subtype === 'success';
    return {
      entry, question: sent.frame.request.question, progress: progress.map((item) => item.frame),
      reply: answered ? reply.frame : null, error: reply !== null && !answered ? reply.frame : null,
      replyGap: answered ? Math.max(0, reply.ms - (progress.at(-1)?.ms ?? sent.ms)) : 0,
    };
  });
}
const isLifecycle = (frame, state) => frame.type === 'command_lifecycle' && (state === undefined || frame.state === state);
/** The CLI's request to use its question tool (M21): what a question's faults change, and what its wait is for. */
const isQuestionRequest = (frame) => frame.type === 'control_request' && frame.request?.subtype === 'can_use_tool' && frame.request.tool_name === 'AskUserQuestion';
/** The CLI's request to use any other tool (M22): what an approval's faults change, and what its wait is for. */
const isApprovalRequest = (frame) => frame.type === 'control_request' && frame.request?.subtype === 'can_use_tool' && frame.request.tool_name !== 'AskUserQuestion' && frame.request.tool_name !== PLAN_TOOL;
/** The CLI's request for the user's decision on a plan (M22b, C10): what its wait is for, and what the decision chooses after it. */
const isPlanRequest = (frame) => frame.type === 'control_request' && frame.request?.subtype === 'can_use_tool' && frame.request.tool_name === PLAN_TOOL;
/** What a reply decided of a plan (M22b, C11): Execute, Cancel or feedback; null for no reply, as where a Stop came in its place. */
const planKind = (response) => (response?.behavior === 'allow' ? 'execute' : response?.behavior === 'deny' ? (response.interrupt === true ? 'cancel' : 'feedback') : null);
/** A `user` frame that carries the result of that tool use. */
const isResultOf = (frame, toolUseId) => frame.type === 'user' && Array.isArray(frame.message?.content) && frame.message.content[0]?.type === 'tool_result' && frame.message.content[0].tool_use_id === toolUseId;
const isSystem = (frame, subtype) => frame.type === 'system' && frame.subtype === subtype;
/** A stream event of the session's own reply that ends a block or the reply: what is still on its way when a request goes out. */
const isReplyEnd = (frame) => frame.type === 'stream_event' && (frame.parent_tool_use_id === null || frame.parent_tool_use_id === undefined) && ['content_block_stop', 'message_delta', 'message_stop'].includes(frame.event?.type);
const isReplyStart = (frame) => frame.type === 'stream_event' && (frame.parent_tool_use_id === null || frame.parent_tool_use_id === undefined) && frame.event?.type === 'message_start';
/** The other mode a faulted report names: `acceptEdits`, or `default` where its own is that. */
const otherMode = (mode) => (mode === 'acceptEdits' ? 'default' : 'acceptEdits');
/** A session rule as the CLI writes one. */
const isRule = (rule) => isRecord(rule) && Object.keys(rule).length === 2 && typeof rule.toolName === 'string' && typeof rule.ruleContent === 'string';
/** The one update a reply may carry beside its `allow` (M22, C69): the CLI's own rules, for this session. */
const isSessionGrant = (updates) => Array.isArray(updates) && updates.length === 1 && isRecord(updates[0])
  && Object.keys(updates[0]).length === 4 && updates[0].type === 'addRules' && updates[0].behavior === 'allow' && updates[0].destination === 'session'
  && Array.isArray(updates[0].rules) && updates[0].rules.length > 0 && updates[0].rules.every(isRule);

export function createChatReplay({ args, parsed, cwd, configFolder, dir, output, takeControl, readControl, mark, env = process.env }) {
  const sessionsFile = env.FATG_SMOKE_CLAUDE_SESSIONS;
  const gap = env.FATG_SMOKE_CLAUDE_GAP_MS !== undefined && Number.isFinite(Number(env.FATG_SMOKE_CLAUDE_GAP_MS)) ? Number(env.FATG_SMOKE_CLAUDE_GAP_MS) : 50;
  const memory = { sessions: {} };
  /** The session this process runs: the one it was resumed by, or a new one. */
  const sessionId = parsed.resume ?? randomUUID();
  /** The turn being replayed, and the prompts that came while one was. */
  let turn = null;
  const queued = [];
  /** Workers this process has opened and not closed: the id sent for each, with its tool use's. */
  const workers = new Map();
  /** The side questions that wait for their reply, by the id fat-g sent each under (M20b). */
  const sides = new Map();
  /** A worker's question that waits for fat-g's reply, by its request's id: the frame that follows the reply (M21). */
  const workerAsked = new Map();
  /** This process has had a worker ask: `workerAsks` is taken once. */
  let workerHasAsked = false;
  /** `exitAtAnswer` or `exitAtDecision` was taken: the process ends at the next bytes written to it. */
  let endsAtInput = false;
  let closed = false;
  /** The permission mode in force (M22, C5): the launch's, until a `set_permission_mode` names another, for this process alone. */
  let modeInForce = parsed.mode;
  /** The mode in force when plan mode was set (M22b, C7): what Execute's status frame names, and what the CLI goes back to by itself. */
  let modeBeforePlan = null;
  /** The launch's tools as an `init` reports them. */
  const reportedTools = REPORTED_TOOLS[parsed.tools.join(',')];
  /** The session rules this process holds (M22, C21): what a reply's `updatedPermissions` gave it. A new process holds none. */
  const rules = [];

  // ── The session file ──────────────────────────────────────────────────────────────────────
  function readSessions() {
    if (!sessionsFile) return memory;
    try { return JSON.parse(readFileSync(sessionsFile, 'utf8')); } catch { return { sessions: {} }; }
  }
  const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  /**
   * Several fakes share the file, one per session: a read, a change and a write are made under a
   * lock, a folder beside the file that only one process can make. One left by a process that was
   * killed is taken over after two seconds.
   */
  function locked(work) {
    const lock = `${sessionsFile}.lock`;
    const deadline = Date.now() + 2000;
    for (;;) {
      try { mkdirSync(lock); break; } catch (error) {
        if (error?.code !== 'EEXIST' && error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error;
        if (Date.now() > deadline) break;
        pause(5);
      }
    }
    try { return work(); } finally { try { rmdirSync(lock); } catch { /* taken over, or gone */ } }
  }
  const blank = () => ({ cwd: null, kept: false, turns: [], interrupts: [], launches: [], efforts: [], answers: [], sides: [], cancels: [], modes: [], grants: [], writes: [], contexts: [] });
  function updateSession(change) {
    if (!sessionsFile) { memory.sessions[sessionId] = change(memory.sessions[sessionId] ?? blank()); return; }
    locked(() => {
      const data = readSessions();
      data.sessions[sessionId] = change(data.sessions[sessionId] ?? blank());
      const temporary = `${sessionsFile}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(data));
      // Windows refuses a rename while anything else has the target open, a scanner included: wait a
      // moment and try again, a few times.
      for (let attempt = 0; ; attempt++) {
        try { renameSync(temporary, sessionsFile); break; } catch (error) {
          if (attempt >= 40 || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error;
          pause(25);
        }
      }
    });
  }

  // ── Substitution: ids, times, the folder ──────────────────────────────────────────────────
  /** `fixed`: alias → id for this use; every other alias gets an id of its own, once. */
  function substituter(entry, fixed = {}) {
    const ids = new Map(Object.entries({ ...(entry.session ? { [entry.session]: sessionId } : {}), ...fixed }));
    const shift = Date.now() - entry.date;
    const idFor = (alias) => {
      if (!ids.has(alias)) ids.set(alias, randomUUID());
      return ids.get(alias);
    };
    const walk = (value, key) => {
      if (typeof value === 'string') {
        if (key === 'timestamp' && ISO_TIME.test(value)) return new Date(Date.parse(value) + shift).toISOString();
        return value.replaceAll('<scratch>', cwd).replace(ALIAS, (alias) => idFor(alias));
      }
      if (typeof value === 'number') return key !== undefined && TIME_KEYS.has(key) ? value + shift : value;
      if (Array.isArray(value)) return value.map((item) => walk(item));
      if (isRecord(value)) {
        // The capture's structured read path must use the host's separator.
        const file = value.type === 'tool_use' && value.name === 'Read' ? value.input?.file_path : undefined;
        if (path.sep === '/' && typeof file === 'string' && file.startsWith('<scratch>\\')) {
          value = { ...value, input: { ...value.input, file_path: file.replaceAll('\\', '/') } };
        }
        return Object.fromEntries(Object.entries(value).map(([name, item]) => [walk(name), walk(item, name)]));
      }
      return value;
    };
    return { frame: (frame) => walk(frame), idFor, fix: (alias, id) => { ids.set(alias, id); } };
  }

  /** A reply of the CLI's to a request of fat-g's: the captured one, under the id fat-g sent. */
  const replyUnder = (frame, requestId) => ({ ...frame, response: { ...frame.response, request_id: requestId } });

  const write = (frames, done) => {
    if (frames.length === 0) { done?.(); return; }
    output(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(''), done);
  };

  /** The answer's text where one is given (M19, C56): `answerText`'s, or a review's answer with its named change (M22e, C42). */
  const givenAnswer = (control) => turn?.answerAs ?? (typeof control.answerText === 'string' ? control.answerText : undefined);

  // ── Faults: a captured frame with one named change ────────────────────────────────────────
  function withFaults(frame, role = null) {
    const control = readControl();
    if (isSystem(frame, 'init')) {
      // The launch, the fourth substitution (M22): the mode in force, and the launch's tools before the capture's `mcp__` ones.
      const launched = { ...frame, permissionMode: modeInForce, tools: [...reportedTools, ...frame.tools.filter((name) => name.startsWith('mcp__'))] };
      if (control.otherMode === 'init' || takeControl('initOtherMode')) return { ...launched, permissionMode: otherMode(modeInForce) };
      if (control.otherTool) return { ...launched, tools: [...launched.tools, parsed.tools.includes('Write') ? 'NotebookEdit' : 'Write'] };
      return launched;
    }
    if (control.workerFailed && isSystem(frame, 'task_updated') && isRecord(frame.patch)) return { ...frame, patch: { ...frame.patch, status: 'failed' } };
    if (control.workerFailed && isSystem(frame, 'task_notification')) return { ...frame, status: 'failed' };
    if (turn === null) return frame;
    // M21 (C51): the question's request, or its result, one named thing changed.
    if (isQuestionRequest(frame)) {
      const [first, ...others] = frame.request.input.questions;
      if (control.questionWorker) return { ...frame, request: { ...frame.request, agent_id: 'no-such-worker' } };
      if (control.questionsTwenty) return { ...frame, request: { ...frame.request, input: { ...frame.request.input, questions: Array.from({ length: TWENTY }, (_, n) => ({ ...first, question: `${first.question} (${n + 1})` })) } } };
      if (control.optionsNine) return { ...frame, request: { ...frame.request, input: { ...frame.request.input, questions: [{ ...first, options: [...first.options, ...Array.from({ length: NINE - first.options.length }, (_, n) => ({ ...first.options[0], label: `option-${first.options.length + n + 1}` }))] }, ...others] } } };
      return frame;
    }
    if (control.questionResultError && turn.asking !== null && isResultOf(frame, turn.asking.toolUseId)) return { ...frame, message: { ...frame.message, content: [{ ...frame.message.content[0], is_error: true }, ...frame.message.content.slice(1)] } };
    // M19 (C56): the answer as it is written, one named thing changed as it is sent.
    if (role === 'delta') {
      const delta = frame.event.delta;
      if (typeof givenAnswer(control) === 'string') return { ...frame, event: { ...frame.event, delta: { ...delta, text: givenAnswer(control) } } };
      if (control.deltaOfWorker) return { ...frame, parent_tool_use_id: 'toolu_fault' };
      if (control.deltasPastBound) return { ...frame, event: { ...frame.event, delta: { ...delta, text: pad(String(delta.text ?? ''), PADDED_DELTA) } } };
    }
    if (role === 'frame') {
      const [first, ...others] = frame.message.content;
      if (typeof givenAnswer(control) === 'string') return { ...frame, message: { ...frame.message, content: [{ ...first, text: givenAnswer(control) }, ...others] } };
      if (control.wholeDiffers) return { ...frame, message: { ...frame.message, content: [{ ...first, text: `${first.text} (as completed)` }, ...others] } };
    }
    if (frame.type === 'result' && control.oversize === 'result' && typeof frame.result === 'string') return { ...frame, result: pad(frame.result, LINE + 64) };
    const content = frame.message?.content;
    if (frame.type === 'user' && control.oversize === 'toolResult' && !turn.padded && Array.isArray(content) && content[0]?.type === 'tool_result' && typeof content[0].content === 'string') {
      turn.padded = true;
      // A line over a session's limit, made of a result of quotes (M20a, C52): nothing of it is taken.
      return { ...frame, message: { ...frame.message, content: [{ ...content[0], content: quoted(content[0].content, LINE + 64) }, ...content.slice(1)] } };
    }
    // M20a (C52): the turn's first tool use of the session's own, and its result, one named thing changed.
    if (frame.type === 'assistant' && frame.parent_tool_use_id === null && Array.isArray(content) && content[0]?.type === 'tool_use') {
      turn.firstTool ??= content[0].id;
      if (control.toolUnknown && turn.firstTool === content[0].id) return { ...frame, message: { ...frame.message, content: [{ ...content[0], name: 'ALaterTool' }, ...content.slice(1)] } };
    }
    if (frame.type === 'user' && frame.parent_tool_use_id === null && Array.isArray(content) && content[0]?.type === 'tool_result' && content[0].tool_use_id === turn.firstTool && typeof content[0].content === 'string') {
      const change = control.toolError ? { is_error: true }
        : control.quotedResult ? { content: quoted(content[0].content, 2 * MIB + 64) }
          : control.longText === 'toolResult' ? { content: `${content[0].content}${'x'.repeat(OUTPUT_BOUND)}THE END` } : null;
      if (change !== null) return { ...frame, message: { ...frame.message, content: [{ ...content[0], ...change }, ...content.slice(1)] } };
    }
    if (frame.type === 'assistant' && control.longText && control.longText !== 'toolResult' && !turn.padded && frame.parent_tool_use_id === null && Array.isArray(content) && content[0]?.type === 'text') {
      turn.padded = true;
      return { ...frame, message: { ...frame.message, content: [{ ...content[0], text: pad(content[0].text, 100_001) }, ...content.slice(1)] } };
    }
    return frame;
  }

  /** Frames a control withholds from the turn being replayed. */
  function withheld(frame, role = null) {
    const control = readControl();
    // M19 (C56): the answer's completing frame, its reply's stream events, or all but the first of its deltas.
    if (role === 'frame' && control.noCompletion) return true;
    if (role !== null && role !== 'frame' && control.noDeltas) return true;
    if (role === 'delta' && typeof givenAnswer(control) === 'string') {
      if (turn.answerGiven) return true;
      turn.answerGiven = true;
    }
    if (control.turnNeverEnds && (frame.type === 'result' || isLifecycle(frame, 'completed') || isLifecycle(frame, 'cancelled'))) return true;
    // M20a (C52): the first tool's result never comes.
    if (control.noToolResult && frame.type === 'user' && frame.parent_tool_use_id === null && Array.isArray(frame.message?.content) && frame.message.content[0]?.type === 'tool_result' && frame.message.content[0].tool_use_id === turn?.firstTool) return true;
    if (control.workerNoClose && (isSystem(frame, 'task_notification') || (isSystem(frame, 'task_updated') && CLOSING_STATUSES.has(frame.patch?.status)))) return true;
    return false;
  }

  /**
   * M22 (C35): a request for a tool other than the question tool, one named thing changed. The three
   * that give it another shape come first: what the others change is then that shape's own.
   */
  function approvalFaults(frame) {
    const control = readControl();
    const { request } = frame;
    const file = typeof request.input?.file_path === 'string' ? request.input.file_path : path.join(cwd, 'approval-fault.txt');
    const reshaped = (tool, input) => ({ ...frame, request: { ...request, tool_name: tool, display_name: tool, input } });
    let changed = frame;
    if (control.targetsForty) changed = reshaped('MultiEdit', { file_path: file, edits: Array.from({ length: FORTY }, (_, n) => ({ old_string: `passage ${n + 1}`, new_string: `passage ${n + 1}, changed`, replace_all: false })) });
    else if (control.writeOverBound) changed = reshaped('Write', { file_path: file, content: 'x'.repeat(CONTENT_BOUND + 1) });
    else if (control.requestOverLine || control.requestOverLineNoId) changed = reshaped('Write', { file_path: file, content: 'x'.repeat(LINE + 64) });
    if (control.grantSuggestsOther && Array.isArray(changed.request.permission_suggestions)) {
      changed = { ...changed, request: { ...changed.request, permission_suggestions: changed.request.permission_suggestions.map((suggestion) => (suggestion?.type === 'addRules' ? { ...suggestion, destination: 'userSettings' } : suggestion)) } };
    }
    if (control.approvalWorker) changed = { ...changed, request: { ...changed.request, agent_id: 'no-such-worker' } };
    // The id written after the request: past the first 512 bytes of a line of over 4 MiB.
    if (control.requestOverLineNoId) changed = { type: changed.type, request: changed.request, request_id: changed.request_id };
    return changed;
  }

  /**
   * M22b (C48): a plan's request, one named thing changed — no plan in its input, a plan of a
   * mebibyte, or one past the line a session reads.
   */
  function planFaults(frame) {
    const control = readControl();
    const { request } = frame;
    const plan = typeof request.input?.plan === 'string' ? request.input.plan : '';
    const withPlan = (text) => ({ ...frame, request: { ...request, input: { ...request.input, plan: text } } });
    if (control.planEmpty) return { ...frame, request: { ...request, input: {} } };
    if (control.planMiB) return withPlan(pad(plan, MIB));
    if (control.planOverLine) return withPlan(pad(plan, LINE + 64));
    return frame;
  }

  /** `approvalChanged`: the request as it is delivered the second time, under the same id and with another input. */
  function changedRequest(frame) {
    const { input } = frame.request;
    const other = !isRecord(input) ? { changed: true }
      : typeof input.command === 'string' ? { ...input, command: `${input.command} --and-something-else` }
        : typeof input.content === 'string' ? { ...input, content: `${input.content} and something else` }
          : typeof input.new_string === 'string' ? { ...input, new_string: `${input.new_string} and something else` }
            : { ...input, changed: true };
    return { ...frame, request: { ...frame.request, input: other } };
  }

  // ── What an allowed request does (M22, C35) ───────────────────────────────────────────────
  /**
   * A path a request names, where it lies inside the folder the fake was started in; null for any
   * other. The captures were taken on Windows, and name a file as `<scratch>\name`: where the
   * separator is another, theirs is read as one.
   */
  function inside(named) {
    const target = path.resolve(cwd, path.sep === '\\' ? named : named.replaceAll('\\', '/'));
    const relative = path.relative(cwd, target);
    return relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? null : target;
  }

  /**
   * The change an allowed tool makes, in the scratch project and nowhere else: a `Write`'s file, an
   * `Edit`'s replacement, the file a `touch` makes where there is none. The path is noted where a
   * file was made or changed, and nothing is where none was.
   */
  function carryOut(tool, input) {
    if (!isRecord(input)) return;
    let target = null;
    try {
      if (tool === 'Write' && typeof input.file_path === 'string' && typeof input.content === 'string') {
        target = inside(input.file_path);
        if (target === null) return;
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, input.content);
      } else if (tool === 'Edit' && typeof input.file_path === 'string' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
        target = inside(input.file_path);
        if (target === null) return;
        const text = readFileSync(target, 'utf8');
        // A function for the new text: a `$` in it is no pattern of the replacement's.
        const edited = input.replace_all === true ? text.replaceAll(input.old_string, () => input.new_string) : text.replace(input.old_string, () => input.new_string);
        if (edited === text) return;
        writeFileSync(target, edited);
      } else if (tool === 'Bash' && typeof input.command === 'string') {
        const named = /^touch\s+(?:"([^"]+)"|'([^']+)'|(\S+))$/.exec(input.command.trim());
        target = named === null ? null : inside(named[1] ?? named[2] ?? named[3]);
        if (target === null || existsSync(target)) return;
        writeFileSync(target, '', { flag: 'wx' });
      } else return;
    } catch { return; }
    updateSession((session) => ({ ...session, writes: [...(session.writes ?? []), target] }));
  }

  // ── A request for a tool other than the question tool (M22, C35) ──────────────────────────
  /** Whether this process holds every rule the request's own `addRules` suggestion names (C21): such a request is not sent. */
  function covered(request) {
    const suggested = Array.isArray(request.permission_suggestions) ? request.permission_suggestions.find((entry) => isRecord(entry) && entry.type === 'addRules' && entry.behavior === 'allow' && Array.isArray(entry.rules)) : undefined;
    return suggested !== undefined && suggested.rules.length > 0 && suggested.rules.every((rule) => rules.some((held) => held.toolName === rule?.toolName && held.ruleContent === rule?.ruleContent));
  }

  /** A turn's first request, and the reply its capture shows to it. */
  function answered(view) {
    const asked = view.frames.find((item) => item.dir === 'recv' && isApprovalRequest(item.frame));
    const reply = view.frames.find((item) => item.dir === 'send' && item.frame.type === 'control_response' && item.frame.response?.request_id === asked.frame.request_id) ?? null;
    return { asked, reply };
  }

  /**
   * What another capture's turn lends a branch: its frames after its answer, as steps under a
   * substituter of their own, less the ends of the reply it was writing — this turn has its own.
   */
  function lent(view, subst) {
    const { reply } = answered(view);
    const next = view.frames.find((item) => item.dir === 'recv' && item.index > reply.index && isReplyStart(item.frame));
    const steps = [];
    let previous = reply.ms;
    for (const item of view.frames) {
      if (item.dir !== 'recv' || item.index <= reply.index) continue;
      if (isReplyEnd(item.frame) && (next === undefined || item.index < next.index)) continue;
      steps.push({ kind: 'frame', frame: item.frame, gap: Math.max(0, item.ms - previous), role: view.answer.roles.get(item.index) ?? null, subst });
      previous = item.ms;
    }
    return steps;
  }

  /** A `Write`'s result as captured, naming the file and the content of another: the ones this request wrote. */
  const naming = (input) => (frame) => {
    const [first, ...others] = frame.message.content;
    const was = frame.tool_use_result.filePath;
    return {
      ...frame,
      message: { ...frame.message, content: [{ ...first, content: first.content.replaceAll(was, input.file_path) }, ...others] },
      tool_use_result: { ...frame.tool_use_result, filePath: input.file_path, content: typeof input.content === 'string' ? input.content : frame.tool_use_result.content },
    };
  };

  /** A denied request's error result, its text the reply's own message, as the CLI echoes it. */
  const echoing = (message) => (frame) => {
    if (typeof message !== 'string') return frame;
    const [first, ...others] = frame.message.content;
    return { ...frame, message: { ...frame.message, content: [{ ...first, content: message }, ...others] }, ...(typeof frame.tool_use_result === 'string' ? { tool_use_result: `Error: ${message}` } : {}) };
  };

  /**
   * What follows an allow where the capture shows none: the tool's result and the turn's end as
   * `m22-approve-once`'s first turn shows them, under this turn's ids; and for a `Write`, the result
   * `m22-approve-files` shows for one, naming this request's file.
   */
  function allowedTail(playing, approving, input) {
    const view = turnsOf(APPROVAL_ONCE)[0];
    const ran = answered(view).asked.frame.request.tool_use_id;
    const steps = lent(view, substituter(view, { [view.promptId]: playing.promptId, [ran]: approving.toolUseId }));
    if (approving.tool !== 'Write' || !isRecord(input) || typeof input.file_path !== 'string') return steps;
    const files = turnsOf(APPROVAL_FILES)[0];
    const wrote = answered(files).asked.frame.request.tool_use_id;
    const result = files.frames.find((item) => item.dir === 'recv' && isResultOf(item.frame, wrote));
    return steps.map((step) => (isResultOf(step.frame, ran) ? { ...step, frame: result.frame, role: null, subst: substituter(files, { [wrote]: approving.toolUseId }), change: naming(input) } : step));
  }

  /**
   * What follows a deny where the capture shows none: `m22-approve-once`'s second turn after its
   * answer, under this turn's ids — its error result, apart, and the end of the turn after it.
   */
  function deniedTail(playing, approving) {
    const view = turnsOf(APPROVAL_ONCE)[1];
    const refused = answered(view).asked.frame.request.tool_use_id;
    const steps = lent(view, substituter(view, { [view.promptId]: playing.promptId, [refused]: approving.toolUseId }));
    return { result: steps.find((step) => isResultOf(step.frame, refused)), end: steps.filter((step) => !isResultOf(step.frame, refused)) };
  }

  /**
   * `deniedByRule`: K2's `system/permission_denied` frame for this turn's tool use and its tool, and
   * the error result that capture shows after it — a worker's naming the tool use that started it.
   */
  function ruleDenial(approving, parent) {
    const view = turnsOf(DENIED_BY_RULE)[0];
    const denied = view.frames.find((item) => item.dir === 'recv' && isSystem(item.frame, 'permission_denied'));
    const result = view.frames.find((item) => item.dir === 'recv' && isResultOf(item.frame, denied.frame.tool_use_id));
    const subst = substituter(view, { [denied.frame.tool_use_id]: approving.toolUseId });
    return [
      { kind: 'frame', frame: denied.frame, gap: 0, role: null, subst, change: (frame) => ({ ...frame, tool_name: approving.tool }) },
      { kind: 'frame', frame: result.frame, gap: Math.max(0, result.ms - denied.ms), role: null, subst, ...(parent === null ? {} : { change: (frame) => ({ ...frame, parent_tool_use_id: parent }) }) },
    ];
  }

  /**
   * The turn goes on from its request by what was decided of it: `allow`; `deny`, with the reply's
   * message; or `rule`, the configuration's own denial, which no reply made. The capture's own frames
   * where they show that outcome, and another capture's where they show the other.
   */
  function proceed(playing, outcome, { message, input } = {}) {
    const approving = playing.approving;
    // A frame of the turn's that is being written goes on to no step of the old ones.
    playing.epoch += 1;
    clearTimeout(playing.timer);
    playing.waiting = null;
    // What the capture shows after the request, less its wait for the answer.
    const rest = playing.steps.slice(playing.next).filter((step) => !(step.kind === 'await' && step.what === 'answer' && step.alias === approving.alias));
    // The ends of the reply that was being written when the request went out: they come whatever is decided.
    const ends = [];
    for (const step of rest) {
      if (step.kind !== 'frame') continue;
      if (step.frame.type === 'result' || isReplyStart(step.frame)) break;
      if (isReplyEnd(step.frame)) ends.push(step);
    }
    const resultAt = rest.findIndex((step) => step.kind === 'frame' && isResultOf(step.frame, approving.toolUseAlias));
    // A worker's request: its tool's result names the tool use that started the worker.
    const parent = resultAt !== -1 && typeof rest[resultAt].frame.parent_tool_use_id === 'string' ? (rest[resultAt].subst ?? playing.subst).frame(rest[resultAt].frame).parent_tool_use_id : null;
    let steps;
    if (outcome === 'allow') steps = approving.own === 'allow' ? rest : [...ends, ...allowedTail(playing, approving, input)];
    else if (parent !== null) {
      // The turn goes on as captured, the worker told of the refusal in place of its tool's result.
      const { result } = deniedTail(playing, approving);
      const refusal = outcome === 'rule' ? ruleDenial(approving, parent) : [{ ...result, change: (frame) => echoing(message)({ ...frame, parent_tool_use_id: parent }) }];
      steps = [...rest.slice(0, resultAt), ...refusal, ...rest.slice(resultAt + 1)];
    } else if (outcome === 'deny' && approving.own === 'deny') steps = rest.map((step, index) => (index === resultAt ? { ...step, change: echoing(message) } : step));
    else {
      const { result, end } = deniedTail(playing, approving);
      steps = [...(outcome === 'rule' ? ruleDenial(approving, null) : [{ ...result, change: echoing(message) }]), ...ends, ...end];
    }
    playing.steps = steps;
    playing.next = 0;
    play();
  }

  /**
   * The frames after a plan's decision where the turn's own capture shows another (M22b, C48): the
   * donor's turn from its reply to the plan request named on, as a turn is replayed — a wait where
   * it shows fat-g sending — under the donor's substituter, its prompt and its plan's tool use this
   * turn's. A feedback's result echoes the user's words; Execute's status frames name the mode the
   * CLI went back to.
   */
  function planTail(playing, [name, n], kind, message) {
    const view = turnsOf(name)[0];
    const asked = view.frames.filter((item) => item.dir === 'recv' && isPlanRequest(item.frame))[n];
    const reply = view.frames.find((item) => item.dir === 'send' && item.frame.type === 'control_response' && item.frame.response?.request_id === asked.frame.request_id);
    const subst = substituter(view, { [view.promptId]: playing.promptId, [asked.frame.request.tool_use_id]: playing.planning.toolUseId });
    const next = view.frames.find((item) => item.dir === 'recv' && item.index > reply.index && isReplyStart(item.frame));
    const steps = [];
    let previous = reply.ms;
    for (const item of view.frames) {
      if (item.index <= reply.index) continue;
      if (item.dir === 'send') {
        const { frame } = item;
        if (frame.type === 'control_request') steps.push({ kind: 'await', what: frame.request.subtype, alias: frame.request_id });
        else if (frame.type === 'control_response') steps.push({ kind: 'await', what: 'answer', alias: frame.response.request_id });
        continue;
      }
      // The donor's own reply ends: this turn has its own.
      if (isReplyEnd(item.frame) && (next === undefined || item.index < next.index)) continue;
      const step = { kind: 'frame', frame: item.frame, gap: Math.max(0, item.ms - previous), role: view.answer.roles.get(item.index) ?? null, subst };
      if (isPlanRequest(item.frame) || isApprovalRequest(item.frame)) {
        const own = view.frames.find((sent) => sent.dir === 'send' && sent.frame.type === 'control_response' && sent.frame.response?.request_id === item.frame.request_id)?.frame.response.response ?? null;
        step.own = isPlanRequest(item.frame) ? planKind(own) : own?.behavior ?? null;
      }
      if (kind === 'feedback' && isResultOf(item.frame, asked.frame.request.tool_use_id)) step.change = echoing(message);
      if (kind === 'execute' && isSystem(item.frame, 'status') && typeof item.frame.permissionMode === 'string') step.change = (frame) => ({ ...frame, permissionMode: modeInForce });
      steps.push(step);
      previous = item.ms;
    }
    return steps;
  }

  /** The turn goes on from its plan's request by what was decided of it (M22b, C11, C48): the capture's own frames, or a donor's. */
  function planProceed(playing, kind, message) {
    const planning = playing.planning;
    playing.epoch += 1;
    clearTimeout(playing.timer);
    playing.waiting = null;
    const rest = playing.steps.slice(playing.next).filter((step) => !(step.kind === 'await' && step.what === 'answer' && step.alias === planning.alias));
    // Execute: the CLI goes back to the mode it was in before plan mode, by itself (K1).
    if (kind === 'execute') modeInForce = modeBeforePlan ?? parsed.mode;
    if (kind === planning.own) {
      const resultAt = rest.findIndex((step) => step.kind === 'frame' && isResultOf(step.frame, planning.toolUseAlias));
      playing.steps = kind === 'feedback' ? rest.map((step, index) => (index === resultAt ? { ...step, change: echoing(message) } : step)) : rest;
    } else {
      // The ends of the reply that was being written when the request went out: they come whatever is decided.
      const ends = [];
      for (const step of rest) {
        if (step.kind !== 'frame') continue;
        if (step.frame.type === 'result' || isReplyStart(step.frame)) break;
        if (isReplyEnd(step.frame)) ends.push(step);
      }
      const donor = kind === 'feedback' ? PLAN_FEEDBACK : kind === 'cancel' ? PLAN_CANCEL : PLAN_EXECUTE[modeBeforePlan ?? parsed.mode] ?? PLAN_EXECUTE.default;
      playing.steps = [...ends, ...planTail(playing, donor, kind, message)];
    }
    playing.next = 0;
    play();
  }

  /** K1's Stop with a plan pending (M22b, C6), for this turn's own plan: its frames named by this turn's prompt, request and tool use. */
  function planStop(playing) {
    const entry = turnsOf(PLAN_STOP)[0];
    const asked = entry.frames.find((item) => item.dir === 'recv' && isPlanRequest(item.frame)).frame;
    const subst = substituter(entry, { [entry.promptId]: playing.promptId, [asked.request_id]: playing.planning.requestId, [asked.request.tool_use_id]: playing.planning.toolUseId });
    return { entry, subst };
  }

  /**
   * K2's Stop with a request pending (M22, C35), for this turn's own request: the capture's second
   * turn, its frames named by this turn's prompt, request and tool use, and the cancel frame among them.
   */
  function approvalStop(playing) {
    const entry = turnsOf(APPROVAL_STOP)[1];
    const asked = answered(entry).asked.frame;
    const subst = substituter(entry, { [entry.promptId]: playing.promptId, [asked.request_id]: playing.approving.requestId, [asked.request.tool_use_id]: playing.approving.toolUseId });
    return { entry, subst, cancel: subst.frame(entry.frames.find((item) => item.dir === 'recv' && item.frame.type === 'control_cancel_request').frame) };
  }

  // ── A turn ────────────────────────────────────────────────────────────────────────────────
  function noteSent(frame) {
    if (isSystem(frame, 'task_started')) workers.set(frame.task_id, { toolUseId: frame.tool_use_id });
    if (isSystem(frame, 'task_notification') || (isSystem(frame, 'task_updated') && CLOSING_STATUSES.has(frame.patch?.status))) workers.delete(frame.task_id);
    if (turn === null) return;
    if (isLifecycle(frame) && frame.command_uuid === turn.promptId) turn.lifecycle.add(frame.state);
    if (isSystem(frame, 'init') && turn.lifecycle.has('started') && !turn.resultSent) turn.initSent = true;
    if (frame.type === 'result') turn.resultSent = true;
  }

  /**
   * Whether the process ends once this frame is out. Asked before the frame is written: a test that
   * sets the control on seeing a frame must not have it taken by the process that sent that frame.
   */
  function exitsAfter(frame, role = null) {
    // M19 (C56): between two deltas of the answer, after its second.
    if (role === 'delta') {
      turn.answerDeltas += 1;
      // A review's process lost after its answer's first text delta (M22e, C42).
      if (turn.answerDeltas === 1 && turn.reviewLost) return true;
      return turn.answerDeltas === 2 && takeControl('exitBetweenDeltas');
    }
    if (isSystem(frame, 'task_started')) return takeControl('exitWithWorker');
    if (frame.type === 'assistant' && frame.parent_tool_use_id === null) return takeControl('exitDuringTurn');
    // A worker that outlives its turn: the turn has ended, and the process ends with the worker open.
    if (frame.type === 'result' && workers.size > 0) return takeControl('exitAfterTurnWithWorker');
    return false;
  }

  function finished() {
    turn = null;
    const next = queued.shift();
    if (next !== undefined) startTurn(next);
  }

  /** Plays the steps from `turn.next` on: frames with their gaps, a wait wherever the capture shows fat-g sending. */
  function play() {
    const playing = turn;
    if (playing === null || playing.cancelled) return;
    const step = playing.steps[playing.next];
    if (step === undefined) {
      // A capture whose process was ended by force ends this one where its frames do (K2).
      if (ENDS_WITH_PROCESS.has(playing.entry.name)) process.exit(3);
      finished();
      return;
    }
    if (step.kind === 'await' && step.what === 'answer' && playing.asking !== null) {
      // `questionLate`: the request has not gone out, so no reply to it is waited for.
      if (playing.late !== null) { playing.next++; play(); return; }
      // `questionCancel`: the CLI takes the request back in place of waiting, and goes on.
      if (readControl().questionCancel && !playing.asking.cancelled) {
        playing.asking.cancelled = true;
        playing.next++;
        write([questionStop(playing).cancel], () => play());
        return;
      }
    }
    if (step.kind === 'await' && step.what === 'answer' && playing.approving !== null && step.alias === playing.approving.alias) {
      const approving = playing.approving;
      // `approvalLate`: the request has not gone out, so no reply to it is waited for.
      if (approving.late) { playing.next++; play(); return; }
      // `approvalCancel`: the CLI takes the request back in place of waiting, and goes on.
      if (readControl().approvalCancel && !approving.cancelled && !approving.answered) {
        approving.cancelled = true;
        playing.next++;
        const epoch = playing.epoch;
        write([approvalStop(playing).cancel], () => { if (playing.epoch === epoch) play(); });
        return;
      }
    }
    if (step.kind === 'await') {
      // What it waits for may have come before the replay got here (a Stop pressed early): go on at once.
      const early = playing.early.findIndex((message) => message.what === step.what);
      if (early === -1) { playing.waiting = step; return; }
      const [message] = playing.early.splice(early, 1);
      bind(playing, step, message);
      playing.next++;
      play();
      return;
    }
    const held = step.frame.type === 'result' ? Number(readControl().holdResult) : NaN;
    playing.timer = setTimeout(() => {
      if (turn !== playing || playing.cancelled) return;
      playing.next++;
      // A frame another capture lent a branch comes under that capture's own substituter, and may carry one named change (M22).
      let frame = (step.subst ?? playing.subst).frame(step.frame);
      if (step.change !== undefined) frame = step.change(frame);
      if (withheld(frame, step.role)) { play(); return; }
      // The reply to a request of fat-g's, under the id that request came with.
      if (frame.type === 'control_response') frame = replyUnder(frame, playing.requests.get(step.frame.response.request_id) ?? frame.response.request_id);
      const sent = frame;
      frame = withFaults(frame, step.role);
      const asks = isQuestionRequest(frame);
      if (asks) {
        // The ids this turn's question went out under: what its result, and a Stop's tail, name.
        playing.asking = { requestId: frame.request_id, toolUseId: frame.request.tool_use_id, cancelled: false };
        // `questionLate`: withheld here, and sent once the turn's `result` is out.
        if (readControl().questionLate) { playing.late = frame; play(); return; }
        // `exitAtAnswer`: an input so large that its answer's line is still being written when the process ends at its first bytes.
        if (takeControl('exitAtAnswer')) {
          frame = { ...frame, request: { ...frame.request, input: { ...frame.request.input, padding: 'x'.repeat(ANSWER_PADDING) } } };
          endsAtInput = true;
        }
      }
      // M22b (C10, C48): a plan's request. What is decided of it chooses the frames after it.
      let pending = false;
      if (isPlanRequest(frame)) {
        // `planWithheld`: the CLI never asks, and the turn goes on as captured past its wait.
        if (readControl().planWithheld) {
          playing.steps = playing.steps.filter((other, index) => index < playing.next || !(other.kind === 'await' && other.what === 'answer' && other.alias === step.frame.request_id));
          play();
          return;
        }
        frame = planFaults(frame);
        playing.planning = { alias: step.frame.request_id, requestId: frame.request_id, toolUseId: frame.request.tool_use_id, toolUseAlias: step.frame.request.tool_use_id, own: step.own ?? null, answered: false };
        // `exitWhilePlanning`: the process ends once the request is out.
        pending = takeControl('exitWhilePlanning');
      }
      // M22 (C35): a request for any other tool. What is decided of it chooses the frames after it.
      const approves = isApprovalRequest(frame);
      if (approves) {
        // The ids this turn's request went out under, and what the capture shows of it: its own answer, and its tool use's alias.
        const approving = { alias: step.frame.request_id, requestId: frame.request_id, toolUseId: frame.request.tool_use_id, toolUseAlias: step.frame.request.tool_use_id, tool: frame.request.tool_name, input: frame.request.input, own: step.own ?? null, answered: false, cancelled: false, late: false };
        playing.approving = approving;
        // A session rule of this process's covers it (C21): it is not sent, and the tool runs.
        if (covered(frame.request)) {
          approving.answered = true;
          carryOut(approving.tool, approving.input);
          proceed(playing, 'allow', { input: approving.input });
          return;
        }
        // `deniedByRule`: the configuration's own denial, in the request's place.
        if (readControl().deniedByRule) { approving.answered = true; proceed(playing, 'rule'); return; }
        frame = approvalFaults(frame);
        approving.tool = frame.request.tool_name;
        approving.input = frame.request.input;
        // `approvalLate`: withheld here, and sent once the turn's `result` is out.
        if (readControl().approvalLate && approving.own !== null) { approving.late = true; playing.late = frame; play(); return; }
        // `exitAtDecision`: as `exitAtAnswer`, for the decision that sends the input back.
        if (takeControl('exitAtDecision')) {
          frame = { ...frame, request: { ...frame.request, input: { ...frame.request.input, padding: 'x'.repeat(ANSWER_PADDING) } } };
          endsAtInput = true;
        }
        // `exitWhileApproving`: the process ends once the request is out.
        pending = takeControl('exitWhileApproving');
      }
      const exit = exitsAfter(frame, step.role) || pending;
      noteSent(frame);
      if (step.role === 'delta') playing.lastDelta = sent;
      // `deltaAfterComplete`: the answer's last delta, again, after the frame that completed it.
      const again = step.role === 'frame' && playing.lastDelta !== null && readControl().deltaAfterComplete ? [playing.lastDelta] : [];
      // `questionTwice`, `approvalTwice`: the request again, under the same id; `approvalChanged`: again, with another
      // input. `questionLate`, `approvalLate`: the request, after the `result`.
      const twice = asks && readControl().questionTwice ? [frame]
        : approves && readControl().approvalTwice ? [frame]
          : approves && readControl().approvalChanged ? [changedRequest(frame)] : [];
      const late = frame.type === 'result' && playing.late !== null ? [playing.late] : [];
      // `workerAsks`: an open worker's question, before the turn's `result` or after it.
      const worker = frame.type === 'result' ? workerQuestion() : null;
      const epoch = playing.epoch;
      write([...(worker?.before ?? []), frame, ...twice, ...again, ...late, ...(worker?.after ?? [])], () => {
        if (exit) process.exit(3);
        // A decision that came while this frame was being written has set the steps anew, and plays them itself.
        if (playing.epoch === epoch) play();
      });
    }, Number.isFinite(held) && held > 0 ? held : Math.min(gap, step.gap));
  }

  /** What a wait was for has come: its id is the one the frames after it name. */
  function bind(playing, step, message) {
    if (step.what === 'prompt') playing.subst.fix(step.alias, message.id);
    else if (step.what === 'interrupt') playing.requests.set(step.alias, message.id);
  }

  /** The turn a prompt chooses: the one of a capture's whose own prompt it is, and T1 for any other. */
  function captureForPrompt(text) {
    // A review's turns (M22e, C42): by the prompt's own words, and by what came before in the session.
    const review = reviewTurnFor(text);
    if (review !== null) return review;
    let found;
    for (const name of TURN_CAPTURES) {
      found = turnsOf(name).find((candidate) => typeof candidate.prompt === 'string' && candidate.prompt.replaceAll('<scratch>', cwd) === text);
      if (found !== undefined) break;
    }
    // In plan mode (M22b, C48): a prompt no other capture holds — K1's own, or a brought plan's — is the plan turn of this process's launch.
    if (found === undefined && modeInForce === 'plan') return turnsOf(parsed.tools.join(',') === READING_TOOLS ? PLAN_CAPTURES.reading : PLAN_CAPTURES[parsed.mode] ?? PLAN_CAPTURES.default)[0];
    if (found === undefined) return turnsOf(DEFAULT_TURN)[0];
    // `exitWhileAsking` (M21, C51): K1's kill, for the prompt it shares with the question that was answered.
    if (found.name === QUESTION_TURN && takeControl('exitWhileAsking')) return capture(QUESTION_KILLED);
    // M22 (C21): the prompt two captures share. The command runs unasked where this process holds
    // its session rule, and is asked for again where it does not: in a process that resumed the session.
    if (found.key === `${APPROVAL_SESSION}#2`) {
      const resumed = turnsOf(APPROVAL_RESUMED)[0];
      if (!covered(substituter(resumed).frame(answered(resumed).asked.frame).request)) return resumed;
    }
    return found;
  }

  /**
   * The turn a prompt of a review's plays (M22e, Design 9; C42), or null for any other: the review's K2
   * turn, or K1's under `review-v1`; Send notes, the next of K2's rounds in the session; a plain
   * prompt in a reviewed session under `review-plain-block`, the asking note's turn. Its answer's
   * named change, where a fault asks for one, is the turn's to send.
   */
  function reviewTurnFor(text) {
    const session = readSessions().sessions?.[sessionId] ?? blank();
    if (isReviewPrompt(text)) {
      updateSession((held) => ({ ...held, reviewed: true }));
      const entry = reviewTurnsOf(takeControl('review-v1') ? REVIEW_CAPTURES.v1 : REVIEW_CAPTURES.rounds)[0];
      return { ...entry, fault: FIRST_ANSWER_FAULTS.find((name) => takeControl(name)) ?? null, lost: takeControl('review-lost') };
    }
    if (isSendNotes(text)) {
      const sent = session.notesSent ?? 0;
      updateSession((held) => ({ ...held, notesSent: sent + 1 }));
      return { ...reviewTurnsOf(REVIEW_CAPTURES.rounds)[Math.min(sent + 1, 3)], fault: LATER_ANSWER_FAULTS.find((name) => takeControl(name)) ?? null, lost: false };
    }
    if (session.reviewed === true && takeControl('review-plain-block')) return { ...reviewTurnsOf(REVIEW_CAPTURES.rounds)[2], fault: null, lost: false };
    return null;
  }

  function startTurn(prompt) {
    const entry = captureForPrompt(prompt.text);
    updateSession((session) => ({ ...session, kept: true, turns: [...session.turns, entry.key ?? entry.name] }));
    const subst = substituter(entry, { [entry.promptId]: prompt.id });
    const steps = [];
    let previous = entry.first.ms;
    // A side question is no part of a turn (M20b, C17): where a capture shows one asked during its
    // turn, the turn is replayed without the question's frames, and the question is answered when
    // fat-g asks it, whenever that is.
    const asked = new Set(entry.frames.filter(isSideRequest).map((item) => item.frame.request_id));
    for (const item of entry.frames) {
      if (item.index <= entry.first.index) continue;
      // A cancel fat-g sent is a side question's; one the CLI sent names a request of the turn's own, and is replayed (M22).
      if ((item.dir === 'send' && item.frame.type === 'control_cancel_request') || asked.has(item.frame.request_id) || asked.has(item.frame.response?.request_id)) continue;
      if (item.dir === 'send') {
        const { frame } = item;
        if (frame.type === 'user') steps.push({ kind: 'await', what: 'prompt', alias: frame.uuid });
        else if (frame.type === 'control_request') steps.push({ kind: 'await', what: frame.request.subtype, alias: frame.request_id });
        else if (frame.type === 'control_response') steps.push({ kind: 'await', what: 'answer', alias: frame.response.request_id });
        continue;
      }
      const step = { kind: 'frame', frame: item.frame, gap: Math.max(0, item.ms - previous), role: entry.answer.roles.get(item.index) ?? null };
      // What the capture shows answered to a request for a tool: `allow`, `deny`, or nothing, where a Stop came in an answer's place (M22).
      if (isApprovalRequest(item.frame)) step.own = entry.frames.find((reply) => reply.dir === 'send' && reply.frame.type === 'control_response' && reply.frame.response?.request_id === item.frame.request_id)?.frame.response.response?.behavior ?? null;
      // And to a plan's (M22b): feedback, Execute, Cancel, or nothing, where a Stop came in its place.
      if (isPlanRequest(item.frame)) step.own = planKind(entry.frames.find((reply) => reply.dir === 'send' && reply.frame.type === 'control_response' && reply.frame.response?.request_id === item.frame.request_id)?.frame.response.response ?? null);
      steps.push(step);
      previous = item.ms;
    }
    // A review's answer, one named change made to its text (M22e, C42): sent as `answerText` sends one.
    const answerAs = entry.fault == null ? null : subst.frame({ text: faulted(entry.fault, answerTextOf(entry)) }).text;
    turn = { entry, subst, steps, next: 0, promptId: prompt.id, requests: new Map(), early: [], waiting: null, cancelled: false, timer: null, lifecycle: new Set(), initSent: false, resultSent: false, padded: false, answerDeltas: 0, answerGiven: false, lastDelta: null, asking: null, late: null, approving: null, planning: null, epoch: 0, answerAs, reviewLost: entry.lost === true };
    play();
  }

  function prompt(message) {
    const id = message.uuid;
    // Its text, and — where it holds images, as a user frame may (M23, C21) — its text blocks: the images change no capture chosen.
    const text = promptText(message.message?.content);
    // A prompt with no id gets no `command_lifecycle` frame, and so no turn fat-g could bound (C79).
    if (typeof id !== 'string' || typeof text !== 'string') { mark('prompt-without-id'); return; }
    if (readControl().hang === 'started') {
      updateSession((session) => ({ ...session, kept: true, turns: [...session.turns, 'hang'] }));
      return;
    }
    const taken = { what: 'prompt', id, text };
    if (turn === null) { startTurn(taken); return; }
    if (turn.waiting?.what === 'prompt') {
      const step = turn.waiting;
      turn.waiting = null;
      bind(turn, step, taken);
      turn.next++;
      play();
      return;
    }
    if (turn.steps.slice(turn.next).some((step) => step.kind === 'await' && step.what === 'prompt')) { turn.early.push(taken); return; }
    // The CLI queues a prompt written while a turn runs; fat-g writes none then (C30).
    queued.push(taken);
  }

  /** The open workers closed, each by K11's two frames. */
  function workerClosingFrames() {
    const entry = capture(WORKER_INTERRUPT);
    const closing = received(entry, (frame) => isSystem(frame, 'task_updated') || isSystem(frame, 'task_notification'));
    const frames = [];
    for (const [taskId, worker] of [...workers]) {
      const subst = substituter(entry, { [closing[0].frame.task_id]: taskId, ...(closing[1]?.frame.tool_use_id ? { [closing[1].frame.tool_use_id]: worker.toolUseId } : {}) });
      for (const item of closing) frames.push(subst.frame(item.frame));
      workers.delete(taskId);
    }
    return frames;
  }

  /**
   * K1's Stop with a question pending (M21, C50), for this turn's own question: the capture, its
   * frames named by this turn's prompt, request and tool use, and the cancel frame among them.
   */
  function questionStop(playing) {
    const entry = capture(QUESTION_STOP);
    const asked = entry.frames.find((item) => item.dir === 'recv' && isQuestionRequest(item.frame)).frame;
    const subst = substituter(entry, { [entry.promptId]: playing.promptId, [asked.request_id]: playing.asking.requestId, [asked.request.tool_use_id]: playing.asking.toolUseId });
    return { entry, subst, cancel: subst.frame(entry.frames.find((item) => item.dir === 'recv' && item.frame.type === 'control_cancel_request').frame) };
  }

  /** K17's first progress frame, for this worker: by its task id, and the tool use that started it. */
  function workerProgress(taskId, worker) {
    const entry = capture(WORKER_PROGRESS);
    const { frame } = entry.frames.find((item) => item.dir === 'recv' && isSystem(item.frame, 'task_progress'));
    return substituter(entry, { [frame.task_id]: taskId, [frame.tool_use_id]: worker.toolUseId }).frame(frame);
  }

  /**
   * `workerAsks` (M21, C51): an open worker's question, once a process. The answered question's
   * tool use and request, each naming the worker, to go out before the turn's `result` or after
   * it; its result follows fat-g's reply — or, where nothing is to confirm it, the worker's next
   * progress frame does. Null where none asks.
   */
  function workerQuestion() {
    const when = readControl().workerAsks;
    if (workerHasAsked || workers.size === 0 || !['during', 'after', 'unconfirmed'].includes(when)) return null;
    workerHasAsked = true;
    const [taskId, worker] = [...workers][0];
    const entry = capture(QUESTION_TURN);
    const subst = substituter(entry);
    const asked = entry.frames.find((item) => item.dir === 'recv' && isQuestionRequest(item.frame)).frame;
    const used = entry.frames.find((item) => item.dir === 'recv' && item.frame.type === 'assistant' && item.frame.message?.content?.[0]?.id === asked.request.tool_use_id).frame;
    const result = entry.frames.find((item) => item.dir === 'recv' && isResultOf(item.frame, asked.request.tool_use_id)).frame;
    const request = subst.frame(asked);
    workerAsked.set(request.request_id, when === 'unconfirmed' ? workerProgress(taskId, worker) : { ...subst.frame(result), parent_tool_use_id: worker.toolUseId });
    const frames = [{ ...subst.frame(used), parent_tool_use_id: worker.toolUseId }, { ...request, request: { ...request.request, agent_id: taskId } }];
    return when === 'during' ? { before: frames, after: [] } : { before: [], after: frames };
  }

  /**
   * An interrupt during a turn whose capture shows none: T4's frames from its reply on, an open
   * worker closing first; before the turn's `init` has gone out, K22's, which shows that case; while
   * a question waits for its reply, K1's Stop, which shows that one (M21, C50); and while a request
   * for another tool waits for its decision, K2's (M22, C35).
   */
  function interruptTail(message) {
    const playing = turn;
    clearTimeout(playing.timer);
    playing.cancelled = true;
    const early = !playing.initSent;
    const asking = playing.asking !== null && playing.waiting?.what === 'answer' ? questionStop(playing) : null;
    // A request for another tool that is out and not yet decided (M22): K2's Stop with one pending.
    const undecided = playing.approving !== null && !playing.approving.answered && !playing.approving.cancelled && !playing.approving.late;
    // A plan that is out and not yet decided (M22b, C6): K1's Stop with one pending.
    const planned = playing.planning !== null && !playing.planning.answered ? planStop(playing) : null;
    const stop = asking ?? planned ?? (undecided ? approvalStop(playing) : null);
    const entry = stop?.entry ?? capture(early ? EARLY_INTERRUPT : INTERRUPT);
    const request = entry.frames.find((item) => item.dir === 'send' && item.frame.type === 'control_request' && item.frame.request.subtype === 'interrupt');
    const subst = stop?.subst ?? substituter(entry, { [entry.promptId]: playing.promptId });
    const frames = [];
    for (const item of entry.frames) {
      if (item.dir !== 'recv' || item.index < request.index) continue;
      const { frame } = item;
      // What this turn has sent already is not sent again: its `queued`, its `started`.
      if (isLifecycle(frame) && playing.lifecycle.has(frame.state)) continue;
      if (frame.type === 'rate_limit_event') continue;
      if (frame.type === 'control_response') { frames.push(replyUnder(subst.frame(frame), message.id), ...workerClosingFrames()); continue; }
      frames.push(withFaults(subst.frame(frame)));
    }
    const kept = frames.filter((frame) => !withheld(frame));
    for (const frame of kept) noteSent(frame);
    write(kept, () => { if (turn === playing) finished(); });
  }

  function interrupt(message) {
    updateSession((session) => ({ ...session, interrupts: [...session.interrupts, { inputOpen: !closed, turn: turn !== null && !turn.resultSent, workers: workers.size }] }));
    if (readControl().hang === 'stop') return;
    const taken = { what: 'interrupt', id: message.request_id };
    if (turn !== null && !turn.cancelled) {
      // Where the capture shows this request, the replay waits for it and goes on from there.
      if (turn.waiting?.what === 'interrupt') {
        const step = turn.waiting;
        turn.waiting = null;
        bind(turn, step, taken);
        turn.next++;
        play();
        return;
      }
      if (turn.steps.slice(turn.next).some((step) => step.kind === 'await' && step.what === 'interrupt')) { turn.early.push(taken); return; }
      if (!turn.resultSent) { interruptTail(taken); return; }
    }
    // No turn to interrupt: the request is answered, and nothing follows it.
    const entry = capture(INTERRUPT);
    const reply = received(entry, (frame) => frame.type === 'control_response' && frame.response.request_id !== entry.reply.frame.response.request_id)[0];
    write([replyUnder(substituter(entry).frame(reply.frame), taken.id)]);
  }

  /**
   * fat-g's answer to a request of the CLI's: noted for a test to read — an `allow`'s with the input
   * it sent back (M21, C50), and with the permissions it carried (M22, C69) — and the replay goes on.
   * A worker's question is no part of the turn's replay: its result follows its own reply. A request
   * for a tool other than the question tool goes by what its reply says (M22, C35).
   */
  function answer(message) {
    const response = message.response ?? {};
    const sentBack = response.response?.updatedInput;
    const updates = response.response?.updatedPermissions;
    updateSession((session) => ({ ...session, answers: [...session.answers, { subtype: response.subtype ?? null, behavior: response.response?.behavior ?? null, message: response.response?.message ?? null, error: response.error ?? null, ...(sentBack === undefined ? {} : { updatedInput: sentBack }), ...(updates === undefined ? {} : { updatedPermissions: updates }) }] }));
    if (workerAsked.has(response.request_id)) {
      const next = workerAsked.get(response.request_id);
      workerAsked.delete(response.request_id);
      write([next]);
      return;
    }
    if (turn === null) return;
    // M22b (C11, C48): a plan's decision chooses what follows it. One a request: a second reply is noted and no more.
    const planning = turn.planning;
    if (planning !== null && response.request_id === planning.requestId) {
      if (planning.answered) return;
      planning.answered = true;
      planProceed(turn, response.subtype === 'success' ? planKind(response.response) ?? 'feedback' : 'feedback', response.response?.message);
      return;
    }
    const approving = turn.approving;
    if (approving !== null && response.request_id === approving.requestId) {
      // One decision a request: a second reply, or one to a request the CLI took back or sent late, is noted and no more.
      if (approving.answered || approving.cancelled || approving.late) return;
      approving.answered = true;
      if (response.subtype !== 'success' || response.response?.behavior !== 'allow') { proceed(turn, 'deny', { message: response.response?.message }); return; }
      if (updates !== undefined) {
        if (isSessionGrant(updates)) {
          const granted = updates[0].rules.map((rule) => ({ toolName: rule.toolName, ruleContent: rule.ruleContent }));
          rules.push(...granted);
          updateSession((session) => ({ ...session, grants: [...(session.grants ?? []), ...granted] }));
        } else mark('unexpected-permission-update');
      }
      // What the CLI runs is the input the reply sent back.
      const input = isRecord(sentBack) ? sentBack : approving.input;
      carryOut(approving.tool, input);
      proceed(turn, 'allow', { input });
      return;
    }
    if (turn.waiting?.what !== 'answer') return;
    // A reply to another request than the one this turn waits on: noted, and no more.
    if (approving !== null && turn.waiting.alias === approving.alias) return;
    turn.waiting = null;
    turn.next++;
    play();
  }

  // ── A side question (M20b, C61, C62) ──────────────────────────────────────────────────────
  function sideFor(question) {
    for (const name of SIDE_CAPTURES) {
      const found = sidesOf(name).find((side) => side.question.replaceAll('<scratch>', cwd) === question);
      if (found !== undefined) return found;
    }
    return sidesOf(DEFAULT_SIDE)[0];
  }
  /** The error reply a cancel is answered with, as K1's capture shows it. */
  const cancelledReply = () => sidesOf(CANCELLED_SIDE)[0];

  /** A side question's reply with one named change (C62): no answer, a placeholder's mark, or another model named as the one that answered. */
  function sideFaults(frame) {
    const control = readControl();
    const value = frame.response.response;
    const changed = control.sideReply === 'null' ? { ...value, response: null }
      : control.sideReply === 'synthetic' ? { ...value, synthetic: true }
        : control.sideReply === 'fallback' ? { ...value, refusal_fallback: { original_model: 'claude-sonnet-5', fallback_model: 'claude-haiku-5' } } : value;
    return { ...frame, response: { ...frame.response, response: changed } };
  }

  function sideQuestion(message) {
    const id = message.request_id;
    const question = message.request.question;
    updateSession((session) => ({ ...session, sides: [...(session.sides ?? []), { question, history: message.request.history ?? null, turn: turn !== null && !turn.resultSent }] }));
    if (takeControl('sideRefused')) {
      const refused = cancelledReply();
      write([replyUnder(substituter(refused.entry).frame(refused.error), id)]);
      return;
    }
    const side = sideFor(question);
    const subst = substituter(side.entry);
    const progress = side.progress.map((frame) => ({ ...subst.frame(frame), request_id: id }));
    const pending = { timer: null };
    sides.set(id, pending);
    write(progress, () => {
      if (progress.length > 0 && takeControl('strayProgress')) write([{ ...progress[0], request_id: 'no-such-request' }]);
      // Its capture shows it cancelled, or the reply is withheld: it waits for a cancel.
      if (side.reply === null || readControl().hang === 'side') return;
      const held = Number(readControl().holdSide);
      pending.timer = setTimeout(() => {
        if (sides.get(id) !== pending) return;
        sides.delete(id);
        write([sideFaults(replyUnder(subst.frame(side.reply), id))]);
      }, Number.isFinite(held) && held > 0 ? held : Math.min(gap, side.replyGap));
    });
  }

  /** A cancel of a question that still waits is answered with the error reply at once; one of nothing gets nothing. */
  function cancel(message) {
    const id = message.request_id;
    const pending = sides.get(id);
    updateSession((session) => ({ ...session, cancels: [...(session.cancels ?? []), { waiting: pending !== undefined }] }));
    if (pending === undefined || readControl().hang === 'cancel') return;
    clearTimeout(pending.timer);
    sides.delete(id);
    const cancelled = cancelledReply();
    write([replyUnder(substituter(cancelled.entry).frame(cancelled.error), id)]);
  }

  // ── The launch ────────────────────────────────────────────────────────────────────────────
  /**
   * K5's capture of a resume like this process's (M22, C74), or null: the session it resumes had an
   * earlier process launched under `bypassPermissions`, and this one was launched with the tools
   * that act under a word K5 resumed that session under. Looked up once, at the first request.
   */
  let resumedAs;
  function bypassResumed() {
    if (resumedAs !== undefined) return resumedAs;
    const earlier = parsed.resume === null ? [] : readSessions().sessions[parsed.resume]?.launches ?? [];
    const followsBypass = parsed.tools.join(',') === EXECUTION_TOOLS && earlier.some((launch) => launch.pid !== process.pid && launch.mode === BYPASS);
    resumedAs = followsBypass && Object.hasOwn(BYPASS_RESUMED, parsed.mode) ? BYPASS_RESUMED[parsed.mode] : null;
    return resumedAs;
  }

  function initialize(message) {
    if (takeControl('exitDuringLaunch')) process.exit(3);
    if (readControl().hang === 'initialize') return;
    // K5's own reply for a resume of a session that was launched able to bypass permissions; M16's for every other.
    const entry = capture(bypassResumed() ?? (parsed.resume === null ? LAUNCH : RESUME));
    const frame = replyUnder(substituter(entry).frame(entry.reply.frame), message.request_id);
    // The launch's word (M22): the captured reply, that one field set. `otherMode`: another word than the launch's.
    const mode = readControl().otherMode === 'reply' ? otherMode(parsed.mode) : parsed.mode;
    write([{ ...frame, response: { ...frame.response, response: { ...frame.response.response, current_permission_mode: mode } } }]);
  }

  /**
   * A mode set with `set_permission_mode` (M22, C5, C74), as `m22-modes-set` shows one: the reply
   * that names the mode and the status frame that names it too, in one write; the reply alone for
   * the mode already in force; and the error reply for `bypassPermissions` in a process that was not
   * launched with it. Each is noted, with whether a turn was running.
   */
  function setMode(message) {
    const word = message.request.mode;
    const running = turn !== null && !turn.resultSent;
    const note = (answered) => updateSession((session) => ({ ...session, modes: [...(session.modes ?? []), { mode: typeof word === 'string' ? word : null, turn: running, answered }] }));
    // A word no capture shows set: nothing a chat session sends.
    if (!SET_WORDS.has(word)) { note('none'); mark('unexpected-chat-request'); return; }
    if (readControl().hang === 'mode') { note('none'); return; }
    const entry = capture(MODES_SET);
    const replyTo = (sent) => entry.frames.find((item) => item.dir === 'recv' && item.frame.type === 'control_response' && item.frame.response.request_id === sent.frame.request_id);
    const sets = entry.frames.filter((item) => item.dir === 'send' && item.frame.request?.subtype === 'set_permission_mode');
    const taken = sets.find((sent) => replyTo(sent).frame.response.subtype === 'success');
    const status = entry.frames.find((item) => item.dir === 'recv' && item.index > taken.index && isSystem(item.frame, 'status')).frame;
    const subst = substituter(entry, { [status.session_id]: sessionId });
    const refused = takeControl('modeRefused');
    if (refused || (word === BYPASS && parsed.mode !== BYPASS)) {
      note('error');
      // K5's own refusal (C74), where this process is the resume under `default` it was taken in: the
      // session was launched able to bypass permissions, and its resume is not. K2's for every other.
      const resumed = !refused && bypassResumed() === BYPASS_RESUMED.default ? capture(BYPASS_RESUMED.default) : null;
      if (resumed !== null) {
        const theirs = resumed.frames.find((item) => item.dir === 'recv' && item.frame.type === 'control_response' && item.frame.response.subtype === 'error');
        write([replyUnder(substituter(resumed).frame(theirs.frame), message.request_id)]);
        return;
      }
      write([replyUnder(subst.frame(replyTo(sets.find((sent) => replyTo(sent).frame.response.subtype === 'error')).frame), message.request_id)]);
      return;
    }
    const changes = word !== modeInForce;
    // The mode plan mode is set over (M22b, C7): what Execute goes back to.
    if (word === 'plan' && modeInForce !== 'plan') modeBeforePlan = modeInForce;
    modeInForce = word;
    note('success');
    const control = readControl();
    const captured = replyUnder(subst.frame(replyTo(taken).frame), message.request_id);
    // `modeReplyOther`: the reply names another mode than the one asked for.
    const reply = { ...captured, response: { ...captured.response, response: { ...captured.response.response, mode: control.modeReplyOther ? (word === 'plan' ? 'default' : 'plan') : word } } };
    if (!changes) { write([reply]); return; }
    // `statusOther`: the frame names another mode than the one now in force.
    const frame = { ...subst.frame(status), permissionMode: control.statusOther ? (word === 'plan' ? 'default' : 'plan') : word };
    // `statusApart`: two writes, the frame after a gap. `statusFirst`: the frame before the reply.
    if (control.statusApart) {
      const apart = typeof control.statusApart === 'number' && control.statusApart > 0 ? control.statusApart : APART_MS;
      write([reply], () => setTimeout(() => write([frame]), apart));
      return;
    }
    write(control.statusFirst ? [frame, reply] : [reply, frame]);
  }

  function effort(message) {
    updateSession((session) => ({ ...session, efforts: [...session.efforts, message.request?.settings ?? null] }));
    if (readControl().hang === 'effort') return;
    const entry = capture(EFFORT);
    const request = entry.frames.find((item) => item.dir === 'send' && item.frame.request?.subtype === 'apply_flag_settings');
    const reply = entry.frames.find((item) => item.dir === 'recv' && item.frame.type === 'control_response' && item.frame.response.request_id === request.frame.request_id);
    write([replyUnder(substituter(entry).frame(reply.frame), message.request_id)]);
  }

  /** A context request (decision 0033): M10's reply under fat-g's id, or the fault the control file names. */
  function context(message) {
    const detail = message.request?.detail ?? null;
    updateSession((session) => ({ ...session, contexts: [...(session.contexts ?? []), detail] }));
    if (detail !== 'summary') mark('unexpected-chat-request');
    const control = readControl();
    if (control.hang === 'context') return;
    if (control.contextRefused) {
      write([{ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'get_context_usage is not supported in this context' } }]);
      return;
    }
    const entry = capture(CONTEXT);
    const request = entry.frames.find((item) => item.dir === 'send' && item.frame.request?.subtype === 'get_context_usage');
    const reply = replyUnder(substituter(entry).frame(entry.frames.find((item) => item.dir === 'recv' && item.frame.type === 'control_response' && item.frame.response.request_id === request.frame.request_id).frame), message.request_id);
    if (!control.contextPrivate) { write([reply]); return; }
    const named = (name) => ({ name: `${SENTINEL}-${name}`, tokens: 5 });
    const response = {
      ...reply.response.response,
      memoryFiles: [{ path: `C:\\Users\\${SENTINEL}\\CLAUDE.md`, type: 'User', tokens: 120 }],
      mcpTools: [{ ...named('tool'), serverName: `${SENTINEL}-server`, isLoaded: true }],
      agents: [{ agentType: `${SENTINEL}-agent`, source: 'userSettings', tokens: 30 }],
      skills: { ...reply.response.response.skills, skillFrontmatter: [{ ...named('skill'), source: 'userSettings' }] },
      messageBreakdown: { ...reply.response.response.messageBreakdown, toolCallsByType: [{ ...named('call'), callTokens: 5, resultTokens: 5 }], attachmentsByType: [named('attachment')] },
      categories: [...reply.response.response.categories, { name: `${SENTINEL} files`, tokens: 7, color: 'inactive', kind: 'used' }],
    };
    write([{ ...reply, response: { ...reply.response, response } }]);
  }

  function startDescendant() {
    const mode = env.FATG_SMOKE_CLAUDE_DESCENDANT;
    if (!mode) return;
    const stdio = mode === 'hold' ? ['ignore', 'inherit', 'inherit'] : mode === 'ignore' ? 'ignore' : ['pipe', 'ignore', 'ignore'];
    // `ignore` and `hold` outlive the fake, so they are detached: on Windows a child otherwise goes
    // with its parent's job, and on POSIX with its parent's group.
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'descendant', mode, dir ?? ''], { stdio, windowsHide: true, detached: mode !== '1', env });
    if (mode !== '1') child.unref();
  }

  return {
    sessionId,
    /** What the process does before it reads anything. False when it has ended instead. */
    start() {
      if (takeControl('launchFails')) { process.exitCode = 1; return false; }
      if (parsed.resume !== null && (takeControl('resumeMissing') || readSessions().sessions[parsed.resume]?.kept !== true)) {
        // Before `initialize` is answered: one `result` frame, then the exit (K3).
        const entry = capture(MISSING);
        const frame = entry.frames.find((item) => item.dir === 'recv').frame;
        write([substituter(entry, { [frame.session_id]: parsed.resume }).frame(frame)], () => process.exit(1));
        return false;
      }
      updateSession((session) => ({ ...session, cwd, launches: [...session.launches, { pid: process.pid, args, cwd, config: configFolder ?? null, model: parsed.model, effort: parsed.effort, resume: parsed.resume, addDirs: parsed.addDirs, mode: parsed.mode, tools: parsed.tools }] }));
      startDescendant();
      return true;
    },
    inputClosed() { closed = true; },
    /** Whether the process is to end at the next bytes written to it, before the line they begin is whole (`exitAtAnswer`). */
    endsAtInput: () => endsAtInput,
    handle(message) {
      if (!isRecord(message)) return;
      if (message.type === 'user') { prompt(message); return; }
      if (message.type === 'control_response') { answer(message); return; }
      // A cancel names the request it takes back, and is no request itself (M20b, C15).
      if (message.type === 'control_cancel_request' && typeof message.request_id === 'string') { cancel(message); return; }
      if (message.type !== 'control_request' || !isRecord(message.request)) return;
      switch (message.request.subtype) {
        case 'initialize': initialize(message); return;
        case 'interrupt': interrupt(message); return;
        case 'apply_flag_settings': effort(message); return;
        case 'side_question':
          if (typeof message.request.question !== 'string') { mark('unexpected-chat-request'); return; }
          sideQuestion(message);
          return;
        case 'set_permission_mode': setMode(message); return;
        case 'get_context_usage': context(message); return;
        // A chat session sends these six requests and no other (decisions 0020, 0025, 0033; M22, C74).
        default: mark('unexpected-chat-request');
      }
    },
  };
}

// The descendant: records itself in the fake's ledger, then lives as its mode says.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === 'descendant') {
  const mode = process.argv[3];
  const ledger = process.argv[4];
  const started = Date.now();
  if (ledger) {
    appendFileSync(path.join(ledger, 'pids'), `${process.pid} chat-descendant ${started}\n`);
    process.on('exit', () => { try { appendFileSync(path.join(ledger, 'exited'), `${process.pid} ${started}\n`); } catch { /* the folder is gone */ } });
  }
  if (mode === '1') {
    process.stdin.resume();
    process.stdin.on('end', () => process.exit(0));
    process.stdin.on('close', () => process.exit(0));
  } else {
    // `ignore` and `hold` end only when something ends them; two minutes bounds a test that did not.
    process.on('SIGTERM', () => {});
    setTimeout(() => process.exit(0), 120_000);
  }
  setInterval(() => {}, 1000);
}
