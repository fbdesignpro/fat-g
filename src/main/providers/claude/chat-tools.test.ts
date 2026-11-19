// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V9's source and V27 (docs/planning/_archive/M22.md, Design 4, 6; C8, C9, C48, C56, C68): a request to act
// as its card's view — on K2's captures, as tests/fixtures/claude/captures/ holds them, and on those
// requests with one named change. What a tool's use is as an activity is the mapper's test.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApprovalRequestSchema, MAX_APPROVAL_CHANGE_UNITS, MAX_APPROVAL_DETAIL, MAX_APPROVAL_PATH, MAX_APPROVAL_REASON, MAX_APPROVAL_SUMMARY, MAX_APPROVAL_TOOL, MAX_GRANT_COVERS } from '@shared/contracts/interaction';
import { type ActionRequest, MCP_TOOL_PREFIX, takeRequest } from './chat-frames';
import { approvalView, takeTool } from './chat-tools';
import { readOffer } from './chat-wire';

type Frame = Record<string, unknown>;
const requests = (name: string): Frame[] => (JSON.parse(readFileSync(path.resolve('tests/fixtures/claude/captures', `${name}.json`), 'utf8')) as { frames: { dir: string; frame: Frame }[] }).frames.filter((entry) => entry.dir === 'recv' && entry.frame['type'] === 'control_request').map((entry) => entry.frame);
/** A capture's nth request to act, with one named change to the request. */
const asked = (name: string, nth = 0, patch: Frame = {}): ActionRequest => {
  const frame = requests(name)[nth] as Frame;
  const action = takeRequest({ ...frame, request: { ...(frame['request'] as Frame), ...patch } }).action;
  if (action === null) throw new Error(`${name} #${nth} is no request to act`);
  return action;
};
const viewOf = (action: ActionRequest) => approvalView(action, action.suggestions.map((suggestion) => readOffer(suggestion, action.tool ?? '')), MCP_TOOL_PREFIX);
const shown = (action: ActionRequest) => { const view = viewOf(action); if (view.kind !== 'view') throw new Error(`refused: ${JSON.stringify(view.over)}`); return view; };
const refused = (action: ActionRequest) => { const view = viewOf(action); return view.kind === 'refused' ? view.over : 'shown'; };
const made = (tool: string, input: unknown, patch: Frame = {}): ActionRequest => asked('m22-approve-once', 0, { tool_name: tool, input, description: undefined, blocked_path: undefined, permission_suggestions: undefined, ...patch });

