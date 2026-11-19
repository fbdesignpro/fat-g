// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The replay (docs/planning/_archive/M15.md, Design 15; C70–C74, C115, C127, C128): how the fake Codex CLI
// answers the session methods. Every frame it sends is a received frame of a capture under
// ./captures, with three substitutions: ids (each alias becomes an id, one per alias), times, and
// the folder (`<scratch>` becomes the `cwd` it was given). A fault is a captured frame with one
// named change. tests/fakes/replay.test.ts holds it to that.
//
// A message's text deltas (docs/planning/_archive/M19.md, Design 9; C54, C56). The fake keeps the handshake's
// opt-out list and sends no frame whose method is on it: a handshake that opts out of every delta,
// as M15's did, sees the whole items it always saw. To a handshake that keeps
// `item/agentMessage/delta`, the prompts of K1's captures (`STREAM_CAPTURES`) choose those captures,
// which hold the deltas as the CLI sent them: T1's prompt and T3's among them. Every other prompt
// chooses as before, from captures that hold whole items alone.
//
// An answer that names a file (docs/planning/_archive/M19b.md, Design 10; C46). M19b's K2 captures join the
// stream captures, each by its own prompt. Codex wrote a file's address with forward slashes, the
// folder's own among them — `/C:/…/src/tides.js:12`, `C:/…/README.md` — and the redaction took the
// folder out in whatever form it was written. So in these three captures the folder goes back with
// forward slashes in the agent's own messages, their deltas included, and as it is everywhere else:
// what a command of the CLI's named, it named the system's own way.
//
// An aside's side thread (docs/planning/_archive/M20b.md, Design 9; C61). `thread/fork` is answered with K3's
// reply, under a new thread id, and the side thread's own `thread/started` after it. A `turn/start`
// on a side thread replays the turn of a K3 side thread, chosen by its prompt — K3's follow-up's
// first turn for any other — with that thread's frames alone, its deltas among them, under the side
// thread's id: beside the session's own turn, if one is being replayed, and any number at once. A
// turn whose capture shows it interrupted is played up to there, and waits. `turn/interrupt` on a
// side thread's turn is answered with K3's frames: the reply, and that turn's interrupted end. The
// two K3 captures that hold a turn of the session's own are turns by their prompts, replayed
// without their side threads' frames, which are sent when fat-g forks and asks.
//
// A question (docs/planning/_archive/M21.md, Design 8; C50, C51). K2's captures are turns by their prompts, to
// a handshake that keeps the agent message's delta: the plan turn that asked through a request, and
// the turns that asked in a message — one of them with the turn that answered it, each of that
// capture's two turns by its own prompt, the second fat-g's words for an answer. The app sends no
// plan turn (decision 0018): the prompt alone chooses the capture, so the plan turn's frames are
// played for an ordinary `turn/start` that carries its prompt. At the request the replay holds, as
// the CLI did, until fat-g replies; `serverRequest/resolved` and the rest of the capture follow the
// reply. An interrupt while the request is held is answered from the capture that traced one, the
// stopped plan turn's, which shares the prompt: its reply, the turn's interrupted end, and Codex's
// word for the request after it.
//
// K2's history read is one reply of five turns, read from a process that never resumed the thread.
// Under `history: 'm21'` those turns are a thread's history, in pages: each turn as that reply holds
// it, `full`, or without its items, `notLoaded`, as many as were asked for, from the turn a cursor
// names. No capture holds a summary of them: one is refused. The captures were redacted apart, so a
// turn has one alias live and another in the history: a turn of K2's that fat-g runs is given the
// ids the history holds for it, kept with its thread, so that it is a turn the history knows and
// not one made elsewhere. The two plan turns share their prompt and are matched to neither.
//
// FATG_SMOKE_CODEX_THREADS     a JSON file of the threads the fakes started, so another process,
//                              in the same run or the next, resumes what the first began (C73). A
//                              thread's entry also notes what was asked of it, for a test to read:
//                              its interrupts, its history reads (M18), and what was asked beside
//                              it (M20b): its forks' parameters, its side threads' turns and their
//                              interrupts. And for a question (M21): what each of K2's turns was
//                              started with, and each reply fat-g gave to a request.
// FATG_SMOKE_CODEX_GAP_MS      the longest gap between two frames, 50 ms unless given (C72).
// FATG_SMOKE_CODEX_DESCENDANT  1: a session's process starts one child that records itself and ends
//                              when its input closes. `ignore`: the child is detached and ignores
//                              its closed input (C114). `hold`: the child keeps the fake's output
//                              open after the fake has ended (C128).
//
// Controls come through the fake's control file (FATG_SMOKE_CODEX_CONTROL). A number is a count of
// times, taken one at a time; a word stays until the file is rewritten.
//   exitDuringStart, exitDuringTurn, exitWithWorker, exitAfterTurnWithWorker   the process ends there
//   otherSandbox: sandbox | network | policy      the start reply reports another one
//   hang: handshake | open | reopen | send | stop | history | fork | childSend | childStop
//                                                  that step never answers: `fork`, a fork; `childSend`, a side thread's
//                                                  `turn/start`; `childStop`, an interrupt of a side thread's turn, which
//                                                  then goes on as its capture has it
//   forkRefused                                    a fork is answered with the captured refusal (M20b, C62)
//   forkOther: sandbox | network | policy          the fork's reply reports another one
//   childTurnFailed                                a side thread's turn ends as failed
//   exitDuringAside                                the process ends once a side thread's turn has started
//   hangHistoryAfter: n                            history answers n times in this process, then never
//   turnNeverEnds                                  the turn's end and the status change are withheld
//   approvalRequest                                T7's approval request is sent during the turn
//   workerNoClose, workerNoTurnEnd, workerTurnFailed     T3's worker, its end changed
//   oversize: toolOutput | turnCompleted | reply | forkReply | historyPage | historyTurn | historyTurnSummary
//                                                  that frame padded past a session's line limit, 4 MiB (M20a, C16): a tool's
//                                                  output with quotes, which JSON's escaping doubles on the line
//   resumeRefused: malformed | otherCode           the captured refusal of an id that is not one
//   longText: answer | commentary | question | historyItem | toolOutput    that string padded past its bound
// And for what a session does between its messages (M20a, C52), each on the turn's first command:
//   quotedOutput                                   its output is a megabyte of quotes: a line of over two, which a session takes
//   itemUnknown                                    its item's type is one the adapter does not know, on both of its frames
//   noItemCompletion                               its `item/completed` is withheld: the turn ends with the item open
//   planTool                                       the user's own configuration enables the checklist tool (K1): the prompt that
//                                                  asks for it by name is answered from the capture taken with it on, with its
//                                                  five `turn/plan/updated` notifications, where it otherwise fails at the server
// A worker's item after its turn's end is a capture's own, and no fault: `m15-worker-outlives-turn`, by its prompt.
//   refuseInterrupt                                every interrupt is refused, as one with no turn is
//   oneChunk                                       the turn/start reply and what follows, in one write
// And for a message's deltas (M19, C56), each on the session's own final answer unless said:
//   wholeDiffers                                   the completing frame's text is another than its deltas brought
//   noCompletion                                   the completing frame is withheld: the turn ends with the message open
//   exitBetweenDeltas                              the process ends after the answer's second delta
//   deltaOtherThread, deltaOtherTurn               every delta names another thread, or another turn
//   deltaAfterComplete                             the answer's last delta is sent again after its completing frame
//   deltasPastBound                                every delta is padded to 20 000 units: the answer's pass the bound
//   noDeltas                                       the answer's deltas are withheld: it arrives whole
//   answerText: "…"                                the answer's text is the one given: its first delta brings all of it, the
//                                                  others are withheld, and the completing frame holds the same
// And for a question (M21, C51). On the plan turn's request:
//   questionTwice                                  it is delivered a second time, under the same id
//   questionWorker                                 it names a thread that is neither the session's nor any worker's
//   questionLate                                   it comes after its turn's end: the turn goes on without it, and
//                                                  Codex's word for it is withheld
//   questionResolvedEarly                          Codex takes it back: its `serverRequest/resolved` follows at once,
//                                                  and the turn goes on without a reply
//   exitWhileAsking                                the process ends once the request is out; or, set after that, as
//                                                  fat-g's reply arrives, before Codex's word for it
//   exitAtAnswer                                   the process ends as the answer is written: its first option's label is
//                                                  padded past what a pipe holds, and the process ends as the first bytes
//                                                  of what comes next arrive, so an answer that chooses that option is cut
//                                                  off, its write failed
//   questionsTwenty                                it holds twenty questions, the captured one under twenty ids
//   optionsNineNoOther                             its question has nine options and takes no free text
//   optionsOnly                                    its question takes no free text: its two options are all of it
//   noOptionsNoOther                               its question has no option and takes no free text
//   questionSecret                                 its question's answer is a secret
// On a message that asks:
//   longAsyncAnswer                                it holds sixteen questions, the captured one repeated: answers of ten
//                                                  thousand units to each pass a prompt's bound
//   historyPartialQuestion                         its completing frame is withheld, and one delta brings its text: the
//                                                  turn ends with the message open, and the history holds it whole
//   history: m21                                   a thread's history is K2's five turns, in pages
//
// What a session may do (docs/planning/_archive/M22.md, Design 11; C35). A `thread/start` and a
// `thread/resume` are answered with the sandbox, the approval policy and the reviewer they named,
// as the captures report them for an account in the fake's sandbox state: `none`, K1's account,
// which answers a workspace sandbox with the read-only one, or `ready`, the same account once K6's
// setup had run. What each start named, and what each `turn/start` named of a policy, is noted with
// the thread (`opens`, `policies`).
//
// K1's, K4's and K6's turns are turns by their prompts, each turn of a capture by its own, to a
// handshake that keeps the agent message's delta (`PERMISSION_CAPTURES`). At a request for leave
// the replay holds, as the CLI did, until fat-g replies, and branches on the reply:
//   accept            the capture's frames after it; and the fake makes the change in its project
//                     folder — a file of a `fileChange` item, or what `echo … > file` writes — where
//                     its target is a bare name there, and nowhere else (noted as `changes`)
//   acceptForSession  the same, and the file is granted for the life of this process: the turn
//                     K1 ran next on that file (`m22-codex-file-session-same-main`'s second) then
//                     plays as captured, with no request. In a process that holds no such grant —
//                     after a restart — that turn asks, with the request K1's resumed process got
//   decline           the item ends `declined`, as it started but for its status, as K1's did
// An error reply is a decline. Where the reply is another than the capture's own, the item's end is
// that one named change — its status — and the rest of the turn is the capture's. Each reply fat-g
// gives is noted with its thread (`replies`), as a question's is. Codex numbers its requests one
// after another for the life of its process, and so does each fake: a request's id, and Codex's
// word for it, are the process's own. An interrupt while a request for leave is held is answered
// from the capture that traced one (`m22-codex-override-main`): its reply, the turn's interrupted
// end, and Codex's word for the request after it. T7's own request is sent as it always was, and
// not waited at.
//
//   sandboxState: ready | none                     the account's sandbox, `none` unless given. An account of the accounts
//                                                  file has its own, `sandbox`; a setup that succeeded makes it `ready`
//                                                  for every process started after it, and not for its own (K6)
//   startOtherPolicy, startOtherReviewer, startOtherSandbox
//                                                  the start or resume reply reports another one than was named; a count
//                                                  is taken one at a time, `true` stays
// On a request for leave:
//   approvalTwice                                  it is delivered a second time, under the same id
//   approvalChanged                                it is delivered a second time under the same id with another payload:
//                                                  another command, or a reason a file change's did not have
//   approvalWorker                                 it names a thread that is neither the session's nor any worker's
//   approvalLate                                   it comes after its turn's end: the turn goes on without it, and
//                                                  Codex's word for it is withheld
//   approvalResolvedEarly                          Codex takes it back: its `serverRequest/resolved` follows at once,
//                                                  and the turn goes on without a reply
//   exitWhileApproving                             the process ends once the request is out; or, set after that, as
//                                                  fat-g's reply arrives, before Codex's word for it
//   exitAtDecision                                 the process ends as the decision is written: as the first bytes of what
//                                                  comes next arrive. A decision is a line of a few bytes, which no pipe
//                                                  refuses, so — unlike an answer's (`exitAtAnswer`) — its write goes: what
//                                                  is lost is Codex's word for it
//   requestOverLine                                the request is padded past a session's line limit, its id first
//   requestOverLineNoId                            the same, its id written after its parameters, past what is read of it
//   fileChangeUnheld                               a file change's request names an item that was never started
//   grantRootNamed                                 a file change's request asks for a root
//   commandForSession                              a command's list of decisions holds `acceptForSession`
// On a `fileChange` item, both of its frames:
//   changesTwentyOne                               it holds twenty-one changes, the captured one under twenty-one paths
//   changeOverBound                                its first change's diff is padded past 1,048,576 units
//
// Codex's own sandbox setup (M22, C60–C62, C72). `windowsSandbox/readiness` is answered by the
// sandbox state, with the captured reply. `windowsSandbox/setupStart` is answered `{ started: true }`
// as K6's was, and `windowsSandbox/setupCompleted` follows after a gap. Every such request is noted
// under the account, beside the threads (`sandbox`): its process, and what it was sent.
//   setupOutcome: success | declined | never | drop   `success` unless given: K6's approved setup, which makes the account's
//                                                  sandbox `ready` for later processes; K6's declined one, with its error;
//                                                  no completion at all; or the process ended right after the reply
//   setupRefused                                   the request is refused, with an error of the fake's own
//   setupNoStarted                                 it is answered `{ started: false }`
//   setupNoReply                                   it is never answered
//   hang: readiness                                readiness never answers
//
// Plans (docs/planning/_archive/M22b.md, Design 8; C13–C15, C48, C53, C55, C59, C61). A handshake that asks
// for the experimental API may name `collaborationMode` on a `turn/start`; one that does not has
// that turn refused, with an error of the fake's own (no capture holds one). The mode a turn names
// stays with its thread, across processes, as Codex keeps it (K2): a turn that names none runs in
// the mode its thread was left in. Each turn's `collaborationMode` is noted with its thread
// (`collaborations`), and the mode it left the thread in (`collaboration`).
//
// A turn in plan mode plays a plan turn of K2's (`PLAN_CAPTURES`, and M21's plan turn, which asks
// before it plans): the one asked in its words under its thread's policy, else in its words; a
// prompt with a block of fat-g's, the chain's feedback turn; any other, the first plan turn of that
// policy that asks nothing, else the first that asks nothing. A turn that names no mode on a thread
// left in plan mode plays the chain's plain prompt, which K2 saw answered without implementing. A
// turn naming `default` plays K2's turn of its words that named it — the chain's Execute, or the
// resumed thread's plain prompt — or, for a prompt with a block of fat-g's that executes it, the
// chain's Execute; any other plays as a turn naming nothing does. Each turn of a capture is an entry
// of its own, on the thread it ran on: `m22b-codex-modes` opened three. Their requests for leave
// are held for fat-g's reply, as K1's are. At M21's plan turn's question, the reply chooses how the
// turn goes on: "No answer" under each id goes on as K2's `skip` did, an empty list as its `empty`
// did, and any other answer as M21's own turn did.
//
//   experimentalRefused                            a handshake that asks for the experimental API is refused, with an error
//                                                  of the fake's own; a plain one is answered as ever
//   collaborationRefused                           a `turn/start` that names `collaborationMode` is refused the same way
// On the session's plan:
//   planWholeDiffers                               its completing frame's text is another than its deltas brought
//   planLarge                                      its first delta, and its completion's text after as much, carry a mebibyte
//                                                  more, in lines of a list: the plan is a megabyte, its deltas adding up to it
//   planOverLine                                   its completion's text is padded past a session's line limit, 4 MiB
//   exitWhilePlanning                              the process ends after its second delta
//
// A review (docs/planning/_archive/M22e.md, Design 9; C42, C46, C48, C49). K2's capture, `m22e-codex-rounds`, is
// one thread's four turns: the review, Send notes that settled a point, Send notes that only asked,
// and the review sent again unchanged. A review prompt of fat-g's — its instruction's first sentence,
// and `"const": 2` in its schema — plays the review; each Send notes on a thread plays the next of
// the other three, the last again from then on. An integration's plan turn plays M22b's plan turns,
// known by its block as a brought plan's feedback is. Each is a capture's turn, under the
// substituter; the faults below change one thing of it:
//   review-v1                                      a review prompt plays K1's review (`m22e-codex-review`), whose block
//                                                  names version 1
//   review-no-block, review-invalid, review-set-aside, review-two-blocks, review-long, review-unclosed
//                                                  the review's answer, one named change (tests/fixtures/review-faults.mjs)
//   review-prose-only, review-drop, review-renumber, review-ambiguous
//                                                  a Send notes answer, one named change
//   review-plain-block                             a plain prompt on a thread that was reviewed plays the asking note's turn:
//                                                  prose above a block that checks, for a prompt that is no review's
//   review-lost                                    the process ends after the review's first text delta
//   review-asks                                    the review prompt plays M21's turn that asks in a message, whose card ends
//                                                  the turn; the turn the card's answer starts plays K2's review
//   integration-asks                               an integration's plan turn plays that turn that asks; the turn the card's
//                                                  answer starts plans as any plan turn does
// Each is a count, taken one at a time.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { faulted, FIRST_ANSWER_FAULTS, isIntegration, isReviewPrompt, isSendNotes, LATER_ANSWER_FAULTS, unmarked } from '../review-faults.mjs';

