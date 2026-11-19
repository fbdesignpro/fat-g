// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Focused M7/M7b fault injection: each mutation breaks one safeguard most likely to look green
// superficially and must turn a focused test red. Since M19 it holds the two providers' streaming
// switches too: Codex's handshake, and a Claude chat's launch arguments; since M20a a worker's stream
// event is told apart by the tool use it names; since M20b a side question's frame, the launch that
// leaves the CLI's commands on, the commands fat-g answers itself and the fields of a Codex side
// thread's fork; since M21 the five tools a Claude chat is offered, the one `allow` and the tool
// it is for, and Codex's session set, which answering a question must not have grown; since M22 a
// Claude chat's mode — its two launch arguments and no flag, the one change of mode and when it may
// be sent — a session grant's one update, a request delivered again, and a line over the limit; and
// Codex's side of it: the policy a start and a turn name, the setup's one request, a card's choices,
// a repeated delivery, and the modes held validated; since M22b a plan turn — the plan word set
// on the wire, a launch's own word alone set back out of it, the plan's tool listed where a mode
// plans and Execute's allow with no update — and Codex's experimental API in the session's
// handshake alone and its collaboration mode on the session's own turn alone; since M23 the eighth
// send, a message written while a turn runs, and the interrupt that drops what the CLI holds, Send
// now offered only where a Stop can take a message back, and Codex's `turn/steer` on a session's own
// connection and `skills/list` on the instance's alone. Runs sequentially. Each mutation's files are put back to their exact original bytes
// and read back, and the run cannot end with one left changed without saying so and failing
// (scripts/lib/mutation-files.mjs). Only scripted-child or fixture-backed tests run: no mutation may
// reach a real CLI or account. Run with Node from the repo root: node scripts/verify-claude-mutations.mjs
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createMutationFiles, guardTree, leftMutated, turn } from './lib/mutation-files.mjs';

