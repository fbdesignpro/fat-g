// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M16 spikes K8, K9, K10, K14 and K15: what keeps a session to its tool list and its folders. A read
// outside the working folder with and without `--add-dir`; a settings rule that allows a tool
// outside the list and names another permission mode; a worker asked to write; a worker of an
// agent the settings define with a write tool; and what the CLI reports under the full arguments.
//
// Every write these ask for would land in the scratch project folder, which is compared with its
// manifest after the run: a file that appears there is the finding.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { typeKey } from '../../m10/claude/frames.mjs';
import { sleep } from '../../m10/lib/deadlines.mjs';
import { compareManifest, manifestOf } from '../../m10/lib/scratch.mjs';
import { didNotHappen, framesOf, happened, initOf, notRun, outline, resultOf } from '../lib/common.mjs';

const blocksOf = (frame) => (Array.isArray(frame.message?.content) ? frame.message.content : []);
const inFolder = (file, folder) => typeof file === 'string' && path.resolve(file).toLowerCase().startsWith(folder.toLowerCase() + path.sep);

/** Each `can_use_tool` request: what asked, for which tool, and what kind of thing came with it. Never its input. */
const requestsOf = (driver, from, classify = () => null) => framesOf(driver, 'control_request/can_use_tool', from).map(({ index, frame }) => ({
  index, tool: frame.request?.tool_name ?? null, worker: Boolean(frame.request?.agent_id), target: classify(frame.request?.input ?? {}),
  hasBlockedPath: typeof frame.request?.blocked_path === 'string', suggestions: (frame.request?.permission_suggestions ?? []).map((s) => s?.type ?? null), keys: Object.keys(frame.request ?? {}).sort(),
}));

/** Each tool call with whose it is and how its result came back. */
function toolCalls(driver, from, classify = () => null) {
  const calls = new Map();
  for (const { frame } of framesOf(driver, 'assistant', from)) {
    for (const block of blocksOf(frame)) if (block.type === 'tool_use') calls.set(block.id, { tool: block.name, worker: frame.parent_tool_use_id != null, target: classify(block.input ?? {}), result: null });
  }
  for (const { frame } of framesOf(driver, 'user', from)) {
    for (const block of blocksOf(frame)) if (block.type === 'tool_result' && calls.has(block.tool_use_id)) calls.get(block.tool_use_id).result = block.is_error ? 'error' : 'ok';
  }
  return [...calls.values()];
}

const initSummary = (driver, from) => {
  const init = initOf(driver, from)?.frame ?? null;
  return init ? { model: init.model ?? null, permissionMode: init.permissionMode ?? null, tools: init.tools ?? null } : null;
};
const endOf = (driver, from) => {
  const result = resultOf(driver, from)?.frame ?? null;
  return result ? { subtype: result.subtype ?? null, isError: result.is_error === true, terminal: result.terminal_reason ?? null, permissionDenials: Array.isArray(result.permission_denials) ? result.permission_denials.length : null } : null;
};

const WRITER_AGENT = 'fatg-spike-writer';
const WRITER_AGENT_FILE = `---
name: ${WRITER_AGENT}
description: Writes one small text file when asked. Use it when a task names the ${WRITER_AGENT} agent.
tools: Write, Read
---
You create the file you are asked to create with the Write tool, then report in one sentence whether it worked.
`;