const CAPTURES = path.join(import.meta.dirname, 'captures');
const MIB = 1024 * 1024;
/** A session's line limit (M20a, C16): what an oversize fault pads a frame past. */
const LINE = 32 * MIB;
/** A tool output's bound (M20a, C5): what `longText: toolOutput` pads one past. */
const OUTPUT_BOUND = 20_000;
/** The captures whose aliases are shared (spikes/m15/resume.mjs): a saved thread, its resume, its history. */
const FAMILY = ['m15-saved', 'm15-resume', 'm15-history'];
const DEFAULT_TURN = 't1-basic';
const START = 'm15-saved';
const RESUME = 'm15-resume';
const HISTORY = 'm15-history';
const REFUSALS = 'm15-resume-refused';
const EARLY_STOP = 'm15-early-stop-first';
const INTERRUPT = 't4-interrupt';
const WORKER_INTERRUPT = 'm15-worker-interrupt';
const APPROVAL = 't7-declined';
/** The one delta a session's handshake may keep (M19, C7). */
const MESSAGE_DELTA = 'item/agentMessage/delta';
/** The captures whose turn has a worker: what the worker controls change. */
const WORKER_TURNS = new Set(['t3-subagent', 'm19-worker', 'm20a-collab-spawn']);
/** How long a delta is made by `deltasPastBound`: six of them pass a message's bound of 100 000. */
const PADDED_DELTA = 20_000;
/** The request a question is asked through, and Codex's word that a request is over (M21). */
const QUESTION_REQUEST = 'item/tool/requestUserInput';
const REQUEST_RESOLVED = 'serverRequest/resolved';
/**
 * How long `exitAtAnswer` makes the first option's label (M21, C51): an answer that chooses it is a
 * line of that many bytes and a few more — longer than any pipe holds unread, and under the megabyte
 * fat-g's process layer queues (spawn.ts), so it is taken, and is still being written when the
 * process ends.
 */
const LONG_LABEL = 900_000;
/** K2's stopped plan turn: the interrupt, and what followed it, of a turn held at its request (M21, C50). It shares the plan turn's prompt, and is no turn by it. */
const PLAN_STOP = 'm21-codex-plan-stop';
/** K2's history read (M21, C50): what `history: 'm21'` serves. Its ids are kept with the thread, as the family's are. */
const QUESTION_HISTORY = 'm21-codex-history';
/** The two requests that ask leave for an action (M22). */
const COMMAND_APPROVAL = 'item/commandExecution/requestApproval';
const FILE_APPROVAL = 'item/fileChange/requestApproval';
const isApproval = (method) => method === COMMAND_APPROVAL || method === FILE_APPROVAL;
/** Codex's leave to run an MCP tool, and an MCP server's own form (decision 0018): both MCP elicitations. */
const MCP_ELICITATION = 'mcpServer/elicitation/request';
/** K1's Stop with a request for leave pending (M22): the interrupt, the turn's interrupted end, and Codex's word for the request after it. Its turns are no turns by their prompts. */
const APPROVAL_STOP = 'm22-codex-override-main';
/** K6's two setups (M22): the one the maintainer approved, and the one they declined. */
const SETUP = 'm22-codex-setup';
const SETUP_DECLINED = 'm22-codex-setup-declined';
/** The captures whose start replies say what an account reports for what a start names (M22): with no sandbox, and with one set up. */
const SANDBOX_REPLIES = { none: ['m22-codex-start', 'm22-codex-once'], ready: ['m22-codex-start-ready', 'm22-codex-ask-first-files'] };
/** The turn K1 ran on a file granted for the session, which brought no request (M22); and the request the same file brought once the process was another. */
const GRANTED_TURN = 'm22-codex-file-session-same-main#2';
const ASKED_AGAIN = 'm22-codex-file-session-same-resumed';
/** A file change's bound, in UTF-16 units (M22, C48): what `changeOverBound` pads one past. */
const CHANGE_BOUND = 1_048_576;

const ALIAS = /<[a-z][a-z-]*-\d+>/g;
/** A string that is one alias and nothing else: an object's key that names a thread. */
const WHOLE_ALIAS = /^<[a-z][a-z-]*-\d+>$/;
const MS_KEYS = /AtMs$/;
const SECOND_KEYS = new Set(['startedAt', 'completedAt', 'createdAt', 'updatedAt', 'recencyAt']);

const files = new Map();
function file(name) {
  if (!files.has(name)) {
    // A review capture's reads, its file markers made neutral (review-faults.mjs).
    const text = readFileSync(path.join(CAPTURES, `${name}.json`), 'utf8');
    files.set(name, JSON.parse(REVIEW_CAPTURES.includes(name) ? unmarked(text) : text));
  }
  return files.get(name);
}
const loaded = new Map();
/** The thread a capture's session ran on, by its alias. */
function sessionOf(data) {
  const reply = Number.isInteger(data.sessionStart?.replyIndex) ? data.frames.find((f) => f.index === data.sessionStart.replyIndex) : null;
  return reply?.frame?.result?.thread?.id ?? data.sessionIds?.[0] ?? null;
}
/** The `turn/start` requests of a capture's own session, in order: a side thread's turn is none of them (M20b). */
function ownStarts(data) {
  const all = data.frames.filter((f) => f.dir === 'send' && f.frame.method === 'turn/start');
  const thread = all[0]?.frame.params?.threadId;
  return all.filter((f) => f.frame.params?.threadId === thread);
}
/**
 * A capture, as one turn of it: its first unless `nth` says another. A capture of two turns is two
 * entries (M21, C50), each from its own `turn/start` to the next one's, under a label of its own.
 */
function capture(name, nth = 0) {
  const label = nth === 0 ? name : `${name}#${nth + 1}`;
  if (!loaded.has(label)) {
    const data = file(name);
    const starts = ownStarts(data);
    const start = starts[nth] ?? null;
    loaded.set(label, {
      name, label, frames: data.frames, date: Date.parse(data.date),
      session: sessionOf(data),
      start, until: starts[nth + 1]?.index ?? (M23_CAPTURES.includes(name) ? endOf(data, start) : Infinity), prompt: start?.frame.params?.input?.[0]?.text ?? null, client: start?.frame.params?.clientUserMessageId ?? null,
      family: FAMILY.includes(name) ? 'family' : name,
      // The captures whose ids are kept with a thread, under one name: what is read again later names the same things.
      kept: FAMILY.includes(name) ? 'family' : name === QUESTION_HISTORY ? 'm21' : null,
    });
  }
  return loaded.get(label);
}
/** Every turn of a capture's own session, in order. */
const turnsOf = (name) => ownStarts(file(name)).map((_, nth) => capture(name, nth));

/** Where a turn's frames end (M23): just past its own `turn/completed`, so nothing sent after it is part of the turn. */
function endOf(data, start) {
  const completed = data.frames.find((f) => f.dir === 'recv' && f.index > (start?.index ?? -1) && f.frame.method === 'turn/completed' && f.frame.params?.threadId === start?.frame.params?.threadId);
  return completed === undefined ? Infinity : completed.index + 1;
}

/**
 * M26's K2 (docs/planning/_archive/M26.md, Spike): the secretary's one turn on its ephemeral read-only
 * thread, with the task's instruction as its base instructions and its overrides, as production starts it, chosen by
 * its prompt — the title task's input for the spike's first prompt — as any turn is.
 */
const M26_TITLE = 'm26-codex-config-off';

/**
 * The captures a prompt can choose (C71), each by its own prompt. Not every capture with a turn is
 * one: the two-turn ones of M15 are left out, and so is the first turn stopped at once, whose capture
 * shows an interrupt the app never sends (it was refused: the turn had not started).
 */
/**
 * M23's K1 (docs/planning/_archive/M23.md, Design 11; C24, C36, C39, C63, C72): an image's turn, and the turn a
 * steer joined, each chosen by its prompt. The steer's turn awaits fat-g's `turn/steer` where the
 * capture shows it sent, and ends at its `turn/completed`: K1's second steer, sent once the turn was
 * over, is no part of it — a steer that comes with no step to await is answered by the turn as it is,
 * `{ turnId }` for the running one and K1's refusal, `-32600`, for any other.
 */
export const M23_CAPTURES = ['m23-codex-image', 'm23-codex-steer'];
export const SKILLS_CAPTURE = 'm23-codex-skills';
export const TURN_CAPTURES = ['t1-basic', 't3-subagent', 't4-interrupt', 't5-error', 't6-question', 't7-declined', 'm15-saved', 'm15-resume', 'm15-large-output', 'm15-worker-interrupt', 'm15-worker-outlives-turn', M26_TITLE, ...M23_CAPTURES];
/**
 * M20a's K1 captures (M20a, C51), each by its own prompt: a turn of several commands and a
 * reasoning item; the same asked to track its steps; one that asked for the checklist tool by name
 * and failed at the server after its commands; and the one taken with that tool switched on, which
 * holds the five `turn/plan/updated` notifications. The fake sends every frame a capture holds.
 *
 * The last two were asked the same prompt: what differed was the configuration, the tool off and
 * on. So that prompt chooses the first, as a configuration that leaves the tool off does, and the
 * second under the `planTool` control, which stands for the user's own configuration enabling it.
 */
export const ACTIVITY_CAPTURES = ['m20a-steps-main', 'm20a-steps-tracked-main', 'm20a-steps-tool-main', 'm20a-steps-tool-on-main'];
const PLAN_TOOL_OFF = 'm20a-steps-tool-main';
const PLAN_TOOL_ON = 'm20a-steps-tool-on-main';
/**
 * K1's captures (M19, C54), taken under the session handshake that keeps the agent message's delta:
 * each by its own prompt, and only for a handshake that keeps that delta too. The first two share
 * their prompts with T1 and T3, so those prompts stream.
 */
/**
 * K3's capture (M20a, round 3): a sub-agent started through the `spawnAgent` collab tool, on a model
 * that uses it — no `subAgentActivity`, the worker's thread named at the call's completion, and the
 * worker ended by its own turn's end. By its own prompt.
 */
export const COLLAB_CAPTURES = ['m20a-collab-spawn'];
/**
 * K3's captures (M20b, C61): a session's thread forked for an aside, and the side thread's turns.
 * Two of them hold a turn of the session's own too — the one that gives the thread something to
 * hold, and the long one a fork is made during — and are turns by their prompts.
 */
export const FORK_CAPTURES = ['m20b-fork-seed', 'm20b-fork-only', 'm20b-fork-followup', 'm20b-fork-during', 'm20b-fork-two', 'm20b-fork-read', 'm20b-fork-again'];
export const FORK_TURN_CAPTURES = ['m20b-fork-seed', 'm20b-fork-during'];
/** The capture whose fork's reply answers every fork, the one whose side thread's turn was interrupted, and the side thread's turn that answers any prompt no capture holds. */
const FORK_REPLY = 'm20b-fork-only';
const CHILD_INTERRUPT = 'm20b-fork-two';
const DEFAULT_CHILD = 'm20b-fork-followup';
/** How a question for a side thread that holds nothing of its aside begins (shared/contracts/aside.ts): its last paragraph is the question itself. */
const EARLIER = 'Earlier in this side conversation, I asked:';
export const STREAM_CAPTURES = ['m19-answer', 'm19-worker', 'm19-interrupt', 'm19-markdown', 'm19b-line', 'm19b-readme', 'm19b-space', ...ACTIVITY_CAPTURES, ...COLLAB_CAPTURES, ...FORK_TURN_CAPTURES];
/**
 * K2's captures (M21, C50), taken under the session handshake too: the plan turn that asked through
 * a request; the turn that asked in a message, with the turn that answered it; and the turn that
 * asked two questions in one. Each of their turns by its own prompt, as the stream captures are.
 */
export const QUESTION_CAPTURES = ['m21-codex-plan', 'm21-codex-async', 'm21-codex-async-two'];
/**
 * K2's captures of a plan (M22b, C48): `modes`, three plan turns under three modes, each on a thread
 * of its own; the `chain` — a plan turn, its feedback, a plain prompt that named no mode and the
 * Execute that named `default`; and a thread's plan turn and the plain prompt that named `default`
 * once a new process resumed it. The chain ran on codex-cli 0.155.1, the others on 0.163.0 (K2 run
 * again). Each of their turns is chosen by its mode, its words and its thread's policy.
 */