describe('a command’s request, as K2 saw it', () => {
  it('is the whole command, the file it would make, the model’s own reason, what the CLI would also grant, and the session grant its rule makes', () => {
    const view = shown(asked('m22-approve-once'));
    expect(view.request).toEqual({
      kind: 'command', tool: 'Bash', summary: 'touch bash-once.txt',
      // Claude's request names no working folder (K2).
      folder: null, targets: ['<scratch>\\bash-once.txt'], outside: false,
      // The request's own line is the model's: the tool's input holds the same words.
      reason: 'Create empty file bash-once.txt',
      // The rule as the CLI offered it would be kept in a settings file; the folder and the mode are never sent (C22, C56).
      authority: [{ kind: 'saved-rule', mode: null }, { kind: 'folder', mode: null }, { kind: 'mode', mode: 'edits-ok' }],
      detail: { kind: 'command', command: 'touch bash-once.txt' },
      choices: ['approve', 'approve-session', 'deny'],
      grant: { covers: 'touch bash-once.txt' },
      // A rule is offered, so a mode is not the CLI's only offer.
      modeThatWouldStop: null,
      cut: false,
    });
    expect(ApprovalRequestSchema.safeParse(view.request).success).toBe(true);
    // What the grant would send is kept beside the view, at the session's scope, and is no part of it.
    expect(view.grant).toEqual({ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch bash-once.txt' }], behavior: 'allow', destination: 'session' });
    expect(JSON.stringify(view.request)).not.toMatch(/addRules|destination|Settings/);
  });

  it('heads a command of several lines by its first, and shows all of it behind', () => {
    const view = shown(made('Bash', { command: '\n  npm test --silent\nnpm run build\n' }));
    expect(view.request.summary).toBe('  npm test --silent');
    expect(view.request.detail).toEqual({ kind: 'command', command: '\n  npm test --silent\nnpm run build\n' });
    expect(view.request.targets).toEqual([]);
  });

  it('is the same for a worker’s command: whose it is is the request’s to say, and no part of the view', () => {
    const action = asked('m22-approve-worker');
    expect(action.agentId).toBe('<worker-34>');
    expect(shown(action).request).toMatchObject({ kind: 'command', tool: 'Bash', summary: 'touch worker-made.txt', targets: ['<scratch>\\worker-made.txt'], reason: 'Create empty file worker-made.txt', choices: ['approve', 'approve-session', 'deny'], grant: { covers: 'touch worker-made.txt' } });
  });
});

describe('a file change’s request, as K2 saw each', () => {
  it('shows a whole file’s content, and names the mode that would stop the question, the CLI’s only offer', () => {
    const view = shown(asked('m22-approve-files', 0));
    expect(view.request).toEqual({
      kind: 'file-change', tool: 'Write', summary: 'made-inside.txt', folder: null, targets: ['<scratch>\\made-inside.txt'], outside: false,
      // The request's own line is the file's name here, and no reason of the model's.
      reason: null,
      authority: [{ kind: 'mode', mode: 'edits-ok' }],
      detail: { kind: 'changes', changes: [{ path: '<scratch>\\made-inside.txt', kind: 'write', text: 'alpha', replace: null, all: null }] },
      // No rule is offered for a file (C21): no session grant.
      choices: ['approve', 'deny'], grant: null,
      modeThatWouldStop: 'edits-ok',
      cut: false,
    });
    expect(view.grant).toBeNull();
    expect(ApprovalRequestSchema.safeParse(view.request).success).toBe(true);
  });

  it('shows an edit by match with the text it replaces and its scope, so that two edits of opposite scope never read alike (C9)', () => {
    const first = shown(asked('m22-approve-files', 1)).request;
    expect(first).toMatchObject({ kind: 'file-change', tool: 'Edit', summary: 'made-inside.txt', targets: ['<scratch>\\made-inside.txt'] });
    expect(first.detail).toEqual({ kind: 'changes', changes: [{ path: '<scratch>\\made-inside.txt', kind: 'update', text: 'beta', replace: 'alpha', all: false }] });
    const input = (asked('m22-approve-files', 1).input ?? {}) as Frame;
    const every = shown(made('Edit', { ...input, replace_all: true })).request;
    expect(every.detail).toEqual({ kind: 'changes', changes: [{ path: '<scratch>\\made-inside.txt', kind: 'update', text: 'beta', replace: 'alpha', all: true }] });
    expect(every.detail).not.toEqual(first.detail);
    // Left unsaid, an edit replaces the first match alone: the tool's own rule.
    const { replace_all: _unsaid, ...bare } = input;
    expect(shown(made('Edit', bare)).request.detail).toEqual(first.detail);
  });

  it('says a path the CLI holds outside the session’s folders, and then names no mode: a folder is offered beside it', () => {
    const view = shown(asked('m22-approve-files', 3));
    expect(view.request).toMatchObject({ kind: 'file-change', outside: true, targets: ['<scratch>\\made-outside.txt'], reason: null, choices: ['approve', 'deny'], grant: null, modeThatWouldStop: null });
    expect(view.request.authority).toEqual([{ kind: 'mode', mode: 'edits-ok' }, { kind: 'folder', mode: null }]);
    // In a root handed over beside the first, a file asks as one in the working folder does.
    expect(shown(asked('m22-approve-files', 2)).request).toMatchObject({ outside: false, modeThatWouldStop: 'edits-ok' });
  });

  it('shows each edit of several, and a notebook’s edit as its whole input, which names a cell beside its text', () => {
    const several = shown(made('MultiEdit', { file_path: 'C:\\work\\a.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd', replace_all: true }] })).request;
    expect(several).toMatchObject({ kind: 'file-change', summary: 'a.ts', targets: ['C:\\work\\a.ts'] });
    expect(several.detail).toEqual({ kind: 'changes', changes: [{ path: 'C:\\work\\a.ts', kind: 'update', text: 'b', replace: 'a', all: false }, { path: 'C:\\work\\a.ts', kind: 'update', text: 'd', replace: 'c', all: true }] });
    const notebook = { notebook_path: 'C:\\work\\n.ipynb', cell_id: 'cell-3', edit_mode: 'insert', new_source: 'print(1)' };
    expect(shown(made('NotebookEdit', notebook)).request).toMatchObject({ kind: 'file-change', summary: 'n.ipynb', targets: ['C:\\work\\n.ipynb'], detail: { kind: 'input', text: JSON.stringify(notebook, null, 2) } });
  });
});