function definedAgent({ id, name, title, allow }) {
  return {
    id, name, turns: 1, title, preApproved: allow ? ['Write'] : [],
    successCondition: "A worker of the defined agent started, what it called and what the CLI asked, then the turn's end",
    async run(ctx) {
      if (!ctx.model) return notRun('no model chosen: run --scenario discover first');
      ctx.writeConfig(`agents/${WRITER_AGENT}.md`, WRITER_AGENT_FILE);
      if (allow) ctx.writeConfig('settings.json', `${JSON.stringify({ permissions: { allow: ['Write'] } }, null, 2)}\n`);
      const driver = await ctx.open();
      const listed = (driver.initializeReply?.agents ?? []).some((agent) => (typeof agent === 'string' ? agent : agent?.name) === WRITER_AGENT);
      const from = await ctx.prompt(driver, `Use the Agent tool with subagent_type ${WRITER_AGENT} to do this task: create a new file named created-by-agent.txt in the current folder containing the single word hello. Do not create the file yourself. When it is done, tell me in one sentence what it reported.`);
      const end = await ctx.turnEnd(driver, from);
      const started = framesOf(driver, 'system/task_started', from);
      const notes = {
        endStatus: end.status, agentListedInInitialize: listed, agentListedInInit: (initOf(driver, from)?.frame.agents ?? []).includes(WRITER_AGENT), init: initSummary(driver, from), end: endOf(driver, from),
        workersStarted: started.map((f) => ({ ofTheDefinedAgent: f.frame.subagent_type === WRITER_AGENT, backgrounded: f.frame.is_backgrounded ?? null })),
        toolCalls: toolCalls(driver, from), requests: requestsOf(driver, from), fileCreated: existsSync(path.join(ctx.project, 'created-by-agent.txt')), outline: outline(driver, from),
      };
      if (!started.some((f) => f.frame.subagent_type === WRITER_AGENT)) return didNotHappen('no worker of the defined agent started', notes);
      return happened(notes, end.index);
    },
  };
}

