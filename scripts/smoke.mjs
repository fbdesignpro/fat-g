// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Launches the real app in smoke mode (see src/main/app/smoke.ts) and exits with its result.
//   npm run smoke       → production path: builds, then serves the renderer from app://fatg
//   npm run smoke:dev   → development path: Vite dev server + HMR
//   npm run smoke:packaged → the packaged smoke flavor (npm run package:smoke first): app.asar, fuses,
//                         installer layout; the in-app packaged checks must report, or the run fails
// Exists so the FATG_SMOKE env var is set the same way on every OS without an extra dependency.
// It launches the app three times on the same data folder and fakes: the demo launch, with the demo
// source seeding and driving sessions (src/main/app/smoke.ts), then two live launches with the
// demo source off, each running its half of a Codex session and of a Claude session on their
// replay fakes (src/main/app/smoke-live.ts; M15, M16). After the last one exits it independently checks every
// fixture PID they recorded, per provider, what the live quit left, and scans the app's own output
// and files for private fixture text. A conversation's text is in the conversation store's own
// files and in no other file of the data folder, a session's name apart, and never in the output
// (M18, C43): the captures' messages are looked for everywhere but there.
// The live project's folder holds the files the fakes' answers name (M19b, C46). A file's text is
// shown and never kept: each file's marker is looked for in the output and in every file of the data
// folder, the conversation store's included, and the folder is as it was after the launches.
// A question asked beside a session (M20b) is conversation content as a prompt is: the side
// questions' captures' texts and the questions typed here are among what is looked for everywhere
// but the conversation store. The one passage of a file that is kept is the one sent to an aside
// (decision 0022's exception): the README's heading, which the store holds and no other file does.
// What a session asks leave for (M22) is conversation content too: a command, a path, a change's
// text, the model's reason, what a grant covers. The approval captures' texts, and the names of the
// files their requests name, are among what is looked for everywhere but the conversation store.
// From M22 the live project's folder is no longer left as it was: the fakes make there what the run
// approved, and nothing else. It must hold its own files as they were and exactly the files the
// approved requests made, with the contents the captures give — each one in its fake's own record.
// A plan (M22b) is conversation content kept in a store of its own: the plans' captures' texts are
// looked for everywhere but the conversation store and the plans folder, and must be in that folder.
// A review's findings (M22e) too: K2's finding texts are looked for everywhere but the store and the
// plans folder, must be in a review's file there, and in no plan's record or version.
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FILE_MARKERS, FILES, HEADINGS } from '../tests/fixtures/project-files.mjs';

const mode = ['dev', 'packaged'].includes(process.argv[2]) ? process.argv[2] : 'preview';
const cli = fileURLToPath(new URL('../node_modules/electron-vite/bin/electron-vite.js', import.meta.url));
const directory = mkdtempSync(path.join(os.tmpdir(), 'fatg-smoke-pids-'));
const pidFile = path.join(directory, 'pids');
const accountStateFile = path.join(directory, 'codex-account-state');
const controlFile = path.join(directory, 'codex-control.json');
writeFileSync(accountStateFile, 'subscription');
writeFileSync(controlFile, '{}');
// The Claude fixture keeps its own provider-tagged ledger ("<pid> <role>") and controls.
const claudeDirectory = path.join(directory, 'claude');
mkdirSync(claudeDirectory);
writeFileSync(path.join(claudeDirectory, 'control.json'), '{}');
// Where a child with debug logging on would write — so a leak lands somewhere we look.
const claudeConfig = path.join(directory, 'claude-config');
const claudeLogs = path.join(directory, 'claude-logs');
const { sentinel, email: claudeEmail } = JSON.parse(readFileSync(fileURLToPath(new URL('../tests/fixtures/claude/fake-cli-constants.json', import.meta.url)), 'utf8'));
const TOKEN = 'FATG-PARENT-SESSION-TOKEN-5K9';
// The folder the stand-in folder picker answers with (src/main/app/smoke-dialogs.ts, M12). It stays
// between runs, like the smoke data folder, so each run finds the project the last one left; fat-g
// itself must never write into it (decision 0015).
const smokeProject = path.join(os.tmpdir(), 'fatg-smoke-project');
mkdirSync(smokeProject, { recursive: true });
// A second Codex account (M14b, V16). Its folder is the one the stand-in account picker answers
// with; it stays between runs, like the project's, so each run finds the account the last one added.
// It holds files of its own, as a CLI's home holds a login, and fat-g must leave it byte for byte as
// it is: it only ever asks whether the folder is there and what its real path is (S6). The Codex
// fixture answers for it from the accounts file below, by the folder's path alone.
const smokeAccount = path.join(os.tmpdir(), 'fatg-smoke-account');
mkdirSync(path.join(smokeAccount, 'sessions'), { recursive: true });
if (!existsSync(path.join(smokeAccount, 'auth.json'))) writeFileSync(path.join(smokeAccount, 'auth.json'), '{"note":"stands in for what a CLI keeps in an account\'s folder; fat-g never opens it"}\n');
if (!existsSync(path.join(smokeAccount, 'sessions', 'one.jsonl'))) writeFileSync(path.join(smokeAccount, 'sessions', 'one.jsonl'), Buffer.from([0, 1, 2, 255, 10]));
const accountBefore = JSON.stringify(folderContents(smokeAccount));
const ACCOUNT_LABEL = 'Smoke-Second-7Q';
const ACCOUNT_EMAIL = 'second-smoke@example.test';
const accountsFile = path.join(directory, 'codex-accounts.json');
writeFileSync(accountsFile, JSON.stringify({
  [smokeAccount]: { state: 'subscription', email: ACCOUNT_EMAIL, plan: 'team', usage: { primary: 63, secondary: 7 }, models: ['gpt-6-sol', 'gpt-5.6-luna', 'gpt-5.5'], efforts: { 'gpt-6-sol': ['low', 'medium'] } },
}));
// The catalog override (M13, V18): the first file this script places in the app's smoke data folder,
// which it otherwise only scans. It alternates between runs — a valid file hiding GPT-5.5 when the
// folder holds none or a broken one, a broken one when it holds a valid one — and tells the app which.
const smokeData = path.join(os.tmpdir(), 'fatg-smoke');
const catalogPlaced = placeCatalog(path.join(smokeData, 'catalog.json'));
console.log(`[smoke] catalog.json placed: ${catalogPlaced}`);
// The live launches (M15, Design 16). Their project's folder is a second one, so their session has a
// project of its own; it stays between runs, like the demo's, and fat-g must write nothing into it.
const liveProject = path.join(os.tmpdir(), 'fatg-smoke-live-project');
mkdirSync(liveProject, { recursive: true });
// It holds the three files K2's answers name (M19b, C46): a README, a source file, and a Markdown
// file in a folder whose name has a space. Written here, before any launch; fat-g reads them when a
// reference is pressed, and they must be byte for byte as they are now once the launches are over.
// Beside them the folder may then hold what the fakes made for the requests the run approved (M22),
// which is no write of fat-g's: the CLI's stand-in made it, at the user's word.
for (const [name, text] of Object.entries(FILES)) {
  mkdirSync(path.dirname(path.join(liveProject, name)), { recursive: true });
  writeFileSync(path.join(liveProject, name), text);
}
// And the two files the captures' tools read (M20a, V14): what a read's row names, and what its
// file control opens. Each holds a marker of its own, as the three above do: what a tool returned
// to the agent is the capture's, kept in the conversation store, while a file fat-g shows in a tab
// is shown and never kept, so these markers may be nowhere but in the files.
const TOOL_FILES = { 'sample.txt': 'A sample file of the live project. Its tab shows marker-sample-2b8e.\n', 'notes-3.txt': 'The third note of the live project. Its tab shows marker-notes-71c4.\n' };
const TOOL_FILE_MARKERS = ['marker-sample-2b8e', 'marker-notes-71c4'];
for (const [name, text] of Object.entries(TOOL_FILES)) writeFileSync(path.join(liveProject, name), text);
// The Codex fake's thread file: outside the data folder, and kept between runs, so a later launch
// resumes what an earlier one began (C127).
const threadsFile = path.join(os.tmpdir(), 'fatg-smoke-threads.json');
// The Claude fake's session file, beside it and kept between runs for the same reason (M16, C51):
// the next launch's process resumes the session the first one's began.
const claudeSessionsFile = path.join(os.tmpdir(), 'fatg-smoke-claude-sessions.json');
const CAPTURES = fileURLToPath(new URL('../tests/fixtures/codex/captures/', import.meta.url));
const capture = (name) => JSON.parse(readFileSync(path.join(CAPTURES, `${name}.json`), 'utf8'));
/** A Codex capture's prompt chooses its replay, as it is written: its first, or its `nth` — a capture of two turns has a prompt for each (M21, M22). */
const promptOf = (name, nth = 0) => capture(name).frames.filter((entry) => entry.dir === 'send' && entry.frame.method === 'turn/start')[nth].frame.params.input[0].text;
const CLAUDE_CAPTURES = fileURLToPath(new URL('../tests/fixtures/claude/captures/', import.meta.url));
const claudeCapture = (name) => JSON.parse(readFileSync(path.join(CLAUDE_CAPTURES, `${name}.json`), 'utf8'));
/** A Claude capture's prompt chooses its replay, as it is written — its first, or its `nth` (M22): none of these names the folder it ran in (C79). */
function claudePromptOf(name, nth = 0) {
  const text = claudeCapture(name).frames.filter((entry) => entry.dir === 'send' && entry.frame.type === 'user')[nth]?.frame.message.content;
  if (typeof text !== 'string' || text.includes('<scratch>')) throw new Error(`${name}'s prompt names its folder: the live launches cannot send it as it is`);
  return text;
}
/**
 * M22: the turns that ask leave to act. Claude's command (K2), which makes a file: approved once
 * from its card, then asked again and granted for the session. Codex's file (K1), made by a change
 * approved from its card on an account with no sandbox, and that file's next change, denied.
 */