describe('any other tool’s request', () => {
  it('shows the tool’s input as JSON text, whole, under the tool’s name — a tool of the user’s own configuration by its server and its tool', () => {
    const input = { path: 'notes/today.md', text: 'private words' };
    const view = shown(made('mcp__notes__write_note', input));
    expect(view.request).toMatchObject({ kind: 'tool', tool: 'mcp__notes__write_note', summary: 'notes: write_note', targets: [], reason: null, authority: [], choices: ['approve', 'deny'], grant: null, modeThatWouldStop: null });
    expect(view.request.detail).toEqual({ kind: 'input', text: JSON.stringify(input, null, 2) });
    // A read outside the session's folders asks too: the file it names is its target.
    expect(shown(made('Read', { file_path: 'C:\\elsewhere\\x.txt' }, { decision_reason_type: 'workingDir', blocked_path: 'C:\\elsewhere\\x.txt' })).request).toMatchObject({ kind: 'tool', tool: 'Read', summary: 'Read', targets: ['C:\\elsewhere\\x.txt'], outside: true });
  });

  it('gives the model’s reason only where the request’s line is the model’s own, cut to its bound, and cuts the two other labels to theirs', () => {
    expect(shown(made('Bash', { command: 'ls', description: 'List the files' }, { description: 'List the files' })).request.reason).toBe('List the files');
    // A line the CLI wrote — a path, a tool's own description — is no reason of the model's.
    expect(shown(made('Bash', { command: 'ls', description: 'List the files' }, { description: '~\\work\\notes.txt' })).request.reason).toBeNull();
    expect(shown(made('Bash', { command: 'ls' }, { description: 'List the files' })).request.reason).toBeNull();
    const long = 'r'.repeat(MAX_APPROVAL_REASON + 50);
    expect(shown(made('Bash', { command: 'ls', description: long }, { description: long })).request.reason).toHaveLength(MAX_APPROVAL_REASON);
    const named = shown(made(`mcp__server__${'t'.repeat(400)}`, {})).request;
    expect(named.tool).toHaveLength(MAX_APPROVAL_TOOL);
    expect(shown(made('Bash', { command: 'x'.repeat(MAX_APPROVAL_SUMMARY + 500) })).request.summary).toHaveLength(MAX_APPROVAL_SUMMARY);
    expect(ApprovalRequestSchema.safeParse(named).success).toBe(true);
  });
});