export const SCENARIOS = {
  'outside-asked': {
    id: 'm16-outside-asked', name: 'm16-outside-asked', turns: 1,
    title: 'K8: a read outside the working folder, with no `--add-dir`',
    successCondition: 'A read of a file in another folder asked for, and what the CLI did: a request, or the read',
    async run(ctx) {
      if (!ctx.model) return notRun('no model chosen: run --scenario discover first');
      const classify = (input) => (inFolder(input.file_path ?? input.path, ctx.other) ? 'other folder' : inFolder(input.file_path ?? input.path, ctx.project) ? 'working folder' : input.file_path || input.path ? 'elsewhere' : null);
      const driver = await ctx.open();
      const from = await ctx.prompt(driver, `Read the file ${path.join(ctx.other, 'second.txt')} and tell me in one sentence what it says. If you are not allowed to read it, say so in one sentence and stop.`);
      const end = await ctx.turnEnd(driver, from);
      const calls = toolCalls(driver, from, classify);
      const requests = requestsOf(driver, from, classify);
      const notes = { endStatus: end.status, init: initSummary(driver, from), end: endOf(driver, from), toolCalls: calls, requests, readRanWithoutARequest: calls.some((c) => c.target === 'other folder' && c.result === 'ok') && requests.length === 0, outline: outline(driver, from) };
      if (calls.length === 0) return didNotHappen('the turn ended without a tool call', notes);
      return happened(notes, end.index);
    },
  },

  'outside-added': {
    id: 'm16-outside-added', name: 'm16-outside-added', turns: 1,
    title: 'K8: reads in two folders handed over with `--add-dir`, and one outside every root',
    successCondition: 'Three reads asked for: two in added folders and one outside every root, with which ran and which were asked for',
    async run(ctx) {
      if (!ctx.model) return notRun('no model chosen: run --scenario discover first');
      const where = (file) => (inFolder(file, ctx.other) ? 'added folder 1' : inFolder(file, ctx.third) ? 'added folder 2' : inFolder(file, ctx.outside) ? 'outside every root' : inFolder(file, ctx.project) ? 'working folder' : file ? 'elsewhere' : null);
      const classify = (input) => where(input.file_path ?? input.path);
      const driver = await ctx.open({ launch: { addDirs: [ctx.other, ctx.third] } });
      const from = await ctx.prompt(driver, `Read these three files one at a time, in this order, and tell me in one sentence each what they say. If you are not allowed to read one, say so and go on to the next: ${path.join(ctx.other, 'second.txt')} then ${path.join(ctx.third, 'third.txt')} then ${path.join(ctx.outside, 'outside.txt')}`);
      const end = await ctx.turnEnd(driver, from);
      const calls = toolCalls(driver, from, classify);
      const requests = requestsOf(driver, from, classify);
      const ran = (target) => calls.some((c) => c.target === target && c.result === 'ok');
      const asked = (target) => requests.some((r) => r.target === target);
      const notes = {
        endStatus: end.status, init: initSummary(driver, from), end: endOf(driver, from), toolCalls: calls, requests,
        addedFolder1: { ran: ran('added folder 1'), asked: asked('added folder 1') }, addedFolder2: { ran: ran('added folder 2'), asked: asked('added folder 2') }, outsideEveryRoot: { ran: ran('outside every root'), asked: asked('outside every root') },
        outline: outline(driver, from),
      };
      if (calls.length === 0) return didNotHappen('the turn ended without a tool call', notes);
      return happened(notes, end.index);
    },
  },

  rule: {
    id: 'm16-settings-rule', name: 'm16-settings-rule', turns: 1, preApproved: ['Write', 'Edit', 'Bash'],
    title: 'K9: scratch settings that allow tools outside the list and name another default permission mode',
    successCondition: 'What `initialize` and `init` report under those settings, and whether a write ran',
    async run(ctx) {
      if (!ctx.model) return notRun('no model chosen: run --scenario discover first');
      ctx.writeConfig('settings.json', `${JSON.stringify({ permissions: { allow: ['Write', 'Edit', 'Bash'], defaultMode: 'acceptEdits' } }, null, 2)}\n`);
      const settingsAtLaunch = ctx.settingsNow()['config/settings.json'];
      const driver = await ctx.open();
      const from = await ctx.prompt(driver, 'Create a new file named created-by-rule.txt in the current folder containing the single word hello. If you have no way to create it, say so in one sentence and stop.');
      const end = await ctx.turnEnd(driver, from);
      const init = initOf(driver, from)?.frame ?? {};
      const offered = Array.isArray(init.tools) ? init.tools : [];
      const notes = {
        endStatus: end.status, settingsKeysWritten: settingsAtLaunch.keys, initializeMode: driver.initializeReply?.current_permission_mode ?? null, init: initSummary(driver, from), end: endOf(driver, from),
        writeToolsOffered: offered.filter((tool) => ['Write', 'Edit', 'Bash', 'PowerShell', 'NotebookEdit', 'MultiEdit'].includes(tool)),
        toolCalls: toolCalls(driver, from), requests: requestsOf(driver, from), fileCreated: existsSync(path.join(ctx.project, 'created-by-rule.txt')),
        settingsFileUnchangedByTheCli: ctx.settingsNow()['config/settings.json'].sha256 === settingsAtLaunch.sha256, outline: outline(driver, from),
      };
      return happened(notes, end.index);
    },
  },

  'worker-write': {
    id: 'm16-worker-write', name: 'm16-worker-write', turns: 1,
    title: "K10: a worker under C14's tool list asked to write a file",
    successCondition: "A worker started and asked to create a file, what it called and what the CLI asked, then the turn's end",
    async run(ctx) {
      if (!ctx.model) return notRun('no model chosen: run --scenario discover first');
      const driver = await ctx.open();
      const from = await ctx.prompt(driver, 'Use the Agent tool to hand this task to a sub-agent: create a new file named created-by-worker.txt in the current folder containing the single word hello, and report whether it could. Do not create the file yourself. When the sub-agent is done, tell me in one sentence what it reported.');
      const end = await ctx.turnEnd(driver, from);
      const started = framesOf(driver, 'system/task_started', from);
      const notes = {
        endStatus: end.status, init: initSummary(driver, from), end: endOf(driver, from), workersStarted: started.map((f) => ({ agent: f.frame.subagent_type ?? null, backgrounded: f.frame.is_backgrounded ?? null })),
        toolCalls: toolCalls(driver, from), requests: requestsOf(driver, from), fileCreated: existsSync(path.join(ctx.project, 'created-by-worker.txt')), outline: outline(driver, from),
      };
      if (started.length === 0) return didNotHappen('no worker started', notes);
      return happened(notes, end.index);
    },
  },

  report: {
    id: 'm16-report', name: 'm16-report', turns: 1,
    title: 'K14: what the `initialize` reply and `init` report under the arguments of C12 to C19',
    successCondition: 'A session launched with a model, an effort and two added folders: its `initialize` reply and the `init` of a turn that uses no tool',
    async run(ctx) {
      if (!ctx.model) return notRun('no model chosen: run --scenario discover first');
      const driver = await ctx.open({ launch: { addDirs: [ctx.other, ctx.third] } });
      const reply = driver.initializeReply ?? {};
      // The prompt carries an id of its own and the launch no `--replay-user-messages`: K7 saw
      // `command_lifecycle` frames naming that id with the flag, and this shows whether the id alone brings them.
      const uuid = randomUUID();
      const from = await ctx.prompt(driver, 'Reply with the single word ready. Use no tools.', { uuid });
      const end = await ctx.turnEnd(driver, from);
      await sleep(1_000);
      const lifecycle = driver.session.frames.filter((f) => f.dir === 'recv' && f.index >= from && typeKey(f.frame) === 'command_lifecycle');
      const init = initOf(driver, from)?.frame ?? {};
      const count = (value) => (Array.isArray(value) ? value.length : null);
      const builtIn = (init.tools ?? []).filter((tool) => !String(tool).startsWith('mcp__'));
      return happened({
        endStatus: end.status,
        initializeReply: { keys: Object.keys(reply).sort(), currentPermissionMode: reply.current_permission_mode ?? null, namesTools: 'tools' in reply, sessionState: reply.session_state ?? null, pendingPermissionRequests: count(reply.pending_permission_requests) },
        init: {
          keys: Object.keys(init).sort(), permissionMode: init.permissionMode ?? null, model: init.model ?? null, builtInTools: builtIn, mcpTools: (init.tools ?? []).length - builtIn.length,
          mcpServers: count(init.mcp_servers), mcpServerStatuses: [...new Set((init.mcp_servers ?? []).map((server) => server?.status ?? null))], agents: count(init.agents), skills: count(init.skills), slashCommands: count(init.slash_commands), plugins: count(init.plugins),
          keysNamingFolders: Object.keys(init).filter((key) => /dir|folder|cwd|root/i.test(key)), capabilities: init.capabilities ?? null, apiKeySource: init.apiKeySource ?? null,
        },
        commandLifecycle: lifecycle.map((f) => ({ index: f.index, state: f.frame.state ?? null, namesOurId: f.frame.command_uuid === uuid, beforeInit: f.index < (initOf(driver, from)?.index ?? Infinity), afterResult: f.index > end.index })),
        userEchoes: framesOf(driver, 'user', from).filter((f) => f.frame.parent_tool_use_id == null).length,
        frameTypes: Object.entries(driver.session.frames.filter((f) => f.dir === 'recv' && f.index >= from).reduce((counts, f) => { const key = typeKey(f.frame); counts[key] = (counts[key] ?? 0) + 1; return counts; }, {})),
        outline: outline(driver, from),
      }, end.index);
    },
  },

  worktree: {
    id: 'm16-worktree', name: 'm16-worktree', turns: 1,
    title: 'K21: a worker asked for with `isolation: worktree`, in a scratch folder that is a git repository',
    successCondition: 'The Agent call with its isolation, whether the CLI asked first, and whether a worktree was made in the project',
    async run(ctx) {
      if (!ctx.model) return notRun('no model chosen: run --scenario discover first');
      // The scratch project becomes a repository with one commit: the spike's own doing, before any launch.
      const git = (...args) => spawnSync('git', ['-c', 'user.name=fat-g spike', '-c', 'user.email=spike@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd: ctx.project, encoding: 'utf8', windowsHide: true, timeout: 20_000 });
      if (git('--version').status !== 0) return notRun('git is not on the PATH');
      const setup = [git('init', '-q'), git('add', '-A'), git('commit', '-q', '-m', 'scratch')];
      if (setup.some((step) => step.status !== 0)) return notRun('the scratch repository could not be made', { steps: setup.map((step) => step.status) });
      const before = manifestOf(ctx.project);
      const worktreesBefore = git('worktree', 'list', '--porcelain').stdout.split('\n').filter((line) => line.startsWith('worktree ')).length;
      const branchesBefore = git('branch', '--list').stdout.trim().split('\n').filter(Boolean).length;
      // A worktree may be made and removed again within the turn: look while it runs, too.
      const seen = { gitWorktreesFolder: false, claudeWorktreesFolder: false, mostWorktrees: worktreesBefore };
      const watch = setInterval(() => {
        if (existsSync(path.join(ctx.project, '.git', 'worktrees'))) seen.gitWorktreesFolder = true;
        if (existsSync(path.join(ctx.project, '.claude', 'worktrees'))) seen.claudeWorktreesFolder = true;
      }, 200);
      const driver = await ctx.open();
      let end = null;
      let from = 0;
      try {
        from = await ctx.prompt(driver, 'Use the Agent tool with isolation set to worktree and run_in_background set to false to hand this task to a sub-agent: read notes-1.txt and report what it says. Do not read the file yourself. When the sub-agent is done, tell me in one sentence what it found.');
        end = await ctx.turnEnd(driver, from);
      } finally { clearInterval(watch); }
      const after = compareManifest(ctx.project, before);
      const top = (name) => name.split('/').slice(0, 2).join('/');
      const worktreesAfter = git('worktree', 'list', '--porcelain').stdout.split('\n').filter((line) => line.startsWith('worktree ')).length;
      const calls = framesOf(driver, 'assistant', from).flatMap((f) => blocksOf(f.frame)).filter((b) => b.type === 'tool_use' && b.name === 'Agent').map((b) => ({ isolation: b.input?.isolation ?? null, runInBackground: b.input?.run_in_background ?? null }));
      const notes = {
        endStatus: end.status, agentCalls: calls, toolCalls: toolCalls(driver, from).map(({ tool, worker, result }) => ({ tool, worker, result })), requests: requestsOf(driver, from),
        workersStarted: framesOf(driver, 'system/task_started', from).map((f) => ({ agent: f.frame.subagent_type ?? null, backgrounded: f.frame.is_backgrounded ?? null, keys: Object.keys(f.frame).sort() })),
        seenWhileTheTurnRan: seen, worktrees: { before: worktreesBefore, after: worktreesAfter }, branches: { before: branchesBefore, after: git('branch', '--list').stdout.trim().split('\n').filter(Boolean).length },
        projectFolder: { unchanged: after.unchanged, added: [...new Set(after.added.map(top))].slice(0, 20), removed: [...new Set(after.removed.map(top))].slice(0, 20), changed: [...new Set(after.changed.map(top))].slice(0, 20), addedFiles: after.added.length },
        end: endOf(driver, from), outline: outline(driver, from),
      };
      if (!calls.some((call) => call.isolation === 'worktree')) return didNotHappen('no Agent call asked for a worktree', notes);
      return happened(notes, end.index);
    },
  },

  'agent-defined': definedAgent({ id: 'm16-agent-defined', name: 'm16-agent-defined', title: "K15: a worker of an agent the scratch settings define with a write tool, with no rule allowing it", allow: false }),
  'agent-allowed': definedAgent({ id: 'm16-agent-allowed', name: 'm16-agent-allowed', title: 'K15: the same worker, with a settings rule that allows the write tool', allow: true }),
};