const CLAUDE_APPROVAL = 'm22-approve-once';
const CODEX_APPROVAL = 'm22-codex-file-session-same-main';
/** M22b: the captures the live plans are played from — Codex's chain, whose feedback turn plans a prompt it does not know, and Claude's plan under Ask first. */
const CODEX_PLAN = 'm22b-codex-chain';
const CLAUDE_PLAN = 'm22b-plan-ask-first';
/** K2's request for the command: its input is what an Approve sends back, and its rule is what a session grant covers. */
const claudeAsked = claudeCapture(CLAUDE_APPROVAL).frames.find((entry) => entry.dir === 'recv' && entry.frame.type === 'control_request' && entry.frame.request?.subtype === 'can_use_tool').frame.request;
const claudeRules = claudeAsked.permission_suggestions.find((entry) => entry.type === 'addRules').rules;
/** The file that command makes where there is none: `touch <name>`, an empty file. */
const claudeMade = /^touch (\S+)$/.exec(claudeAsked.input.command)[1];
/** The change K1's first turn was approved for: one file added in the session's folder, with the text its item gives. The second turn's, of the same file, is the one the run denies. */
const codexChange = capture(CODEX_APPROVAL).frames.find((entry) => entry.dir === 'recv' && entry.frame.method === 'item/completed' && entry.frame.params.item.type === 'fileChange').frame.params.item.changes[0];
const codexMade = codexChange.path.replace(/^<scratch>[\\/]/, '');
/** What the approved requests make in the live project, each file by its name with its content: these, and nothing else. */
const MADE = { [claudeMade]: '', [codexMade]: codexChange.diff };
if (codexChange.kind.type !== 'add' || Object.keys(MADE).length !== 2 || Object.keys(MADE).some((name) => !/^[\w.-]+$/.test(name))) throw new Error('the approval captures do not name the two files the live launches expect');
// What an earlier run's fakes made there is not this run's: it goes before the first launch, so
// that the files found afterwards are the ones this run's approved requests made.
for (const name of Object.keys(MADE)) rmSync(path.join(liveProject, name), { force: true });
const liveProjectBefore = JSON.stringify(folderContents(liveProject));
// The Codex fake notes an account's sandbox beside its threads, and a setup it approved stays with
// the account (M22). Each run begins with an account that has none: what an earlier run's setup
// left is taken out of the fake's file before the first launch.
forgetSandbox(threadsFile);
/** The threads the Codex fake started that never ran a turn: a start whose reply fat-g refused leaves one (M22, C46), and this run must leave exactly one more. */
const neverRan = () => { try { return Object.values(JSON.parse(readFileSync(threadsFile, 'utf8')).threads).filter((thread) => thread.turns.length === 0).length; } catch { return 0; } };
const neverRanBefore = neverRan();
/**
 * The Claude captures the live launches replay: a worker (T3), an interrupt (T4), a basic turn (T1)
 * and the answer in Markdown — M19's K2 captures, which hold each reply's stream events (C55).
 */
const CLAUDE_TURNS = { worker: 'm19-t3-subagent', interrupt: 'm19-t4-interrupt', basic: 'm19-t1-basic', markdown: 'm19-markdown', readme: 'm19b-readme', line: 'm19b-line', space: 'm19b-space' };
/** M19b's K2 captures, whose answers name a file (C46): the same three prompts were put to both CLIs. */
const FILE_TURNS = { readme: 'm19b-readme', line: 'm19b-line', space: 'm19b-space' };
/**
 * What an answer is made to say for the references that lead out (M19b, V15): a file outside the
 * project, by a link and by a code span, and an external address, by a link and by itself. The page
 * must say that the first is outside and open nothing, and hand the second to the browser's stand-in.
 * And a file of the project named in bold, with its line said in words after it (V24): the page
 * must open it at that line.
 * Each line carries the marker, so the scan below finds any of it that leaves the conversation store.
 */
const REFERENCES_MARKER = 'refs-5d2c';
const REFERENCES = [
  `${REFERENCES_MARKER}: see [the notes outside](../${REFERENCES_MARKER}-outside/notes.md) and \`../${REFERENCES_MARKER}-outside/notes.md\`.`,
  '',
  `${REFERENCES_MARKER}: and [the documentation](https://example.invalid/${REFERENCES_MARKER}/docs) or https://example.invalid/${REFERENCES_MARKER}/bare for more.`,
  '',
  // A file's name in bold and its line in words, as Claude Haiku answered (M19b, C64, C65): line 6 is `parseTime`.
  `${REFERENCES_MARKER}: the parser is in **src/tides.js** at **line 6**.`,
].join('\n');
/**
 * What an answer is made to say for the hostile message (M19, V21; C28, C31–C33): every way a text
 * could ask the page to run, load or open something. The page must draw it as the text it is. Each
 * line carries the marker, so the scan below finds any of it that leaves the conversation store.
 */
const HOSTILE_MARKER = 'hostile-7f3a';
const HOSTILE = [
  `# ${HOSTILE_MARKER} <script>document.title = "pwned-7f3a"</script>`,
  '',
  `<img src="https://example.invalid/${HOSTILE_MARKER}.png" onerror="document.title='pwned-7f3a'">`,
  `<iframe src="https://example.invalid/${HOSTILE_MARKER}"></iframe>`,
  '',
  `![${HOSTILE_MARKER} image](https://example.invalid/${HOSTILE_MARKER}.png) and ![${HOSTILE_MARKER} data](data:image/svg+xml;base64,PHN2Zy8+)`,
  '',
  `[${HOSTILE_MARKER} link](javascript:document.title="pwned-7f3a"), [a reference][${HOSTILE_MARKER}] and <https://example.invalid/${HOSTILE_MARKER}>`,
  '',
  `[${HOSTILE_MARKER}]: javascript:alert(1) "${HOSTILE_MARKER} title"`,
  '',
  `<a href="https://example.invalid/${HOSTILE_MARKER}" onclick="document.title='pwned-7f3a'">${HOSTILE_MARKER} anchor</a>`,
  `<style>body { display: none }</style><link rel="stylesheet" href="https://example.invalid/${HOSTILE_MARKER}.css">`,
  `<svg onload="document.title='pwned-7f3a'"></svg> <form action="https://example.invalid/${HOSTILE_MARKER}"><input name="${HOSTILE_MARKER}"></form>`,
].join('\n');
/** M20b: a question typed freely beside a session, and its follow-up. Each carries the marker, so the scan finds any of it outside the conversation store. */
const ASIDE_MARKER = 'aside-3e7a';
/** K2's command that passes to the CLI, which answers it by itself; and one fat-g answers, and never sends. */
const PASSED_COMMAND = 'm20b-cmd-exit';
/** K1's side questions and K3's side threads, whose replies the fakes answer an aside with. */
const SIDE_CAPTURES = ['m20b-idle', 'm20b-during', 'm20b-two', 'm20b-followup', 'm20b-cancel'];
const FORK_CAPTURES = ['m20b-fork-seed', 'm20b-fork-only', 'm20b-fork-followup', 'm20b-fork-during', 'm20b-fork-two', 'm20b-fork-read', 'm20b-fork-again'];
/**
 * M21: the turns that ask the user. Claude's through its question tool (K1), answered from its
 * card; Codex's in a message (K2), answered from its card by a prompt in fat-g's words, and a
 * second with two questions, dismissed.
 */
const CLAUDE_QUESTION = 'm21-question-one';
const CODEX_QUESTIONS = ['m21-codex-async', 'm21-codex-async-two'];
/** What the capture answered Claude's question with: the one string its `allow` sent back for it. */
const claudeAllowed = claudeCapture(CLAUDE_QUESTION).frames.find((entry) => entry.dir === 'send' && entry.frame.type === 'control_response' && entry.frame.response?.response?.behavior === 'allow').frame.response.response.updatedInput;
/** The prompt that answered Codex's question, as K2 sent it: the question's title on a line and the chosen option on the next (C26). */
const codexAnswer = capture(CODEX_QUESTIONS[0]).frames.filter((entry) => entry.dir === 'send' && entry.frame.method === 'turn/start')[1].frame.params.input[0].text;
const prompts = {
  saved: promptOf('m15-saved'), resume: promptOf('m15-resume'), interrupt: promptOf('t4-interrupt'), question: promptOf('t6-question'), basic: promptOf('t1-basic'),
  asides: { free: `${ASIDE_MARKER}: why does the harbour office keep its tide table by hand?`, followUp: `${ASIDE_MARKER}: and who reads it each morning?` },
  // M21: the prompts whose turns ask, and the option each capture was answered with.
  questions: { claude: claudePromptOf(CLAUDE_QUESTION), claudeOption: Object.values(claudeAllowed.answers)[0], codex: promptOf(CODEX_QUESTIONS[0]), codexOption: codexAnswer.split('\n')[1], codexTwo: promptOf(CODEX_QUESTIONS[1]) },
  // M22: the prompts whose turns ask leave to act, each capture's two, and the file each approved request makes in the live project.
  // Codex's prompts name their folder as the capture has it, which is how its fake knows them: they are sent as they are.
  approvals: { claude: claudePromptOf(CLAUDE_APPROVAL), claudeAgain: claudePromptOf(CLAUDE_APPROVAL, 1), claudeMade, codex: promptOf(CODEX_APPROVAL), codexAgain: promptOf(CODEX_APPROVAL, 1), codexMade },
  // M20a: the prompt whose turn starts a worker (T3), for its row in the chat and its tab.
  worker: promptOf('t3-subagent'),
  // M19: the answer that streams as Markdown, with a code block and a table (K1), and the hostile answer's text.
  markdown: promptOf('m19-markdown'), hostile: HOSTILE,
  claude: { ...Object.fromEntries(Object.entries(CLAUDE_TURNS).map(([key, name]) => [key, claudePromptOf(name)])), cleared: '/clear', passed: claudePromptOf(PASSED_COMMAND) },
  // M19b: the prompts whose answers name a file, the answer whose references lead out, and each Markdown file's own heading.
  files: Object.fromEntries(Object.entries(FILE_TURNS).map(([key, name]) => [key, promptOf(name)])),
  references: { text: REFERENCES, marker: REFERENCES_MARKER },
  headings: { readme: HEADINGS['README.md'], log: HEADINGS['field notes/harbour-log.md'] },
  // M22b: a plan turn's prompt for each: Codex's fake plans any under the chat's policy, Claude's by its capture's prompt.
  plans: { codex: 'Plan the harbour office’s tide table, in three steps at most.', claude: claudePromptOf(CLAUDE_PLAN) },
};
const promptsFile = path.join(directory, 'live-prompts.json');
writeFileSync(promptsFile, JSON.stringify(prompts));
/**
 * Every conversation text the live launches can meet: the captures' prompts and items (M15, C78),
 * and the Claude captures' — its prompts, its texts, and what its tools read (M16, C55).
 */