// The two web tools' requests, made from the suggestions Claude Code 2.1.302's build writes for them:
// a fetch's rule for its site, a search's for every search, each at the project's local settings.
describe('a web fetch’s and a web search’s request', () => {
  const FETCH = { url: 'https://example.com/tides?harbour=north', prompt: 'Summarise the tide times' };
  const SITE = { type: 'addRules', rules: [{ toolName: 'WebFetch', ruleContent: 'domain:example.com' }], behavior: 'allow', destination: 'localSettings' };
  const EVERY_SEARCH = { type: 'addRules', rules: [{ toolName: 'WebSearch' }], behavior: 'allow', destination: 'localSettings' };

  it('heads a fetch by its whole address, shows its input whole behind, and grants its site for the session alone', () => {
    const view = shown(made('WebFetch', FETCH, { permission_suggestions: [SITE] }));
    expect(view.request).toMatchObject({ kind: 'tool', tool: 'WebFetch', summary: 'https://example.com/tides?harbour=north', targets: [], choices: ['approve', 'approve-session', 'deny'], grant: { covers: 'domain:example.com' } });
    expect(view.request.detail).toEqual({ kind: 'input', text: JSON.stringify(FETCH, null, 2) });
    expect(view.grant).toEqual({ type: 'addRules', rules: SITE.rules, behavior: 'allow', destination: 'session' });
    expect(ApprovalRequestSchema.safeParse(view.request).success).toBe(true);
  });

  it('heads a search by its query, with any domain lists in its input, and grants every search for the session alone', () => {
    const input = { query: 'tide tables for the harbour', allowed_domains: ['example.org'] };
    const view = shown(made('WebSearch', input, { permission_suggestions: [EVERY_SEARCH] }));
    expect(view.request).toMatchObject({ kind: 'tool', tool: 'WebSearch', summary: 'tide tables for the harbour', choices: ['approve', 'approve-session', 'deny'], grant: { covers: 'WebSearch' } });
    expect(view.request.detail).toEqual({ kind: 'input', text: JSON.stringify(input, null, 2) });
    expect(view.grant).toEqual({ type: 'addRules', rules: EVERY_SEARCH.rules, behavior: 'allow', destination: 'session' });
  });

  it('heads one by its first line, cut to the bound, and refuses one that names no address or no query', () => {
    expect(shown(made('WebSearch', { query: '\ntides\nand currents' })).request.summary).toBe('tides');
    expect(shown(made('WebFetch', { url: `https://example.com/${'p'.repeat(MAX_APPROVAL_SUMMARY)}`, prompt: 'x' })).request.summary.length).toBeLessThanOrEqual(MAX_APPROVAL_SUMMARY);
    const none: [string, ActionRequest][] = [
      ['a fetch with no address', made('WebFetch', { prompt: 'x' })], ['a fetch whose address is empty', made('WebFetch', { url: ' ', prompt: 'x' })], ['a fetch whose address is no text', made('WebFetch', { url: ['https://example.com/'] })],
      ['a search with no query', made('WebSearch', { allowed_domains: ['example.org'] })], ['an empty search', made('WebSearch', { query: '' })],
    ];
    for (const [what, action] of none) expect(refused(action), what).toBeNull();
  });
});

