// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Names of configured items that ship with the CLIs themselves (C54). Seeded from public
// documentation and the Agent SDK's type definitions, never from a CLI folder (C3). A name that is
// not listed here is treated as the user's own and gets an alias in a fixture.
//
// Reviewed by the maintainer at M10 step 5. Adding a name here means it may appear in a committed
// fixture, so only add names the vendors document as built in.

export const SHIPPED = Object.freeze({
  claude: {
    // Built-in tools (sdk-tools.d.ts `ToolInputSchemas`, plus documented older names).
    tools: [
      'Agent', 'Task', 'Bash', 'BashOutput', 'KillShell', 'Edit', 'MultiEdit', 'Read', 'Write', 'Glob', 'Grep', 'LS',
      'NotebookEdit', 'NotebookRead', 'TodoWrite', 'WebFetch', 'WebSearch', 'AskUserQuestion', 'ExitPlanMode',
      'EnterPlanMode', 'TaskStop', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList', 'TaskOutput', 'ListMcpResourcesTool',
      'ReadMcpResourceTool', 'Skill', 'SlashCommand', 'ToolSearch', 'Workflow', 'CronCreate', 'CronDelete', 'CronList',
      'ScheduleWakeup', 'RemoteTrigger', 'ReadNotifications', 'Monitor', 'EnterWorktree', 'ExitWorktree',
      'PushNotification', 'LSP', 'PowerShell',
    ],
    // Built-in slash commands (Claude Code documentation, "Slash commands").
    // Conservative on purpose: an unlisted built-in only costs an alias in a fixture.
    commands: [
      'add-dir', 'agents', 'bug', 'clear', 'compact', 'config', 'context', 'cost', 'doctor', 'effort', 'exit',
      'export', 'fast', 'feedback', 'help', 'hooks', 'ide', 'init', 'install-github-app', 'login', 'logout', 'mcp',
      'memory', 'model', 'output-style', 'permissions', 'plan', 'plugin', 'pr-comments', 'privacy-settings',
      'release-notes', 'rename', 'resume', 'review', 'rewind', 'sandbox', 'security-review', 'skills', 'status',
      'statusline', 'terminal-setup', 'todos', 'upgrade', 'usage', 'vim',
      // Bundled skills the documentation lists.
      'batch', 'debug', 'loop', 'simplify', 'claude-api',
    ],
    // Built-in sub-agent types (documentation, "Subagents").
    agents: ['general-purpose', 'Explore', 'Plan', 'statusline-setup', 'output-style-setup', 'claude-code-guide'],
    outputStyles: ['default', 'Explanatory', 'Learning'],
    skills: [],
    plugins: [],
    mcpServers: [],
    // Added at the maintainer's request: what Claude Code 2.1.268 itself reported in
    // M10's discovery and traces with empty setting sources, strict MCP configuration and no
    // plugins, so nothing of the user's could load. It reported every skill as `source: built-in`.
    // The claude.ai connectors it listed in the trust spike's positive control are the user's own
    // and are deliberately NOT here.
    reportedBuiltIn: {
      agents: ['claude'],
      commands: [
        '__remote-workflow', 'advisor', 'auto-mode-setup', 'autocompact', 'code-review', 'color', 'dataviz',
        'deep-research', 'design', 'design-consent', 'design-revoke', 'design-sync', 'extra-usage',
        'fewer-permission-prompts', 'goal', 'heapdump', 'import', 'insights', 'list-agents', 'recap', 'reload-plugins',
        'reload-skills', 'run', 'run-skill-generator', 'schedule', 'skill-doctor', 'team-onboarding', 'ultrareview',
        'update-config', 'usage-credits', 'verify', 'workflow-authoring', 'workflow-launch-exec',
      ],
      skills: ['keybindings-help'],
      outputStyles: ['Concise', 'Proactive'],
    },
  },
  codex: {
    tools: [],
    commands: [],
    agents: [],
    skills: [],
    plugins: [],
    mcpServers: [],
  },
});

/** Names the spikes themselves create, which are not private either. */
export const SPIKE_OWN = Object.freeze(['fatg-marker', 'm23-marker']);

/** Every shipped name for `cli`, lower-cased, across kinds (nested groups included). */
export function shippedSet(cli) {
  const names = [];
  const collect = (value) => {
    if (Array.isArray(value)) names.push(...value);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(SHIPPED[cli] ?? {});
  return new Set([...names, ...SPIKE_OWN].map((name) => name.toLowerCase()));
}