const conversation = [...new Set([
  // With what its commands printed (M20a, C33): a tool's output is conversation content, kept in the store and nowhere else.
  ...['m15-saved', 'm15-resume', 'm15-history', 't4-interrupt', 't6-question', 't1-basic', 't3-subagent', 'm19-answer', 'm19-worker', 'm19-markdown', ...Object.values(FILE_TURNS)].flatMap((name) => texts(capture(name).frames, ['text', 'aggregatedOutput'])),
  // The hostile answer, and the one whose references lead out, by their markers: every line of each has one.
  HOSTILE_MARKER, REFERENCES_MARKER,
  // Not a reply's stream events (M19): a text delta is a few characters, which any file may hold; the whole
  // text they add up to is in the frame that completes them.
  ...Object.values(CLAUDE_TURNS).flatMap((name) => texts(claudeCapture(name).frames.filter((entry) => entry.frame.type !== 'stream_event'), ['text', 'content', 'result'])),
  // M20b: the questions typed beside a session, by their marker; what K1's side questions were answered, and what K3's side
  // threads said and read; and the CLI's own answer to the command that passed.
  ASIDE_MARKER,
  ...SIDE_CAPTURES.flatMap((name) => texts(claudeCapture(name).frames.filter((entry) => entry.frame.type !== 'stream_event'), ['response', 'question', 'text', 'content', 'result'])),
  ...FORK_CAPTURES.flatMap((name) => texts(capture(name).frames, ['text', 'aggregatedOutput'])),
  ...texts(claudeCapture(PASSED_COMMAND).frames.filter((entry) => entry.frame.type !== 'stream_event'), ['text', 'result']),
  // M21 (C34): what each session asked and was answered — a question's text, its header, its options'
  // labels and descriptions, the answer sent back — with what the turns said and read around it. A
  // label under the floor falls under it as any short text does.
  ...texts(claudeCapture(CLAUDE_QUESTION).frames.filter((entry) => entry.frame.type !== 'stream_event'), ['text', 'content', 'result', 'question', 'header', 'label', 'description']),
  ...Object.entries(claudeAllowed.answers).flat().filter((text) => text.length >= 12 && !text.includes('<')),
  ...CODEX_QUESTIONS.flatMap((name) => texts(capture(name).frames, ['text', 'aggregatedOutput', 'title', 'question', 'header', 'label', 'description'])),
  // M22 (C28): what each session asked leave for, with what its turns said around it — Claude's command,
  // its description, which is the model's reason, and the rule a grant covers; Codex's change, whose text
  // is its diff, looked for as it is and as a JSON string spells its line ends. A path holds the folder it
  // was replayed in, so each is looked for by its file's name. A change's text of one common word is
  // under the floor, as any short text is: the file's name beside it is not.
  ...texts(claudeCapture(CLAUDE_APPROVAL).frames.filter((entry) => entry.frame.type !== 'stream_event'), ['text', 'content', 'result', 'command', 'description', 'ruleContent']),
  ...texts(capture(CODEX_APPROVAL).frames, ['text', 'aggregatedOutput', 'command', 'diff']).flatMap((text) => (text.includes('\n') ? [text, JSON.stringify(text).slice(1, -1)] : [text])),
  ...Object.keys(MADE),
  // M22b (C22): each plan's whole text, as its capture completes it, and what its turns said around it.
  ...texts(capture(CODEX_PLAN).frames, ['text', 'aggregatedOutput']),
  ...texts(claudeCapture(CLAUDE_PLAN).frames.filter((entry) => entry.frame.type !== 'stream_event'), ['text', 'content', 'result', 'plan']),
].flatMap((text) => [text, asScanned(text)]))];
/**
 * M22e (C16): the findings K2's reviews hold, on each provider — every title, example, description
 * and correction of each round's block, read from the answers as the captures hold them.
 */
const findingsOf = (answers) => answers.flatMap((text) => {
  const opening = text.lastIndexOf('```json');
  const closing = opening === -1 ? -1 : text.indexOf('\n```', opening + 7);
  if (closing === -1) return [];
  try { return JSON.parse(text.slice(text.indexOf('\n', opening) + 1, closing)).issues.flatMap((issue) => [issue.title, issue.example, issue.description, issue.correction]); } catch { return []; }
});
const reviewTexts = {
  codex: findingsOf(capture('m22e-codex-rounds').frames.flatMap((entry) => (entry.frame.method === 'item/completed' && entry.frame.params?.item?.type === 'agentMessage' && entry.frame.params.item.phase === 'final_answer' ? [entry.frame.params.item.text] : []))),
  claude: findingsOf(claudeCapture('m22e-claude-rounds').frames.flatMap((entry) => (entry.dir === 'recv' && entry.frame.type === 'assistant' && entry.frame.parent_tool_use_id == null && entry.frame.message?.content?.[0]?.type === 'text' ? [entry.frame.message.content.map((part) => part.text ?? '').join('')] : []))),
};
if (reviewTexts.codex.length < 8 || reviewTexts.claude.length < 8) throw new Error('the review captures’ findings could not be read');
conversation.push(...[...new Set([...reviewTexts.codex, ...reviewTexts.claude].filter((text) => text.length >= 24))].flatMap((text) => [text, asScanned(text)]));
/** The plans' own texts (M22b, C16), as the scan reads them: files are read byte for byte, as latin1. No plan's record holds them, and no file but the plans folder and the conversation store. */
const planTexts = { codex: texts(capture(CODEX_PLAN).frames.filter((entry) => entry.frame.params?.item?.type === 'plan'), ['text']), claude: texts(claudeCapture(CLAUDE_PLAN).frames, ['plan']) };
if (planTexts.codex.length === 0 || planTexts.claude.length === 0 || ![...planTexts.codex, ...planTexts.claude].every((text) => conversation.includes(text))) throw new Error('the plan captures’ texts are not all among what the scan looks for');
/** The approval captures' own needles, so that the scan can say it looked for them (M22): the command, the diff of the denied change, and the two files' names. */
const approvalNeedles = [...new Set([claudeAsked.input.command, ...texts(capture(CODEX_APPROVAL).frames, ['diff']), ...Object.keys(MADE)])];
if (approvalNeedles.length < 4 || !approvalNeedles.every((needle) => conversation.includes(needle))) throw new Error('the approval captures’ command, change and file names are not all among what the scan looks for');

/** The smoke flavor's executable (scripts/package.mjs smoke), per platform. */
function packagedExecutable() {
  const base = fileURLToPath(new URL('../release/smoke/', import.meta.url));
  if (process.platform === 'win32') return path.join(base, 'win-unpacked', 'fat-g.exe');
  if (process.platform === 'linux') return path.join(base, 'linux-unpacked', 'fat-g');
  const folder = existsSync(base) ? readdirSync(base).find((name) => name.startsWith('mac')) : undefined;
  return path.join(base, folder ?? 'mac', 'fat-g.app', 'Contents', 'MacOS', 'fat-g');
}
const [command, args] = mode === 'packaged' ? [packagedExecutable(), []] : [process.execPath, [cli, mode]];
if (!existsSync(command)) {
  console.error(`[smoke] ${command} is missing; run: npm run package:smoke`);
  process.exit(1);
}

const baseEnv = { ...process.env, FATG_SMOKE: '1', FATG_SMOKE_NODE: process.execPath,
    // A packaged app must ignore a dev-server URL, however it arrives (src/main/app/origins.ts).
    ...(mode === 'packaged' ? { ELECTRON_RENDERER_URL: 'http://localhost:5173' } : {}),
    FATG_SMOKE_FIXTURE: fileURLToPath(new URL('../tests/fixtures/fake-app-server.mjs', import.meta.url)),
    FATG_SMOKE_CODEX_FIXTURE: fileURLToPath(new URL('../tests/fixtures/fake-codex-cli.mjs', import.meta.url)), FATG_SMOKE_PIDS: pidFile,
    FATG_SMOKE_CODEX_ACCOUNT_STATE: accountStateFile, FATG_SMOKE_CODEX_CONTROL: controlFile,
    FATG_SMOKE_CLAUDE_FIXTURE: fileURLToPath(new URL('../tests/fixtures/fake-claude-cli.mjs', import.meta.url)), FATG_SMOKE_CLAUDE_DIR: claudeDirectory,
    FATG_SMOKE_PICK_FOLDER: smokeProject, FATG_SMOKE_CATALOG: catalogPlaced,
    FATG_SMOKE_PICK_ACCOUNT_FOLDER: smokeAccount, FATG_SMOKE_ACCOUNT_LABEL: ACCOUNT_LABEL, FATG_SMOKE_CODEX_ACCOUNTS: accountsFile,
    // The demo source seeds the smoke project with sessions and drives them (M14, C68): it starts nothing.
    FATG_DEMO_SESSIONS: 'seed',
    // Inherited as if from a debugging shell inside a parent Claude session that exports the Agent
    // SDK's identity: no child may receive the debug switches, the session token or that identity.
    CLAUDE_CONFIG_DIR: claudeConfig, CLAUDE_CODE_DEBUG_LOGS_DIR: claudeLogs, DEBUG_CLAUDE_AGENT_SDK: '1', DEBUG_SDK: '1', DEBUG: '1',
    CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_VERSION: '0.3.278', CLAUDE_CODE_SESSION_ID: TOKEN, CLAUDE_CODE_MESSAGING_TOKEN: TOKEN,
    FATG_SMOKE_CODEX_THREADS: threadsFile, FATG_SMOKE_CLAUDE_SESSIONS: claudeSessionsFile };

/** One launch of the app: its exit code, and everything it printed. */
function launch(env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'pipe'], env });
    let text = '';
    child.stdout.on('data', (chunk) => { process.stdout.write(chunk); text += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { process.stderr.write(chunk); text += chunk.toString('utf8'); });
    child.on('close', (code) => resolve({ code: code ?? 1, output: text }));
  });
}

const demoRun = await launch(baseEnv);
let output = demoRun.output;
let result = demoRun.code;
// The live launches: the demo source off, the second folder picked, the fake's controls reset to a
// signed-in account, and the frames replayed quickly. Each prints its own report line.
const liveRuns = [];
for (const stage of ['first', 'next']) {
  writeFileSync(accountStateFile, 'subscription');
  writeFileSync(controlFile, '{}');
  // Whatever the demo launch left in the Claude fake's controls is not the live launches'.
  writeFileSync(path.join(claudeDirectory, 'control.json'), '{}');
  const env = { ...baseEnv, FATG_SMOKE_LIVE: '1', FATG_SMOKE_LIVE_STAGE: stage, FATG_SMOKE_LIVE_PROMPTS: promptsFile, FATG_SMOKE_PICK_FOLDER: liveProject, FATG_SMOKE_CODEX_GAP_MS: '5', FATG_SMOKE_CLAUDE_GAP_MS: '5' };
  delete env.FATG_DEMO_SESSIONS;
  const run = await launch(env);
  output += run.output;
  liveRuns.push({ stage, ...run });
  if (run.code !== 0) result = 1;
}