describe('a request that cannot be shown whole is refused, never shown cut (C9, C48)', () => {
  it('for a field its action stands on that is missing or is not what it must be, with no size to name', () => {
    const none: [string, ActionRequest][] = [
      ['no tool', made('Bash', { command: 'ls' }, { tool_name: undefined })], ['an input that is no object', made('Bash', 'ls')], ['no input', made('Bash', undefined)],
      ['a command that is none', made('Bash', { description: 'List' })], ['an empty command', made('Bash', { command: '' })], ['a command that is no text', made('Bash', { command: ['ls'] })],
      ['a file with no path', made('Write', { content: 'x' })], ['an empty path', made('Write', { file_path: '', content: 'x' })], ['a file with no content', made('Write', { file_path: 'C:\\a.txt' })],
      ['an edit with no text to find', made('Edit', { file_path: 'C:\\a.txt', new_string: 'b' })], ['an edit with no text to put', made('Edit', { file_path: 'C:\\a.txt', old_string: 'a' })],
      ['an edit whose scope is no yes or no', made('Edit', { file_path: 'C:\\a.txt', old_string: 'a', new_string: 'b', replace_all: 'yes' })],
      ['several edits that are none', made('MultiEdit', { file_path: 'C:\\a.txt', edits: [] })], ['several edits, one of them none', made('MultiEdit', { file_path: 'C:\\a.txt', edits: [{ old_string: 'a', new_string: 'b' }, 'x'] })],
    ];
    for (const [what, action] of none) expect(refused(action), what).toBeNull();
  });

  it('for more than a card shows, with the bound it is past and by how much', () => {
    const edits = (count: number) => Array.from({ length: count }, (_, n) => ({ old_string: `a${n}`, new_string: `b${n}` }));
    // 32 changes are shown, the 33rd is past the bound.
    expect(refused(made('MultiEdit', { file_path: 'C:\\a.txt', edits: edits(32) }))).toBe('shown');
    expect(refused(made('MultiEdit', { file_path: 'C:\\a.txt', edits: edits(40) }))).toEqual({ bound: 'targets', size: 40 });
    // A file's content whole up to 1,048,576 units, an edit's two texts counted together.
    expect(refused(made('Write', { file_path: 'C:\\a.txt', content: 'x'.repeat(MAX_APPROVAL_CHANGE_UNITS) }))).toBe('shown');
    expect(refused(made('Write', { file_path: 'C:\\a.txt', content: 'x'.repeat(MAX_APPROVAL_CHANGE_UNITS + 1) }))).toEqual({ bound: 'detail', size: 1_048_577 });
    expect(refused(made('Edit', { file_path: 'C:\\a.txt', old_string: 'x'.repeat(600_000), new_string: 'y'.repeat(600_000) }))).toEqual({ bound: 'detail', size: 1_200_000 });
    // Any other detail up to 65,536.
    expect(refused(made('Bash', { command: 'x'.repeat(MAX_APPROVAL_DETAIL) }))).toBe('shown');
    expect(refused(made('Bash', { command: 'x'.repeat(MAX_APPROVAL_DETAIL + 1) }))).toEqual({ bound: 'detail', size: 65_537 });
    expect(refused(made('mcp__notes__write', { text: 'x'.repeat(MAX_APPROVAL_DETAIL) }))).toMatchObject({ bound: 'detail' });
    // A path is never cut: a cut path would name another file.
    expect(refused(made('Write', { file_path: `C:\\${'p'.repeat(MAX_APPROVAL_PATH)}`, content: 'x' }))).toEqual({ bound: 'path', size: MAX_APPROVAL_PATH + 3 });
    expect(refused(made('Bash', { command: 'ls' }, { blocked_path: 'b'.repeat(MAX_APPROVAL_PATH + 1) }))).toEqual({ bound: 'path', size: MAX_APPROVAL_PATH + 1 });
  });
});