export const PLAN_CAPTURES = ['m22b-codex-modes', 'm22b-codex-chain', 'm22b-codex-resumed-first', 'm22b-codex-resumed-resumed'];
/** M21's plan turn, which asks before it plans (M21, C50): a plan turn of the plan captures' too, by its words. */
const QUESTION_PLAN = 'm21-codex-plan';
/** How K2's plan turn went on after the reply to its question (M22b, C53): "No answer" under each id, and an empty list. Neither is a turn by its words. */
const SKIPPED = 'm22b-codex-skip';
const EMPTIED = 'm22b-codex-empty';
/** The chain's turns that stand for what no capture holds: a plan's feedback, a plain prompt in plan mode, and Execute. */
const REVISION = 'm22b-codex-chain#2';
const PLAIN_IN_PLAN = 'm22b-codex-chain#3';
const IMPLEMENTED = 'm22b-codex-chain#4';
/** The opening line of a block of fat-g's (shared/contracts/plans.ts), and the words of Execute before one. */
const BLOCK = /^<fat-g-plan id="[a-z0-9-]{1,64}" version="[1-9][0-9]{0,5}" token="[0-9a-f]{12}">$/m;
const EXECUTE_WORDS = ['Implement the plan you proposed.', 'Implement the plan in the block below.'];
const PLAN_DELTA = 'item/plan/delta';
/** What the fake refuses a field it needs the experimental API for with: its own words, since no capture holds a refusal. */
const EXPERIMENTAL_REFUSAL = { code: -32600, message: 'the experimental API is not available' };
/**
 * K1's, K4's and K6's captures (M22, C35), taken under the session handshake too: each of their
 * turns by its own prompt. The turns that asked leave are held at each request for fat-g's reply.
 * Two families are left out: the captures that sent no prompt, whose replies the starts, readiness
 * and the setup are answered from; and the override's, whose first turn was stopped with its
 * request pending — the tail an interrupt is answered from — and whose second has no end.
 */
export const PERMISSION_CAPTURES = [
  'm22-codex-once', 'm22-codex-files', 'm22-codex-on-request', 'm22-codex-amendment', 'm22-codex-worker',
  'm22-codex-file-session-main', 'm22-codex-file-session-resumed', 'm22-codex-file-session-same-main', 'm22-codex-file-session-same-resumed',
  'm22-codex-sandbox-files', 'm22-codex-sandbox-commands', 'm22-codex-sandbox-ask-first', 'm22-codex-sandbox-ask-write', 'm22-codex-sandbox-temp',
  'm22-codex-reviewer-turn-main', 'm22-codex-read-only-turn', 'm22-codex-ask-first-files', 'm22-codex-auto-review-main', 'm22-codex-auto-review-resumed', 'm22-codex-berserk-main',
];
/**
 * The Codex MCP spike's captures (spikes/codex-mcp; decision 0018), taken under the session handshake,
 * each turn by its own prompt: leave to run an MCP tool asked as an elicitation and answered once,
 * for the session and declined, and left pending under a Stop; a server's own form; and Read only's
 * turn, which asks nothing. At each elicitation the turn is held for fat-g's reply.
 */
export const MCP_CAPTURES = ['codex-mcp-approval-once', 'codex-mcp-approval-session', 'codex-mcp-approval-deny', 'codex-mcp-approval-stop', 'codex-mcp-server-form', 'codex-mcp-annotated-read-only'];
/** M22e's K2 (C42): a review and its three later rounds on one thread; and K1's review, whose block names version 1, the fault `review-v1`. */
export const REVIEW_CAPTURES = ['m22e-codex-rounds', 'm22e-codex-review'];
const REVIEW_ROUNDS = 'm22e-codex-rounds';
const REVIEW_V1 = 'm22e-codex-review';
/** M21's turn that asked in a message, whose card ends its turn (C49): what `review-asks` and `integration-asks` play in a turn's place. */
const ASKS_IN_MESSAGE = 'm21-codex-async';
/** M19b's K2 captures: the ones whose answers name a file by an address the CLI wrote with forward slashes. */
const FORWARD_FOLDER = new Set(['m19b-line', 'm19b-readme', 'm19b-space']);
let prompts = null;
let streamPrompts = null;
function captureForPrompt(text, streams, planTool = false) {
  prompts ??= new Map(TURN_CAPTURES.map((name) => [capture(name).prompt, capture(name)]));
  streamPrompts ??= new Map([...STREAM_CAPTURES.filter((name) => name !== PLAN_TOOL_ON).map((name) => capture(name)), ...[...QUESTION_CAPTURES, ...PERMISSION_CAPTURES, ...MCP_CAPTURES].flatMap((name) => turnsOf(name))].map((entry) => [entry.prompt, entry]));
  const chosen = (streams ? streamPrompts.get(text) : undefined) ?? prompts.get(text) ?? capture(DEFAULT_TURN);
  return chosen.name === PLAN_TOOL_OFF && planTool ? capture(PLAN_TOOL_ON) : chosen;
}

/** What a start or a resume named of a policy, as one key: `sandbox|approvalPolicy|approvalsReviewer`. */
const policyKey = (named) => `${named?.sandbox ?? ''}|${named?.approvalPolicy ?? ''}|${named?.approvalsReviewer ?? ''}`;
/** The mode a capture's turn named: `plan`, `default`, or null for none. */
const modeOf = (entry) => entry.start?.frame.params?.collaborationMode?.mode ?? null;
/** The policy the thread a capture's turn ran on was opened with. */
function policyOf(entry) {
  const opened = entry.frames.filter((f) => f.dir === 'send' && f.index < entry.start.index && (f.frame.method === 'thread/start' || f.frame.method === 'thread/resume')).at(-1);
  return policyKey(opened?.frame.params);
}
/** Whether a capture's turn sent a request: a question, or one for leave. */
const asks = (entry) => entry.frames.some((f) => f.dir === 'recv' && f.index > entry.start.index && f.index < entry.until && (f.frame.method === QUESTION_REQUEST || isApproval(f.frame.method)));

/**
 * Each turn of a plan capture as an entry (M22b, C48): from its `turn/start` to the next start of a
 * turn or of a thread, on the thread it ran on.
 */
function planEntries(name) {
  const data = file(name);
  const sends = data.frames.filter((f) => f.dir === 'send' && ['turn/start', 'thread/start', 'thread/resume'].includes(f.frame.method));
  return sends.filter((f) => f.frame.method === 'turn/start').map((start, nth) => {
    const label = nth === 0 ? name : `${name}#${nth + 1}`;
    if (!loaded.has(label)) {
      const next = sends.find((f) => f.index > start.index);
      loaded.set(label, {
        name, label, frames: data.frames, date: Date.parse(data.date), session: start.frame.params.threadId,
        start, until: next?.index ?? Infinity, prompt: start.frame.params.input?.[0]?.text ?? null, client: start.frame.params.clientUserMessageId ?? null,
        family: name, kept: null,
      });
    }
    return loaded.get(label);
  });
}
let planPool = null;
const planTurns = () => (planPool ??= [...PLAN_CAPTURES.flatMap((name) => planEntries(name)), capture(QUESTION_PLAN)]);

/**
 * The plan capture's turn a `turn/start` plays (M22b, C48), or null where it plays as a turn naming
 * no mode does. `mode`: what it named; `key`: its thread's policy; `planning`: its thread is in
 * plan mode for it.
 */
function planCaptureFor(text, mode, key, planning) {
  const pool = planTurns();
  const named = (wanted) => pool.filter((entry) => modeOf(entry) === wanted);
  const byWords = (entries) => entries.find((entry) => entry.prompt === text && policyOf(entry) === key) ?? entries.find((entry) => entry.prompt === text);
  if (planning && mode === 'plan') {
    const plans = named('plan');
    return byWords(plans) ?? (BLOCK.test(text) ? loaded.get(REVISION) : undefined) ?? plans.find((entry) => policyOf(entry) === key && !asks(entry)) ?? plans.find((entry) => !asks(entry));
  }
  if (planning) return byWords(named(null)) ?? loaded.get(PLAIN_IN_PLAN);
  if (mode !== 'default') return null;
  const executes = BLOCK.test(text) && EXECUTE_WORDS.some((words) => text.startsWith(words));
  return byWords(named('default')) ?? (executes ? loaded.get(IMPLEMENTED) : null);
}

/** Lines of a list, `units` long: what `planLarge` and `planOverLine` pad a plan with. */
const planPadding = (units) => '\n- a line of padding'.repeat(Math.ceil(units / 20)).slice(0, units);

let history = null;
/** K2's history read (M21, C50): the reply to its one request, five turns newest first. */
function questionHistory() {
  if (history === null) {
    const entry = capture(QUESTION_HISTORY);
    const request = entry.frames.find((f) => f.dir === 'send' && f.frame.method === 'thread/turns/list');
    history = { entry, reply: entry.frames.find((f) => f.dir === 'recv' && f.index > request.index && f.frame.id === request.frame.id && f.frame.method === undefined).frame };
  }
  return history;
}
const linked = new Map();
/**
 * A turn of K2's as its history read names it (M21, C50): live alias → history alias, or null. The
 * turn is the one of the history that holds its prompt, where exactly one does, and its items are
 * matched by their type, in order; its prompt's id by its echo.
 */
function historyAliases(entry) {
  if (linked.has(entry.label)) return linked.get(entry.label);
  const same = questionHistory().reply.result.data.filter((turn) => turn.items.some((item) => item.type === 'userMessage' && item.content?.[0]?.text === entry.prompt));
  let pairs = null;
  if (same.length === 1) {
    const [turn] = same;
    pairs = new Map();
    const reply = entry.frames.find((f) => f.dir === 'recv' && f.index > entry.start.index && f.frame.id === entry.start.frame.id && f.frame.method === undefined);
    if (typeof reply?.frame.result?.turn?.id === 'string') pairs.set(reply.frame.result.turn.id, turn.id);
    const live = entry.frames.filter((f) => f.dir === 'recv' && f.index > entry.start.index && f.index < entry.until && f.frame.method === 'item/started' && f.frame.params?.threadId === entry.session).map((f) => f.frame.params.item);
    const taken = new Set();
    for (const item of turn.items) {
      const match = live.find((candidate) => candidate.type === item.type && !taken.has(candidate.id));
      if (match === undefined) continue;
      taken.add(match.id);
      pairs.set(match.id, item.id);
      if (item.type === 'userMessage' && typeof match.clientId === 'string' && typeof item.clientId === 'string') pairs.set(match.clientId, item.clientId);
    }
  }
  linked.set(entry.label, pairs);
  return pairs;
}

/** The received frame that answers the captured request `id`. */
const replyTo = (entry, id, from = 0) => entry.frames.find((f) => f.dir === 'recv' && f.index >= from && f.frame.id === id && f.frame.method === undefined);
const sent = (entry, method, nth = 0) => entry.frames.filter((f) => f.dir === 'send' && f.frame.method === method)[nth] ?? null;

const reported = new Map();
/**
 * What an account reports for what a start names (M22), by its sandbox state: `sandbox|policy|reviewer`,
 * as each `thread/start` and `thread/resume` of that state's captures named them, to the three
 * fields its reply reported.
 */
function reportedPolicies(state) {
  if (!reported.has(state)) {
    const index = new Map();
    for (const name of SANDBOX_REPLIES[state]) {
      const { frames } = file(name);
      for (const f of frames) {
        if (f.dir !== 'send' || (f.frame.method !== 'thread/start' && f.frame.method !== 'thread/resume')) continue;
        const named = f.frame.params ?? {};
        const result = frames.find((r) => r.dir === 'recv' && r.index > f.index && r.frame.method === undefined && r.frame.id === f.frame.id)?.frame.result;
        if (result?.sandbox === undefined || typeof named.sandbox !== 'string' || typeof named.approvalPolicy !== 'string') continue;
        const key = `${named.sandbox}|${named.approvalPolicy}|${named.approvalsReviewer ?? ''}`;
        if (!index.has(key)) index.set(key, { sandbox: result.sandbox, approvalPolicy: result.approvalPolicy, approvalsReviewer: result.approvalsReviewer });
      }
    }
    reported.set(state, index);
  }
  return reported.get(state);
}

/** How the capture's own reply to a request for leave left its item (M22): `completed` for an acceptance of any kind, `declined`, or null where the capture shows no reply. */
function answeredAs(entry, request) {
  const reply = entry.frames.find((f) => f.dir === 'send' && f.index > request.index && f.frame.method === undefined && f.frame.id === request.frame.id);
  const decision = reply?.frame.result?.decision;
  return decision === undefined ? null : decision === 'decline' ? 'declined' : 'completed';
}

/** A file's text with a diff's one change made (M22): the lines it takes out replaced by the lines it puts in; or, where they are not there, the lines it puts in. */
function patched(text, diff) {
  const lines = diff.split('\n').filter((line) => !line.startsWith('@@'));
  const from = lines.filter((line) => line.startsWith('-')).map((line) => line.slice(1)).join('\n');
  const to = lines.filter((line) => line.startsWith('+')).map((line) => line.slice(1)).join('\n');
  return from !== '' && text.includes(from) ? text.replace(from, to) : `${to}\n`;
}

const forked = new Map();
/**
 * What a capture holds of side threads (M20b, C61): their aliases, a test for whether a frame is
 * one's — its own notification, a request about it, or that request's reply — and each turn that
 * was started on one, with that turn's frames alone and where the capture shows it interrupted.
 */
function forksOf(name) {
  if (forked.has(name)) return forked.get(name);
  const entry = capture(name);
  const children = new Set();
  const requests = new Set();
  for (const f of entry.frames) {
    if (f.dir !== 'send' || f.frame.method === undefined) continue;
    if (f.frame.method === 'thread/fork') {
      requests.add(f.frame.id);
      const id = replyTo(entry, f.frame.id, f.index)?.frame.result?.thread?.id;
      if (typeof id === 'string') children.add(id);
    } else if (children.has(f.frame.params?.threadId)) requests.add(f.frame.id);
  }
  const isChilds = (f) => {
    if (f.frame.method === undefined || f.dir === 'send') return requests.has(f.frame.id);
    return children.has(f.frame.params?.threadId) || children.has(f.frame.params?.thread?.id);
  };
  const turns = entry.frames.filter((f) => f.dir === 'send' && f.frame.method === 'turn/start' && children.has(f.frame.params?.threadId)).map((start) => {
    const child = start.frame.params.threadId;
    const turnAlias = replyTo(entry, start.frame.id, start.index)?.frame.result?.turn?.id;
    const interrupt = entry.frames.find((f) => f.dir === 'send' && f.frame.method === 'turn/interrupt' && f.frame.params?.threadId === child && f.frame.params?.turnId === turnAlias) ?? null;
    const frames = [];
    for (const f of entry.frames) {
      if (f.index <= start.index || f.dir !== 'recv') continue;
      if (interrupt !== null && f.index > interrupt.index) break;
      if (f.frame.method === undefined) { if (f.frame.id === start.frame.id) frames.push(f); continue; }
      if (f.frame.params?.threadId !== child) continue;
      // Another turn of the same side thread is another turn's.
      const named = f.frame.params?.turnId ?? f.frame.params?.turn?.id;
      if (named !== undefined && named !== turnAlias) continue;
      frames.push(f);
      if (f.frame.method === 'turn/completed') break;
    }
    return { entry, start, child, turnAlias, client: start.frame.params.clientUserMessageId ?? null, prompt: start.frame.params.input?.[0]?.text ?? '', frames, interrupted: interrupt !== null };
  });
  const found = { entry, children, isChilds, turns };
  forked.set(name, found);
  return found;
}

