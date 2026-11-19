// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V2, V20, V25, V34 (docs/planning/_archive/M22.md, Design 1, 6; C3, C5, C39, C44, C45, C47, C63, C74, C85,
// C94, C96, C97): Claude's five modes — what the descriptor declares of them, the CLI's own word and
// the tool list each is launched with, what its reports are held to, which changes the CLI makes on
// a live process, and which modes an account is offered.
import { describe, expect, it } from 'vitest';
import { declaredTransition, modeOf, readingMode, resolveMode } from '@shared/contracts/permissions';
import { CLAUDE_MODE_IDS, CLAUDE_MODES, CLAUDE_PERMISSIONS, CLAUDE_PLANS, claudeMode, claudeModeAvailability, claudeTransition, EXECUTION_TOOLS, FLAG_ONLY_MODES, mayName, modeIdOfWord, modeReason, PLAN_MODES, PLAN_TOOL, PLAN_WORD, planVariant, READING_MODE, READING_TOOLS, reportsMode, reportsTools, SETTABLE_WORDS, VALIDATED_MODES } from './chat-modes';
import { scriptedChat } from './chat-test-support';
import { CLAUDE_DESCRIPTOR } from './descriptor';
import { createClaudeFacet } from './facet';

describe('what Claude’s descriptor declares of its modes (C39, C63)', () => {
  it('lists its five alone, in fat-g’s names, each with the one line that says what runs without asking', () => {
    expect(CLAUDE_DESCRIPTOR.capabilities.permissions).toBe(CLAUDE_PERMISSIONS);
    expect(CLAUDE_PERMISSIONS.modes.map((mode) => [mode.id, mode.label, mode.description])).toEqual([
      // "Your files", so that its searching is not taken for the web's.
      ['read-only', 'Read only + allowed MCP', 'Reads and searches your files and asks you; every request to act is refused — the MCP tools your settings allow and your hooks still act'],
      // The CLI's build lets a fetch of its own documentation sites run with no request.
      ['ask-first', 'Ask first', 'Each command, file change, web search, fetch and other tool asks before it runs, unless a rule of your configuration allows it; Claude fetches its own list of documentation sites without asking'],
      // K2 saw a file change and two commands run under it with no request, and K5 a sub-agent's (C97).
      ['edits-ok', 'Edits ok', 'File changes run without asking, and so do the commands Claude holds safe and fetches of its documentation sites, for its sub-agents too; other commands, searches and fetches ask'],
      // K5 saw a file made outside every root with no request and no frame of a review (C96).
      ['auto-reviewed', 'Auto reviewed', 'Claude decides by itself what would ask, outside the project’s folders too, for its sub-agents too, with no card here'],
      // The one that asks nothing names the CLI's own word for it (C3).
      ['berserk', 'Berserk', 'Everything runs without asking, for its sub-agents too: Claude’s Bypass permissions'],
    ]);
    expect(CLAUDE_PERMISSIONS.modes.map((mode) => mode.id)).toEqual([...CLAUDE_MODE_IDS]);
    // No Codex mode among them (C63): a provider shows its own.
    expect(CLAUDE_PERMISSIONS.modes.some((mode) => mode.id === 'sandbox-ok')).toBe(false);
  });

  it('says which of them ask, which one reads, and that no account needs a set-up step', () => {
    expect(CLAUDE_PERMISSIONS.modes.map((mode) => [mode.id, mode.asks, mode.reading])).toEqual([
      ['read-only', false, true], ['ask-first', true, false], ['edits-ok', true, false], ['auto-reviewed', true, false], ['berserk', false, false],
    ]);
    expect(readingMode(CLAUDE_PERMISSIONS)?.id).toBe('read-only');
    expect(CLAUDE_PERMISSIONS.setup).toBeNull();
  });

  it('falls back to Auto reviewed, and to the reading mode where Auto reviewed cannot be used', () => {
    expect(CLAUDE_PERMISSIONS.fallback).toBe('auto-reviewed');
    expect(modeOf(CLAUDE_PERMISSIONS, CLAUDE_PERMISSIONS.fallback)?.asks).toBe(true);
    const none = { saved: null, project: null, user: null };
    expect(resolveMode(CLAUDE_PERMISSIONS, none)).toEqual({ id: 'auto-reviewed', source: 'fallback' });
    expect(resolveMode(CLAUDE_PERMISSIONS, none, (id) => id !== 'auto-reviewed')).toEqual({ id: 'read-only', source: 'fallback' });
    // A choice stands, whichever it is: a saved Berserk is no fallback's to replace (C43).
    expect(resolveMode(CLAUDE_PERMISSIONS, { saved: 'berserk', project: 'edits-ok', user: 'read-only' })).toEqual({ id: 'berserk', source: 'chat' });
    // And an id of another provider's is no choice here.
    expect(resolveMode(CLAUDE_PERMISSIONS, { saved: 'sandbox-ok', project: null, user: 'edits-ok' })).toEqual({ id: 'edits-ok', source: 'user' });
  });

  it('carries the one line that stands under every list of them, and the one that says what is known of the CLI’s rules (C3, C23)', () => {
    // No description promises a card before every action: K2 saw a rule, an allowed MCP tool and a hook act with no request.
    expect(CLAUDE_PERMISSIONS.inherited).toBe('Rules, allowed MCP tools and hooks of your own configuration act as it lets them, with no card here');
    expect(CLAUDE_PERMISSIONS.rules).toBe('Claude’s rules are not listed by this CLI version');
  });

  it('names one another for the three a change with no restart moves between, and none for the reading mode and Berserk (C2, C74)', () => {
    expect(Object.fromEntries(CLAUDE_PERMISSIONS.modes.map((mode) => [mode.id, mode.transitionsFrom]))).toEqual({
      'read-only': [], 'ask-first': ['edits-ok', 'auto-reviewed'], 'edits-ok': ['ask-first', 'auto-reviewed'], 'auto-reviewed': ['ask-first', 'edits-ok'], berserk: [],
    });
    // What the declared lists say is what the adapter answers, for every pair.
    for (const from of CLAUDE_MODE_IDS) for (const to of CLAUDE_MODE_IDS) if (from !== to) expect(claudeTransition(from, to), `${from} → ${to}`).toBe(declaredTransition(CLAUDE_PERMISSIONS, from, to));
  });
});