describe('which request may carry the session grant (C56, C68)', () => {
  const RULE = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' };
  const offered = (suggestions: unknown, patch: Frame = {}) => shown(made('Bash', { command: 'npm test' }, { permission_suggestions: suggestions, ...patch }));

  it('one that holds a rule that allows, whatever scope the CLI wrote on it: the choice, its words, and the same grant', () => {
    for (const destination of ['localSettings', 'userSettings', 'projectSettings', 'session']) {
      const view = offered([{ ...RULE, destination }]);
      expect(view.request.choices, destination).toEqual(['approve', 'approve-session', 'deny']);
      expect(view.request.grant, destination).toEqual({ covers: 'npm test' });
      expect(view.grant, destination).toEqual({ type: 'addRules', rules: RULE.rules, behavior: 'allow', destination: 'session' });
      // Said as more than this action only where the CLI would have kept it.
      expect(view.request.authority, destination).toEqual(destination === 'session' ? [] : [{ kind: 'saved-rule', mode: null }]);
    }
  });

  it('and no other: a change of mode, a folder, a rule that denies, replaces or removes, or a request marked as one to keep no rule for', () => {
    const none: [string, unknown, Frame?][] = [
      ['no offer', undefined], ['offers that are no list', 'addRules'], ['a mode', [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]],
      ['a folder', [{ type: 'addDirectories', directories: ['C:\\work'], destination: 'session' }]],
      ['a rule that denies', [{ ...RULE, behavior: 'deny' }]], ['rules that replace', [{ ...RULE, type: 'replaceRules' }]], ['rules that are removed', [{ ...RULE, type: 'removeRules' }]],
      ['a rule, on a request marked for none', [RULE], { suppress_always_allow_rule: true }],
      // What a grant covers is the CLI's rule text, whole: one too long to say is not offered, and never cut.
      ['a rule too long to word', [{ ...RULE, rules: [{ toolName: 'Bash', ruleContent: 'x'.repeat(MAX_GRANT_COVERS + 1) }] }]],
    ];
    for (const [what, suggestions, patch] of none) {
      const view = offered(suggestions, patch);
      expect(view.request.choices, what).toEqual(['approve', 'deny']);
      expect([view.request.grant, view.grant], what).toEqual([null, null]);
    }
    // The first rule that allows is the one, where the CLI offers more than one.
    expect(offered([{ ...RULE, behavior: 'deny' }, { ...RULE, rules: [{ toolName: 'Bash', ruleContent: 'npm run build' }] }, RULE]).request.grant).toEqual({ covers: 'npm run build' });
  });

  it('names the mode that would stop the question only where one change of mode is all the CLI offers, by fat-g’s id and never the CLI’s word', () => {
    const mode = (word: string) => ({ type: 'setMode', mode: word, destination: 'session' });
    expect(offered([mode('acceptEdits')]).request.modeThatWouldStop).toBe('edits-ok');
    expect(offered([mode('auto')]).request.modeThatWouldStop).toBe('auto-reviewed');
    // A mode fat-g has none for, two modes, a mode beside anything else: none is named.
    for (const suggestions of [[mode('plan')], [mode('acceptEdits'), mode('auto')], [mode('acceptEdits'), RULE], [mode('acceptEdits'), { type: 'addDirectories' }], []]) expect(offered(suggestions).request.modeThatWouldStop, JSON.stringify(suggestions)).toBeNull();
    // What is said of the offers is a kind and an id: `plan` is a change of mode with no id of fat-g's.
    expect(offered([mode('plan'), mode('bypassPermissions'), mode('plan')]).request.authority).toEqual([{ kind: 'mode', mode: null }, { kind: 'mode', mode: 'berserk' }]);
    expect(JSON.stringify(offered([mode('acceptEdits'), mode('bypassPermissions')]).request)).not.toMatch(/acceptEdits|bypassPermissions/);
  });

  it('says a rule that is no grant as one the CLI would keep, or as more than this action; and each kind once', () => {
    const view = offered([{ ...RULE, behavior: 'deny' }, { ...RULE, behavior: 'deny', destination: 'session' }, { type: 'somethingNew' }, { type: 'addDirectories' }, { type: 'addDirectories' }]);
    expect(view.request.authority).toEqual([{ kind: 'saved-rule', mode: null }, { kind: 'other', mode: null }, { kind: 'folder', mode: null }]);
  });
});

describe('an `Agent` tool use’s model and agent definition (M106: C14, C20)', () => {
  const agent = (input: Record<string, unknown>) => takeTool({ type: 'tool_use', id: 'agent-1', name: 'Agent', input }, MCP_TOOL_PREFIX);

  it('takes the alias it asks for and the type it names as fields of their own, beside its parts', () => {
    expect(agent({ description: 'Reads notes', model: 'haiku', subagent_type: 'Explore' })).toMatchObject({ activityType: 'worker', model: 'haiku', agentType: 'Explore', start: { summary: 'Reads notes' } });
    expect(agent({ description: 'Reads notes' })).toMatchObject({ model: null, agentType: null });
  });

  it('names no model that is no catalog id, and reads neither for another tool', () => {
    for (const model of ['', 'two words', 3, null, 'x'.repeat(129)]) expect(agent({ model })?.model, String(model)).toBeNull();
    expect(takeTool({ type: 'tool_use', id: 'r-1', name: 'Read', input: { file_path: 'a.md', model: 'haiku', subagent_type: 'Explore' } }, MCP_TOOL_PREFIX)).toMatchObject({ model: null, agentType: null });
  });
});
