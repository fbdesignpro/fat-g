// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Source invariants the linter cannot express (dynamic imports, string literals, argument lists):
// they must keep holding across refactors and CLI updates. Production sources only.
//
// Three kinds of Claude session, each with its own closed set in its own module (decisions 0006,
// 0020 and 0028; docs/planning/_archive/M16.md, Design 1; docs/planning/_archive/M26.md, Design 2): the usage
// and models-only sessions' client, a chat session's wire, and the secretary's wire. Each is held
// to its own set here, file by file.
//
// Since M22 (decision 0027; docs/planning/_archive/M22.md, Design 5, 6, 8; V7; C22, C47, C67, C69) a chat
// session runs under a mode and may give leave for an action. What that added is held to one file
// each: the CLI's own words for its modes in the mode table, the change of mode and the one update
// a reply may carry in the wire, and no word anywhere for a scope the CLI would save a rule at, or
// for a flag that bypasses permissions.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SECRETARY_ARGS, secretaryArgs } from '../../src/main/providers/claude/secretary';
import { CONTROL_ARGS, INITIALIZE_REQUEST } from '../../src/main/providers/claude/session';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CLAUDE = 'src/main/providers/claude';

function productionSources(directory = 'src'): string[] {
  return readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return productionSources(relative);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [relative] : [];
  });
}
const sources = productionSources().map((file) => ({ file, text: readFileSync(path.join(ROOT, file), 'utf8') }));
const containing = (pattern: RegExp) => sources.filter(({ text }) => pattern.test(text)).map(({ file }) => file);
const read = (file: string) => readFileSync(path.join(ROOT, CLAUDE, file), 'utf8');
const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;

/** The module's production files. Test support is no part of what ships. */
const claudeSources = () => sources.filter(({ file }) => file.startsWith(`${CLAUDE}/`) && !file.endsWith('-test-support.ts'));
const claudeFiles = (pattern: RegExp) => claudeSources().filter(({ text }) => pattern.test(text)).map(({ file }) => file.slice(CLAUDE.length + 1)).sort();

/** The usage and models-only sessions' own files: decision 0006's two subtypes, and nothing of a chat session's. */
const USAGE_SESSION = ['control-client.ts', 'session.ts', 'usage-experimental.ts'];
/** The one writer to each kind of session's process (M16, Design 1). */
const WRITERS = ['chat-wire.ts', 'control-client.ts', 'secretary-wire.ts'];
/** The one file of names the CLI reports or asks by, which the checks compare (M16, C22, C67). */
const NAMES = 'chat-frames.ts';
/** The one file of the CLI's own words for its permission modes, and of the tools each is launched with (M22, C5, C47). */
const MODES = 'chat-modes.ts';

/** A source without its comment lines: what it does, and not what its comments say it does not. */
const code = (text: string): string => text.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

/** The `kind` literals of one exported union in chat-wire.ts, in the order they are written. */
function unionKinds(name: string): string[] {
  const body = new RegExp(`export type ${name} =([\\s\\S]*?);\\n\\n`).exec(read('chat-wire.ts'))?.[1];
  if (body === undefined) throw new Error(`chat-wire.ts has no ${name}`);
  return [...body.matchAll(/\bkind: '([a-z-]+)'/g)].map((match) => match[1] as string);
}