const claude = (file) => `src/main/providers/claude/${file}`;
const SESSION_TEST = claude('session.test.ts');
const CLIENT_TEST = claude('control-client.test.ts');
const WIRE_TEST = claude('chat-wire.test.ts');
const CONFINEMENT = 'tests/architecture/claude-confinement.test.ts';
const CODEX_CONFINEMENT = 'tests/architecture/codex-confinement.test.ts';
const CODEX_METHODS = 'src/main/providers/codex/methods.ts';
const CODEX_SESSION = 'src/main/providers/codex/session.ts';
const codex = (file) => `src/main/providers/codex/${file}`;
const CODEX_SESSION_TEST = codex('session.test.ts');
const CODEX_MODES_TEST = codex('modes.test.ts');
const CODEX_SANDBOX_TEST = codex('sandbox.test.ts');
const CODEX_APPROVALS_TEST = codex('approvals.test.ts');
const LAUNCH_TEST = claude('chat-launch.test.ts');
const CHAT_SESSION_TEST = claude('chat-session.test.ts');
const MODES_TEST = claude('chat-modes.test.ts');
const COMMANDS_TEST = claude('chat-commands.test.ts');
const CODEX_HANDSHAKE = 'capabilities: { ...(plain ? {} : { experimentalApi: true }), optOutNotificationMethods: [...OPTED_OUT_DELTAS] }';
const READING_TOOLS = "export const READING_TOOLS = ['Read', 'Glob', 'Grep', 'Agent', 'AskUserQuestion'] as const;";
const EXECUTION_TOOLS = "export const EXECUTION_TOOLS = [...READING_TOOLS, 'Bash', 'Write', 'Edit', ...WEB_TOOLS, PLAN_TOOL] as const;";
const SESSION_UPDATE = "{ updatedPermissions: [{ type: 'addRules', rules: grant.rules, behavior: 'allow', destination: 'session' }] }";
const FIXED_TAIL = "    '--tools', mode.tools.join(','),\n    '--include-partial-messages',\n  ]);";
const CODEX_SESSION_SET = "session: Object.freeze(new Set(['initialize', 'initialized', 'thread/start', 'thread/resume', 'thread/fork', 'turn/start', 'turn/interrupt', 'turn/steer'])),";
const CODEX_EXISTING_SET = "existing: Object.freeze(new Set(['initialize', 'initialized', 'account/read', 'account/rateLimits/read', 'model/list', HISTORY_METHOD, SKILLS_METHOD])),";
const STEER_TEST = claude('chat-steer.test.ts');
const CODEX_STEER_TEST = codex('session-steer.test.ts');
const ARGS = "'--setting-sources=', '--strict-mcp-config', '--permission-mode', 'default', '--no-session-persistence',";
const SPAWN_OPTIONS = '{ cwd: options.probeDirectory, signal: controller.signal }';
/** [name, [[file, before, after], …], test file, test-name filter] */
const mutations = [
  // Session isolation and identity (decision 0006).
  ['--strict-mcp-config dropped', [[claude('session.ts'), ARGS, ARGS.replace("'--strict-mcp-config', ", '')]], SESSION_TEST, 'exact arguments and frames'],
  ['--no-session-persistence dropped', [[claude('session.ts'), ARGS, ARGS.replace(" '--no-session-persistence',", '')]], SESSION_TEST, 'exact arguments and frames'],
  ['--setting-sources= dropped', [[claude('session.ts'), ARGS, ARGS.replace("'--setting-sources=', ", '')]], SESSION_TEST, 'exact arguments and frames'],
  ['session claims to be the Agent SDK', [[claude('session.ts'), SPAWN_OPTIONS, "{ cwd: options.probeDirectory, signal: controller.signal, env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' } }"]], SESSION_TEST, 'exact arguments and frames'],
  ['inherited SDK entrypoint kept for children', [[claude('environment.ts'), "    'CLAUDE_CONFIG_DIR', ", "    'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_ENTRYPOINT', "]], 'tests/claude/environment.test.ts', 'never lets a child identify fat-g'],
  ['inherited Claude session token forwarded', [[claude('environment.ts'), "  removePrefixes: ['CLAUDE_'],\n", '  removePrefixes: [],\n']], 'tests/claude/environment.test.ts', 'drops parent-session metadata'],
  // The models-only session (M13, C90) sends `initialize` and nothing else.
  ['the models-only session reads usage too', [[claude('index.ts'), 'runClaudeSession(sessionOptions(resolved), linked, () => false)', 'runClaudeSession(sessionOptions(resolved), linked, () => true)']], claude('index.test.ts'), 'sends only initialize'],
  // What may be sent, and what the CLI may ask.
  ['a third request subtype becomes sendable', [[claude('control-client.ts'), "export type ControlSubtype = 'initialize' | 'get_usage';", "export type ControlSubtype = 'initialize' | 'get_usage' | 'claude_authenticate';"]], CONFINEMENT, 'can send only initialize and get_usage'],
  ['a payload overrides the subtype', [[claude('control-client.ts'), 'request: { ...payload, subtype }', 'request: { subtype, ...payload }']], CLIENT_TEST, 'never lets a payload change'],
  ['a CLI-initiated request is granted', [[claude('control-client.ts'), "response: { subtype: 'error', request_id: id, error: 'unsupported' }", "response: { subtype: 'success', request_id: id, response: {} }"]], CLIENT_TEST, 'refuses every request the CLI makes'],
  // A chat session's wire (M16, V2; M20b, V5; M22, V7; M23, V11; decisions 0020, 0025, 0027): eight sends, one key, nothing granted but at the user's word.
  ['a ninth chat send becomes sendable', [[claude('chat-wire.ts'), "  | { readonly kind: 'set-mode'; readonly mode: string; readonly restoring?: boolean };", "  | { readonly kind: 'set-mode'; readonly mode: string; readonly restoring?: boolean }\n  | { readonly kind: 'model'; readonly model: string };"]], CONFINEMENT, 'can send eight things and answer six'],
  // M23 (C43): an interrupt drops what the CLI holds only where something is held; Send now only where a Stop can take it back.
  ['every interrupt drops what the CLI holds', [[claude('chat-wire.ts'), '...(send.cancelQueued === true ? { cancel_queued: true } : {})', 'cancel_queued: true']], STEER_TEST, 'asks a plain interrupt where nothing is held'],
  ['Send now offered while a plan turn plans', [[claude('chat-session.ts'), '    return inForce === chatMode && pending === null && restoring === null;\n  }', '    return true;\n  }']], CHAT_SESSION_TEST, 'offers no Send now while a plan turn plans'],
  ['Send now offered where a Stop cannot take a message back', [[claude('chat-session.ts'), '    if (!mapper.cancelsQueued || mapper.steered.size >= MAX_STEERED) return false;\n', '    if (mapper.steered.size >= MAX_STEERED) return false;\n']], STEER_TEST, 'is offered only once the turn'],
  ['apply_flag_settings gains a second key', [[claude('chat-wire.ts'), 'settings: { effortLevel: send.level }', "settings: { effortLevel: send.level, permissions: { defaultMode: 'acceptEdits' } }"]], WIRE_TEST, 'encodes each of the seven'],
  // M20b (V5; C13, C27, C54, C55): a side question carries its text and its history alone; the launch leaves the CLI's commands on; a listed command is never sent.
  ['a side question names a model', [[claude('chat-wire.ts'), "subtype: 'side_question', question: send.question, ", "subtype: 'side_question', question: send.question, model: 'opus', "]], WIRE_TEST, 'encodes each of the seven'],
  ['a side question always carries a history', [[claude('chat-wire.ts'), '...(send.history.length === 0 ? {} : { history:', '...(false ? {} : { history:']], WIRE_TEST, 'encodes each of the seven'],
  ['a cancel is given an id of its own', [[claude('chat-wire.ts'), "{ type: 'control_cancel_request', request_id: send.requestId }", "{ type: 'control_cancel_request', request_id: requestId }"]], WIRE_TEST, 'encodes each of the seven'],
  ['the launch turns the CLI’s commands off again', [[claude('chat-launch.ts'), "    '--include-partial-messages',\n  ]);", "    '--disable-slash-commands',\n    '--include-partial-messages',\n  ]);"]], LAUNCH_TEST, 'are the fixed list, exactly'],
  ['/clear is no longer answered by fat-g', [[claude('chat-commands.ts'), "  { name: '/clear', kind: 'command-clear' },\n", '']], COMMANDS_TEST, 'are a closed list of two'],
  ['a command’s name is matched as a prefix', [[claude('chat-commands.ts'), "if (next === '' || /\\s/.test(next)) return command.kind;", 'return command.kind;']], COMMANDS_TEST, 'does not match'],
  ['a placeholder reply is shown as the model’s', [[claude('chat-frames.ts'), " || value['synthetic'] === true) return { text: null, cut: false, model: null };", ') return { text: null, cut: false, model: null };']], claude('chat-frames.test.ts'), 'gives no answer for a null reply'],
  ['a Codex side thread’s fork gains a config override', [[CODEX_SESSION, "          developerInstructions: ASIDE_INSTRUCTIONS,\n", "          developerInstructions: ASIDE_INSTRUCTIONS,\n          config: { sandbox_mode: 'workspace-write' },\n"]], CODEX_CONFINEMENT, 'forks a side thread from one place'],
  ['a Codex side thread is no longer read-only', [[CODEX_SESSION, "          sandbox: 'read-only',\n          approvalPolicy: 'never',\n          developerInstructions", "          sandbox: 'workspace-write',\n          approvalPolicy: 'never',\n          developerInstructions"]], CODEX_CONFINEMENT, 'forks a side thread from one place'],
  ['a tool request is granted', [[claude('chat-wire.ts'), "response: { behavior: 'deny', message: answer.by === 'user' ? USER_DENY_MESSAGE : answer.by === 'user-skipped' ? USER_DECLINE_MESSAGE : answer.by === 'no-plan' ? PLAN_MISSING_MESSAGE : DENY_MESSAGE }", "response: { behavior: 'allow', updatedInput: {} }"]], WIRE_TEST, 'denies a tool request'],
  // M21 (V6; S6, C16, C17, C29; decision 0026): the launch offers five tools and no sixth; the one
  // `allow` is the answer to a question, for the tool that asks the user and for no other name; and
  // Codex's question is the reply to a request, so its session set holds no method more.
  ['a sixth tool is offered to a reading session', [[claude('chat-modes.ts'), READING_TOOLS, READING_TOOLS.replace("'AskUserQuestion']", "'AskUserQuestion', 'Bash']")]], CONFINEMENT, 'launches a chat session with M16’s arguments'],
  ['the allow is typed for any tool’s name', [[claude('chat-wire.ts'), "readonly tool: 'AskUserQuestion';", 'readonly tool: string;']], CONFINEMENT, 'allows one tool’s use'],
  ['the allow is written for any tool’s name', [[claude('chat-wire.ts'), "      if (answer.tool !== 'AskUserQuestion') throw new TypeError('no other tool is allowed');\n", '']], WIRE_TEST, 'allows the tool that asks the user and no other name'],
  ['a Codex session may list the user’s threads', [[CODEX_METHODS, CODEX_SESSION_SET, CODEX_SESSION_SET.replace("'turn/steer']", "'turn/steer', 'thread/list']")]], CODEX_CONFINEMENT, 'holds exactly the four sets'],
  // M23 (C36, C63): a steer on a session's own connection alone, and the skills read on the instance's alone.
  ['turn/steer leaves the session connection', [[CODEX_METHODS, CODEX_EXISTING_SET, CODEX_EXISTING_SET.replace('SKILLS_METHOD]', "SKILLS_METHOD, 'turn/steer']")]], CODEX_CONFINEMENT, 'holds exactly the four sets'],
  ['skills/list leaves the instance connection', [[CODEX_METHODS, CODEX_SESSION_SET, CODEX_SESSION_SET.replace("'turn/steer']", "'turn/steer', SKILLS_METHOD]")]], CODEX_CONFINEMENT, 'holds exactly the four sets'],
  ['a steer is sent on the instance connection', [[CODEX_SESSION, "sendRequest('session', rpc, 'turn/steer'", "sendRequest('existing', rpc, 'turn/steer'"]], CODEX_CONFINEMENT, 'sends turn/steer from the session alone'],
  ['a stale-turn code taken for the turn’s end whatever became of it', [[CODEX_SESSION, 'if (error.numericCode === STALE_STEER_CODE && await endsSoon(named)) return { kind: \'turn-over\' };', 'if (error.numericCode === STALE_STEER_CODE) return { kind: \'turn-over\' };']], CODEX_STEER_TEST, 'says not sent, with the code alone'],
  // M19 (V5; C9, C10, C12): a chat session asks for partial messages, and reads of them a text's own words in the session's own reply.
  ['a chat session no longer asks for partial messages', [[claude('chat-launch.ts'), FIXED_TAIL, "    '--tools', mode.tools.join(','),\n  ]);"]], LAUNCH_TEST, 'are the fixed list, exactly'],
  // M22 (V7; C5, C21, C22, C45–C47, C67, C69, C74, C90, C91; decision 0027). The launch: the mode's two
  // arguments, no flag beside them, eight tools and no ninth. The change of mode: one of three words, with
  // nothing running and none waiting, its status frame no mismatch. A session grant: the one rule, at the
  // session's scope, alone. A request delivered again: compared before it is answered. A line over the limit:
  // a request told apart, and one that may be a request stopped.
  ['a flag that bypasses permissions is added to the launch', [[claude('chat-launch.ts'), FIXED_TAIL, "    '--tools', mode.tools.join(','),\n    '--include-partial-messages',\n    ...(mode.reading ? [] : ['--allow-dangerously-skip-permissions']),\n  ]);"]], LAUNCH_TEST, 'names each mode’s permission mode and tool list'],
  ['a twelfth tool is offered under the modes that act', [[claude('chat-modes.ts'), EXECUTION_TOOLS, EXECUTION_TOOLS.replace('PLAN_TOOL]', "PLAN_TOOL, 'NotebookEdit']")]], CONFINEMENT, 'names the CLI’s permission modes in the mode table alone'],
  ['the reading mode is launched with the tools that act', [[claude('chat-modes.ts'), "  'read-only': mode('read-only', 'default', READING_TOOLS, true),", "  'read-only': mode('read-only', 'default', EXECUTION_TOOLS, true),"]], MODES_TEST, 'maps the five to four words'],
  ['a start that names no mode runs under one that acts', [[claude('chat-modes.ts'), 'return isModeId(id) ? CLAUDE_MODES[id] : READING_MODE;', "return isModeId(id) ? CLAUDE_MODES[id] : CLAUDE_MODES['ask-first'];"]], MODES_TEST, 'runs a start that names no mode'],
  ['Berserk becomes a change on the live process', [[claude('chat-modes.ts'), "const SETTABLE: readonly ClaudeModeId[] = ['ask-first', 'edits-ok', 'auto-reviewed'];", "const SETTABLE: readonly ClaudeModeId[] = ['ask-first', 'edits-ok', 'auto-reviewed', 'berserk'];"]], MODES_TEST, 'is made on the live process between'],
  ['a mode is set outside the three', [[claude('chat-wire.ts'), "      if (!mayName(send.mode, launch, send.restoring === true)) throw new TypeError('no change names this mode');\n", '']], WIRE_TEST, 'writes no change of mode that names another word'],
  ['a mode is set with a turn running', [[claude('chat-session.ts'), 'const idle = current === null && mapper.workers.size === 0', 'const idle = mapper.workers.size === 0']], CHAT_SESSION_TEST, 'writes nothing where the gate does not stand'],
  ['a mode is set with another change waiting', [[claude('chat-session.ts'), "claudeTransition(inForce.id, id) !== 'idle' || pending !== null || !idle", "claudeTransition(inForce.id, id) !== 'idle' || !idle"]], CHAT_SESSION_TEST, 'writes nothing where the gate does not stand'],
  ['a status frame that names the pending target ends the process', [[claude('chat-session.ts'), '    if (pending !== null && reportsMode(pending.to, taken.mode)) {\n', '    if (false) {\n']], CHAT_SESSION_TEST, 'confirms on the reply whether its status frame comes'],
  ['a change is confirmed whatever its reply names', [[claude('chat-session.ts'), '    if (answered && reportsMode(target, reported)) {\n      inForce = target;\n      chatMode = target;', '    if (answered) {\n      inForce = target;\n      chatMode = target;']], CHAT_SESSION_TEST, 'is not confirmed by a reply that names another mode'],
  ['a mode set back is confirmed whatever its reply names', [[claude('chat-session.ts'), '      if (answered && reportsMode(target, reported)) {\n        inForce = target;\n        mapper.mode = target;', '      if (answered) {\n        inForce = target;\n        mapper.mode = target;']], CHAT_SESSION_TEST, 'sets the chat’s word back after a Cancel, before the turn’s end is said, and ends the process where the reply names another'],
  ['the launch’s reply is no longer held to the mode', [[claude('chat-session.ts'), 'if (!reportsMode(inForce, reported)) throw inForce.reading', 'if (reported === null) throw inForce.reading']], CHAT_SESSION_TEST, 'fails the start and sends nothing when the reply reports another policy'],
  ['a request to act is held under the reading mode', [[claude('chat-session.ts'), 'if (taken.action === null || inForce.reading) {', 'if (taken.action === null) {']], CHAT_SESSION_TEST, 'is denied under the reading mode'],
  ['a grant is written at the scope the CLI offered it at', [[claude('chat-wire.ts'), SESSION_UPDATE, SESSION_UPDATE.replace("destination: 'session'", "destination: 'localSettings'")]], WIRE_TEST, 'sends a session grant as the CLI’s own rule'],
  ['a second suggestion is sent beside the rule', [[claude('chat-wire.ts'), SESSION_UPDATE, SESSION_UPDATE.replace(' }] }', " }, { type: 'setMode', mode: 'acceptEdits', destination: 'session' }] }")]], WIRE_TEST, 'sends a session grant as the CLI’s own rule'],
  ['a grant keeps the scope its offer named', [[claude('chat-wire.ts'), "grant: { type: 'addRules', rules, behavior: 'allow', destination: 'session' }", "grant: { type: 'addRules', rules, behavior: 'allow', destination: suggestion['destination'] }"]], WIRE_TEST, 'names the session’s scope whatever scope the offer named'],
  ['a rule that denies makes a grant', [[claude('chat-wire.ts'), "const covers = suggestion['behavior'] === 'allow' && Array.isArray(rules) ? ruleText(rules, tool) : null;", 'const covers = Array.isArray(rules) ? ruleText(rules, tool) : null;']], WIRE_TEST, 'makes a grant of a rule that allows'],
  ['a session grant is sent for a plain approval', [[claude('chat-session.ts'), "grant: choice === 'approve-session' ? hold.grant : null }", 'grant: hold.grant }']], CHAT_SESSION_TEST, 'approves once'],
  ['the user’s denial is said in fat-g’s own name', [[claude('chat-session.ts'), "? { kind: 'deny', requestId, by: 'user' }", "? { kind: 'deny', requestId }"]], CHAT_SESSION_TEST, 'denies in the user’s name'],
  ['a repeated delivery with another input is answered from the hold', [[claude('chat-session.ts'), '      if (!samePayload(held.payload, taken.payload)) { changed(held, reply); return; }\n', '']], CHAT_SESSION_TEST, 'refuses another payload under that id'],
  ['a repeated delivery is compared by its tool use alone', [[claude('chat-frames.ts'), 'return held !== null && again !== null && sameValue(held.tool, again.tool) && sameValue(held.input, again.input) && sameValue(held.toolUseId, again.toolUseId)', 'return held !== null && again !== null && sameValue(held.toolUseId, again.toolUseId)']], claude('chat-frames.test.ts'), 'compares a request delivered again'],
  ['a request past a bound is shown cut', [[claude('chat-tools.ts'), "  if (over !== null) return { kind: 'refused', over };\n", '']], claude('chat-tools.test.ts'), 'for more than a card shows'],
  ['a denied action reads as a failure', [[claude('chat-mapper.ts'), "declined: approval.decided === 'denied' ? { by: 'user' } : null,", 'declined: null,']], claude('chat-mapper.test.ts'), 'K2’s command, allowed and then denied'],
  ['a request over the line limit is no longer told apart', [[claude('chat-launch.ts'), "peekLine(line, { types: [REQUEST_TYPE], name: { object: 'request', field: 'tool_name' } })", "peekLine(line, { types: [], name: { object: 'request', field: 'tool_name' } })"]], LAUNCH_TEST, 'tells the session of a request by its id'],
  ['a line that may be a request stops nothing', [[claude('chat-session.ts'), "if (over || line.request === 'no') return;", "if (over || line.request !== 'yes') return;"]], CHAT_SESSION_TEST, 'stops a line that may be a request the same way'],
  ['a request with no id is answered by none and stops nothing', [[claude('chat-session.ts'), "      emit({ type: 'notice', kind: 'line-too-long', ...(current === null ? {} : { turnId: current.request.turnId }), size: line.size });\n      stopSession();\n", '']], CHAT_SESSION_TEST, 'stops everything the process runs for a request whose id cannot be read'],
  // M22b (V6; C7, C8, C11, C51, C70; decision 0029): plan mode is set on the wire and set back by
  // the launch's own word alone; the plan's tool is listed where a mode plans and nowhere else;
  // Execute answers the request's input as it came, with no update.
  ['the plan word is no longer named on the wire', [[claude('chat-modes.ts'), "  return SETTABLE_WORDS.has(word) || word === PLAN_WORD || (restoring && launch !== null && word === launch);", "  return SETTABLE_WORDS.has(word) || (restoring && launch !== null && word === launch);"]], WIRE_TEST, 'writes no change of mode that names another word'],
  ['a word that is no launch of this process’s is set back', [[claude('chat-modes.ts'), "  return SETTABLE_WORDS.has(word) || word === PLAN_WORD || (restoring && launch !== null && word === launch);", "  return SETTABLE_WORDS.has(word) || word === PLAN_WORD || restoring;"]], WIRE_TEST, 'writes no change of mode that names another word'],
  ['the plan’s tool is offered to the reading mode', [[claude('chat-modes.ts'), READING_TOOLS, READING_TOOLS.replace("'AskUserQuestion']", "'AskUserQuestion', 'ExitPlanMode']")]], CONFINEMENT, 'launches a chat session with M16’s arguments'],
  ['Execute’s allow carries a mode update', [[claude('chat-wire.ts'), "      const update = grant === null ? {} : { updatedPermissions:", "      const update = grant === null ? (answer.tool === PLAN_TOOL ? { updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] } : {}) : { updatedPermissions:"]], WIRE_TEST, 'writes Execute as the request’s input as it came'],
  // Since M20a (C20, C22) a worker's stream event is the worker's, by the tool use it names: read as the session's own, its text would be the session's.
  ['a worker’s stream event is read as the session’s own', [[claude('chat-frames.ts'), '  return { own, parent: parentOf(parent), event: taken };', '  return { own: true, parent: null, event: taken };']], claude('chat-mapper.test.ts'), 'takes a worker’s own stream events as its text'],
  ['a thinking delta is read as a text’s', [[claude('chat-frames.ts'), "if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {", "if (typeof delta['type'] === 'string' && typeof (delta['text'] ?? delta['thinking']) === 'string') {"]], CONFINEMENT, 'reads of a stream event only a text'],
  // M19 (V5; S7, C7) and M22b (V6; C13, C14): a Codex session's handshake keeps the two deltas, opts out of the nine others, and asks
  // for the experimental API — its plain form, and every other handshake, for nothing experimental.
  ['Codex opts out of the message delta again', [[CODEX_METHODS, CODEX_HANDSHAKE, 'capabilities: { ...(plain ? {} : { experimentalApi: true }), optOutNotificationMethods: [...DELTA_METHODS] }']], CODEX_CONFINEMENT, 'opts a session out of exactly the nine'],
  ['Codex’s plain handshake still asks for the experimental API', [[CODEX_METHODS, CODEX_HANDSHAKE, 'capabilities: { experimentalApi: true, optOutNotificationMethods: [...OPTED_OUT_DELTAS] }']], CODEX_CONFINEMENT, 'opts a session out of exactly the nine'],
  ['Codex’s secretary asks for the experimental API', [[CODEX_METHODS, 'return { clientInfo: clientInfo(applicationVersion), capabilities: { optOutNotificationMethods: [...DELTA_METHODS] } };', 'return { clientInfo: clientInfo(applicationVersion), capabilities: { experimentalApi: true, optOutNotificationMethods: [...DELTA_METHODS] } };']], CODEX_CONFINEMENT, 'names the experimental API in the session’s handshake alone'],
  ['a Codex side thread’s fork names a collaboration mode', [[CODEX_SESSION, "          developerInstructions: ASIDE_INSTRUCTIONS,\n", "          developerInstructions: ASIDE_INSTRUCTIONS,\n          collaborationMode: { mode: 'default' },\n"]], CODEX_CONFINEMENT, 'names the experimental API in the session’s handshake alone'],
  ['a Codex turn after a plan names no default', [[CODEX_SESSION, "request.plan === true ? 'plan' : request.plannedBefore === true ? 'default' : null", "request.plan === true ? 'plan' : null"]], 'tests/codex/plan.integration.test.ts', 'names default on a turn of a thread that planned before'],
  // M22 (V7; C7, C22, C60, C62, C64, C70, C72, C84, C85, C91; decision 0027): Codex's policy is the mode's on a start and the reply's on a turn, its setup one request at a press, and a card's choices its request's own.
  ['a Codex turn names a policy its reply did not report', [[CODEX_SESSION, '      policy = check.turn;\n', "      policy = { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } };\n"]], CODEX_SESSION_TEST, 'what the reply reported on every turn'],
  ['a Codex asking mode names no reviewer', [[codex('modes.ts'), '  return { sandbox, approvalPolicy, ...(approvalsReviewer === null ? {} : { approvalsReviewer }) };', '  return { sandbox, approvalPolicy };']], CODEX_MODES_TEST, 'gives a start and a resume exactly those fields'],
  ['a second setupStart is sent with one under way', [[codex('sandbox.ts'), "      if (current !== null) return 'running';\n", '']], CODEX_SANDBOX_TEST, 'to a second press while one is under way'],
  ['Codex’s setup is sent in the unelevated mode', [[codex('sandbox.ts'), "{ mode: 'elevated', cwd: context.probeDirectory }", "{ mode: 'unelevated', cwd: context.probeDirectory }"]], CODEX_SANDBOX_TEST, 'never sends the unelevated mode'],
  ['Codex’s amendment makes a session choice on its card', [[codex('approvals.ts'), '    grant = taken.forSession ? covers(command) : null;', '    grant = taken.forSession || taken.authority.length > 0 ? covers(command) : null;']], CODEX_APPROVALS_TEST, 'never lists it among the choices'],
  ['a Codex side thread’s fork is given the session’s mode', [[CODEX_SESSION, "          sandbox: 'read-only',\n          approvalPolicy: 'never',\n          developerInstructions", '          ...startPolicy(mode),\n          developerInstructions']], CODEX_SESSION_TEST, 'leaves an aside’s fork and its turns as they were'],
  ['a Codex request that comes again with other params is counted as a repeat', [[CODEX_SESSION, 'if (existing.method === method && sameValue(existing.params, params)) {', 'if (existing.method === method) {']], CODEX_SESSION_TEST, 'lets the first go as changed'],
  ['a Codex mode no capture shows a turn under is listed available', [[codex('modes.ts'), "    if (!validated.includes(id)) return { ...none, available: false, reason: 'unvalidated' };\n", '']], CODEX_MODES_TEST, 'lists a mode left out of the validated ones unavailable'],
  // Output bounds and raw text.
  ['CLI error text kept unbounded', [[claude('control-client.ts'), 'error.slice(0, CONTROL_LIMITS.errorChars)', 'error']], CLIENT_TEST, 'bounds error text'],
  ['total output cap removed', [[claude('control-client.ts'), 'if (outputBytes > CONTROL_LIMITS.outputBytes)', 'if (false)']], CLIENT_TEST, 'too much output in total'],
  ['a non-JSON line fails the session', [[claude('control-client.ts'), 'const decoder = new NdjsonDecoder(receive, () => { counts.ignored += 1; });', "const decoder = new NdjsonDecoder(receive, () => { fail('protocol-error'); });"]], CLIENT_TEST, 'drops non-JSON lines'],
  ['outcome C matched loosely', [[claude('usage-experimental.ts'), 'UNSUPPORTED_REQUEST.has(reply.error)', "reply.error.includes('Unsupported')"]], claude('usage-experimental.test.ts'), 'treats any other rejection'],
  // Deadlines and teardown.
  ['startup deadline removed, usage deadline kept', [[claude('session.ts'), '{ startupExpired = true; controller.abort(); }', '{ startupExpired = true; }']], SESSION_TEST, 'withheld initialize expires'],
  ['abort no longer stops the child tree', [[claude('session.ts'), SPAWN_OPTIONS, '{ cwd: options.probeDirectory }']], SESSION_TEST, 'caller abort during the usage request'],
  ['a pre-aborted caller still launches', [[claude('session.ts'), "    if (controller.signal.aborted) throw new ProcessFailure('aborted');\n", '']], SESSION_TEST, 'launches nothing for a caller that aborted'],
  ['normally closing child stopped without grace', [[claude('session.ts'), '    await closedWithin(child, SESSION_LIMITS.closeGraceMs);\n', '']], SESSION_TEST, 'exact arguments and frames'],
  ['session cleanup not awaited', [[claude('session.ts'), '    cleanup = await child.stop();\n', '    void child.stop();\n']], SESSION_TEST, 'unconfirmed cleanup take precedence'],
  ['retry permitted after failed cleanup', [[claude('index.ts'), "      if (latched) return { kind: 'error', reason: 'cleanup-failed' };\n", '']], claude('index.test.ts'), 'latches on a scope cleanup refusal'],
  ['account cleared on a rejected get_usage', [['src/main/services/usage-service.ts', "usage.reason === 'api-key' || usage.reason === 'cloud-provider'\n              ? cleared(value, status)", 'true\n              ? cleared(value, status)']], 'src/main/services/usage-service.test.ts', 'keeps a validated account without usage'],
  // Normalization.
  ['duplicate model-window IDs emitted', [[claude('normalize.ts'), '    if (seen.has(window.id)) return false;\n', '']], claude('normalize.test.ts'), 'limits\\[\\] as authoritative'],
  ['empty limits[] falls back to named windows', [[claude('normalize.ts'), 'if (Array.isArray(rows)) windows', 'if (Array.isArray(rows) && rows.length > 0) windows']], claude('normalize.test.ts'), 'empty limits'],
  ['provider severity ignored', [[claude('normalize.ts'), "severity: providerSeverity(row['severity']) ?? severityFromPercent(usedPercent),", 'severity: severityFromPercent(usedPercent),']], claude('normalize.test.ts'), 'provider severity'],
  ['offset-less ISO timestamp parsed', [['src/shared/contracts/time.ts', '(?:Z|[+-]\\d{2}:\\d{2})$/', '(?:Z|[+-]\\d{2}:\\d{2})?$/']], claude('normalize.test.ts'), 'explicit offset'],
  // Composition.
  ['smoke resolves the installed CLI', [['src/main/app/smoke-providers.ts', "      argsPrefix: [claudeFixture, '--fixture-dir', claudeDirectory],\n      executableNames: names,", "      argsPrefix: [claudeFixture, '--fixture-dir', claudeDirectory],\n      executableNames: ['claude'],"]], 'src/main/app/smoke-providers.test.ts', 'launches only the smoke Node'],
  ['a preference toggle rechecks a blocked scope', [['src/main/services/provider-registry.ts', '      const recheck = slot.recheckRequested;\n', '      const recheck = true;\n']], 'src/main/services/provider-registry.test.ts', 'preference toggles never recheck'],
];