describe('each mode in the CLI’s own words (C5, C45, C47)', () => {
  it('maps the five to four words: the reading mode and Ask first share the CLI’s own, and differ by the tools', () => {
    expect(CLAUDE_MODE_IDS.map((id) => [id, CLAUDE_MODES[id].native, CLAUDE_MODES[id].tools.length])).toEqual([
      ['read-only', 'default', 5], ['ask-first', 'default', 11], ['edits-ok', 'acceptEdits', 11], ['auto-reviewed', 'auto', 11], ['berserk', 'bypassPermissions', 11],
    ]);
    expect([...READING_TOOLS]).toEqual(['Read', 'Glob', 'Grep', 'Agent', 'AskUserQuestion']);
    // The execution modes add the three that act (C5), the two of the web, and the plan's tool (M22b, C8), and no twelfth.
    expect([...EXECUTION_TOOLS]).toEqual(['Read', 'Glob', 'Grep', 'Agent', 'AskUserQuestion', 'Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'ExitPlanMode']);
    for (const id of CLAUDE_MODE_IDS) expect(CLAUDE_MODES[id].tools, id).toBe(id === 'read-only' ? READING_TOOLS : EXECUTION_TOOLS);
    expect(CLAUDE_MODE_IDS.filter((id) => CLAUDE_MODES[id].reading)).toEqual(['read-only']);
    expect(Object.isFrozen(CLAUDE_MODES)).toBe(true);
  });

  it('runs a start that names no mode, or one it does not know, under the reading mode: never one that acts', () => {
    for (const id of [null, undefined, '', 'sandbox-ok', 'Berserk', 'bypassPermissions', 'default', 'acceptEdits']) expect(claudeMode(id), String(id)).toBe(READING_MODE);
    for (const id of CLAUDE_MODE_IDS) expect(claudeMode(id).id).toBe(id);
  });

  it('holds a report to the mode’s own word — `manual` too for the CLI’s default — and to the tools its launch offered', () => {
    for (const id of ['read-only', 'ask-first'] as const) {
      expect(reportsMode(CLAUDE_MODES[id], 'default')).toBe(true);
      expect(reportsMode(CLAUDE_MODES[id], 'manual')).toBe(true);
      for (const word of ['acceptEdits', 'auto', 'bypassPermissions', 'plan', 'dontAsk', '', null, undefined, 7]) expect(reportsMode(CLAUDE_MODES[id], word), `${id}: ${String(word)}`).toBe(false);
    }
    for (const [id, word] of [['edits-ok', 'acceptEdits'], ['auto-reviewed', 'auto'], ['berserk', 'bypassPermissions']] as const) {
      expect(reportsMode(CLAUDE_MODES[id], word)).toBe(true);
      for (const other of ['default', 'manual', 'plan', null]) expect(reportsMode(CLAUDE_MODES[id], other), `${id}: ${String(other)}`).toBe(false);
    }
    // The tools as `init` lists them: `Task` for the launch's `Agent`, and `Agent` for when that changes (C67).
    expect(reportsTools(READING_MODE, ['Task', 'AskUserQuestion', 'Glob', 'Grep', 'Read'])).toBe(true);
    expect(reportsTools(READING_MODE, ['Agent', 'Read'])).toBe(true);
    // A tool that acts or reaches the web is outside the reading mode's launch, and inside every other's.
    for (const tool of ['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch']) {
      expect(reportsTools(READING_MODE, ['Read', tool]), tool).toBe(false);
      for (const id of ['ask-first', 'edits-ok', 'auto-reviewed', 'berserk'] as const) expect(reportsTools(CLAUDE_MODES[id], ['Read', tool]), `${id}: ${tool}`).toBe(true);
    }
    // The acting modes pass their whole list as `init` names it, and a subset of it: an account or a backend whose CLI offers no web tool.
    for (const id of ['ask-first', 'edits-ok', 'auto-reviewed', 'berserk'] as const) {
      expect(reportsTools(CLAUDE_MODES[id], ['Task', 'AskUserQuestion', 'Bash', 'Edit', 'ExitPlanMode', 'Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch', 'Write']), id).toBe(true);
      expect(reportsTools(CLAUDE_MODES[id], ['Task', 'AskUserQuestion', 'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write']), id).toBe(true);
    }
    // No mode's launch offers another, and a list that is none cannot be compared.
    for (const id of CLAUDE_MODE_IDS) {
      for (const tool of ['NotebookEdit', 'MultiEdit', 'TodoWrite', 'Skill', 'ToolSearch']) expect(reportsTools(CLAUDE_MODES[id], ['Read', tool]), `${id}: ${tool}`).toBe(false);
      expect(reportsTools(CLAUDE_MODES[id], null)).toBe(false);
    }
  });

  it('gives fat-g’s id for a word one of the CLI’s offers names, and none for a mode fat-g has not', () => {
    expect(['default', 'manual', 'acceptEdits', 'auto', 'bypassPermissions'].map(modeIdOfWord)).toEqual(['ask-first', 'ask-first', 'edits-ok', 'auto-reviewed', 'berserk']);
    for (const word of ['plan', 'dontAsk', '', 'AcceptEdits', null, undefined, 7, {}]) expect(modeIdOfWord(word), JSON.stringify(word)).toBeNull();
  });
});

describe('a change of mode (C2, C5, C74)', () => {
  it('is made on the live process between Ask first, Edits ok and Auto reviewed, and by a new process for every other pair', () => {
    const idle: string[] = [];
    for (const from of CLAUDE_MODE_IDS) for (const to of CLAUDE_MODE_IDS) if (claudeTransition(from, to) === 'idle') idle.push(`${from} → ${to}`);
    expect(idle).toEqual(['ask-first → edits-ok', 'ask-first → auto-reviewed', 'edits-ok → ask-first', 'edits-ok → auto-reviewed', 'auto-reviewed → ask-first', 'auto-reviewed → edits-ok']);
    // Into the reading mode and out of it: another tool list, so no grant outlives the move (C45, C66).
    for (const other of ['ask-first', 'edits-ok', 'auto-reviewed', 'berserk']) expect([claudeTransition(other, 'read-only'), claudeTransition('read-only', other)], other).toEqual(['restart', 'restart']);
    // Into Berserk and out of it (C74): no process launched able to bypass permissions lives under another mode's name.
    for (const other of ['read-only', 'ask-first', 'edits-ok', 'auto-reviewed']) expect([claudeTransition(other, 'berserk'), claudeTransition('berserk', other)], other).toEqual(['restart', 'restart']);
    // A mode to itself is no change, and an id it does not know is no change it makes on a live process.
    for (const id of CLAUDE_MODE_IDS) expect(claudeTransition(id, id)).toBe('restart');
    expect([claudeTransition('ask-first', 'sandbox-ok'), claudeTransition('', 'edits-ok')]).toEqual(['restart', 'restart']);
  });

  it('names, on the wire, one of the three words and never the one that bypasses permissions', () => {
    expect([...SETTABLE_WORDS].sort()).toEqual(['acceptEdits', 'auto', 'default']);
    expect(SETTABLE_WORDS.has(CLAUDE_MODES.berserk.native)).toBe(false);
  });
});

describe('what an account is offered (C43, C47, C51, C85, C94)', () => {
  it('lists the five as shown under a turn, each available, with no set-up step, no trust recorded and no sandbox to say anything of', () => {
    // K2 showed Ask first and Edits ok under a turn, K5 Auto reviewed and Berserk (C94).
    expect([...VALIDATED_MODES]).toEqual(['read-only', 'ask-first', 'edits-ok', 'auto-reviewed', 'berserk']);
    // The installed CLI takes Berserk by the launch's mode argument alone (K2): no mode needs a flag fat-g never passes.
    expect([...FLAG_ONLY_MODES]).toEqual([]);
    expect(claudeModeAvailability()).toEqual(CLAUDE_MODE_IDS.map((id) => ({ id, available: true, reason: null, setup: false, records: false, unconfined: false, places: null })));
  });

  it('lists a mode left out of the constant as unavailable, with that reason, and one the CLI takes only with the flag as refused (C47, C85)', () => {
    const shown = claudeModeAvailability(['read-only', 'ask-first', 'edits-ok']);
    expect(shown.map((mode) => [mode.id, mode.available, mode.reason])).toEqual([
      ['read-only', true, null], ['ask-first', true, null], ['edits-ok', true, null], ['auto-reviewed', false, 'unvalidated'], ['berserk', false, 'unvalidated'],
    ]);
    // Still listed (C43): an unavailable mode is shown with its reason, and never dropped.
    expect(shown).toHaveLength(5);
    expect(modeReason('berserk', VALIDATED_MODES, ['berserk'])).toBe('cli-refuses');
    expect(claudeModeAvailability(VALIDATED_MODES, ['berserk']).find((mode) => mode.id === 'berserk')).toMatchObject({ available: false, reason: 'cli-refuses', setup: false });
  });

  it('is what the facet answers, with the transitions, and nothing ever changes it', () => {
    const facet = createClaudeFacet({ context: scriptedChat().context, executable: () => undefined, argsPrefix: [] });
    expect(facet.modes?.()).toEqual(claudeModeAvailability());
    expect(facet.transition?.('ask-first', 'edits-ok')).toBe('idle');
    expect(facet.transition?.('berserk', 'ask-first')).toBe('restart');
    let told = 0;
    const stop = facet.onModesChanged?.(() => { told += 1; });
    expect(typeof stop).toBe('function');
    stop?.();
    expect(told).toBe(0);
    // Claude has no sandbox of its own to set up (C60): the facet has no such member.
    expect(facet.sandbox).toBeUndefined();
  });
});

describe('a plan turn’s mode (M22b, V3; C5, C7, C8, C51, C70)', () => {
  it('is the CLI’s plan word over the chat’s own mode and tools, under every mode that acts and never Read only', () => {
    expect([...PLAN_MODES]).toEqual(['ask-first', 'edits-ok', 'auto-reviewed', 'berserk']);
    expect(CLAUDE_PLANS.modes).toBe(PLAN_MODES);
    expect(CLAUDE_PLANS.unavailable).toMatch(/Read only/);
    for (const id of PLAN_MODES) {
      const variant = planVariant(CLAUDE_MODES[id]);
      expect(variant).toMatchObject({ id, native: PLAN_WORD, reading: false, planning: true });
      expect(variant.tools).toBe(CLAUDE_MODES[id].tools);
      expect(variant.tools).toContain(PLAN_TOOL);
      expect(reportsMode(variant, 'plan')).toBe(true);
      expect(reportsMode(variant, CLAUDE_MODES[id].native)).toBe(false);
      expect(CLAUDE_MODES[id].planning).toBe(false);
    }
    // Read only's list holds no Write, and no plan's tool (C70).
    expect(CLAUDE_MODES['read-only'].tools).not.toContain(PLAN_TOOL);
    expect(CLAUDE_MODES['read-only'].tools).not.toContain('Write');
  });

  it('may name the plan word, the three, and the launch’s own word coming out of plan mode alone (C7, C51)', () => {
    for (const word of ['plan', ...SETTABLE_WORDS]) expect(mayName(word, null, false), word).toBe(true);
    expect(mayName('bypassPermissions', 'bypassPermissions', true)).toBe(true);
    // Not into Berserk from another mode, not out of plan mode on a process launched under another, and never by a frame's word.
    expect(mayName('bypassPermissions', 'bypassPermissions', false)).toBe(false);
    expect(mayName('bypassPermissions', 'default', true)).toBe(false);
    expect(mayName('bypassPermissions', null, true)).toBe(false);
    for (const word of ['dontAsk', 'manual', 'Plan', 'bypassPermissions', '']) expect(mayName(word, 'default', true), word).toBe(false);
  });
});