describe('Claude control protocol confinement (decisions 0001, 0006 and 0020)', () => {
  it('scans the real tree', () => {
    expect(sources.length).toBeGreaterThan(50);
    expect(sources.map(({ file }) => file)).toEqual(expect.arrayContaining([`${CLAUDE}/control-client.ts`, `${CLAUDE}/session.ts`, `${CLAUDE}/usage-experimental.ts`, `${CLAUDE}/chat-wire.ts`]));
  });

  it('names no Anthropic package in any production file or dependency list, statically or dynamically', () => {
    expect(containing(/@anthropic-ai\//)).toEqual([]);
    for (const list of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      expect(Object.keys(packageJson[list] ?? {}).filter((name) => name.startsWith('@anthropic-ai/')), list).toEqual([]);
    }
  });

  it('can send only initialize and get_usage — never a login, OAuth or any other request', () => {
    expect(read('control-client.ts')).toMatch(/export type ControlSubtype = 'initialize' \| 'get_usage';/);
    // Every subtype the usage client could put on the wire is a string literal passed to request().
    const requested = claudeSources().flatMap(({ text }) => [...text.matchAll(/\brequest\(\s*'([a-z_]+)'/g)].map((match) => match[1]));
    expect(new Set(requested)).toEqual(new Set(['initialize', 'get_usage']));
    // Nothing of a chat session's is spelled in the usage session's own files.
    for (const file of USAGE_SESSION) {
      for (const forbidden of ['can_use_tool', 'mcp_message', 'set_permission_mode', 'interrupt', 'apply_flag_settings', 'effortLevel']) expect(read(file).includes(forbidden), `${file}: ${forbidden}`).toBe(false);
    }
  });

  // M20b (V5; S5, C13, C15, C27; decision 0025): a side question and its cancel are the fifth and the sixth.
  // M21 (V6; S6, C17, C29; decision 0026): the third answer is the user's answer to a question.
  // M22 (V7; C5, C13; decision 0027): the seventh send changes the permission mode, and the fourth answer is leave for one action.
  // M22b (V6; C7, C11, C51; decision 0029): the fifth and the sixth answers are a plan's feedback and its Cancel; its Execute is the fourth.
  it('a chat session can send ten things and answer six, in one module (decisions 0020, 0025, 0026, 0027, 0029, 0033)', () => {
    // M23 (C36, C43): the eighth, a message written while a turn runs — a prompt's own frame.
    // Decision 0020: the ninth, fast mode on or off, by the effort's own subtype.
    // Decision 0033: the tenth, how full the context window is.
    expect(unionKinds('ChatSend')).toEqual(['initialize', 'prompt', 'steer', 'interrupt', 'effort', 'fast', 'side-question', 'cancel', 'set-mode', 'context']);
    // A prompt and a message sent now share one case, and so one frame and one encoder.
    expect(read('chat-wire.ts')).toMatch(/case 'prompt':\n(\s*\/\/[^\n]*\n)*\s*case 'steer': return \{ type: 'user'/);
    // An interrupt names the drop of what the CLI holds, and nothing else (C43).
    expect([...read('chat-wire.ts').matchAll(/subtype: 'interrupt', ([^\n]*)\} \};/g)].map((match) => match[1]?.trim())).toEqual(["...(send.cancelQueued === true ? { cancel_queued: true } : {})"]);
    expect(unionKinds('ChatAnswer')).toEqual(['deny', 'unsupported', 'allow-question', 'allow-action', 'plan-feedback', 'plan-cancel']);
    const wire = read('chat-wire.ts');
    // The subtypes its frames can carry: six requests, and the two replies' own.
    expect(new Set([...wire.matchAll(/\bsubtype: '([a-z_]+)'/g)].map((match) => match[1]))).toEqual(new Set(['initialize', 'interrupt', 'apply_flag_settings', 'side_question', 'set_permission_mode', 'get_context_usage', 'success', 'error']));
    // The context's request asks for its summary detail alone, which the CLI answers with no token-count call of its own (decision 0033).
    expect([...wire.matchAll(/subtype: 'get_context_usage', ([^\n]*)\} \};/g)].map((match) => match[1]?.trim())).toEqual(["detail: 'summary'"]);
    expect(claudeFiles(/'get_context_usage'/)).toEqual(['chat-wire.ts']);
    // A change of mode carries the mode's word alone, and only one of the words the mode table lets a change name (C74).
    expect([...wire.matchAll(/subtype: 'set_permission_mode', ([^\n]*)\} \};/g)].map((match) => match[1]?.trim())).toEqual(['mode: send.mode']);
    const sends = /export function encodeSend\(send: ChatSend, requestId: string, launch: string \| null = null\): unknown \{([\s\S]*?)\n\}/.exec(wire)?.[1] ?? '';
    const change = /case 'set-mode':([\s\S]*?)default:/.exec(sends)?.[1] ?? '';
    // M22b (C7, C51): the plan word too, and — on a restoration alone — the process's own launch word, which the wire was made with and no frame names.
    expect(change).toMatch(/^\s*(\/\/[^\n]*\n\s*)*if \(!mayName\(send\.mode, launch, send\.restoring === true\)\) throw new TypeError\(/);
    expect(change.indexOf('mayName(send.mode')).toBeLessThan(change.indexOf("subtype: 'set_permission_mode'"));
    expect([...wire.matchAll(/encodeSend\(what, requestId \?\? '', ([a-z]+)\)/g)].map((match) => match[1])).toEqual(['launch']);
    expect([...wire.matchAll(/export function createChatWire\(([^)]*)\)/g)].map((match) => match[1])).toEqual(["child: Pick<ManagedProcess, 'write'>, launch: string | null = null"]);
    expect([...read('chat-launch.ts').matchAll(/createChatWire\(([^)]*)\)/g)].map((match) => match[1])).toEqual(['opened.process, options.launchWord ?? null']);
    expect([...read('chat-session.ts').matchAll(/launchWord: ([^,]+),/g)].map((match) => match[1])).toEqual(['inForce.native']);
    // The frames it writes are of four types: a request, a prompt, a cancel, and an answer — the blocks
    // of a prompt's content aside (M23, C21), which are its user frame's and no frame of their own.
    const frames = wire.replace(/export function userContent[\s\S]*?\n\}\n/, '');
    expect([...new Set([...frames.matchAll(/\{ type: '([a-z_]+)'/g)].map((match) => match[1]))].sort()).toEqual(['control_cancel_request', 'control_request', 'control_response', 'user']);
    // A prompt's content (M23, C21; K2): its text, or the text block and one base64 image block per image, and nothing else.
    const content = /export function userContent[\s\S]*?\n\}\n/.exec(wire)?.[0] ?? '';
    expect(new Set([...content.matchAll(/\{ type: '([a-z0-9_]+)'/g)].map((match) => match[1]))).toEqual(new Set(['text', 'image', 'base64']));
    // A side question carries its text and its history's pairs, each its two texts; a cancel the id of the request it takes back.
    expect([...wire.matchAll(/subtype: 'side_question', ([^\n]*)\} \};/g)].map((match) => match[1]?.trim())).toEqual(['question: send.question, ...(send.history.length === 0 ? {} : { history: send.history.map((pair) => ({ question: pair.question, response: pair.response })) })']);
    expect([...wire.matchAll(/\{ type: 'control_cancel_request'[^\n]*/g)].map((match) => match[0])).toEqual(["{ type: 'control_cancel_request', request_id: send.requestId };"]);
    // `apply_flag_settings` carries `effortLevel` alone, or `fastMode` alone (decision 0020).
    expect([...wire.matchAll(/\bsettings: \{([^}]*)\}/g)].map((match) => match[1]?.trim())).toEqual(['effortLevel: send.level', 'fastMode: send.on']);
    // One `user` frame, holding its content and one id.
    expect([...wire.matchAll(/\{ type: 'user'[^\n]*/g)].map((match) => match[0])).toEqual(["{ type: 'user', uuid: send.id, message: { role: 'user', content: userContent(send.text, send.images) }, parent_tool_use_id: null, session_id: '' };"]);
    // What a reply says: `deny` three times — fat-g's or the user's refusal, a plan's feedback and its Cancel — and `allow` twice — the answer to a question, and leave for one action, a plan's Execute among them.
    expect([...wire.matchAll(/\bresponse: \{ behavior: '([a-z]+)'/g)].map((match) => match[1])).toEqual(['deny', 'deny', 'deny', 'allow', 'allow']);
    expect(new Set([...wire.matchAll(/\bbehavior: '([a-z]+)'/g)].map((match) => match[1]))).toEqual(new Set(['deny', 'allow']));
    // Its four refusal messages are a closed list, chosen by who refused — and, for the user, what (M100b, C31) — and never passed in;
    // a plan's feedback is the user's own words, the one deny that carries them (M22b, C11), and its Cancel fat-g's, with the interrupt.
    expect([...wire.matchAll(/\bbehavior: 'deny', message: ([^}]*) \}/g)].map((match) => match[1])).toEqual(["answer.by === 'user' ? USER_DENY_MESSAGE : answer.by === 'user-skipped' ? USER_DECLINE_MESSAGE : answer.by === 'no-plan' ? PLAN_MISSING_MESSAGE : DENY_MESSAGE", 'answer.text', 'PLAN_CANCEL_MESSAGE, interrupt: true']);
    expect([...wire.matchAll(/\binterrupt: true\b/g)]).toHaveLength(1);
  });

  // M21 (V6; S6, C16, C17, C29): one `allow` is the answer to a question, for one tool's name.
  it('allows one tool’s use as an answer, the one that asks the user, and names it in the five files that offer, read and answer it', () => {
    const wire = read('chat-wire.ts');
    // The answer is typed to the tool's name as a literal, and the encoder refuses any other before it writes `allow`.
    // M22: leave for an action is typed to any tool's name — and its encoder refuses this one's.
    const answers = new RegExp('export type ChatAnswer =([\\s\\S]*?);\\n\\n').exec(wire)?.[1] ?? '';
    expect([...answers.matchAll(/readonly tool: ([^;]+);/g)].map((match) => match[1])).toEqual(["'AskUserQuestion'", 'string']);
    const encoder = /export function encodeAnswer\(answer: ChatAnswer\): unknown \{([\s\S]*?)\n\}/.exec(wire)?.[1] ?? '';
    const allowed = /case 'allow-question':([\s\S]*?)case 'allow-action':/.exec(encoder)?.[1] ?? '';
    expect(allowed).toMatch(/^\s*(\/\/[^\n]*\n\s*)*if \(answer\.tool !== 'AskUserQuestion'\) throw new TypeError\(/);
    expect(allowed.indexOf("answer.tool !== 'AskUserQuestion'")).toBeLessThan(allowed.indexOf("behavior: 'allow'"));
    // What each `allow` carries: a question's, the request's input as it came with the answers beside it;
    // an action's, the request's input as it came, and the one update below or none.
    expect([...wire.matchAll(/\bresponse: \{ behavior: 'allow', ([^\n]*)\} \} \};/g)].map((match) => match[1]?.trim())).toEqual(['updatedInput: { ...answer.input, answers: answer.answers }', 'updatedInput: answer.input, ...update']);
    // No file but the wire spells the field an `allow` sends a tool's input back by.
    expect(claudeFiles(/updatedInput/)).toEqual(['chat-wire.ts']);
    // The tool is named where it is offered, answered, read, kept and told apart from an activity: nowhere else.
    expect(claudeFiles(/AskUserQuestion/)).toEqual(['chat-frames.ts', 'chat-mapper.ts', MODES, 'chat-tools.ts', 'chat-wire.ts']);
    // M22b (C8, C9): the plan's tool is the mode table's constant, and the wire's words to a request that carried no plan.
    expect(claudeFiles(/ExitPlanMode/)).toEqual([MODES, 'chat-wire.ts']);
    expect(claudeFiles(/\bPLAN_TOOL\b/)).toEqual(['chat-frames.ts', MODES, 'chat-session.ts', 'chat-tools.ts']);
    // The CLI's own words for whose question it is, and for taking a request back, are read in the
    // file of names alone; the wire spells the second for the one cancel fat-g sends, a side question's.
    expect(claudeFiles(/agent_id/)).toEqual([NAMES]);
    expect(claudeFiles(/control_cancel_request/)).toEqual([NAMES, 'chat-wire.ts']);
  });

  // M22 (V7, V27; C13, C21, C22, C68, C69; decision 0027): the other `allow` is leave for one action, and what may go with it is one thing.
  it('gives leave for an action with the request’s own input, and with one update alone: the CLI’s rule at the session’s scope, written field by field in the wire', () => {
    const wire = read('chat-wire.ts');
    const encoder = /export function encodeAnswer\(answer: ChatAnswer\): unknown \{([\s\S]*?)\n\}/.exec(wire)?.[1] ?? '';
    const action = /case 'allow-action': \{([\s\S]*?)default:/.exec(encoder)?.[1] ?? '';
    // Never the tool that asks the user, and never an update that is not an allow rule at the session's scope: each refused before `allow` is written.
    expect(action).toMatch(/^\s*(\/\/[^\n]*\n\s*)*if \(answer\.tool === 'AskUserQuestion'\) throw new TypeError\(/);
    expect(action).toContain("if (grant !== null && (grant.type !== 'addRules' || grant.behavior !== 'allow' || grant.destination !== 'session' || !Array.isArray(grant.rules))) throw new TypeError(");
    expect(action.indexOf("grant.destination !== 'session'")).toBeLessThan(action.indexOf("behavior: 'allow', updatedInput"));
    // The update, whole: one entry, its four fields written here, its rules the grant's own. Nothing is spread into it from what the CLI offered.
    expect([...wire.matchAll(/updatedPermissions: ([^\n]*);/g)].map((match) => match[1])).toEqual(["[{ type: 'addRules', rules: grant.rules, behavior: 'allow', destination: 'session' }] }"]);
    expect(action).not.toMatch(/\.\.\.(grant|suggestion|answer\.grant)/);
    // And the grant itself is made in one place, of the offer's rules and the session's scope: the scope the CLI wrote is never copied.
    expect([...wire.matchAll(/grant: \{ ([^}]*) \}/g)].map((match) => match[1])).toEqual(["type: 'addRules', rules, behavior: 'allow', destination: 'session'"]);
    // The words of an update, of a rule, and of the offers that are never sent back — a mode, a folder — are the wire's alone.
    for (const word of ['updatedPermissions', 'addRules', "destination: 'session'", "'setMode'", 'addDirectories', 'ruleContent', 'toolName']) expect(claudeFiles(new RegExp(word)), word).toEqual(['chat-wire.ts']);
    // The session's is the only scope any file names: no word for one the CLI would save a rule at, and none for a rule that replaces, removes or always allows (C22).
    for (const forbidden of ['localSettings', 'userSettings', 'projectSettings', 'policySettings', 'flagSettings', 'alwaysAllow', 'allowedTools', 'disallowedTools', 'replaceRules', 'removeRules', 'removeDirectories']) expect(claudeFiles(new RegExp(forbidden)), forbidden).toEqual([]);
    // What the CLI offers is read from the request in the file of names, and for its kind in the wire: no other file looks into an offer.
    expect(claudeFiles(/permission_suggestions/)).toEqual([NAMES]);
    expect(claudeFiles(/\breadOffer\(/)).toEqual(['chat-session.ts', 'chat-wire.ts']);
  });

  // M22 (V7; C5, C45, C47, C74; decision 0027): a mode is the CLI's own word in one file, a launch argument from that file, and a change by one send.
  it('names the CLI’s permission modes in the mode table alone, launches each by its two arguments and no flag, and changes one by the wire’s one send', () => {
    // The CLI's words for its modes: the mode table's, and no other file's — in its code or in a comment.
    for (const word of ['acceptEdits', 'bypassPermissions', "'auto'", "'manual'"]) expect(claudeFiles(new RegExp(word)), word).toEqual([MODES]);
    // `default` is also a model's key, and the usage session's own fixed argument (decision 0006): as a chat session's mode it is the mode table's.
    expect(claudeFiles(/'default'/)).toEqual([MODES, 'models.ts', 'session.ts']);
    for (const never of ['dontAsk']) expect(claudeFiles(new RegExp(never)), never).toEqual([]);
    // M22b (C7): the plan word is the mode table's constant, and no change names it but by that constant.
    expect(claudeFiles(/PLAN_WORD = 'plan'/)).toEqual([MODES]);
    expect(claudeFiles(/mode: 'plan'/)).toEqual([]);
    expect(/export const PLAN_MODES: readonly ClaudeModeId\[\] = \[([^\]]*)\];/.exec(read(MODES))?.[1]).toBe("'ask-first', 'edits-ok', 'auto-reviewed', 'berserk'");
    expect(/export function mayName\(word: string, launch: string \| null, restoring: boolean\): boolean \{\n\s*return ([^\n]*)\n\}/.exec(read(MODES))?.[1]).toBe('SETTABLE_WORDS.has(word) || word === PLAN_WORD || (restoring && launch !== null && word === launch);');
    expect(claudeFiles(/set_permission_mode/)).toEqual(['chat-wire.ts']);
    // The five, each with its word and its tools; the three a change may name; and the two tool lists.
    const modes = read(MODES);
    expect([...modes.matchAll(/^ {2}(?:'([a-z-]+)'|([a-z]+)): mode\('([a-z-]+)', '([A-Za-z]+)', ([A-Z_]+)(, true)?\),$/gm)].map((match) => [match[1] ?? match[2], match[3], match[4], match[5], match[6] !== undefined])).toEqual([
      ['read-only', 'read-only', 'default', 'READING_TOOLS', true], ['ask-first', 'ask-first', 'default', 'EXECUTION_TOOLS', false], ['edits-ok', 'edits-ok', 'acceptEdits', 'EXECUTION_TOOLS', false],
      ['auto-reviewed', 'auto-reviewed', 'auto', 'EXECUTION_TOOLS', false], ['berserk', 'berserk', 'bypassPermissions', 'EXECUTION_TOOLS', false],
    ]);
    expect(/const SETTABLE: readonly ClaudeModeId\[\] = \[([^\]]*)\];/.exec(modes)?.[1]).toBe("'ask-first', 'edits-ok', 'auto-reviewed'");
    // The tools: M21's five for the reading mode, and those with the three that act, the two of the web and the plan's tool (M22b, C8) for every other (C5) — no twelfth.
    expect(/export const READING_TOOLS = \[([^\]]*)\] as const;/.exec(modes)?.[1]).toBe("'Read', 'Glob', 'Grep', 'Agent', 'AskUserQuestion'");
    expect(/export const WEB_TOOLS = \[([^\]]*)\] as const;/.exec(modes)?.[1]).toBe("'WebFetch', 'WebSearch'");
    expect(/export const EXECUTION_TOOLS = \[([^\]]*)\] as const;/.exec(modes)?.[1]).toBe("...READING_TOOLS, 'Bash', 'Write', 'Edit', ...WEB_TOOLS, PLAN_TOOL");
    // A launch's permission mode is written in one place, from the mode table; the usage session's is its own fixed argument.
    expect(claudeFiles(/--permission-mode/)).toEqual(['chat-launch.ts', 'session.ts']);
    expect([...read('chat-launch.ts').matchAll(/'--permission-mode', ([^,]+),/g)].map((match) => match[1])).toEqual(['mode.native']);
    // No flag that bypasses permissions, in either spelling, in any file — code or comment (C47; decision 0020, item 4).
    for (const { file, text } of claudeSources()) expect(/dangerously|skip-permissions/i.test(text), file).toBe(false);
    // What is exposed is one constant (C85), and the flag's refusal another, empty for the installed CLI.
    expect(/export const VALIDATED_MODES: readonly ClaudeModeId\[\] = \[([^\]]*)\];/.exec(modes)?.[1]).toBe("'read-only', 'ask-first', 'edits-ok', 'auto-reviewed', 'berserk'");
    expect(/export const FLAG_ONLY_MODES: readonly ClaudeModeId\[\] = \[([^\]]*)\];/.exec(modes)?.[1]).toBe('');
  });

  // M22 (V7; C67, C71): of a line over the limit the adapter keeps its kind and its id, and nothing else.
  it('reads of a line over the limit only what the kit’s peek gives: no file looks at its bytes', () => {
    const launch = read('chat-launch.ts');
    // The line's bytes go to the kit's bounded peek, which answers a kind, an id and a size; that answer is all the session is handed.
    // M22b (C79): and, of a request, the one field of its own object that names its tool.
    expect([...launch.matchAll(/options\.onOversized\(([^\n]*)\); \} catch/g)].map((match) => match[1])).toEqual(["peekLine(line, { types: [REQUEST_TYPE], name: { object: 'request', field: 'tool_name' } }), answer"]);
    expect(launch).toContain("const REQUEST_TYPE = 'control_request';");
    for (const { file, text } of claudeSources()) {
      expect(code(text).match(/\.peek\b/g) ?? [], file).toEqual([]);
      expect(code(text).includes('OversizedLine'), file).toBe(false);
    }
    expect(claudeFiles(/\bpeekLine\(/)).toEqual(['chat-launch.ts']);
    // Nothing of it is logged but that a line was dropped, and that a request was refused, under fat-g's own name for it.
    expect(read('chat-session.ts')).toContain("context.logger.record({ type: 'request-refused', method: OVERSIZED_REQUEST });");
  });

  // M19 (V5; S7, C9, C10): streaming changes what a chat session is launched with by one argument,
  // and what it sends by nothing. Of a reply as it is written it reads a text's own words and no more.
  // M20b (C54; decision 0023): but for the flag that turned the CLI's commands off, which no file of the adapter names.
  it('launches a chat session with M16’s arguments and the one that asks for partial messages, and reads of a stream event only a text’s own', () => {
    const launch = read('chat-launch.ts');
    // M22 (C5, C45): the fixed list is a function of the session's mode, which gives it two values and nothing else.
    const fixed = /export function chatFixedArgs\(mode: ClaudeMode\): readonly string\[\] \{\n {2}return Object\.freeze\(\[([\s\S]*?)\]\);\n\}/.exec(launch)?.[1] ?? '';
    expect([...fixed.matchAll(/'([^']+)'|(mode\.native)|(mode\.tools\.join\(','\))/g)].map((match) => match[1] ?? (match[2] !== undefined ? '<mode>' : '<tools>'))).toEqual([
      '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
      '--setting-sources', 'user,project,local',
      '--permission-mode', '<mode>', '--permission-prompt-tool', 'stdio',
      '--tools', '<tools>',
      '--include-partial-messages',
    ]);
    // Nothing else of the mode reaches the line: the function reads those two fields of it.
    expect([...new Set([...fixed.matchAll(/\bmode\.([a-zA-Z]+)/g)].map((match) => match[1]))].sort()).toEqual(['native', 'tools']);
    for (const { file, text } of claudeSources()) expect(code(text).includes('disable-slash-commands'), file).toBe(false);
    // The tools are the mode table's (M21, C16, C29; M22, C5): the five for the reading mode — the four that read, which an aside added none to, and the one that asks the user.
    expect(/export const READING_TOOLS = \[([^\]]*)\] as const;/.exec(read(MODES))?.[1]).toBe("'Read', 'Glob', 'Grep', 'Agent', 'AskUserQuestion'");
    // The sends and the three answers are the test above's: streaming added none.
    expect(read('chat-wire.ts')).not.toMatch(/partial|stream_event/);
    // What is read of a `stream_event`: its event's type, a block's index and type, a reply's id and model, a text delta's text.
    const frames = read('chat-frames.ts');
    const take = /export function takeStream\(frame: unknown\): StreamFrame \| null \{([\s\S]*?)\n\}/.exec(frames)?.[1] ?? '';
    expect(take).not.toBe('');
    expect([...new Set([...take.matchAll(/\['([a-z_]+)'\]/g)].map((match) => match[1]))].sort()).toEqual(['id', 'model', 'text', 'type']);
    expect([...new Set([...take.matchAll(/event\.([a-z_]+)/g)].map((match) => match[1]))].sort()).toEqual(['content_block', 'delta', 'index', 'message', 'type']);
    // The deltas of a thinking, a signature and a tool's input are named nowhere in what the adapter
    // reads of a frame, and neither is a signature. A thinking block's own text is read from its
    // `assistant` frame alone, whole (M20a, C17; decision 0020, item 14): never from a stream event.
    expect(frames).not.toMatch(/thinking_delta|signature_delta|input_json_delta|partial_json|\['signature'\]/);
    expect(take).not.toMatch(/\['thinking'\]/);
    expect(frames.match(/\['thinking'\]/g)).toHaveLength(3);
    const assistant = /export function takeAssistant\(frame: unknown\): AssistantFrame \| null \{([\s\S]*?)\n\}/.exec(frames)?.[1] ?? '';
    expect(assistant.match(/\['thinking'\]/g)).toHaveLength(3);
  });

  it('spells no login, model, settings or MCP request on either kind of session, and no request that lists or edits the CLI’s rules', () => {
    for (const forbidden of ['claude_authenticate', 'claude_oauth', 'claudeAuthenticate', 'claudeOAuth', 'set_model', 'get_settings', 'list_permission_rules', 'mcp_set_servers']) {
      expect(claudeFiles(new RegExp(forbidden)), forbidden).toEqual([]);
    }
    // `mcp_` is read, never written: the name of a request the CLI may make, and the prefix of the
    // tools a user's own configuration brings, both in the file of names the checks compare.
    expect(claudeFiles(/mcp_/).filter((file) => file !== NAMES)).toEqual([]);
    expect(claudeFiles(/can_use_tool/).filter((file) => file !== NAMES)).toEqual([]);
  });

  // Decision 0033: of a context reply, the counts and the used parts' labels alone. Its lists of
  // memory files (paths), tools, agents and skills, and its messages by tool or attachment, are
  // named nowhere in the Claude module, so nothing of them can be read.
  it('reads no path or configured name of a context reply', () => {
    // Match the configured agents field, not M105's closed 'subagents' waiting reason.
    for (const unread of ['memoryFiles', 'mcpTools', '\\bagents\'', 'skillFrontmatter', 'toolCallsByType', 'attachmentsByType', 'gridRows', 'systemPromptSections']) {
      expect(claudeFiles(new RegExp(unread)), unread).toEqual([]);
    }
    const reader = read('chat-context.ts');
    // The parts are classed by the CLI's own kind, never by their name.
    expect(reader).toMatch(/raw\['kind'\] !== 'used'/);
    expect(reader).not.toMatch(/name'\] ===|name'\] !==/);
  });

  it('has one writer for each kind of session: no other file writes to a process, or spells a frame fat-g sends', () => {
    expect(claudeFiles(/\.write\(/)).toEqual(WRITERS);
    expect(claudeFiles(/type: 'control_request'/)).toEqual(WRITERS);
    expect(claudeFiles(/type: 'control_response'/)).toEqual(WRITERS);
    expect(claudeFiles(/\bsubtype: '/)).toEqual(WRITERS);
    expect(claudeFiles(/type:\s*'user'/)).toEqual(['chat-wire.ts', 'secretary-wire.ts']);
  });

  // M26 (decision 0028): the secretary's process sends three things, each written in its wire alone.
  it('the secretary writes an initialize with the task’s instruction, one prompt, and the usage client’s refusal, launched with fixed arguments', () => {
    const wire = read('secretary-wire.ts');
    const union = /export type SecretarySend =([\s\S]*?);\n\n/.exec(wire)?.[1] ?? '';
    expect([...union.matchAll(/\bkind: '([a-z-]+)'/g)].map((match) => match[1])).toEqual(['initialize', 'prompt', 'unsupported']);
    expect(new Set([...wire.matchAll(/\bsubtype: '([a-z_]+)'/g)].map((match) => match[1]))).toEqual(new Set(['initialize', 'error']));
    expect([...new Set([...wire.matchAll(/\{ type: '([a-z_]+)'/g)].map((match) => match[1]))].sort()).toEqual(['control_request', 'control_response', 'user']);
    // The initialize carries the instruction as the system prompt and nothing else; the prompt one text, with no id.
    expect([...wire.matchAll(/request: \{ subtype: 'initialize', ([^\n]*) \} \};/g)].map((match) => match[1])).toEqual(['systemPrompt: [send.instructions]']);
    expect([...wire.matchAll(/\{ type: 'user'[^\n]*/g)].map((match) => match[0])).toEqual(["{ type: 'user', message: { role: 'user', content: send.text }, parent_tool_use_id: null, session_id: '' };"]);
    expect([...wire.matchAll(/\{ type: 'control_response'[^\n]*/g)].map((match) => match[0])).toEqual(["{ type: 'control_response', response: { subtype: 'error', request_id: send.requestId, error: 'unsupported' } };"]);
    // No settings, MCP server, transcript, tool or thinking of the user's; the model and its level after them, and nothing of the request.
    expect([...SECRETARY_ARGS]).toEqual(['--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json', '--setting-sources=', '--strict-mcp-config', '--no-session-persistence', '--tools', '', '--thinking', 'disabled']);
    expect(Object.isFrozen(SECRETARY_ARGS)).toBe(true);
    expect(secretaryArgs('haiku', null)).toEqual([...SECRETARY_ARGS, '--model', 'haiku']);
    expect(secretaryArgs('sonnet', 'low')).toEqual([...SECRETARY_ARGS, '--model', 'sonnet', '--effort', 'low']);
    for (const flag of ['--print', '-p', '--resume', '--continue', '--mcp-config', '--add-dir', '--permission-mode', '--permission-prompt-tool', '--include-partial-messages', '--debug', '--settings']) expect(SECRETARY_ARGS, flag).not.toContain(flag);
    // Its arguments and its wire are its own two files'.
    expect(claudeFiles(/--thinking/)).toEqual(['secretary.ts']);
    expect(claudeFiles(/createSecretaryWire|encodeSecretarySend/)).toEqual(['secretary-wire.ts', 'secretary.ts']);
    expect(read('secretary.ts')).not.toMatch(/\benv\s*:/);
  });

  it('keeps the unstable usage request and its rejection text in one seam file', () => {
    expect(containing(/'get_usage'/).sort()).toEqual([`${CLAUDE}/control-client.ts`, `${CLAUDE}/usage-experimental.ts`]);
    expect(containing(/Unsupported control request subtype/)).toEqual([`${CLAUDE}/usage-experimental.ts`]);
  });

  it('isolates every session: strict MCP, no settings files, no transcript, default permissions, idle', () => {
    expect([...CONTROL_ARGS]).toEqual([
      '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
      '--setting-sources=', '--strict-mcp-config', '--permission-mode', 'default', '--no-session-persistence',
    ]);
    expect(Object.isFrozen(CONTROL_ARGS)).toBe(true);
    for (const flag of ['--print', '-p', '--resume', '--continue', '--mcp-config', '--add-dir', '--allowedTools', '--dangerously-skip-permissions', '--debug', '--model']) {
      expect(CONTROL_ARGS, flag).not.toContain(flag);
    }
    expect(INITIALIZE_REQUEST).toEqual({ systemPrompt: [''] });
    // The session sends control requests only: no `user` message, so no prompt and no turn.
    expect(read('session.ts')).not.toMatch(/type:\s*'user'/);
    expect(read('control-client.ts')).not.toMatch(/type:\s*'user'/);
  });

  it('never identifies fat-g as the Agent SDK', () => {
    expect(containing(/sdk-ts|CLAUDE_AGENT_SDK_VERSION\s*[:=]|CLAUDE_CODE_ENTRYPOINT\s*[:=]/)).toEqual([]);
    expect(read('session.ts')).not.toMatch(/\benv\s*:/);
  });

  it('keeps the provider off Node child processes, network modules, the file system and credential paths', () => {
    for (const { file, text } of claudeSources()) {
      expect(text, file).not.toMatch(/from\s+'(node:)?(child_process|http|https|http2|net|tls|dgram|dns|fs|fs\/promises)'/);
      expect(text, file).not.toMatch(/\.credentials\.json|keychain|auth\.json/i);
      expect(text, file).not.toMatch(/\bfetch\s*\(/);
      // No settings file, trust record or transcript of Claude's is named (M16, C23, C48).
      expect(text, file).not.toMatch(/settings(\.local)?\.json|\.claude\.json|\.jsonl\b/);
    }
  });
});