const vitest = (test, title) => spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', test, '-t', title], { encoding: 'utf8', windowsHide: true, timeout: 120_000, env: process.env });

// A failure only counts as detection if the same focused test passes on the unmutated tree.
let survived = 0;
for (const [test, title] of new Map(mutations.map(([, , test, title]) => [`${test}\n${title}`, [test, title]])).values()) {
  const result = vitest(test, title);
  if (result.status !== 0 || !/Tests\s+\d+ passed/.test(result.stdout)) {
    console.log(`BASELINE FAILED: ${test} -t ${title}`);
    console.log(result.stdout, result.stderr);
    survived++;
  }
}
if (survived) { process.exitCode = 1; throw new Error('focused tests must pass before mutations are meaningful'); }

const files = createMutationFiles();
guardTree(files);
for (const [name, edits, test, title] of mutations) {
  let failed;
  try {
    for (const [file, before, after] of edits) {
      const target = path.resolve(file);
      const source = files.read(target)?.toString('utf8') ?? '';
      if (!source.includes(before)) throw new Error(`missing mutation anchor: ${name} (${file})`);
      files.write(target, source.replace(before, after));
    }
    const result = vitest(test, title);
    const detected = result.status !== 0 && (result.stdout + result.stderr).includes('FAIL');
    console.log(`${detected ? 'DETECTED' : 'SURVIVED/INVALID'}: ${name}`);
    if (!detected) { survived++; console.log(result.stdout, result.stderr); }
  } finally {
    failed = files.restore();
  }
  // A file that could not be put back stops the run: nothing more is mutated on a tree that is not as it was.
  if (failed.length > 0) throw leftMutated(failed);
  await turn();
}
process.exitCode = survived ? 1 : 0;