/** A question's own words: the last paragraph of one that carries an aside's earlier exchanges before it, and else all of it. */
const ownQuestion = (text) => (text.startsWith(EARLIER) ? text.slice(text.lastIndexOf('\n\n') + 2) : text);
let childTurns = null;
/** The side thread's turn a prompt chooses: the one K3 asked in those words, or — a question that came with earlier exchanges — the one whose own question it ends with. */
function childTurnFor(text) {
  childTurns ??= FORK_CAPTURES.flatMap((name) => forksOf(name).turns);
  return childTurns.find((turn) => turn.prompt === text)
    ?? (text.startsWith(EARLIER) ? childTurns.find((turn) => turn.prompt.startsWith(EARLIER) && ownQuestion(turn.prompt) === ownQuestion(text)) : undefined)
    ?? forksOf(DEFAULT_CHILD).turns[0];
}

/**
 * `endAtInput`: ends this process as the first bytes of whatever is written to it next arrive (M21,
 * `exitAtAnswer`; M22, `exitAtDecision`): the fake's own to do. `sandbox`: the account's own sandbox
 * state, where the accounts file gives it one.
 */
export function createReplay({ output, takeControl, readControl, endAtInput = () => {}, sandbox = undefined, env = process.env }) {
  const threadsFile = env.FATG_SMOKE_CODEX_THREADS;
  const gap = Number.isFinite(Number(env.FATG_SMOKE_CODEX_GAP_MS)) && env.FATG_SMOKE_CODEX_GAP_MS !== undefined ? Number(env.FATG_SMOKE_CODEX_GAP_MS) : 50;
  const memory = { threads: {} };
  /** What this process runs: one turn at most. */
  let turn = null;
  /** The side threads this process forked, by id (M20b): each with the thread it was forked from, and its turn in flight. */
  const children = new Map();
  /** The notification methods this process's handshake opted out of (C54): no frame of one is sent. */
  let optedOut = new Set();
  /** This process's handshake asked for the experimental API, and was answered (M22b, C13). */
  let experimental = false;
  /** How many history requests this process has answered (`hangHistoryAfter`). */
  let historyAnswered = 0;
  let descendantStarted = false;
  /** Codex numbers its own requests one after another for the life of its process (K1: 0, then 1), and so does this one (M22). */
  let nextRequest = 0;
  /** The files granted for the session in this process (M22): the paths of each change answered `acceptForSession`. They go with the process. */
  const grants = new Set();
  /** The account's sandbox as this process found it (M22): read once, since a setup changes it for later processes alone (K6). */
  let sandboxFound = null;
  /** The account, by the home this process was given: what its sandbox's notes are kept under. */
  const account = (() => {
    const name = Object.keys(env).find((candidate) => candidate.toUpperCase() === 'CODEX_HOME');
    return name === undefined || env[name] === '' ? 'default' : env[name];
  })();

  // ── The thread file ───────────────────────────────────────────────────────────────────────
  function readThreads() {
    if (!threadsFile) return memory;
    try { return JSON.parse(readFileSync(threadsFile, 'utf8')); } catch { return { threads: {} }; }
  }
  const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  /**
   * Several fakes share the file, one per session: a read, a change and a write are made under a
   * lock, a folder beside the file that only one process can make. One left by a process that was
   * killed is taken over after two seconds.
   */
  function locked(work) {
    const lock = `${threadsFile}.lock`;
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
  function updateThread(id, change) {
    if (!threadsFile) {
      memory.threads[id] = change(memory.threads[id] ?? { cwd: null, kept: false, aliases: {}, turns: [], interrupts: [] });
      return memory.threads[id];
    }
    return locked(() => writeThread(id, change));
  }
  function writeThread(id, change) {
    const data = readThreads();
    data.threads[id] = change(data.threads[id] ?? { cwd: null, kept: false, aliases: {}, turns: [], interrupts: [] });
    writeData(data);
    return data.threads[id];
  }
  function writeData(data) {
    const temporary = `${threadsFile}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(data));
    // Windows refuses a rename while anything else has the target open, a scanner included: wait a
    // moment and try again, a few times.
    for (let attempt = 0; ; attempt++) {
      try { renameSync(temporary, threadsFile); break; } catch (error) {
        if (attempt >= 40 || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code)) throw error;
        pause(25);
      }
    }
  }
  const thread = (id) => readThreads().threads[id] ?? null;
  /** What is noted of the account's sandbox, beside the threads (M22): its state once a setup made one, and each request it was sent. */
  function updateSandbox(change) {
    const apply = (data) => { data.sandbox = { ...data.sandbox, [account]: change(data.sandbox?.[account] ?? {}) }; return data; };
    if (!threadsFile) { apply(memory); return; }
    locked(() => writeData(apply(readThreads())));
  }
  /** `ready` or `none`: what a setup left for this account, else what its accounts entry says, else the control. */
  function sandboxState() {
    sandboxFound ??= readThreads().sandbox?.[account]?.state ?? sandbox ?? readControl().sandboxState ?? 'none';
    return sandboxFound === 'ready' ? 'ready' : 'none';
  }
  /** A control that is a count is taken one at a time; one that is `true` stays. */
  const flagged = (name) => (typeof readControl()[name] === 'number' ? takeControl(name) : readControl()[name] === true);
  /**
   * The ids a thread keeps for these aliases under `kept`, each made once, in one write (M21): an
   * alias given an id here takes that one, as a prompt's own id is the one it was sent with.
   */
  function keptIds(threadId, kept, aliases) {
    const ids = {};
    updateThread(threadId, (t) => {
      const next = { ...t.aliases };
      for (const [alias, given] of aliases) {
        const key = `${kept}:${alias}`;
        next[key] = given ?? next[key] ?? randomUUID();
        ids[alias] = next[key];
      }
      return { ...t, aliases: next };
    });
    return ids;
  }

  // ── Substitution: ids, times, the folder ──────────────────────────────────────────────────
  /** `fixed`: alias → id for this use; other aliases get an id each, kept with the thread for a capture whose ids are. */
  function substituter(entry, threadId, fixed = {}, fresh = false) {
    const local = new Map(Object.entries({ ...(entry.session ? { [entry.session]: threadId } : {}), ...fixed }));
    const shift = Date.now() - entry.date;
    const cwd = thread(threadId)?.cwd ?? '';
    const idFor = (alias) => {
      if (local.has(alias)) return local.get(alias);
      let id;
      if (entry.kept !== null && !fresh) {
        const key = `${entry.kept}:${alias}`;
        id = thread(threadId)?.aliases?.[key];
        if (id === undefined) { id = randomUUID(); updateThread(threadId, (t) => ({ ...t, aliases: { ...t.aliases, [key]: id } })); }
      } else id = randomUUID();
      local.set(alias, id);
      return id;
    };
    /** The folder as an agent's message of M19b's captures spells it: with forward slashes. */
    const forward = cwd.replaceAll('\\', '/');
    let folder = cwd;
    const text = (value) => value.replaceAll('<scratch>', folder).replace(ALIAS, (alias) => idFor(alias));
    const walk = (value, key) => {
      if (typeof value === 'string') return text(value);
      if (typeof value === 'number' && key !== undefined) {
        if (MS_KEYS.test(key)) return value + shift;
        if (SECOND_KEYS.has(key)) return value + Math.round(shift / 1000);
        return value;
      }
      if (Array.isArray(value)) return value.map((item) => walk(item));
      // A key that is an id — a collab call's agents' states are by thread (M20a, K3) — is the same id its values are.
      if (value && typeof value === 'object') {
        // The capture's structured read path must use the host's separator.
        if (path.sep === '/' && value.type === 'read' && typeof value.path === 'string' && value.path.startsWith('<scratch>\\')) {
          value = { ...value, path: value.path.replaceAll('\\', '/') };
        }
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [WHOLE_ALIAS.test(k) ? idFor(k) : k, walk(v, k)]));
      }
      return value;
    };
    const frame = (value) => {
      const ofAgent = value?.method === MESSAGE_DELTA || value?.params?.item?.type === 'agentMessage';
      folder = FORWARD_FOLDER.has(entry.name) && ofAgent ? forward : cwd;
      return walk(value);
    };
    return { frame, idFor, fix: (alias, id) => local.set(alias, id) };
  }

  /** How this process was started, for a test to read: its arguments, its folder, and the home it was given, if any. */
  const launch = () => {
    const name = Object.keys(env).find((candidate) => candidate.toUpperCase() === 'CODEX_HOME');
    return { pid: process.pid, args: process.argv.slice(2), cwd: process.cwd(), home: name === undefined || env[name] === '' ? null : env[name] };
  };

  const pad = (value, length) => (value.length >= length ? value : value + ' '.repeat(length - value.length));
  /** `value` with quotes after it, so many that its JSON is `bytes` long at least: each is two on the line (M20a, C16). */
  const quoted = (value, bytes) => value + '"'.repeat(Math.ceil(bytes / 2));
  /** The turn's first command, by its item id: what the activity faults change. */
  const firstCommand = (frame) => {
    const item = frame.params?.item;
    if (item?.type !== 'commandExecution' || frame.params.threadId !== turn?.threadId) return false;
    turn.firstCommand ??= item.id;
    return turn.firstCommand === item.id;
  };

  /** The answer's text where one is given (M19, C56): `answerText`'s, or a review's answer with its named change (M22e, C42). */
  const givenAnswer = (control) => turn?.answerAs ?? (typeof control.answerText === 'string' ? control.answerText : undefined);

  // ── Faults: a captured frame with one named change ────────────────────────────────────────
  function withFaults(frame) {
    const params = frame.params ?? {};
    const item = params.item;
    const control = readControl();
    const oversize = control.oversize;
    const long = control.longText;
    // A line over a session's limit, made of an output of quotes (M20a, C52): nothing of it is taken.
    if (frame.method === 'item/completed' && item?.type === 'commandExecution' && oversize === 'toolOutput') return { ...frame, params: { ...params, item: { ...item, aggregatedOutput: quoted(String(item.aggregatedOutput ?? ''), LINE + 64) } } };
    if (frame.method === 'turn/completed' && params.threadId === turn?.threadId && oversize === 'turnCompleted') return { ...frame, params: { ...params, turn: { ...params.turn, items: [...(params.turn?.items ?? []), { type: 'agentMessage', id: 'padding', text: pad('', LINE + 64), phase: 'final_answer' }] } } };
    // M20a (C52): the turn's first command, one named thing changed.
    if (item?.type === 'commandExecution' && firstCommand(frame)) {
      if (typeof control.generatedImage === 'string') return { ...frame, params: { ...params, item: { type: 'imageGeneration', id: item.id, status: frame.method === 'item/completed' ? 'completed' : 'inProgress', result: frame.method === 'item/completed' ? control.generatedImage : '' } } };
      if (control.itemUnknown) return { ...frame, params: { ...params, item: { ...item, type: 'aLaterItemType' } } };
      if (frame.method === 'item/completed' && control.quotedOutput) return { ...frame, params: { ...params, item: { ...item, aggregatedOutput: quoted(String(item.aggregatedOutput ?? ''), 2 * MIB + 64) } } };
      if (frame.method === 'item/completed' && long === 'toolOutput') return { ...frame, params: { ...params, item: { ...item, aggregatedOutput: `${String(item.aggregatedOutput ?? '')}${'x'.repeat(OUTPUT_BOUND)}THE END` } } };
    }
    if (item?.type === 'agentMessage' && frame.method === 'item/completed' && params.threadId === turn?.threadId) {
      if (long === 'answer' && item.phase === 'final_answer') return { ...frame, params: { ...params, item: { ...item, text: pad(item.text, 100_001) } } };
      if (long === 'commentary' && item.phase === 'commentary') return { ...frame, params: { ...params, item: { ...item, text: pad(item.text, 2_050) } } };
      if (long === 'question' && Array.isArray(item.questions) && item.questions.length > 0) {
        const [first] = item.questions;
        const options = Array.from({ length: 9 }, (_, i) => first.options[i] ?? `${first.options[0]} ${i + 1}`);
        return { ...frame, params: { ...params, item: { ...item, questions: Array.from({ length: 17 }, (_, i) => ({ title: i === 0 ? pad(first.title, 501) : first.title, options })) } } };
      }
      // M21 (C51): the message that asks, one named thing changed.
      if (Array.isArray(item.questions) && item.questions.length > 0) {
        if (control.longAsyncAnswer) return { ...frame, params: { ...params, item: { ...item, questions: Array.from({ length: 16 }, () => item.questions[0]) } } };
        // In place of its completing frame, one delta with its text: the message stays open, and partial.
        if (control.historyPartialQuestion && !optedOut.has(MESSAGE_DELTA)) return { method: MESSAGE_DELTA, params: { threadId: params.threadId, turnId: params.turnId, itemId: item.id, delta: item.text } };
      }
    }
    // M19 (C56): the session's own answer, one named thing changed as it is sent.
    if (frame.method === MESSAGE_DELTA && params.threadId === turn?.threadId) {
      if (control.deltaOtherThread) return { ...frame, params: { ...params, threadId: randomUUID() } };
      if (control.deltaOtherTurn) return { ...frame, params: { ...params, turnId: randomUUID() } };
      if (control.deltasPastBound && turn.answers_.has(params.itemId)) return { ...frame, params: { ...params, delta: pad(String(params.delta ?? ''), PADDED_DELTA) } };
      if (typeof givenAnswer(control) === 'string' && turn.answers_.has(params.itemId)) return { ...frame, params: { ...params, delta: givenAnswer(control) } };
    }
    if (item?.type === 'agentMessage' && frame.method === 'item/completed' && params.threadId === turn?.threadId && item.phase === 'final_answer' && typeof givenAnswer(control) === 'string') {
      return { ...frame, params: { ...params, item: { ...item, text: givenAnswer(control) } } };
    }
    if (item?.type === 'agentMessage' && frame.method === 'item/completed' && params.threadId === turn?.threadId && item.phase === 'final_answer' && control.wholeDiffers) {
      return { ...frame, params: { ...params, item: { ...item, text: `${item.text} (as completed)` } } };
    }
    // M22b (C59, C61): the session's plan, one named thing changed as it is sent.
    if (frame.method === PLAN_DELTA && params.threadId === turn?.threadId && !turn.planDeltas.has(params.itemId)) {
      turn.planDeltas.set(params.itemId, String(params.delta ?? '').length);
      if (control.planLarge) return { ...frame, params: { ...params, delta: `${String(params.delta ?? '')}${planPadding(MIB)}` } };
    }
    if (item?.type === 'plan' && frame.method === 'item/completed' && params.threadId === turn?.threadId) {
      const text = String(item.text ?? '');
      const first = turn.planDeltas.get(item.id) ?? 0;
      if (control.planLarge) return { ...frame, params: { ...params, item: { ...item, text: `${text.slice(0, first)}${planPadding(MIB)}${text.slice(first)}` } } };
      if (control.planOverLine) return { ...frame, params: { ...params, item: { ...item, text: `${text}${planPadding(LINE + 64)}` } } };
      if (control.planWholeDiffers) return { ...frame, params: { ...params, item: { ...item, text: `${text} (as completed)` } } };
    }
    if (frame.method === 'turn/completed' && params.threadId !== turn?.threadId && control.workerTurnFailed && WORKER_TURNS.has(turn?.entry.name)) return { ...frame, params: { ...params, turn: { ...params.turn, status: 'failed' } } };
    // M22: a `fileChange` item, one named thing changed on both of its frames.
    if (item?.type === 'fileChange' && Array.isArray(item.changes) && item.changes.length > 0 && (frame.method === 'item/started' || frame.method === 'item/completed')) {
      const [first] = item.changes;
      if (control.changesTwentyOne) return { ...frame, params: { ...params, item: { ...item, changes: Array.from({ length: 21 }, (_, n) => (n === 0 ? first : { ...first, path: `${first.path}.${n}` })) } } };
      if (control.changeOverBound) return { ...frame, params: { ...params, item: { ...item, changes: [{ ...first, diff: pad(String(first.diff ?? ''), CHANGE_BOUND + 1) }, ...item.changes.slice(1)] } } };
    }
    return frame;
  }

  /** A request for leave, one named thing changed (M22, C35). */
  function approvalWithFaults(frame, control) {
    const params = frame.params;
    const ofFile = frame.method === FILE_APPROVAL;
    if (control.approvalWorker) return { ...frame, params: { ...params, threadId: randomUUID() } };
    if (control.fileChangeUnheld && ofFile) return { ...frame, params: { ...params, itemId: randomUUID() } };
    if (control.grantRootNamed && ofFile) return { ...frame, params: { ...params, grantRoot: thread(turn.threadId)?.cwd ?? 'root' } };
    if (control.commandForSession && !ofFile) return { ...frame, params: { ...params, availableDecisions: ['accept', 'acceptForSession', ...(params.availableDecisions ?? []).filter((decision) => decision !== 'accept')] } };
    // Past a session's line limit: a reason no request of the captures has, of spaces.
    if (control.requestOverLine || control.requestOverLineNoId) return { ...frame, params: { ...params, reason: pad('', LINE + 64) } };
    return frame;
  }
  /** The same request with another payload (`approvalChanged`): another command, or a reason a file change's did not have. */
  const changedRequest = (frame) => (frame.method === FILE_APPROVAL ? { ...frame, params: { ...frame.params, reason: 'changed' } } : { ...frame, params: { ...frame.params, command: `${frame.params.command} --changed` } });

  /** The item's end as the reply left it, where the capture's own reply left it otherwise (M22): the item as it started, declined; or completed, a command's with exit code 0. */
  function endedAs(frame, status) {
    const item = frame.params.item;
    if (item.status === status) return frame;
    const started = turn.items.get(item.id) ?? item;
    if (status === 'declined') return { ...frame, params: { ...frame.params, item: { ...started, status } } };
    return { ...frame, params: { ...frame.params, item: { ...item, status, ...(item.type === 'commandExecution' ? { exitCode: 0, durationMs: 0 } : {}) } } };
  }

  /**
   * An accepted change, made (M22, C35): in the thread's project folder alone, and only where its
   * target is a bare file name there. A `fileChange` item's files, each by its kind; or the one
   * file an `echo … > file` command writes. `forSession`: its files are granted for this process.
   */
  function makeChange(threadId, item, forSession) {
    const cwd = thread(threadId)?.cwd;
    const made = [];
    const inside = (target) => {
      if (typeof cwd !== 'string' || cwd === '' || typeof target !== 'string') return null;
      const rest = target.startsWith(`${cwd}\\`) || target.startsWith(`${cwd}/`) ? target.slice(cwd.length + 1) : target;
      return /^[\w.-]+$/.test(rest) && rest !== '.' && rest !== '..' ? rest : null;
    };
    if (item.type === 'fileChange') {
      for (const change of item.changes ?? []) {
        if (forSession) grants.add(change.path);
        const name = inside(change.path);
        if (name === null) continue;
        const kind = change.kind?.type ?? change.kind;
        const target = path.join(cwd, name);
        try {
          if (kind === 'delete') rmSync(target, { force: true });
          else if (kind === 'update') { let before = ''; try { before = readFileSync(target, 'utf8'); } catch { /* none yet */ } writeFileSync(target, patched(before, String(change.diff ?? ''))); }
          else writeFileSync(target, String(change.diff ?? ''));
          made.push({ file: name, kind });
        } catch { /* the folder is gone */ }
      }
    } else if (item.type === 'commandExecution') {
      const found = /^echo (\S+) > (.+)$/.exec(String(item.commandActions?.[0]?.command ?? ''));
      const name = found === null ? null : inside(found[2]);
      if (name !== null) { try { writeFileSync(path.join(cwd, name), `${found[1]}\n`); made.push({ file: name, kind: 'command' }); } catch { /* the folder is gone */ } }
    }
    if (made.length > 0) updateThread(threadId, (t) => ({ ...t, changes: [...(t.changes ?? []), ...made] }));
  }

  /** The question's request, one named thing changed (M21, C51). */
  function askedWithFaults(frame, control) {
    const params = frame.params;
    const [first] = params.questions;
    const asking = (questions) => ({ ...frame, params: { ...params, questions } });
    if (control.questionWorker) return { ...frame, params: { ...params, threadId: randomUUID() } };
    if (control.questionsTwenty) return asking(Array.from({ length: 20 }, (_, i) => ({ ...first, id: `${first.id}_${i + 1}` })));
    if (control.optionsNineNoOther) return asking([{ ...first, isOther: false, options: Array.from({ length: 9 }, (_, i) => first.options[i] ?? { ...first.options[0], label: `${first.options[0].label} ${i + 1}` }) }]);
    if (control.optionsOnly) return asking([{ ...first, isOther: false }]);
    if (control.noOptionsNoOther) return asking([{ ...first, isOther: false, options: [] }]);
    if (control.questionSecret) return asking([{ ...first, isSecret: true }]);
    return frame;
  }

  /** Frames a control withholds from the turn being replayed. */
  function withheld(frame) {
    const params = frame.params ?? {};
    const control = readControl();
    const session = params.threadId === turn?.threadId;
    if (control.turnNeverEnds && session && (frame.method === 'turn/completed' || (frame.method === 'thread/status/changed' && params.status?.type !== 'active'))) return true;
    // M21 (C51): Codex's word for a request that was not sent in its place.
    if (session && turn.late !== null && frame.method === REQUEST_RESOLVED) return true;
    // M19 (C56): the answer's completing frame, or its deltas, withheld.
    if (session && control.noCompletion && frame.method === 'item/completed' && params.item?.type === 'agentMessage' && params.item.phase === 'final_answer') return true;
    if (session && control.noDeltas && frame.method === MESSAGE_DELTA && turn.answers_.has(params.itemId)) return true;
    // M20a (C52): the first command's completion never comes.
    if (control.noItemCompletion && frame.method === 'item/completed' && firstCommand(frame)) return true;
    // A given answer is told by its first delta alone.
    if (session && typeof givenAnswer(control) === 'string' && frame.method === MESSAGE_DELTA && turn.answers_.has(params.itemId)) {
      if (turn.answerGiven) return true;
      turn.answerGiven = true;
    }
    if (!WORKER_TURNS.has(turn?.entry.name)) return false;
    if (control.workerNoClose && params.item?.type === 'subAgentActivity' && ['completed', 'interrupted'].includes(params.item.kind)) return true;
    if (control.workerNoTurnEnd && !session && frame.method === 'turn/completed') return true;
    return false;
  }

  // ── A turn ────────────────────────────────────────────────────────────────────────────────
  function write(frames) {
    if (frames.length === 0) return;
    output(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(''));
  }

  function afterFrame(frame) {
    const params = frame.params ?? {};
    if (frame.method === 'turn/started' && params.threadId === turn.threadId) {
      turn.active = true;
      // Codex keeps a thread from its first turn's start, and no sooner (as traced).
      updateThread(turn.threadId, (t) => ({ ...t, kept: true, turns: [...t.turns, turn.entry.label] }));
      if (takeControl('approvalRequest')) injectApproval();
    }
    if (frame.method === 'turn/completed' && params.threadId === turn.threadId) {
      turn.active = false;
      if (turn.workers.size > 0 && takeControl('exitAfterTurnWithWorker')) process.exit(3);
      // The request that was held back comes now, after its turn's end (M21, C51).
      if (turn.late !== null && !turn.late.sent) { turn.late.sent = true; write([turn.late.request]); }
    }
    if (frame.method === 'turn/started' && params.threadId !== turn.threadId) turn.workers.add(params.threadId);
    if (frame.method === 'turn/completed' && params.threadId !== turn.threadId) turn.workers.delete(params.threadId);
  }

  /**
   * What the delta controls need to know of a frame before it is sent (M19, C56): which of the
   * session's items is its final answer, and that answer's deltas as they go out.
   */
  function noteMessage(frame) {
    const params = frame.params ?? {};
    if (params.threadId !== turn.threadId) return;
    if (frame.method === 'item/started' && params.item?.type === 'agentMessage' && params.item.phase === 'final_answer' && typeof params.item.id === 'string') turn.answers_.add(params.item.id);
  }

  /** The frames that follow `frame` because a control says so: the answer's last delta, again, after its completing frame (M19, C56). */
  function following(frame) {
    const params = frame.params ?? {};
    if (frame.method === MESSAGE_DELTA && params.threadId === turn.threadId && turn.answers_.has(params.itemId)) { turn.lastDelta = frame; return []; }
    if (frame.method !== 'item/completed' || params.threadId !== turn.threadId || params.item?.type !== 'agentMessage' || !turn.answers_.has(params.item.id)) return [];
    return turn.lastDelta !== null && readControl().deltaAfterComplete ? [turn.lastDelta] : [];
  }

  /**
   * Whether the process ends once this frame is out. Asked before the frame is written: a test that
   * sets the control on seeing a frame must not have it taken by the process that sent that frame.
   */
  function exitsAfter(frame) {
    const params = frame.params ?? {};
    if (frame.method !== 'item/started' || params.threadId !== turn.threadId) return false;
    if (params.item?.type === 'subAgentActivity' && params.item.kind === 'started' && takeControl('exitWithWorker')) return true;
    return params.item?.type !== 'userMessage' && takeControl('exitDuringTurn');
  }

  /** Whether the process ends once this delta is out (M19, C56): after the answer's second, so between two of them. */
  function exitsBetweenDeltas(frame) {
    const params = frame.params ?? {};
    // And after the plan's second (M22b, C59): the process lost while it writes.
    if (frame.method === PLAN_DELTA && params.threadId === turn.threadId) { turn.planDeltaCount += 1; return turn.planDeltaCount === 2 && takeControl('exitWhilePlanning'); }
    if (frame.method !== MESSAGE_DELTA || params.threadId !== turn.threadId || !turn.answers_.has(params.itemId)) return false;
    turn.answerDeltas += 1;
    // A review's process lost after its answer's first text delta (M22e, C42).
    if (turn.answerDeltas === 1 && turn.reviewLost) return true;
    return turn.answerDeltas === 2 && takeControl('exitBetweenDeltas');
  }

  /** T7's approval request, then its `serverRequest/resolved` once fat-g has answered. */
  function injectApproval() {
    const entry = capture(APPROVAL);
    const request = entry.frames.find((f) => f.dir === 'recv' && f.frame.method === 'item/commandExecution/requestApproval');
    const resolved = entry.frames.find((f) => f.dir === 'recv' && f.frame.method === 'serverRequest/resolved');
    const turnAlias = request.frame.params.turnId;
    const subst = substituter(entry, turn.threadId, { [turnAlias]: turn.id });
    turn.pendingRequest = { id: request.frame.id, then: () => write([subst.frame(resolved.frame)]) };
    write([subst.frame(request.frame)]);
  }

  /**
   * The question's request (M21, C50): sent as its capture has it, and the turn held at it, as the
   * CLI's was, until fat-g replies. What follows the reply is the capture's own: Codex's word for
   * the request, and the rest of the turn. Each control changes one named thing of it (C51).
   */
  function ask(step) {
    const asking = turn;
    turn.timer = setTimeout(() => {
      if (turn !== asking || turn.cancelled) return;
      turn.next++;
      const control = readControl();
      let request = askedWithFaults({ ...turn.subst.frame(step.frame), id: numbered(step.frame.id) }, control);
      // Held back until the turn has ended: the turn goes on without it.
      if (control.questionLate) { turn.late = { request, sent: false }; play(); return; }
      // Asked before the request is written, as an exit during a turn is: a test that sets one on
      // seeing the request must not have it taken by this write.
      const exits = takeControl('exitWhileAsking');
      const cutOff = !exits && takeControl('exitAtAnswer');
      // An answer that chooses the first option is then a line longer than a pipe holds: still being
      // written when its first bytes arrive, which is when the process ends.
      if (cutOff) request = { ...request, params: { ...request.params, questions: request.params.questions.map((question, at) => (at !== 0 ? question : { ...question, options: question.options.map((option, place) => (place !== 0 ? option : { ...option, label: pad(option.label, LONG_LABEL) })) })) } };
      write(control.questionTwice ? [request, request] : [request]);
      if (exits) process.exit(3);
      if (cutOff) endAtInput();
      // Taken back: Codex's word follows at once, and no reply is waited for.
      if (control.questionResolvedEarly) { play(); return; }
      turn.pendingRequest = {
        id: request.id,
        question: true,
        then: (reply) => {
          // Noted with its thread, for a test to hold fat-g's reply to the capture's.
          updateThread(asking.threadId, (t) => ({ ...t, replies: [...(t.replies ?? []), 'error' in reply ? { id: reply.id, error: reply.error } : { id: reply.id, result: reply.result }] }));
          // Set once the request was out: the process is lost as the answer arrives, before Codex's word for it.
          if (takeControl('exitWhileAsking')) process.exit(3);
          // A plan turn's question goes on as K2's did after the reply it was given (M22b, C53).
          const tail = asking.planning && asking.entry.name === QUESTION_PLAN ? replyTail(asking, reply, request.id) : null;
          if (tail !== null) asking.steps.splice(asking.next, Infinity, ...tail);
          play();
        },
      };
    }, turn.oneChunk ? 0 : Math.min(gap, step.gap));
  }

  /**
   * What M21's plan turn goes on with after a reply that is no answer (M22b, C53): K2's `skip` after
   * "No answer" under each id, its `empty` after an empty list — each capture's frames on its session
   * after its reply, to its turn's end, under this turn's ids, Codex's word naming this request. Null
   * for any other reply: the turn goes on as M21's did.
   */
  function replyTail(playing, reply, requestId) {
    const answers = reply.result?.answers;
    if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) return null;
    const given = Object.values(answers);
    const skipped = given.length > 0 && given.every((answer) => Array.isArray(answer?.answers) && answer.answers.length === 1 && answer.answers[0] === 'No answer');
    const name = given.length === 0 ? EMPTIED : skipped ? SKIPPED : null;
    if (name === null) return null;
    const data = file(name);
    const request = data.frames.find((f) => f.dir === 'recv' && f.frame.method === QUESTION_REQUEST);
    const replied = data.frames.find((f) => f.dir === 'send' && f.index > request.index && f.frame.method === undefined && f.frame.id === request.frame.id);
    const session = request.frame.params.threadId;
    const subst = substituter({ name, frames: data.frames, date: Date.parse(data.date), session, kept: null }, playing.threadId, { [request.frame.params.turnId]: playing.id }, true);
    const steps = [];
    let previous = replied.ms;
    for (const f of data.frames) {
      if (f.index <= replied.index || f.dir !== 'recv' || f.frame.params?.threadId !== session) continue;
      const frame = subst.frame(f.frame);
      steps.push({ kind: 'frame', frame: frame.method === REQUEST_RESOLVED ? { ...frame, params: { ...frame.params, requestId } } : frame, raw: true, gap: Math.max(0, f.ms - previous) });
      previous = f.ms;
      if (f.frame.method === 'turn/completed') break;
    }
    return steps;
  }

  /** The process's next request id, noted against the capture's own for that request: Codex's word for it names it by the same. */
  function numbered(captured) {
    const id = nextRequest++;
    turn.requests.set(captured, id);
    return id;
  }

  /**
   * A request for leave (M22, C35): sent as its capture has it, under the process's next id, and
   * the turn held at it, as the CLI's was, until fat-g replies. The reply decides how the item
   * ends, and whether the fake makes the change. Each control changes one named thing of it.
   */
  function approve(step) {
    const asking = turn;
    turn.timer = setTimeout(() => {
      if (turn !== asking || turn.cancelled) return;
      turn.next++;
      const control = readControl();
      const base = { ...(step.raw ? step.frame : turn.subst.frame(step.frame)), id: numbered(step.frame.id) };
      // The item it is for, whatever a control makes the request name.
      const itemId = base.params?.itemId;
      const request = approvalWithFaults(base, control);
      // Held back until the turn has ended: the turn goes on without it.
      if (control.approvalLate) { turn.late = { request, sent: false }; play(); return; }
      // Asked before the request is written, as an exit during a turn is.
      const exits = takeControl('exitWhileApproving');
      const cutOff = !exits && takeControl('exitAtDecision');
      const lines = control.approvalTwice ? [request, request] : control.approvalChanged ? [request, changedRequest(request)] : [request];
      // Its id after its parameters: past what is read of a line over the limit.
      if (control.requestOverLineNoId) output(lines.map((line) => `${JSON.stringify({ method: line.method, params: line.params, id: line.id })}\n`).join(''));
      else write(lines);
      if (exits) process.exit(3);
      // The process ends as the first bytes of the decision arrive, before any line of it is read.
      if (cutOff) endAtInput();
      // Taken back: Codex's word follows at once, and no reply is waited for.
      if (control.approvalResolvedEarly) { play(); return; }
      turn.pendingRequest = {
        id: request.id,
        approval: true,
        then: (reply) => {
          // Noted with its thread, for a test to hold fat-g's reply to the capture's.
          updateThread(asking.threadId, (t) => ({ ...t, replies: [...(t.replies ?? []), 'error' in reply ? { id: reply.id, error: reply.error } : { id: reply.id, result: reply.result }] }));
          // Set once the request was out: the process is lost as the decision arrives, before Codex's word for it.
          if (takeControl('exitWhileApproving')) process.exit(3);
          const decision = reply.result?.decision;
          const accepted = decision === 'accept' || decision === 'acceptForSession';
          const item = asking.items.get(itemId);
          if (accepted && item !== undefined) makeChange(asking.threadId, item, decision === 'acceptForSession');
          // Anything but an acceptance — a decline, an error — leaves the item declined.
          asking.outcomes.set(itemId, accepted ? 'completed' : 'declined');
          play();
        },
      };
    }, turn.oneChunk ? 0 : Math.min(gap, step.gap));
  }

  /**
   * An MCP elicitation of the Codex MCP spike's turns (decision 0018): sent as it came, and held for
   * fat-g's reply, which is noted with its thread; the capture's own frames follow whatever it is,
   * Codex's end of the call among them. One the capture left unanswered — K1's `stop` — is not waited
   * for: the replay goes on to the capture's own interrupt, and a reply that comes is still noted.
   */
  function elicit(step) {
    const asking = turn;
    turn.timer = setTimeout(() => {
      if (turn !== asking || turn.cancelled) return;
      turn.next++;
      const request = { ...turn.subst.frame(step.frame), id: numbered(step.frame.id) };
      write([request]);
      turn.pendingRequest = {
        id: request.id,
        approval: true,
        then: (reply) => {
          updateThread(asking.threadId, (t) => ({ ...t, replies: [...(t.replies ?? []), 'error' in reply ? { id: reply.id, error: reply.error } : { id: reply.id, result: reply.result }] }));
          if (!step.held) play();
        },
      };
      if (step.held) play();
    }, turn.oneChunk ? 0 : Math.min(gap, step.gap));
  }

  /** Plays the steps from `turn.next` on: frames with their gaps, a wait wherever the capture shows fat-g sending. */
  function play() {
    if (turn === null || turn.cancelled) return;
    const step = turn.steps[turn.next];
    if (step === undefined) return;
    if (step.kind === 'await') {
      // The request may have come before the replay got here (a Stop pressed early): go on at once.
      const early = turn.early.findIndex((request) => request.method === step.method);
      if (early === -1) { turn.waiting = step; return; }
      const [request] = turn.early.splice(early, 1);
      turn.answers.set(step.id, request.id);
      turn.next++;
      play();
      return;
    }
    if (step.kind === 'ask') { ask(step); return; }
    if (step.kind === 'approve') { approve(step); return; }
    if (step.kind === 'elicit') { elicit(step); return; }
    const batch = [];
    const wait = turn.oneChunk ? 0 : Math.min(gap, step.gap);
    turn.timer = setTimeout(() => {
      if (turn === null || turn.cancelled) return;
      for (;;) {
        const current = turn.steps[turn.next];
        if (current === undefined || current.kind !== 'frame') break;
        turn.next++;
        // A frame of another capture, put in among this turn's, was given its ids as it was put in (M22).
        let frame = current.raw ? current.frame : turn.subst.frame(current.frame);
        // A notification the handshake opted out of is never sent (C54).
        if (frame.method !== undefined && optedOut.has(frame.method)) continue;
        noteMessage(frame);
        if (withheld(frame)) continue;
        if (frame.id !== undefined && frame.method === undefined) frame = { ...frame, id: turn.answers.get(current.frame.id) ?? frame.id };
        // Codex's word for a request names it by the id this process gave it (M22).
        if (frame.method === REQUEST_RESOLVED && turn.requests.has(current.frame.params?.requestId)) frame = { ...frame, params: { ...frame.params, requestId: turn.requests.get(current.frame.params.requestId) } };
        // An item a request for leave may name, as it started; and its end, as the reply left it (M22).
        if (frame.method === 'item/started' && typeof frame.params?.item?.id === 'string') turn.items.set(frame.params.item.id, frame.params.item);
        if (frame.method === 'item/completed' && turn.outcomes.has(frame.params?.item?.id)) frame = endedAs(frame, turn.outcomes.get(frame.params.item.id));
        // A change to files granted for the session runs with no request (K1): made as an accepted one is.
        else if (frame.method === 'item/completed' && frame.params?.item?.type === 'fileChange' && frame.params.item.status === 'completed' && grants.size > 0 && (frame.params.item.changes ?? []).every((change) => grants.has(change.path))) makeChange(turn.threadId, frame.params.item, false);
        const repeated = following(frame);
        batch.push(withFaults(frame), ...repeated);
        // One chunk: everything up to the next wait goes out in one write (C110).
        if (!turn.oneChunk) break;
      }
      const exit = batch.findIndex((frame) => exitsAfter(frame) || exitsBetweenDeltas(frame));
      write(batch);
      for (const [index, frame] of batch.entries()) {
        if (turn === null) return;
        afterFrame(frame);
        if (index === exit) process.exit(3);
      }
      play();
    }, wait);
  }

  function startTurn(message) {
    const { threadId, input, clientUserMessageId } = message.params ?? {};
    // The mode it names stays with its thread (M22b, C55): one that names none runs in the mode its thread was left in.
    const mode = message.params?.collaborationMode?.mode ?? null;
    const known = thread(threadId);
    const planning = mode === 'plan' || (mode === null && known?.collaboration === 'plan');
    updateThread(threadId, (t) => ({ ...t, ...(mode === null ? {} : { collaboration: mode }), collaborations: [...(t.collaborations ?? []), message.params?.collaborationMode ?? null] }));
    const text = input?.[0]?.text ?? '';
    // A review's turns (M22e, C42, C49): by the prompt's own words, and by what came before on its thread.
    const review = reviewTurnFor(threadId, text);
    const entry = review?.entry ?? planCaptureFor(text, mode, policyKey(known?.opens?.at(-1)), planning) ?? captureForPrompt(text, !optedOut.has(MESSAGE_DELTA), readControl().planTool === true);
    const fixed = entry.client && typeof clientUserMessageId === 'string' ? { [entry.client]: clientUserMessageId } : {};
    // A family capture played a second time on one thread gets ids of its own: only its first turn is the history's.
    const fresh = (thread(threadId)?.turns ?? []).includes(entry.label);
    // The history is that first turn's too: the id its prompt was sent with is kept with the thread,
    // as the CLI keeps it (the captures show the same id sent, echoed and read back).
    if (entry.family === 'family' && !fresh && fixed[entry.client] !== undefined) updateThread(threadId, (t) => ({ ...t, aliases: { ...t.aliases, [`family:${entry.client}`]: clientUserMessageId } }));
    if (QUESTION_CAPTURES.includes(entry.name)) {
      // A turn of K2's carries the ids K2's history holds for it (M21, C50), kept with the thread, its
      // prompt's the one it was sent with: what fat-g ran is then a turn the history knows.
      const pairs = fresh ? null : historyAliases(entry);
      if (pairs !== null) {
        const ids = keptIds(threadId, 'm21', [...pairs].map(([alias, historyAlias]) => [historyAlias, alias === entry.client ? fixed[alias] : undefined]));
        for (const [alias, historyAlias] of pairs) fixed[alias] = ids[historyAlias];
      }
    }
    // What it was started with, noted with its thread: an answer given from a card is a prompt as any; and a plan's turns (M22b).
    if (QUESTION_CAPTURES.includes(entry.name) || PLAN_CAPTURES.includes(entry.name)) updateThread(threadId, (t) => ({ ...t, starts: [...(t.starts ?? []), { capture: entry.label, text: input?.[0]?.text ?? null, model: message.params?.model ?? null, effort: message.params?.effort ?? null, mode }] }));
    // What it named of a policy, noted with its thread (M22): a turn names again what its thread's start reply reported, or nothing.
    const { approvalPolicy = null, sandboxPolicy = null, approvalsReviewer = null } = message.params ?? {};
    updateThread(threadId, (t) => ({ ...t, policies: [...(t.policies ?? []), { approvalPolicy, sandboxPolicy, approvalsReviewer }] }));
    const subst = substituter(entry, threadId, fixed, fresh);
    const reply = replyTo(entry, entry.start.frame.id, entry.start.index);
    const turnAlias = reply.frame.result?.turn?.id;
    const id = typeof turnAlias === 'string' ? subst.idFor(turnAlias) : randomUUID();
    const steps = [];
    let previous = entry.start.ms;
    // A side thread is no part of the session's turn (M20b, C21): where a capture shows a fork made
    // during its turn, the turn is replayed without the side thread's frames, which are sent when
    // fat-g forks and asks, whenever that is.
    const forks = FORK_TURN_CAPTURES.includes(entry.name) ? forksOf(entry.name) : null;
    for (const f of entry.frames) {
      if (f.index <= entry.start.index) continue;
      // A capture of two turns: this one ends where the next one's `turn/start` was sent (M21).
      if (f.index >= entry.until) break;
      if (forks !== null && forks.isChilds(f)) continue;
      if (f.dir === 'send') {
        if (f.frame.method !== undefined) steps.push({ kind: 'await', method: f.frame.method, id: f.frame.id });
        // fat-g's answer to a request of the CLI's (T7): nothing to wait for by method.
        continue;
      }
      // A question asked as a request is waited at for its reply, which the capture shows fat-g sending (M21, C50);
      // and so is a request for leave of K1's, K4's and K6's turns (M22, C35). T7's is sent as it always was.
      const approval = isApproval(f.frame.method) && (PERMISSION_CAPTURES.includes(entry.name) || PLAN_CAPTURES.includes(entry.name));
      // And an MCP elicitation of the Codex MCP spike's (decision 0018).
      const elicitation = f.frame.method === MCP_ELICITATION && MCP_CAPTURES.includes(entry.name);
      const held = elicitation && !entry.frames.some((r) => r.dir === 'send' && r.index > f.index && r.frame.method === undefined && r.frame.id === f.frame.id);
      steps.push({ kind: f.frame.method === QUESTION_REQUEST ? 'ask' : approval ? 'approve' : elicitation ? 'elicit' : 'frame', frame: f.frame, gap: Math.max(0, f.ms - previous), ...(approval ? { answered: answeredAs(entry, f) } : {}), ...(elicitation ? { held } : {}) });
      previous = f.ms;
    }
    // The turn K1 ran on a granted file, in a process that holds no such grant (M22): it asks, as K1's resumed process was asked.
    if (entry.label === GRANTED_TURN) askAgain(steps, entry, subst, threadId, id);
    // A review's answer, one named change made to its text (M22e, C42): sent as `answerText` sends one.
    const answerAs = review?.fault == null ? null : subst.frame({ text: faulted(review.fault, finalAnswerOf(entry)) }).text;
    turn = { entry, threadId, id, subst, steps, next: 0, answers: new Map([[entry.start.frame.id, message.id]]), early: [], waiting: null, active: false, cancelled: false, workers: new Set(), oneChunk: takeControl('oneChunk'), timer: null, pendingRequest: null, answers_: new Set(), lastDelta: null, answerDeltas: 0, late: null, requests: new Map(), items: new Map(), outcomes: new Map(), planning, planDeltas: new Map(), planDeltaCount: 0, answerAs, reviewLost: review?.lost === true };
    play();
  }

  /**
   * The turn a prompt of a review's plays (M22e, Design 9; C42, C49), or null for any other: the
   * review's K2 turn, or K1's under `review-v1`; Send notes, the next of K2's rounds on the thread;
   * the turn a card's answer starts after `review-asks`, the review; a plain prompt on a reviewed
   * thread under `review-plain-block`, the asking note's turn. `fault`: the named change its answer
   * takes, where one is asked for.
   */
  function reviewTurnFor(threadId, text) {
    const known = thread(threadId);
    const firstFault = () => FIRST_ANSWER_FAULTS.find((name) => takeControl(name)) ?? null;
    if (known?.reviewNext === true) {
      updateThread(threadId, (t) => ({ ...t, reviewNext: false, reviewed: true }));
      return { entry: capture(REVIEW_ROUNDS, 0), fault: firstFault(), lost: false };
    }
    if (isReviewPrompt(text)) {
      if (takeControl('review-asks')) { updateThread(threadId, (t) => ({ ...t, reviewNext: true })); return { entry: capture(ASKS_IN_MESSAGE, 0), fault: null, lost: false }; }
      updateThread(threadId, (t) => ({ ...t, reviewed: true }));
      return { entry: takeControl('review-v1') ? capture(REVIEW_V1, 0) : capture(REVIEW_ROUNDS, 0), fault: firstFault(), lost: takeControl('review-lost') };
    }
    if (isSendNotes(text)) {
      const sent = known?.notesSent ?? 0;
      updateThread(threadId, (t) => ({ ...t, notesSent: sent + 1 }));
      return { entry: capture(REVIEW_ROUNDS, Math.min(sent + 1, 3)), fault: LATER_ANSWER_FAULTS.find((name) => takeControl(name)) ?? null, lost: false };
    }
    if (isIntegration(text) && takeControl('integration-asks')) return { entry: capture(ASKS_IN_MESSAGE, 0), fault: null, lost: false };
    if (known?.reviewed === true && takeControl('review-plain-block')) return { entry: capture(REVIEW_ROUNDS, 2), fault: null, lost: false };
    return null;
  }

  /** A capture's turn's final answer, as captured: the text its last `final_answer` message completed with. */
  function finalAnswerOf(entry) {
    const done = entry.frames.filter((f) => f.dir === 'recv' && f.index > entry.start.index && f.index < entry.until && f.frame.method === 'item/completed' && f.frame.params?.item?.type === 'agentMessage' && f.frame.params.item.phase === 'final_answer');
    return String(done.at(-1)?.frame.params.item.text ?? '');
  }

  /**
   * Puts the request K1's resumed process got for the same file among a turn's steps, after its
   * `fileChange` item's start (M22): the thread's status while it waits, the request, Codex's word
   * for it and the status after — each a frame of that capture, under this turn's ids. Nothing is
   * put in where this process holds the session's grant for every file of the item.
   */
  function askAgain(steps, entry, subst, threadId, turnId) {
    const at = steps.findIndex((step) => step.kind === 'frame' && step.frame.method === 'item/started' && step.frame.params?.item?.type === 'fileChange');
    if (at === -1) return;
    const item = subst.frame(steps[at].frame).params.item;
    if ((item.changes ?? []).every((change) => grants.has(change.path))) return;
    const asked = capture(ASKED_AGAIN);
    const request = asked.frames.find((f) => f.dir === 'recv' && f.frame.method === FILE_APPROVAL);
    const { itemId, turnId: turnAlias } = request.frame.params;
    const started = asked.frames.find((f) => f.dir === 'recv' && f.frame.method === 'item/started' && f.frame.params?.item?.id === itemId);
    const completed = asked.frames.find((f) => f.dir === 'recv' && f.frame.method === 'item/completed' && f.frame.params?.item?.id === itemId);
    const other = substituter(asked, threadId, { [turnAlias]: turnId, [itemId]: item.id }, true);
    const between = asked.frames.filter((f) => f.dir === 'recv' && f.index > started.index && f.index < completed.index && f.frame.params?.threadId === asked.session);
    steps.splice(at + 1, 0, ...between.map((f) => ({ kind: isApproval(f.frame.method) ? 'approve' : 'frame', frame: other.frame(f.frame), raw: true, gap: 0, ...(isApproval(f.frame.method) ? { answered: answeredAs(asked, f) } : {}) })));
  }

  /**
   * The tail of T4 from its interrupt's reply on, for a turn whose capture shows no interrupt. For a
   * turn held at a question's request (M21, C50), the tail of the capture that traced that: the
   * stopped plan turn's, whose end is followed by Codex's word for the request.
   */
  function interruptTail(message) {
    clearTimeout(turn.timer);
    turn.cancelled = true;
    const asked = turn.pendingRequest?.question === true;
    // And for one held at a request for leave (M22): K1's stopped turn, which ends the same way.
    const approving = turn.pendingRequest?.approval === true;
    const pending = turn.pendingRequest?.id;
    // The request is never replied to (C27): what Codex says of it is in the tail.
    if (asked || approving) turn.pendingRequest = null;
    const entry = capture(asked ? PLAN_STOP : approving ? APPROVAL_STOP : INTERRUPT);
    const request = sent(entry, 'turn/interrupt');
    // That capture's next turn, where it has one, is no part of the tail.
    const until = entry.frames.find((f) => f.dir === 'send' && f.index > request.index && f.frame.method === 'turn/start')?.index ?? Infinity;
    const turnAlias = request.frame.params.turnId;
    const subst = substituter(entry, turn.threadId, { [turnAlias]: turn.id });
    const named = (frame) => (frame.method === REQUEST_RESOLVED && pending !== undefined ? { ...frame, params: { ...frame.params, requestId: pending } } : frame);
    const frames = entry.frames.filter((f) => f.dir === 'recv' && f.index > request.index && f.index < until && (f.frame.id === request.frame.id || f.frame.params?.threadId === entry.session))
      .map((f) => (f.frame.id === request.frame.id ? { ...subst.frame(f.frame), id: message.id } : named(subst.frame(f.frame))));
    turn.active = false;
    write(frames);
  }

  /** A worker's own interrupt, from the capture that traced one: its reply, then that turn's end. */
  function workerInterruptTail(message) {
    const entry = capture(WORKER_INTERRUPT);
    const request = sent(entry, 'turn/interrupt', 1);
    const { threadId: workerAlias, turnId: turnAlias } = request.frame.params;
    const subst = substituter(entry, turn.threadId, { [workerAlias]: message.params.threadId, [turnAlias]: message.params.turnId });
    const frames = entry.frames.filter((f) => f.dir === 'recv' && f.index > request.index && (f.frame.id === request.frame.id || (f.frame.params?.threadId === workerAlias && ['turn/completed', 'thread/status/changed'].includes(f.frame.method))))
      .map((f) => (f.frame.id === request.frame.id ? { ...subst.frame(f.frame), id: message.id } : subst.frame(f.frame)));
    turn.workers.delete(message.params.threadId);
    write(frames);
  }

  function refuseInterrupt(message) {
    const entry = capture(EARLY_STOP);
    const refusal = entry.frames.find((f) => f.dir === 'recv' && f.frame.error !== undefined);
    write([{ ...refusal.frame, id: message.id }]);
  }

  // ── An aside's side thread (M20b, C61, C62) ───────────────────────────────────────────────
  function threadFork(message) {
    const params = message.params ?? {};
    const parent = params.threadId;
    const known = typeof parent === 'string' ? thread(parent) : null;
    const refuse = () => {
      const refusals = capture(REFUSALS);
      const frame = replyTo(refusals, sent(refusals, 'thread/resume', 0).frame.id).frame;
      write([{ ...frame, id: message.id, error: { ...frame.error, message: frame.error.message.replace(ALIAS, String(parent)) } }]);
    };
    if (known === null) { refuse(); return; }
    // Noted with the thread it forks: every field it was sent, for a test to hold to the fields the app may send.
    updateThread(parent, (t) => ({ ...t, forks: [...(t.forks ?? []), params] }));
    if (readControl().hang === 'fork') return;
    if (takeControl('forkRefused')) { refuse(); return; }
    const { entry } = forksOf(FORK_REPLY);
    const request = sent(entry, 'thread/fork');
    const reply = replyTo(entry, request.frame.id, request.index);
    const childAlias = reply.frame.result.thread.id;
    const childId = randomUUID();
    const subst = substituter(entry, parent, { [childAlias]: childId }, true);
    let frame = { ...subst.frame(reply.frame), id: message.id };
    const other = readControl().forkOther;
    if (other === 'sandbox') frame = { ...frame, result: { ...frame.result, sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false } } };
    if (other === 'network') frame = { ...frame, result: { ...frame.result, sandbox: { ...frame.result.sandbox, networkAccess: true } } };
    if (other === 'policy') frame = { ...frame, result: { ...frame.result, approvalPolicy: 'on-request' } };
    if (readControl().oversize === 'forkReply') frame = { ...frame, result: { ...frame.result, padding: pad('', LINE + 64) } };
    children.set(childId, { parent, turn: null });
    const started = entry.frames.find((f) => f.dir === 'recv' && f.frame.method === 'thread/started' && f.frame.params?.thread?.id === childAlias);
    write([frame, ...(started === undefined || optedOut.has('thread/started') ? [] : [subst.frame(started.frame)])]);
  }

  /** Plays a side thread's turn from `playing.next` on: its own frames, with their gaps, beside whatever else this process plays. */
  function playChild(child, playing) {
    if (child.turn !== playing || !playing.active) return;
    const step = playing.steps[playing.next];
    // Its capture shows it interrupted there: it goes no further until it is.
    if (step === undefined) return;
    playing.timer = setTimeout(() => {
      if (child.turn !== playing || !playing.active) return;
      playing.next++;
      let frame = playing.subst.frame(step.frame);
      // A notification the handshake opted out of is never sent (C54).
      if (frame.method !== undefined && optedOut.has(frame.method)) { playChild(child, playing); return; }
      if (frame.method === undefined) frame = { ...frame, id: playing.requestId };
      if (frame.method === 'turn/completed') {
        playing.active = false;
        if (readControl().childTurnFailed) frame = { ...frame, params: { ...frame.params, turn: { ...frame.params.turn, status: 'failed' } } };
      }
      const exit = frame.method === 'turn/started' && takeControl('exitDuringAside');
      write([frame]);
      if (exit) process.exit(3);
      playChild(child, playing);
    }, Math.min(gap, step.gap));
  }

  function startChildTurn(message) {
    const params = message.params ?? {};
    const child = children.get(params.threadId);
    const text = params.input?.[0]?.text ?? '';
    const chosen = childTurnFor(text);
    updateThread(child.parent, (t) => ({ ...t, asides: [...(t.asides ?? []), { capture: chosen.entry.name, text, model: params.model ?? null, effort: params.effort ?? null, client: params.clientUserMessageId ?? null }] }));
    if (readControl().hang === 'childSend') return;
    const turnId = randomUUID();
    const fixed = { [chosen.child]: params.threadId, ...(typeof chosen.turnAlias === 'string' ? { [chosen.turnAlias]: turnId } : {}), ...(chosen.client && typeof params.clientUserMessageId === 'string' ? { [chosen.client]: params.clientUserMessageId } : {}) };
    const subst = substituter(chosen.entry, child.parent, fixed, true);
    let previous = chosen.start.ms;
    const steps = chosen.frames.map((f) => {
      const step = { frame: f.frame, gap: Math.max(0, f.ms - previous) };
      previous = f.ms;
      return step;
    });
    const playing = { turnId, subst, steps, next: 0, timer: null, active: true, requestId: message.id };
    child.turn = playing;
    playChild(child, playing);
  }

  /** An interrupt of a side thread's turn, from the capture that traced one: its reply, then that turn's interrupted end. */
  function childInterrupt(message) {
    const { threadId, turnId } = message.params ?? {};
    const child = children.get(threadId);
    const playing = child.turn;
    const active = playing !== null && playing.active && playing.turnId === turnId;
    updateThread(child.parent, (t) => ({ ...t, asideInterrupts: [...(t.asideInterrupts ?? []), { active, inputOpen: !closed }] }));
    if (readControl().hang === 'childStop') return;
    if (!active) { refuseInterrupt(message); return; }
    clearTimeout(playing.timer);
    playing.active = false;
    const { entry } = forksOf(CHILD_INTERRUPT);
    const request = sent(entry, 'turn/interrupt');
    const { threadId: childAlias, turnId: turnAlias } = request.frame.params;
    const subst = substituter(entry, child.parent, { [childAlias]: threadId, [turnAlias]: turnId }, true);
    const frames = entry.frames.filter((f) => f.dir === 'recv' && f.index > request.index && ((f.frame.method === undefined && f.frame.id === request.frame.id) || (f.frame.params?.threadId === childAlias && ['turn/completed', 'thread/status/changed'].includes(f.frame.method))))
      .map((f) => (f.frame.method === undefined ? { ...subst.frame(f.frame), id: message.id } : subst.frame(f.frame)));
    write(frames);
  }

  /**
   * A message into the running turn (M23, C36, C39): where the capture shows it sent, the replay waits
   * for it and goes on from there, its reply naming the turn; with no step to await, the running turn's
   * id is taken and any other is refused as K1's steer after the turn's end was. Noted with its thread.
   */
  function steer(message) {
    const { threadId, expectedTurnId, input } = message.params ?? {};
    updateThread(threadId, (t) => ({ ...t, steers: [...(t.steers ?? []), { expectedTurnId: expectedTurnId ?? null, input: Array.isArray(input) ? input.map((item) => item?.type ?? null) : null }] }));
    if (turn !== null && !turn.cancelled && turn.threadId === threadId) {
      if (turn.waiting?.method === 'turn/steer') {
        turn.answers.set(turn.waiting.id, message.id);
        turn.waiting = null;
        turn.next++;
        play();
        return;
      }
      if (turn.steps.slice(turn.next).some((step) => step.kind === 'await' && step.method === 'turn/steer')) { turn.early.push({ method: 'turn/steer', id: message.id }); return; }
      if (turn.active && expectedTurnId === turn.id) { write([{ id: message.id, result: { turnId: turn.id } }]); return; }
    }
    write([{ id: message.id, error: { code: -32600, message: 'no active turn to steer' } }]);
  }

  /** A folder's skills (M23, C63): K1's reply, its `<scratch>` the folder asked of, under this request's id. */
  function skillsList(message) {
    const folder = message.params?.cwds?.[0];
    const entry = file(SKILLS_CAPTURE);
    const request = entry.frames.find((f) => f.dir === 'send' && f.frame.method === 'skills/list');
    const reply = entry.frames.find((f) => f.dir === 'recv' && f.index > request.index && f.frame.id === request.frame.id && f.frame.method === undefined);
    const text = typeof folder === 'string' ? JSON.stringify(reply.frame.result).replaceAll('<scratch>', JSON.stringify(folder).slice(1, -1)) : JSON.stringify(reply.frame.result);
    write([{ id: message.id, result: JSON.parse(text) }]);
  }

  function interrupt(message) {
    const { threadId } = message.params ?? {};
    if (children.has(threadId)) { childInterrupt(message); return; }
    // Noted with its thread: that it arrived, and that this process's input was still open (V40).
    updateThread(turn?.threadId ?? threadId, (t) => ({ ...t, interrupts: [...t.interrupts, { inputOpen: !closed, worker: turn !== null && threadId !== turn.threadId }] }));
    if (readControl().hang === 'stop') return;
    if (readControl().refuseInterrupt) { refuseInterrupt(message); return; }
    if (turn !== null && !turn.cancelled) {
      // Where the capture shows this request, the replay waits for it and goes on from there.
      if (turn.waiting?.method === 'turn/interrupt') {
        // The traced refusal: an interrupt before the turn has started is one of these captures' own.
        turn.answers.set(turn.waiting.id, message.id);
        turn.waiting = null;
        turn.next++;
        play();
        return;
      }
      if (turn.steps.slice(turn.next).some((step) => step.kind === 'await' && step.method === 'turn/interrupt')) { turn.early.push({ method: 'turn/interrupt', id: message.id }); return; }
      if (threadId === turn.threadId && turn.active) { interruptTail(message); return; }
      if (threadId !== turn.threadId && turn.workers.has(threadId)) { workerInterruptTail(message); return; }
    } else if (turn !== null && threadId !== turn.threadId && turn.workers.has(threadId)) { workerInterruptTail(message); return; }
    refuseInterrupt(message);
  }

  // ── Start, resume, history ────────────────────────────────────────────────────────────────
  function startDescendant() {
    const mode = env.FATG_SMOKE_CODEX_DESCENDANT;
    if (!mode || descendantStarted) return;
    descendantStarted = true;
    const stdio = mode === 'hold' ? ['ignore', 'inherit', 'inherit'] : mode === 'ignore' ? 'ignore' : ['pipe', 'ignore', 'ignore'];
    // `ignore` and `hold` outlive the fake, so they are detached: on Windows a child otherwise goes
    // with its parent's job, and on POSIX with its parent's group.
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'descendant', mode], { stdio, windowsHide: true, detached: mode !== '1', env });
    if (mode !== '1') child.unref();
  }

  function startReply(entry, request, message, threadId) {
    const subst = substituter(entry, threadId);
    let frame = { ...subst.frame(replyTo(entry, request.frame.id, request.index).frame), id: message.id };
    // M22: the sandbox, the policy and the reviewer that were named, as a capture reports them for
    // an account in this sandbox state. A read-only start is reported as it always was.
    const named = message.params ?? {};
    const reportedAs = typeof named.sandbox === 'string' && typeof named.approvalPolicy === 'string' ? reportedPolicies(sandboxState()).get(`${named.sandbox}|${named.approvalPolicy}|${named.approvalsReviewer ?? ''}`) : undefined;
    if (reportedAs !== undefined) frame = { ...frame, result: { ...frame.result, ...reportedAs } };
    const other = readControl().otherSandbox;
    if (other === 'sandbox') frame = { ...frame, result: { ...frame.result, sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false } } };
    if (other === 'network') frame = { ...frame, result: { ...frame.result, sandbox: { ...frame.result.sandbox, networkAccess: true } } };
    if (other === 'policy') frame = { ...frame, result: { ...frame.result, approvalPolicy: 'on-request' } };
    // Another one than was named, whatever was named — on a session's thread alone: the secretary's
    // ephemeral one (M26), started beside a first prompt, never takes a fault meant for the session's.
    const session = named.ephemeral !== true;
    if (session && flagged('startOtherPolicy')) frame = { ...frame, result: { ...frame.result, approvalPolicy: named.approvalPolicy === 'on-request' ? 'never' : 'on-request' } };
    if (session && flagged('startOtherReviewer')) frame = { ...frame, result: { ...frame.result, approvalsReviewer: named.approvalsReviewer === 'auto_review' ? 'user' : 'auto_review' } };
    if (session && flagged('startOtherSandbox')) frame = { ...frame, result: { ...frame.result, sandbox: named.sandbox === 'danger-full-access' ? { type: 'readOnly', networkAccess: false } : { type: 'dangerFullAccess' } } };
    if (readControl().oversize === 'reply') frame = { ...frame, result: { ...frame.result, padding: pad('', LINE + 64) } };
    return frame;
  }

  /** What a start or a resume named of a policy, for a test to read (M22). */
  const opened = (message) => ({ method: message.method, sandbox: message.params?.sandbox ?? null, approvalPolicy: message.params?.approvalPolicy ?? null, approvalsReviewer: message.params?.approvalsReviewer ?? null });

  function threadStart(message) {
    if (takeControl('exitDuringStart')) process.exit(3);
    if (readControl().hang === 'open') return;
    const threadId = randomUUID();
    updateThread(threadId, (t) => ({ ...t, cwd: message.params?.cwd ?? null, launches: [...(t.launches ?? []), launch()], opens: [...(t.opens ?? []), opened(message)] }));
    startDescendant();
    const entry = capture(START);
    write([startReply(entry, sent(entry, 'thread/start'), message, threadId)]);
  }

  function threadResume(message) {
    if (takeControl('exitDuringStart')) process.exit(3);
    if (readControl().hang === 'reopen') return;
    const threadId = message.params?.threadId;
    const refusals = capture(REFUSALS);
    const refused = readControl().resumeRefused;
    if (refused === 'malformed' || refused === 'otherCode') {
      // The captured refusal of an id that is not well formed: the same code, another message (C129).
      const frame = replyTo(refusals, sent(refusals, 'thread/resume', 1).frame.id).frame;
      write([{ ...frame, id: message.id, ...(refused === 'otherCode' ? { error: { ...frame.error, code: -32000 } } : {}) }]);
      return;
    }
    const known = typeof threadId === 'string' ? thread(threadId) : null;
    if (known === null || !known.kept) {
      const request = sent(refusals, 'thread/resume', 0);
      const frame = replyTo(refusals, request.frame.id).frame;
      write([{ ...frame, id: message.id, error: { ...frame.error, message: frame.error.message.replace(ALIAS, String(threadId)) } }]);
      return;
    }
    updateThread(threadId, (t) => ({ ...t, ...(typeof message.params?.cwd === 'string' ? { cwd: message.params.cwd } : {}), launches: [...(t.launches ?? []), launch()], opens: [...(t.opens ?? []), opened(message)] }));
    startDescendant();
    const entry = capture(RESUME);
    write([startReply(entry, sent(entry, 'thread/resume'), message, threadId)]);
  }

  /** The captured request this one matches: the same view and cursor, and a page that holds as many turns. */
  function historyRequest(entry, params) {
    const view = params.itemsView ?? 'summary';
    const requests = entry.frames.filter((f) => f.dir === 'send' && f.frame.method === 'thread/turns/list' && (f.frame.params.sortDirection ?? 'desc') === (params.sortDirection ?? 'desc')
      && (f.frame.params.itemsView ?? 'summary') === view && (f.frame.params.cursor === undefined) === (params.cursor === undefined || params.cursor === null));
    const limit = params.limit ?? 2;
    return requests.find((f) => f.frame.params.limit === limit) ?? requests.filter((f) => f.frame.params.limit <= limit).sort((a, b) => b.frame.params.limit - a.frame.params.limit)[0] ?? null;
  }

  /**
   * K2's history, in pages (M21, C50): the five turns of its one reply, newest first, as many as
   * were asked for, from the turn a cursor names — each a turn of that reply as it holds it, or
   * without its items. A page's cursor is its last turn's id. Asked for all five whole, as K2 asked,
   * the answer is K2's reply itself.
   */
  function questionTurnsList(message, params) {
    const { entry, reply } = questionHistory();
    const view = params.itemsView ?? 'summary';
    // No capture holds a summary of these turns: refused, as any read no capture answers is.
    if (view !== 'full' && view !== 'notLoaded') { write([{ id: message.id, error: { code: -32601, message: 'Method not found' } }]); return; }
    const whole = substituter(entry, params.threadId).frame(reply).result;
    const from = typeof params.cursor === 'string' ? whole.data.findIndex((turn) => turn.id === params.cursor) + 1 : 0;
    const limit = Number.isInteger(params.limit) && params.limit > 0 ? params.limit : whole.data.length;
    const page = whole.data.slice(from, from + limit);
    const more = from + limit < whole.data.length;
    write([{ id: message.id, result: { ...whole, data: view === 'full' ? page : page.map((turn) => ({ ...turn, items: [], itemsView: 'notLoaded' })), nextCursor: more ? page.at(-1).id : whole.nextCursor } }]);
  }

  function turnsList(message) {
    const params = message.params ?? {};
    const known = typeof params.threadId === 'string' ? thread(params.threadId) : null;
    // Noted with its thread, as an interrupt is: that it arrived, for which view and how many turns, and whether from a cursor (M18, V17).
    if (known !== null && known.kept) updateThread(params.threadId, (t) => ({ ...t, historyReads: [...(t.historyReads ?? []), { view: params.itemsView ?? 'summary', limit: params.limit ?? null, cursor: params.cursor !== undefined && params.cursor !== null }] }));
    if (readControl().hang === 'history') return;
    // After n answers, the next read is the one that never answers: a walk cut short between two pages.
    const after = readControl().hangHistoryAfter;
    if (Number.isInteger(after) && historyAnswered >= after) return;
    historyAnswered += 1;
    if (known === null || !known.kept) {
      const refusals = capture(REFUSALS);
      const frame = replyTo(refusals, sent(refusals, 'thread/turns/list').frame.id).frame;
      write([{ ...frame, id: message.id, error: { ...frame.error, message: frame.error.message.replace(ALIAS, String(params.threadId)) } }]);
      return;
    }
    if (readControl().history === 'm21') { questionTurnsList(message, params); return; }
    const entry = capture(HISTORY);
    const request = historyRequest(entry, params);
    if (request === null) { write([{ id: message.id, error: { code: -32601, message: 'Method not found' } }]); return; }
    const subst = substituter(entry, params.threadId);
    let frame = { ...subst.frame(replyTo(entry, request.frame.id, request.index).frame), id: message.id };
    const control = readControl();
    const view = params.itemsView ?? 'summary';
    const newest = params.cursor === undefined || params.cursor === null;
    if (typeof control.generatedImage === 'string' && view === 'full' && frame.result?.data?.length > 0) {
      const data = frame.result.data.map((entryTurn, index) => index === 0 ? { ...entryTurn, items: [...(entryTurn.items ?? []), { type: 'imageGeneration', id: 'fixture-generated-image', status: 'completed', result: control.generatedImage }] } : entryTurn);
      frame = { ...frame, result: { ...frame.result, data } };
    }
    const tooLarge = control.oversize === 'historyPage'
      || (newest && view === 'full' && (control.oversize === 'historyTurn' || control.oversize === 'historyTurnSummary'))
      || (newest && view === 'summary' && control.oversize === 'historyTurnSummary');
    if (tooLarge) frame = { ...frame, result: { ...frame.result, padding: pad('', LINE + 64) } };
    else if (control.longText === 'historyItem') {
      const data = frame.result.data.map((entryTurn) => ({ ...entryTurn, items: entryTurn.items.map((item) => (item.type === 'agentMessage' && item.phase === 'final_answer' ? { ...item, text: pad(item.text, 100_001) } : item)) }));
      frame = { ...frame, result: { ...frame.result, data } };
    }
    write([frame]);
  }

  // ── Codex's own sandbox: readiness, and the setup (M22, C60–C62, C72) ─────────────────────
  /** Each request of the account's sandbox, noted with its process: a test reads there what was sent, and on which connection. */
  const noteSandbox = (message) => updateSandbox((s) => ({ ...s, asked: [...(s.asked ?? []), { pid: process.pid, method: message.method, params: message.params ?? null }] }));

  function readiness(message) {
    const state = sandboxState();
    noteSandbox(message);
    if (readControl().hang === 'readiness') return;
    // The captured reply of an account in that state: K6's before its setup, K1's once set up.
    const entry = capture(state === 'ready' ? SANDBOX_REPLIES.ready[0] : SETUP);
    const request = sent(entry, 'windowsSandbox/readiness');
    write([{ ...replyTo(entry, request.frame.id, request.index).frame, id: message.id }]);
  }

  function setupStart(message) {
    // Read before the setup changes anything: this process answers as it found the account (K6).
    sandboxState();
    noteSandbox(message);
    const control = readControl();
    if (control.setupNoReply) return;
    // No capture holds a refusal of it: the error is the fake's own.
    if (control.setupRefused) { write([{ id: message.id, error: { code: -32600, message: 'windowsSandbox/setupStart refused' } }]); return; }
    if (control.setupNoStarted) { write([{ id: message.id, result: { started: false } }]); return; }
    const outcome = control.setupOutcome ?? 'success';
    const entry = capture(outcome === 'declined' ? SETUP_DECLINED : SETUP);
    const request = sent(entry, 'windowsSandbox/setupStart');
    const reply = replyTo(entry, request.frame.id, request.index);
    write([{ ...reply.frame, id: message.id }]);
    // The connection ends before Codex's word.
    if (outcome === 'drop') process.exit(3);
    if (outcome === 'never') return;
    const completed = entry.frames.find((f) => f.dir === 'recv' && f.index > reply.index && f.frame.method === 'windowsSandbox/setupCompleted');
    setTimeout(() => {
      // Set up, for every process started from here on: this one still answers that none is (K6).
      if (outcome === 'success') updateSandbox((s) => ({ ...s, state: 'ready' }));
      write([{ ...completed.frame, emittedAtMs: Date.now() }]);
    }, Math.min(gap, Math.max(0, completed.ms - reply.ms)));
  }

  let closed = false;
  return {
    /** A session's handshake opts out of delta notifications (C13): the fake's other reads do not. */
    hangsHandshake: (message) => Array.isArray(message.params?.capabilities?.optOutNotificationMethods) && readControl().hang === 'handshake',
    /** The handshake's opt-out list is kept (M19, C54): no frame of a method on it is sent by this process. */
    handshake(message) {
      const list = message.params?.capabilities?.optOutNotificationMethods;
      optedOut = new Set(Array.isArray(list) ? list.filter((method) => typeof method === 'string') : []);
      experimental = message.params?.capabilities?.experimentalApi === true;
    },
    /** The error a handshake is refused with (M22b, `experimentalRefused`), or null where it is answered. */
    refusesHandshake: (message) => (message.params?.capabilities?.experimentalApi === true && flagged('experimentalRefused') ? EXPERIMENTAL_REFUSAL : null),
    inputClosed() { closed = true; },
    /** True when the message was one of the session methods, or an answer to the fake's own request. */
    handle(message) {
      if (message.method === undefined && message.id !== undefined) {
        if (turn?.pendingRequest && message.id === turn.pendingRequest.id) { const { then } = turn.pendingRequest; turn.pendingRequest = null; then(message); }
        return true;
      }
      switch (message.method) {
        case 'thread/start': threadStart(message); return true;
        case 'thread/resume': threadResume(message); return true;
        case 'thread/fork': threadFork(message); return true;
        case 'turn/start':
          // A side thread's turn is its own (M20b): beside the session's, if one is being replayed.
          if (children.has(message.params?.threadId)) { startChildTurn(message); return true; }
          if (readControl().hang === 'send') return true;
          // A field the experimental API brings (M22b, C13): refused without it, and under `collaborationRefused`.
          if (message.params?.collaborationMode !== undefined && (!experimental || flagged('collaborationRefused'))) { write([{ id: message.id, error: EXPERIMENTAL_REFUSAL }]); return true; }
          startTurn(message);
          return true;
        case 'turn/interrupt': interrupt(message); return true;
        case 'turn/steer': steer(message); return true;
        case 'skills/list': skillsList(message); return true;
        case 'thread/turns/list': turnsList(message); return true;
        case 'windowsSandbox/readiness': readiness(message); return true;
        case 'windowsSandbox/setupStart': setupStart(message); return true;
        default: return false;
      }
    },
  };
}

// The descendant (C49, C114, C128): records itself in the ledger, then lives as its mode says.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === 'descendant') {
  const mode = process.argv[3];
  const ledger = process.env.FATG_SMOKE_PIDS;
  const started = Date.now();
  if (ledger) {
    appendFileSync(ledger, `${process.pid} ${started}\n`);
    process.on('exit', () => { try { appendFileSync(`${ledger}.exited`, `${process.pid} ${started}\n`); } catch { /* the folder is gone */ } });
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