{
  try {
    // A packaged run passes only if the app itself reported its packaged checks (src/main/app/smoke.ts).
    if (mode === 'packaged') {
      const line = demoRun.output.split(/\r?\n/).find((text) => text.startsWith('[smoke] {'));
      const packaged = line === undefined ? undefined : JSON.parse(line.slice('[smoke] '.length)).packaged;
      if (typeof packaged !== 'object' || packaged === null) throw new Error('the packaged app did not report its packaged checks');
      console.log('[smoke] packaged checks reported: main from app.asar, app:// origin, no dev menu, userData and name');
    }
    // Every fixture process is recorded as "<pid> [role] <started>" and records a normal exit as
    // "<pid> <started>". Windows recycles PIDs within one run, so identity is the pair, never the PID.
    const codex = ledger(pidFile, false);
    if (codex.length < 4) throw new Error('the Codex and process fixtures did not record all generations and descendants');
    const claude = ledger(path.join(claudeDirectory, 'pids'), true);
    const count = (role) => claude.filter((entry) => entry.role === role).length;
    // Per provider, including the session left hung at quit (session-hung) and its stuck descendant,
    // and the two processes the live launches' chat session ran on: its start, and its resume (M16).
    const minimums = { version: 1, auth: 3, session: 3, 'session-hung': 4, descendant: 1, chat: 2 };
    const short = Object.entries(minimums).filter(([role, minimum]) => count(role) < minimum);
    if (short.length) throw new Error(`the Claude fixture did not record every expected launch: ${short.map(([role]) => role).join(', ')}`);
    if (codex.length + claude.length < 4 + Object.values(minimums).reduce((sum, value) => sum + value, 0)) throw new Error('too few fixture PIDs were recorded');
    const exited = new Set([...lines(`${pidFile}.exited`), ...lines(path.join(claudeDirectory, 'exited'))]);
    const ended = (entry) => exited.has(`${entry.pid} ${entry.started}`);
    if (claude.some((entry) => entry.role === 'descendant' && ended(entry))) throw new Error('the stuck Claude descendant exited by itself instead of being killed at quit');
    // A process that ended by itself is done. Every other one — each process fat-g had to kill, the
    // quit case included — must be gone; a live PID counts only if that process started when ours did.
    const candidates = [...codex.map((entry) => ({ ...entry, label: 'codex/process' })), ...claude.map((entry) => ({ ...entry, label: `claude/${entry.role}` }))]
      .filter((entry) => !ended(entry) && alive(entry.pid));
    const created = startTimes(candidates.map((entry) => entry.pid));
    // A fixture's process exists before its script records `started`; a recycled PID's new holder
    // can only be created after that fixture died. Without start times (POSIX, or a failed query),
    // every live PID counts as a survivor.
    const ours = (entry) => created === null || (created.has(entry.pid) && created.get(entry.pid) <= entry.started + 250);
    const survivors = candidates.filter(ours);
    if (survivors.length) throw new Error(`fixture PIDs survived app exit: ${survivors.map(({ pid, label }) => `${pid} (${label})`).join(', ')}`);
    const reused = candidates.length - survivors.length + [...codex, ...claude].filter((entry) => ended(entry) && alive(entry.pid)).length;
    if (reused) console.log(`[smoke] note: ${reused} recorded PID(s) now belong to processes started after the fixture that recorded them`);
    if (existsSync(path.join(claudeDirectory, 'overlaps'))) throw new Error('two Claude sessions overlapped');
    if (existsSync(path.join(claudeDirectory, 'prompts'))) throw new Error('a Claude session received a prompt');
    if (existsSync(path.join(claudeDirectory, 'sdk-markers'))) throw new Error('a Claude session received the Agent SDK identity');
    if (existsSync(path.join(claudeDirectory, 'unexpected-args'))) throw new Error('a Claude session was launched with unexpected arguments');
    if (existsSync(path.join(claudeDirectory, 'cli-request-accepted'))) throw new Error('fat-g accepted a request from the Claude CLI');
    if (existsSync(path.join(claudeDirectory, 'prompt-without-id'))) throw new Error('a Claude chat session was sent a prompt that carries no id');
    if (existsSync(path.join(claudeDirectory, 'unexpected-chat-request'))) throw new Error('a Claude chat session was sent a request outside the ones it may send');
    // M22 (C69): an allow carries nothing but the request's own input and, for a session grant, the CLI's own rule for this session alone.
    if (existsSync(path.join(claudeDirectory, 'unexpected-permission-update'))) throw new Error('a Claude chat session’s allow carried a permission update other than the CLI’s own rules for the session');
    if (!readdirSync(claudeDirectory).some((name) => name.startsWith('cli-request-refused-'))) throw new Error('the Claude fixture request was never refused');
    console.log('[smoke] external PID verification passed (Claude and Codex)');

    // Raw CLI text and the inherited token must reach neither output nor disk; account identity
    // lives in memory only, so neither synthetic fixture email may be on disk either.
    // An account's label and its folder are the user's own (M14b, C49, C50): neither may reach the
    // app's output, and on disk they are in preferences.json alone. The folder is looked for by its
    // last segment, which no other path here has, so any spelling or escaping of the path is found.
    const accountText = [ACCOUNT_LABEL, path.basename(smokeAccount)];
    const leaks = [
      ...[['app output', output]].filter(([, text]) => [sentinel, TOKEN, ...accountText].some((needle) => text.includes(needle))),
      ...[claudeConfig, claudeLogs, path.join(os.tmpdir(), 'fatg-smoke')].flatMap(files)
        .filter(([, text]) => [sentinel, TOKEN, claudeEmail, 'smoke@example.test', ACCOUNT_EMAIL].some((needle) => text.includes(needle))),
      ...files(path.join(os.tmpdir(), 'fatg-smoke'))
        .filter(([file, text]) => path.basename(file) !== 'preferences.json' && accountText.some((needle) => text.includes(needle))),
    ].map(([where]) => where);
    if (leaks.length) throw new Error(`private fixture text reached: ${leaks.join(', ')}`);
    console.log('[smoke] privacy scan passed: no raw CLI text, inherited token, persisted identity, or account label or folder outside preferences.json');
    // An account's folder is its CLI's (M14b, S6): nothing added, removed or changed.
    if (JSON.stringify(folderContents(smokeAccount)) !== accountBefore) throw new Error('fat-g changed the smoke account’s folder');
    console.log('[smoke] the smoke account’s folder is byte for byte as it was');
    // A project's folder is the user's: fat-g reads it, and writes nothing into it (decision 0015).
    const written = readdirSync(smokeProject);
    if (written.length) throw new Error(`fat-g wrote into the smoke project's folder: ${written.join(', ')}`);
    // The live project's holds the files the answers name (M19b, C46): read, and left byte for byte as
    // they were. Beside them it may hold what the fakes made for the requests the run approved (M22),
    // and nothing else: those files are held to the captures further down, once the launches' own
    // reports have been read.
    const liveProjectAfter = folderContents(liveProject);
    if (JSON.stringify(liveProjectAfter.filter(([name]) => !(name in MADE))) !== liveProjectBefore) throw new Error('the live project’s folder was changed: one of its own files, or a file no approved request names');
    console.log('[smoke] both project folders hold nothing of fat-g’s: the smoke project’s is empty, and the live project’s holds its five files as they were, with nothing beside them but what an approved request names');

    // The live launches (M15): each reported, and passed.
    for (const run of liveRuns) {
      const line = run.output.split(/\r?\n/).find((text) => text.startsWith('[smoke] {"live"'));
      const report = line === undefined ? null : JSON.parse(line.slice('[smoke] '.length));
      if (report === null || report.ok !== true || run.code !== 0) throw new Error(`the live launch's ${run.stage} half failed: ${JSON.stringify(report?.problems ?? `exit ${run.code}`)}`);
    }
    // The app's own quit during a turn (C118): the turn's own end was written, interrupted and not
    // stopped, and the interrupt reached the fake while its input was still open.
    const left = JSON.parse(readFileSync(path.join(smokeData, 'smoke-live.json'), 'utf8'));
    const record = JSON.parse(readFileSync(path.join(smokeData, 'records.json'), 'utf8')).sessions.find((entry) => entry.id === left.quitDuring);
    if (record?.lastTurn?.outcome !== 'interrupted') throw new Error(`the turn running at the live quit was written ${JSON.stringify(record?.lastTurn ?? null)}, expected interrupted`);
    const thread = JSON.parse(readFileSync(threadsFile, 'utf8')).threads[left.reference];
    const interrupt = thread?.interrupts.at(-1);
    if ((thread?.interrupts.length ?? 0) <= left.interruptsBefore || interrupt?.inputOpen !== true) throw new Error('the live quit’s interrupt did not reach the fake while its input was open');
    console.log('[smoke] live launches passed: a Codex session started, answered, stopped, completed, read back from the conversation store by the next launch, checked against its history with no item read, resumed, and interrupted by the quit');

    // M19 (V21): an answer streamed onto the page, as Markdown; the hostile answer drawn as text, in
    // the launch that received it and in the next, which read it from the store; and no request made
    // for anything a text named. The violations are counted by each launch at its end.
    const reported = (stage) => { const line = liveRuns.find((run) => run.stage === stage)?.output.split(/\r?\n/).find((text) => text.startsWith('[smoke] {"live"')); return line === undefined ? {} : JSON.parse(line.slice('[smoke] '.length)); };
    const { streamed, hostile, claudeStreamed, claudeHostile } = reported('first');
    const { fromStore, claudeFromStore } = reported('next');
    if (!(streamed?.shownWhileWritten > 0 && streamed.then > streamed.shownWhileWritten && streamed.complete > streamed.then)) throw new Error(`the streamed answer was not shown growing before it completed: ${JSON.stringify(streamed ?? null)}`);
    if (!(streamed.codeBlocks >= 1 && streamed.copyCode === streamed.codeBlocks && streamed.tableRows >= 10)) throw new Error(`the streamed answer was not drawn as Markdown: ${JSON.stringify(streamed)}`);
    if (hostile?.shownAsText !== true || hostile.foreignElements !== 0 || hostile.activeAttributes !== 0 || hostile.pageChanged !== false) throw new Error(`the hostile answer was not drawn as inert text: ${JSON.stringify(hostile ?? null)}`);
    if (!(fromStore?.codeBlocks >= 1 && fromStore.copyCode === fromStore.codeBlocks && fromStore.tableRows >= 10 && fromStore.hostileAsText === true && fromStore.foreignElements === 0)) throw new Error(`the next launch did not draw the same chat from the store: ${JSON.stringify(fromStore ?? null)}`);
    if (/\[security\] blocked (request|navigation)/.test(liveRuns.map((run) => run.output).join('\n'))) throw new Error('a live launch asked for something outside the app: a blocked request or navigation was logged');
    // The same of Claude (step 5): its answer as it is written, the hostile one, and both from the store.
    if (!(claudeStreamed?.shownWhileWritten > 0 && claudeStreamed.then > claudeStreamed.shownWhileWritten && claudeStreamed.complete > claudeStreamed.then)) throw new Error(`Claude's streamed answer was not shown growing before it completed: ${JSON.stringify(claudeStreamed ?? null)}`);
    if (!(claudeStreamed.codeBlocks >= 1 && claudeStreamed.copyCode === claudeStreamed.codeBlocks && claudeStreamed.tableRows >= 10)) throw new Error(`Claude's streamed answer was not drawn as Markdown: ${JSON.stringify(claudeStreamed)}`);
    if (claudeHostile?.shownAsText !== true || claudeHostile.foreignElements !== 0 || claudeHostile.activeAttributes !== 0 || claudeHostile.pageChanged !== false) throw new Error(`Claude's hostile answer was not drawn as inert text: ${JSON.stringify(claudeHostile ?? null)}`);
    if (!(claudeFromStore?.codeBlocks >= 1 && claudeFromStore.copyCode === claudeFromStore.codeBlocks && claudeFromStore.tableRows >= 10 && claudeFromStore.hostileAsText === true && claudeFromStore.foreignElements === 0)) throw new Error(`the next launch did not draw Claude's chat the same from the store: ${JSON.stringify(claudeFromStore ?? null)}`);
    console.log(`[smoke] streaming passed: a Claude answer shown at ${claudeStreamed.shownWhileWritten} then ${claudeStreamed.then} of its ${claudeStreamed.complete} characters before it completed, drawn as Markdown with ${claudeStreamed.codeBlocks} code block(s) each with its Copy button and a ${claudeStreamed.tableRows}-row table; a hostile answer drawn as text; both drawn the same from the store by the next launch, with no chat process`);
    console.log(`[smoke] streaming passed: a Codex answer shown at ${streamed.shownWhileWritten} then ${streamed.then} of its ${streamed.complete} characters before it completed, drawn as Markdown with ${streamed.codeBlocks} code block(s) each with its Copy button and a ${streamed.tableRows}-row table; a hostile answer drawn as text with no element, attribute or request of its own; both drawn the same from the store by the next launch`);

    // The Claude session (M16, V20), as the fake's own session file has it: one conversation, begun
    // by the first launch and resumed by the next, three turns, one interrupt, and no folder beside
    // the project's own handed to it.
    const chat = left.claude === undefined ? undefined : JSON.parse(readFileSync(claudeSessionsFile, 'utf8')).sessions[left.claude.reference];
    if (chat === undefined) throw new Error('the live launches left no Claude session in the fake’s session file');
    // A run that also captures the chat for the maintainer's review (FATG_SMOKE_VISUAL_DIR) sends one
    // prompt more, whose process is lost during its turn so that the chat shows the notice.
    const visual = process.env.FATG_SMOKE_VISUAL_DIR !== undefined;
    // The first launch: the worker, the Markdown answer, the turn answered with the hostile text, the Stop. The next: the resume.
    // M19b: between the hostile answer and the Stop, the three answers that name a file and the turn answered with references that lead out.
    // M20b: then the command that passes, which is a turn the CLI answers; the one fat-g answered is no turn of the CLI's, and no side question is one.
    // M23: then a message queued on the idle session, which goes at once as a turn of its own.
    // M21: then the turn that asks through the question tool, answered from its card.
    const turns = [CLAUDE_TURNS.worker, CLAUDE_TURNS.markdown, CLAUDE_TURNS.basic, CLAUDE_TURNS.readme, CLAUDE_TURNS.line, CLAUDE_TURNS.space, CLAUDE_TURNS.basic, PASSED_COMMAND, CLAUDE_TURNS.basic, CLAUDE_QUESTION, CLAUDE_TURNS.interrupt, CLAUDE_TURNS.basic, ...(visual ? [CLAUDE_TURNS.basic] : [])];
    if (JSON.stringify(chat.turns) !== JSON.stringify(turns)) throw new Error(`the Claude session ran ${JSON.stringify(chat.turns)}`);
    if (chat.launches.length !== 2 || chat.launches[0].resume !== null || chat.launches[1].resume !== left.claude.reference) throw new Error('the Claude session was not started once and resumed once, by its own reference');
    if (chat.interrupts.length !== 1 || chat.interrupts[0].inputOpen !== true) throw new Error('the Claude session’s Stop did not reach the fake as one interrupt, with its input open');
    if (chat.launches.some((launched) => launched.addDirs.length !== 0)) throw new Error('the Claude session was handed a folder the live project does not have');
    // This session's fake asked for one thing in the live launches, and was answered nothing else (M21,
    // C17): its question, by `allow`, with the request's own input and the one answer chosen in the
    // card — what K1's capture sent back, key for key. The permission session's fake asked leave to
    // act, and was answered nothing but the decisions the run made: held further down (M22).
    if (chat.answers.length !== 1 || chat.answers[0].behavior !== 'allow' || JSON.stringify(chat.answers[0].updatedInput) !== JSON.stringify(claudeAllowed)) throw new Error(`the Claude fake was answered ${JSON.stringify(chat.answers.map((answer) => answer.behavior))} in the live launches, expected its one question allowed with the capture's own input and answer`);
    const claudeRecord = JSON.parse(readFileSync(path.join(smokeData, 'records.json'), 'utf8')).sessions.find((entry) => entry.id === left.claude.session);
    if (claudeRecord?.reference !== left.claude.reference || claudeRecord?.lastTurn?.outcome !== (visual ? 'failed' : 'completed')) throw new Error(`the Claude session is recorded ${JSON.stringify({ reference: claudeRecord?.reference === left.claude.reference, lastTurn: claudeRecord?.lastTurn ?? null })}`);
    console.log('[smoke] live launches passed: a Claude session started, answered through a worker, stopped, completed, read back from the conversation store by the next launch with no chat process, and resumed in a new process while a Codex turn ran');

    // M18, C43 (amends M15, C78): no conversation text in the app's output, and none in the data
    // folder outside the conversation store's own files — its main file, what SQLite keeps beside it
    // and a copy set aside — but each session's name in records.json, which is taken from its first
    // prompt. Every other file is scanned as before.
    const STORE_FILES = /^conversations(\.set-aside\.[\dT-]+Z(-\d+)?)?\.sqlite(-wal|-shm)?$/;
    const inStore = (file) => path.dirname(file) === smokeData && STORE_FILES.test(path.basename(file));
    // And the plans folder (M22b, C16): a plan's text is kept there, and in no file but it and the store.
    const inPlans = (file) => path.relative(smokeData, file).split(path.sep)[0] === 'plans';
    const scrubbed = (file, text) => {
      if (path.basename(file) !== 'records.json') return text;
      try {
        const parsed = JSON.parse(text);
        return JSON.stringify({ ...parsed, sessions: (parsed.sessions ?? []).map((entry) => ({ ...entry, name: null })) });
      } catch { return text; }
    };
    const conversationLeaks = [
      ...(conversation.some((needle) => output.includes(needle)) ? ['app output'] : []),
      ...files(smokeData).filter(([file, text]) => !inStore(file) && !inPlans(file) && conversation.some((needle) => scrubbed(file, text).includes(needle))).map(([file]) => file),
    ];
    if (conversationLeaks.length) throw new Error(`conversation text reached: ${conversationLeaks.join(', ')}`);
    // And it is where it belongs: the store holds what the live launches said.
    const stored = files(smokeData).filter(([file]) => inStore(file));
    const kept = [prompts.saved, prompts.claude.worker].every((prompt) => stored.some(([, text]) => text.includes(prompt)));
    if (!kept) throw new Error('the conversation store does not hold the live launches’ conversations');
    // Every plan the live launches executed or discarded is deleted with its text (decision 0029, as of
    // the shared workflow), which the live checks count; what the plans folder still holds
    // are the plans the reviews keep (M22e), at least one a provider. A plan's record holds no text of it.
    const planned = files(smokeData).filter(([file]) => inPlans(file));
    const records = planned.filter(([file]) => path.basename(file) === 'plan.json');
    const recordsWithText = records.filter(([, held]) => [...planTexts.codex, ...planTexts.claude].some((text) => held.includes(asScanned(text)))).map(([file]) => path.relative(smokeData, file));
    if (records.length < 2 || recordsWithText.length > 0) throw new Error(`the plans folder holds ${planned.length} file(s), ${records.length} plan record(s), and plan text in ${JSON.stringify(recordsWithText)}`);
    // And each provider's findings in a review's file of it (M22e, C16), and in no plan's record or version.
    const inReviews = (file) => path.relative(smokeData, file).split(path.sep)[2] === 'reviews';
    const reviewFiles = planned.filter(([file]) => inReviews(file));
    const findingsKept = [reviewTexts.codex, reviewTexts.claude].every((found) => found.some((text) => text.length >= 24 && reviewFiles.some(([, held]) => held.includes(asScanned(text)))));
    const findingsOut = planned.filter(([file, held]) => !inReviews(file) && [...reviewTexts.codex, ...reviewTexts.claude].some((text) => text.length >= 24 && held.includes(asScanned(text)))).map(([file]) => path.relative(smokeData, file));
    if (!findingsKept || reviewFiles.length < 2 || findingsOut.length > 0) throw new Error(`the plans folder holds ${reviewFiles.length} review file(s), each provider's findings ${findingsKept ? '' : 'not '}in them, and findings in ${JSON.stringify(findingsOut)}`);
    console.log(`[smoke] conversation scan passed: ${conversation.length} capture texts, Codex's and Claude's, kept in the conversation store, and none in the output or in any other file of the data folder but a session's name; each plan executed or discarded deleted with its text, the ${records.length} plans the reviews keep holding none of it in their records; each provider's findings kept in ${reviewFiles.length} review files and in no plan's record or version`);

    // M20b (V14; C4, C5, C30, C32, C36–C48, C53–C58, C73–C75): a question asked beside a session of
    // each provider — from the icon beside a block, from fat-g's own menu on a selection in an
    // activity's output, from a file's tab by the keyboard, and typed freely with a follow-up — each
    // answered in a tab of its own, its session untouched; one removed; the rest read from the store by
    // the next launch and reopened from a marker; and a Claude command answered by fat-g, and one passed.
    const { asides: codexAsides, claudeAsides, commands } = reported('first');
    const { asidesFromStore, claudeAsidesFromStore, pet: petNext } = reported('next');
    for (const [who, found] of [['Codex', codexAsides], ['Claude', claudeAsides]]) {
      if (!(found?.selectedMessage === true && found.tabs === 3 && found.asked === 5 && found.listed === 3 && found.byKeyboard === true && found.direct === true && JSON.stringify(found.menu) === JSON.stringify(['Copy', 'Explain this in a side chat', 'Send to new side chat']) && JSON.stringify(found.answers) === JSON.stringify([1, 1, 1, 2]))) throw new Error(`${who}'s asides were not asked and answered as they should be: ${JSON.stringify(found ?? null)}`);
      // The passage is painted through the platform's own highlight registry, in the real page.
      if (!(found.painted >= 1)) throw new Error(`${who}'s aside's passage was not painted: ${JSON.stringify(found.painted)}`);
    }
    for (const [who, found] of [['Codex', asidesFromStore], ['Claude', claudeAsidesFromStore]]) {
      if (!(found?.listed === 3 && found.restored === true && found.removed === true && found.reopened === true && found.answers === 1 && found.painted >= 1)) throw new Error(`the next launch did not read ${who}'s asides from the store: ${JSON.stringify(found ?? null)}`);
    }
    if (!(commands?.answeredByFatg === '/clear' && commands.cliAnswered === true)) throw new Error(`the CLI's commands were not handled as they should be: ${JSON.stringify(commands ?? null)}`);
    for (const [stage, pet] of [['first', reported('first').pet], ['next', petNext]]) {
      // With M22's three: a chat's mode, a decision on a request to act, and an account's sandbox setup.
      if (JSON.stringify(pet?.files) !== JSON.stringify(Array(15).fill('forbidden'))) throw new Error(`the Pet was not refused the file, refresh, address, aside, question and permission channels in the ${stage} launch: ${JSON.stringify(pet?.files ?? null)}`);
    }
    // The fakes' own files: each session's side questions reached its one process, and ran no turn of it.
    const codexThread = JSON.parse(readFileSync(threadsFile, 'utf8')).threads[left.reference];
    if (!(codexThread?.forks?.length === 4 && codexThread.asides?.length === 5)) throw new Error(`Codex was sent ${codexThread?.forks?.length ?? 0} fork(s) and ${codexThread?.asides?.length ?? 0} side-thread question(s), expected four and five`);
    if (codexThread.forks.some((fork) => fork.ephemeral !== true || fork.sandbox !== 'read-only' || fork.approvalPolicy !== 'never' || 'config' in fork)) throw new Error('a Codex side thread was not forked ephemeral, read-only and with no approval asked');
    if (!(chat.sides?.length === 5 && (chat.cancels ?? []).length === 0)) throw new Error(`Claude was sent ${chat.sides?.length ?? 0} side question(s), expected five`);
    // The one passage of a file that is kept is the one the user sent to an aside (decision 0022): the
    // README's heading is in the conversation store, and in no other file of the data folder.
    const heading = HEADINGS['README.md'];
    if (!stored.some(([, text]) => text.includes('about a passage in the file README.md') && text.includes(`> ${heading}`))) throw new Error('the conversation store does not hold the passage of a file that was sent to an aside');
    // Each session's free aside was removed, with its two questions and its two answers: nothing of it
    // is left in any file of the store (C32), and the scan above found it nowhere else.
    if (stored.some(([, text]) => text.includes(ASIDE_MARKER))) throw new Error('a removed aside left its question in the conversation store');
    console.log(`[smoke] asides passed: beside a Codex session and a Claude session, Explain this from the menu on a selection in an answer, in an output and in a file's tab by the keyboard, and a free question with its follow-up, each answered in a tab of its own with its passage painted and its session untouched; one removed; the rest read from the store by the next launch and reopened from a marker; /clear answered by fat-g and never sent, ${prompts.claude.passed} passed and answered by the CLI; the Pet refused all four channels`);

    // M21 (V12; C15, C17, C26, C34, C37–C41, C47, C61, C62): a question each session asked. Claude's,
    // through its tool: a card its turn waited on, the capsule counting it, answered from the card and
    // confirmed by the CLI. Codex's, in a message: a card that waited for nothing, answered by a prompt
    // in fat-g's words, and a second one dismissed. Each read from the store by the next launch, inert.
    const { claudeQuestion, codexQuestions } = reported('first');
    const { questionsFromStore, claudeQuestionsFromStore } = reported('next');
    if (!(claudeQuestion?.card === 'blocking' && claudeQuestion.capsule === '1 Question' && claudeQuestion.answered === true && claudeQuestion.confirmed === true && claudeQuestion.foreignElements === 0)) throw new Error(`Claude's question was not asked and answered as it should be: ${JSON.stringify(claudeQuestion ?? null)}`);
    if (!(codexQuestions?.card === 'async' && codexQuestions.answered === true && codexQuestions.confirmed === true && codexQuestions.second === 2 && codexQuestions.dismissed === true && codexQuestions.turns === 3 && codexQuestions.foreignElements === 0)) throw new Error(`Codex's questions were not asked, answered and dismissed as they should be: ${JSON.stringify(codexQuestions ?? null)}`);
    if (!(claudeQuestionsFromStore?.inert === true && JSON.stringify(claudeQuestionsFromStore.outcomes) === JSON.stringify(['answered']))) throw new Error(`the next launch did not read Claude's question from the store: ${JSON.stringify(claudeQuestionsFromStore ?? null)}`);
    if (!(questionsFromStore?.inert === true && JSON.stringify(questionsFromStore.outcomes) === JSON.stringify(['answered', 'dismissed']))) throw new Error(`the next launch did not read Codex's questions from the store: ${JSON.stringify(questionsFromStore ?? null)}`);
    // Codex was sent the answer as a prompt, in fat-g's words: the turn K2's capture answers was the one that ran.
    // The fake names a capture's second turn by its place: `m21-codex-async#2` is the turn that capture answered with.
    const asked = (codexThread.turns ?? []).filter((name) => CODEX_QUESTIONS.some((capture) => name === capture || name.startsWith(`${capture}#`)));
    if (JSON.stringify(asked) !== JSON.stringify([CODEX_QUESTIONS[0], `${CODEX_QUESTIONS[0]}#2`, CODEX_QUESTIONS[1]])) throw new Error(`Codex's thread ran ${JSON.stringify(asked)} for its questions, expected the one that asked, the one that answered it, and the one that asked twice`);
    // And each is where it belongs (C34): the question and the answer in the conversation store; the scan above found them nowhere else.
    const questionTexts = [Object.keys(claudeAllowed.answers)[0], codexAnswer.split('\n')[0]];
    if (!questionTexts.every((text) => stored.some(([, held]) => held.includes(text)))) throw new Error('the conversation store does not hold the questions the sessions asked');
    console.log(`[smoke] questions passed: Claude's question through its tool stood as a card its turn waited on, the capsule reading ${claudeQuestion.capsule}, with nothing sent until Submit; answered from the card by allow with the capture's own input, confirmed by the CLI, and the turn went on; Codex's question in a message stood as a card that waited for nothing, answered from the card by a prompt in fat-g's words, and a second card of ${codexQuestions.second} questions was dismissed with nothing sent; the cards' own inputs apart, the chat's list held nothing a text may not become; the next launch read every card from the store, inert; the Pet refused both channels`);

    // M22 (V11, V12; C1–C8, C12, C13, C21, C28, C43, C46, C56, C57, C60–C62, C64, C69, C72, C74–C76, C86, C89):
    // what a session may do, on a session of each provider made for it. Claude's: a command approved
    // once from its card, asked again and granted for the session, run unasked, the grant ended by Read
    // only, asked again; Edits ok on the live process, Read only by a new one. Codex's: blocked by a
    // start whose reply reported another policy, changed from the block's remedy; a file change
    // approved and the next denied, on an account with no sandbox; Codex's own setup declined and then
    // approved; Sandbox ok chosen and confirmed. Each card read from the store by the next launch, inert.
    const { claudeApprovals, claudeModes, blockedStart, codexApprovals, codexSetup, permissions: permissionsRan } = reported('first');
    const { approvalsFromStore, claudeApprovalsFromStore, permissionsFromStore } = reported('next');
    const same = (a, b) => canonical(a) === canonical(b);
    // The page's own count of what its policy refused, read by each launch once its permission steps were over — the next half ends by quitting, and reads none at its end.
    if (permissionsRan?.csp !== '0' || permissionsFromStore?.csp !== '0') throw new Error(`the Main page's policy was violated during the permission steps: ${JSON.stringify([permissionsRan?.csp ?? null, permissionsFromStore?.csp ?? null])}`);
    if (!(claudeApprovals?.card === 'command' && same(claudeApprovals.choices, ['approve', 'approve-session', 'deny']) && claudeApprovals.capsule === '1 Approval' && claudeApprovals.approvedOnce === true && claudeApprovals.fileMade === true
      && claudeApprovals.granted === true && claudeApprovals.ranUnasked === true && claudeApprovals.liveGrant === true && claudeApprovals.endedByReadOnly === true && claudeApprovals.askedAgain === true && claudeApprovals.foreignElements === 0 && same(claudeApprovals.petHolds, []))) {
      throw new Error(`Claude's command was not approved, granted and asked again as it should be: ${JSON.stringify(claudeApprovals ?? null)}`);
    }
    // Ask first is the chat's own choice, made before its first prompt: the providers'
    // fallback is Auto reviewed (decision 0027, item 7), so the chat's header names it as the chat's.
    if (!(same(claudeModes?.atStart, ['ask-first', 'chat']) && claudeModes.editsOk?.restart === false && claudeModes.editsOk.confirmed === true && claudeModes.editsOk.liveGrants === 1
      && claudeModes.readOnly?.restart === true && claudeModes.readOnly.liveGrants === 0 && claudeModes.readOnly.endedGrants === 2 && claudeModes.launches === 3 && claudeModes.changesOnLiveProcess === 1)) {
      throw new Error(`Claude's mode was not changed as it should be: ${JSON.stringify(claudeModes ?? null)}`);
    }
    if (!(blockedStart?.block === 'mode-unconfirmed' && blockedStart.remedy === true && blockedStart.chose === 'read-only' && blockedStart.sent === true)) throw new Error(`the chat blocked by a refused start was not changed from its remedy and sent its next prompt: ${JSON.stringify(blockedStart ?? null)}`);
    if (!(codexApprovals?.card === 'file-change' && same(codexApprovals.choices, ['approve', 'approve-session', 'deny']) && codexApprovals.capsule === '1 Approval' && codexApprovals.approvedOnce === true && codexApprovals.fileMade === true
      && codexApprovals.denied === true && codexApprovals.declinedRows?.length === 1 && codexApprovals.foreignElements === 0)) {
      throw new Error(`Codex's file change was not approved, and its next one denied, as they should be: ${JSON.stringify(codexApprovals ?? null)}`);
    }
    // Codex's own setup is Windows' alone (C62): on another system no control is offered and nothing is asked, and the session stays under Ask first.
    const windows = process.platform === 'win32';
    const setUp = windows
      ? codexSetup?.offered === true && codexSetup.unavailable === 'needs-setup' && codexSetup.unconfined === true && codexSetup.declined === true && codexSetup.approved === true && codexSetup.requests === 2 && codexSetup.chose === 'sandbox-ok' && codexSetup.confirmed === true && same(codexSetup.petHolds, [])
      : codexSetup?.offered === false && codexSetup.unavailable === 'needs-setup' && codexSetup.unconfined === true && codexSetup.requests === 0;
    if (!setUp) throw new Error(`Codex's sandbox setup was not offered, declined, approved and followed by Sandbox ok as it should be: ${JSON.stringify(codexSetup ?? null)}`);
    if (!(claudeApprovalsFromStore?.inert === true && same(claudeApprovalsFromStore.outcomes, ['approved', 'approved-session', 'approved-session']) && claudeApprovalsFromStore.liveGrants === 0
      // The grants list stands in the Sub-agents tab, which a grant ended in a run before does not open (M100, round 8): none listed, or both ended.
      && [0, 2].includes(claudeApprovalsFromStore.endedListed)
      && claudeApprovalsFromStore.mode === 'read-only' && claudeApprovalsFromStore.launched === 0 && claudeApprovalsFromStore.foreignElements === 0)) {
      throw new Error(`the next launch did not read Claude's approvals from the store, inert, with every grant ended: ${JSON.stringify(claudeApprovalsFromStore ?? null)}`);
    }
    if (!(approvalsFromStore?.inert === true && same(approvalsFromStore.outcomes, ['approved', 'denied']) && approvalsFromStore.liveGrants === 0 && approvalsFromStore.endedListed === 0
      && approvalsFromStore.mode === (windows ? 'sandbox-ok' : 'ask-first') && approvalsFromStore.launched === 0 && approvalsFromStore.foreignElements === 0)) {
      throw new Error(`the next launch did not read Codex's approvals from the store, inert: ${JSON.stringify(approvalsFromStore ?? null)}`);
    }
    // The fakes' own files, in the CLIs' own words. Claude's permission session: the command, the same
    // again, again unasked, again after the restart, and a turn under Read only; on three launches —
    // Ask first's nine tools (M22b, C8: `ExitPlanMode` the ninth), the same resumed, and the five that read — each under the CLI's default
    // mode, Edits ok being one change written to the second with no turn running.
    const permitted = left.permissions;
    const grantedSession = JSON.parse(readFileSync(claudeSessionsFile, 'utf8')).sessions[permitted?.claude.reference];
    if (grantedSession === undefined) throw new Error('the live launches left no Claude permission session in the fake’s session file');
    const askedAgain = `${CLAUDE_APPROVAL}#2`;
    if (!same(grantedSession.turns, [CLAUDE_APPROVAL, askedAgain, askedAgain, askedAgain, CLAUDE_TURNS.basic])) throw new Error(`Claude's permission session ran ${JSON.stringify(grantedSession.turns)}`);
    const ACTING = ['Read', 'Glob', 'Grep', 'Agent', 'AskUserQuestion', 'Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'ExitPlanMode'];
    const launched = grantedSession.launches.map((launch) => [launch.resume, launch.mode, launch.tools]);
    if (!same(launched, [[null, 'default', ACTING], [permitted.claude.reference, 'default', ACTING], [permitted.claude.reference, 'default', ACTING.slice(0, 5)]])) throw new Error(`Claude's permission session was launched ${JSON.stringify(grantedSession.launches.map((launch) => [launch.resume === null ? 'start' : 'resume', launch.mode, launch.tools.length]))}`);
    if (!same(grantedSession.modes, [{ mode: 'acceptEdits', turn: false, answered: 'success' }])) throw new Error(`Claude's permission session was sent the changes of mode ${JSON.stringify(grantedSession.modes ?? null)}`);
    // The fake was answered nothing but the decisions the run made (M21, C17; M22, C69): an allow with
    // the request's own input, and twice that with the one rule the CLI offered, for the session alone.
    const sessionRule = [{ type: 'addRules', rules: claudeRules, behavior: 'allow', destination: 'session' }];
    const decisions = grantedSession.answers.map(({ subtype, behavior, updatedInput, updatedPermissions }) => ({ subtype, behavior, updatedInput, updatedPermissions: updatedPermissions ?? null }));
    const decided = (updatedPermissions) => ({ subtype: 'success', behavior: 'allow', updatedInput: claudeAsked.input, updatedPermissions });
    if (!same(decisions, [decided(null), decided(sessionRule), decided(sessionRule)])) throw new Error(`the Claude fake was answered ${JSON.stringify(grantedSession.answers.map((answer) => [answer.behavior, answer.updatedPermissions?.length ?? 0]))} for the run's three decisions, expected an allow with the request's own input and two more with the CLI's one rule for the session`);
    if (!same(grantedSession.grants, [...claudeRules, ...claudeRules]) || grantedSession.interrupts.length !== 0) throw new Error(`the Claude fake recorded ${grantedSession.grants?.length ?? 0} session rule(s), expected the command's own, once for each process it was granted on`);
    // Codex's: one thread that never ran a turn, the start fat-g refused; then the session's own —
    // started read-only after the remedy, resumed under Ask first's policy for the two changes, and,
    // where the setup ran, resumed under Sandbox ok's.
    const codexFile = JSON.parse(readFileSync(threadsFile, 'utf8'));
    const permittedThread = codexFile.threads[permitted?.codex.reference];
    if (permittedThread === undefined) throw new Error('the live launches left no Codex permission session in the fake’s thread file');
    if (neverRan() !== neverRanBefore + 1) throw new Error(`the Codex fake holds ${neverRan() - neverRanBefore} more thread(s) that never ran a turn, expected the one whose start was refused`);
    // Its turns: the saved thread's two under Read only, which are the fake's history of it; the change and that file's next
    // change; and under Sandbox ok T1's prompt, which chooses K1's capture of it under a session's handshake (M19, C54).
    if (!same(permittedThread.turns, ['m15-saved', 'm15-resume', CODEX_APPROVAL, `${CODEX_APPROVAL}#2`, ...(windows ? ['m19-answer'] : [])])) throw new Error(`Codex's permission session ran ${JSON.stringify(permittedThread.turns)}`);
    const opened = permittedThread.opens.map((open) => [open.method, open.sandbox, open.approvalPolicy, open.approvalsReviewer]);
    if (!same(opened, [['thread/start', 'read-only', 'never', null], ['thread/resume', 'workspace-write', 'untrusted', 'user'], ...(windows ? [['thread/resume', 'workspace-write', 'on-request', 'user']] : [])])) throw new Error(`Codex's permission session was opened ${JSON.stringify(opened)}`);
    // Each turn named again what its thread's last reply had reported, and nothing else (C7): under Ask
    // first that is the read-only sandbox, which is how an account with none answers a workspace one
    // (C4) — every write asked, and the accepted one ran unconfined — and, once set up, a workspace one.
    const named = permittedThread.policies.map((policy) => [policy.approvalPolicy, policy.approvalsReviewer, policy.sandboxPolicy?.type ?? null]);
    if (!same(named, [['never', null, 'readOnly'], ['never', null, 'readOnly'], ['untrusted', 'user', 'readOnly'], ['untrusted', 'user', 'readOnly'], ...(windows ? [['on-request', 'user', 'workspaceWrite']] : [])])) throw new Error(`the turns of Codex's permission session named the policies ${JSON.stringify(named)}`);
    // The next launch's history check listed its turns and asked for no turn's items (M18, C51): each turn the fake's history holds is one fat-g ran.
    if (!((permittedThread.historyReads ?? []).length > 0 && permittedThread.historyReads.every((read) => read.view === 'notLoaded'))) throw new Error(`the history check of Codex's permission session asked for ${JSON.stringify((permittedThread.historyReads ?? []).map((read) => read.view))}`);
    if (!same(permittedThread.replies.map((reply) => reply.result ?? null), [{ decision: 'accept' }, { decision: 'decline' }])) throw new Error(`the Codex fake was answered ${JSON.stringify(permittedThread.replies.map((reply) => reply.result?.decision ?? null))} for the run's two decisions`);
    // What the fake noted of the account's sandbox, in this run alone: readiness asked of fresh processes, and Codex's one setup request at each press — twice, in the mode that was traced.
    const noted = codexFile.sandbox?.default ?? {};
    const setups = (noted.asked ?? []).filter((entry) => entry.method === 'windowsSandbox/setupStart');
    if (windows ? !(setups.length === 2 && setups.every((entry) => entry.params?.mode === 'elevated') && noted.state === 'ready') : (noted.asked ?? []).length !== 0) throw new Error(`the Codex fake noted ${setups.length} setup request(s) of ${(noted.asked ?? []).length} asked of the account's sandbox, and the state ${JSON.stringify(noted.state ?? null)}`);
    // The scratch project, changed by the fakes alone (C35): the two files the approved requests
    // made, each with its capture's content and each in its fake's own record — the denied change left
    // the second as it was made — and, as the check above found, nothing else.
    const madeNow = Object.fromEntries(liveProjectAfter.filter(([name]) => name in MADE));
    if (!same(madeNow, Object.fromEntries(Object.entries(MADE).map(([name, text]) => [name, Buffer.from(text).toString('base64')])))) throw new Error(`the live project does not hold the files the approved requests made, with the captures' contents: it holds ${Object.keys(madeNow).length} of ${Object.keys(MADE).length}, or one differs`);
    const inLiveProject = (file) => path.basename(file) === claudeMade && realpathSync.native(path.dirname(file)) === realpathSync.native(liveProject);
    if (grantedSession.writes.length !== 1 || !inLiveProject(grantedSession.writes[0])) throw new Error(`the Claude fake made ${grantedSession.writes.length} file(s), expected the one its approved command names, in the live project`);
    if (!same(permittedThread.changes, [{ file: codexMade, kind: 'add' }])) throw new Error(`the Codex fake made ${permittedThread.changes?.length ?? 0} change(s), expected the one file its approved change names`);
    // And each is where it belongs (C28): the command and the changed file's name in the conversation store; the scan above found them nowhere else.
    if (![claudeAsked.input.command, codexMade].every((text) => stored.some(([, held]) => held.includes(text)))) throw new Error('the conversation store does not hold what the sessions asked leave for');
    console.log(`[smoke] approvals passed: Claude's command stood as a card its turn waited on, the capsule reading ${claudeApprovals.capsule}, with nothing run until Approve once, which sent back the request's own input and nothing else, and the fake then made its file; asked again, it was granted for the session by the CLI's own rule at the session destination alone, ran in the next turn with no card, and was listed live; a change to Read only ended the grant with its process, and the next turn asked again; Codex's file change stood as a card under Ask first on an account with no sandbox, was approved and its file made, and the next change of it was denied, its activity reading declined; with a card's whole action shown, the chat's list held nothing a text may not become; the next launch read every card from the store, inert, with every grant ended and no process started; ${approvalNeedles.length} of the scan's needles are the captures' command, change and file names; the live project holds its own files as they were and the ${Object.keys(MADE).length} the fakes made, with the captures' contents, and nothing else; no CSP violation and no request by the page in either launch; the Pet refused the three channels, and its state held no session, mode or setup`);
    console.log(`[smoke] modes passed: a new chat of each provider had Ask first, chosen for it before its first prompt; Claude's went to Edits ok on its live process — one change written, no launch, its grant still live — and to Read only by a new process on the reading launch, every grant ended; a Codex chat left blocked by a start whose reply reported another policy was changed from the block's Change mode, and its next prompt ran; ${windows ? `Sandbox ok stood unavailable with its Set up control, Codex's setup was declined and then approved against the fake (${setups.length} requests, each at a press), and Sandbox ok was then chosen and confirmed by the next start's reply` : 'Sandbox ok stood unavailable with no Set up control, which Codex has on Windows alone, and nothing was asked of a sandbox'}`);

    // M20a (V14; C33, C36–C40, C47): what each session did is in its chat as groups; a read's row
    // opened to its output, the file it names opened as a tab, and a worker's row chose the sub-agent
    // in the Sub-agents tab, whose thread showed the worker's own read the same way (M106, C4).
    const { activity: codexActivity, claudeActivity } = reported('first');
    for (const [who, found] of [['Codex', codexActivity], ['Claude', claudeActivity]]) {
      if (!(found?.groups > 0 && found.readOutput > 0 && found.workerEntries > 0 && found.workerReadOutput > 0 && found.workerReads > 0 && String(found.workerTab ?? '') !== '')) throw new Error(`${who}'s activity was not shown as it should be: ${JSON.stringify(found ?? null)}`);
      // Two tabs were opened from it: the file its own read names, and the file the worker's read names; and
      // the Sub-agents tab, first, which opens by itself once the session has a sub-agent (M100, round 8;
      // C78) and holds the worker's thread (M106, C4).
      const opened = found.tabs.filter((title) => title !== 'Sub-agents');
      if (opened.length !== 2 || found.tabs[0] !== 'Sub-agents' || found.workerTab !== 'Sub-agents' || !opened.includes('sample.txt') || !opened.includes('notes-3.txt')) throw new Error(`${who}'s activity opened the tabs ${JSON.stringify(found.tabs)}`);
    }
    console.log(`[smoke] activity passed: a Codex turn and a Claude turn each showed its work as groups (${codexActivity.groups} and ${claudeActivity.groups}); a read's row opened to its output, with its Copy buttons and no control made of it; the file it names opened as a tab; a worker's row chose the sub-agent in the ${JSON.stringify(codexActivity.workerTab)} tab, whose thread showed the worker's own read and its file the same way and took no prompt; nothing of a worker's was in its session's chat`);

    // M19b (V15; C33, C46): a reference in an answer of each provider opened its file as a tab, after
    // the session's Sub-agents tab (M106, C2), the next launch began with the Sub-agents tab alone —
    // its finished sub-agent listed from the store (M106, C1, C26) — and opened a file again from the stored chat, a reference outside the
    // project said so and opened nothing, and an address reached the browser's stand-in.
    const { files: codexFiles, claudeFiles, tabsBySession, pet: petFirst } = reported('first');
    const { tabsAfterRestart } = reported('next');
    for (const [who, found, tabs] of [['Codex', codexFiles, ['Sub-agents', 'README.md', 'tides.js']], ['Claude', claudeFiles, ['Sub-agents', 'README.md', 'tides.js', 'harbour-log.md']]]) {
      if (found?.readme !== HEADINGS['README.md'] || !String(found.source ?? '').includes('nextHighTide')) throw new Error(`${who}'s references did not open the README and the source file at its line: ${JSON.stringify(found ?? null)}`);
      if (JSON.stringify(found.tabs) !== JSON.stringify(tabs)) throw new Error(`${who}'s session has the tabs ${JSON.stringify(found.tabs)}, expected ${JSON.stringify(tabs)}`);
      if (found.external !== 2 || found.shownInFolder !== 1 || found.foreignElements !== 0 || found.activeAttributes !== 0) throw new Error(`${who}'s references that lead out, or the pane, are not as they should be: ${JSON.stringify(found)}`);
    }
    if (claudeFiles.log !== HEADINGS['field notes/harbour-log.md']) throw new Error(`Claude's bare name was not looked up in the project's folders: ${JSON.stringify(claudeFiles.log)}`);
    // M19b (V24; C64, C65): a name in bold is a reference as a code span's is, and a line said in words beside one is come to.
    if (codexFiles.log !== HEADINGS['field notes/harbour-log.md']) throw new Error(`Codex's name in bold was not opened: ${JSON.stringify(codexFiles.log)}`);
    for (const [who, found] of [['Codex', codexFiles], ['Claude', claudeFiles]]) {
      if (!String(found.spokenLine ?? '').includes('parseTime')) throw new Error(`${who}'s name in bold did not open its file at the line said in words: ${JSON.stringify(found.spokenLine ?? null)}`);
    }
    if (JSON.stringify(tabsBySession?.codex) === JSON.stringify(tabsBySession?.claude) || tabsBySession === undefined) throw new Error(`each session did not keep its own tabs: ${JSON.stringify(tabsBySession ?? null)}`);
    if (tabsAfterRestart?.atStart !== 4 || !(tabsAfterRestart.subAgentsListed > 0) || tabsAfterRestart.reopened !== HEADINGS['README.md']) throw new Error(`the next launch did not restore Sub-agents and three saved side questions, then open a file from the stored chat: ${JSON.stringify(tabsAfterRestart ?? null)}`);
    if (JSON.stringify(petFirst?.files.slice(0, 3)) !== JSON.stringify(['forbidden', 'forbidden', 'forbidden'])) throw new Error(`the Pet was not refused the two file channels and the address channel: ${JSON.stringify(petFirst?.files ?? null)}`);
    // A file's text is shown and never kept (C33): no file's marker is in the output, or in any file
    // of the data folder — the conversation store's own files included, which hold what was said and
    // nothing of what was opened.
    const shownMarkers = [...FILE_MARKERS, ...TOOL_FILE_MARKERS];
    const fileLeaks = [
      ...(shownMarkers.some((marker) => output.includes(marker)) ? ['app output'] : []),
      ...files(smokeData).filter(([, text]) => shownMarkers.some((marker) => text.includes(marker))).map(([file]) => file),
    ];
    if (fileLeaks.length) throw new Error(`a project file's text reached: ${fileLeaks.join(', ')}`);
    // And the markers are where they belong: in the files, in the live project's folder.
    if (!shownMarkers.every((marker) => files(liveProject).some(([, text]) => text.includes(marker)))) throw new Error('the live project’s files do not hold their markers: the scan above looked for nothing');
    console.log(`[smoke] artifact pane passed: a Codex answer's link and a Claude answer's code span each opened the README, drawn with its heading, and the source file at its line; Claude's bare name and Codex's name in bold were looked up in the project's folders; a name in bold opened its file at the line said in words after it; a reference outside the project said so and opened nothing; ${codexFiles.external + claudeFiles.external} addresses reached the browser's stand-in and no browser; each session kept its own tabs, the next launch began with none and opened one again; and none of ${FILE_MARKERS.length} file markers is in the output or in any file of the data folder`);
  } catch (error) { console.error('[smoke]', error.message); result = 1; }
  // A format change has no migration before the first release (decision 0014): a smoke data folder
  // an earlier build wrote is refused, as a user's would be, and every later check fails on it.
  if (result !== 0 && /\[prefs\] preferences are incompatible|\[(conversations|records)\] refused: (older|newer)/.test(output)) {
    console.error(`[smoke] note: ${smokeData} holds files of another format version, which this build refuses. It is the smoke runs' own folder: delete it and run again.`);
  }
  rmSync(directory, { recursive: true, force: true });
  process.exit(result);
}

/**
 * A capture's conversation: the prompts sent, and every text the fake sends back, long enough to be
 * told apart. `keys` are the fields a provider's frames carry text under: Codex's under `text`;
 * Claude's also under `content` (a prompt, what a tool read) and `result` (a turn's last text).
 */
/** A text as a file's bytes read as latin1 spell it: what a scan of a file compares it with. */
function asScanned(text) {
  return Buffer.from(text, 'utf8').toString('latin1');
}

function texts(frames, keys) {
  const found = [];
  const walk = (value) => {
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    if (value === null || typeof value !== 'object') return;
    for (const [key, inner] of Object.entries(value)) {
      if (keys.includes(key) && typeof inner === 'string' && inner.length >= 12 && !inner.includes('<')) found.push(inner);
      else walk(inner);
    }
  };
  for (const entry of frames) walk(entry.frame);
  return found;
}

/** A value as JSON with every object's keys in order: two values that hold the same read the same, however their keys were written. */
function canonical(value) {
  return JSON.stringify(value, (_key, inner) => (inner !== null && typeof inner === 'object' && !Array.isArray(inner) ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b))) : inner));
}

/** Takes what the Codex fake noted of its accounts' sandboxes out of its thread file (M22): its threads stay, for a later launch to resume. */
function forgetSandbox(file) {
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch { return; }
  if (data === null || typeof data !== 'object' || data.sandbox === undefined) return;
  delete data.sandbox;
  writeFileSync(file, JSON.stringify(data));
}

/** Writes the next catalog.json for the app to find, and answers which one: valid or broken. */
function placeCatalog(file) {
  let last = null;
  try { last = JSON.parse(readFileSync(file, 'utf8')).smoke ?? null; } catch { /* none, or not JSON */ }
  const next = last === 'valid' ? 'broken' : 'valid';
  // The broken one has a known field of the wrong type: ignored whole, with the field at fault.
  const hidden = next === 'valid' ? true : 'yes';
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, minReaderVersion: 1, smoke: next, providers: { codex: { models: { 'gpt-5.5': { hidden } } } } }, null, 2)}\n`);
  return next;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

function lines(file) {
  try { return readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean); } catch { return []; }
}

/** "<pid> [role] <started>" lines as { pid, role, started }. */
function ledger(file, withRole) {
  return lines(file).map((line) => {
    const parts = line.split(' ');
    return { pid: Number(parts[0]), role: withRole ? parts[1] : undefined, started: Number(parts.at(-1)) };
  });
}

/**
 * Windows only: when each of these PIDs' current process started (epoch ms), or null when that
 * cannot be established. Reads nothing but that timestamp. A same-user fixture is always readable,
 * so after a successful query a PID missing here is gone or not ours.
 */
function startTimes(pids) {
  if (process.platform !== 'win32') return null;
  if (pids.length === 0) return new Map();
  const shell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // `exit 0`: PowerShell reports 1 whenever a PID is missing, which here just means it is gone.
  const script = `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { try { '{0} {1}' -f $_.Id, ([DateTimeOffset]$_.StartTime).ToUnixTimeMilliseconds() } catch { } }; exit 0`;
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  if (result.error || result.status !== 0) return null;
  return new Map((result.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).map((line) => line.split(' ').map(Number)));
}

/** A folder as it is: every folder and file under it by name, each file with its bytes. */
function folderContents(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return [path.relative(root, file), entry.isFile() ? readFileSync(file).toString('base64') : 'folder'];
    })
    .sort(([a], [b]) => a.localeCompare(b));
}

/** Every readable file under `root` (bounded per file), as [path, text]. */
function files(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).flatMap((entry) => {
    const file = path.join(entry.parentPath, entry.name);
    try { return statSync(file).size <= 8 * 1024 * 1024 ? [[file, readFileSync(file, 'latin1')]] : []; } catch { return []; }
  });
}
