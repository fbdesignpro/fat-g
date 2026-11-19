// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V2, V8 (docs/planning/_archive/M20b.md; C55–C59; decision 0023): the CLI's own commands that fat-g answers
// itself — a closed list, matched at a prompt's very start — and those it passes as written, which
// are K2's seven, by the prompts its captures were taken with.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMAND_NOTICE_KINDS } from '@shared/contracts/conversation';
import { INTERCEPTED_COMMANDS, interceptedCommand } from './chat-commands';
import { createClaudeFacet } from './facet';

const CAPTURES = path.resolve('tests/fixtures/claude/captures');
const prompts = (name: string): string[] => (JSON.parse(readFileSync(path.join(CAPTURES, name), 'utf8')) as { frames: { dir: string; frame: { type?: string; message?: { content?: unknown } } }[] }).frames
  .filter((entry) => entry.dir === 'send' && entry.frame.type === 'user').map((entry) => String(entry.frame.message?.content));

describe('the commands fat-g answers itself (C55, C56)', () => {
  it('are a closed list of three: /clear, /model and /fast, each with its own notice (decision 0023)', () => {
    expect(INTERCEPTED_COMMANDS).toEqual([{ name: '/clear', kind: 'command-clear' }, { name: '/model', kind: 'command-model' }, { name: '/fast', kind: 'command-fast' }]);
    expect(Object.isFrozen(INTERCEPTED_COMMANDS)).toBe(true);
    // Every notice a command can be answered with is one the conversation's schema knows, and each has its command.
    expect(INTERCEPTED_COMMANDS.map((command) => command.kind).sort()).toEqual([...COMMAND_NOTICE_KINDS].sort());
  });

  it.each([
    ['/clear', 'command-clear'],
    ['/clear now', 'command-clear'],
    ['/clear\nand the rest', 'command-clear'],
    ['/clear\tnow', 'command-clear'],
    ['/model', 'command-model'],
    ['/model haiku', 'command-model'],
    // Decision 0023: /fast would change the speed fat-g asks for with each turn.
    ['/fast', 'command-fast'],
    ['/fast on', 'command-fast'],
    ['/fast\noff', 'command-fast'],
  ] as const)('matches %j', (prompt, kind) => {
    expect(interceptedCommand(prompt)).toBe(kind);
  });

  it.each([
    '/clearance', '/models', '/model-picker', 'say /clear', ' /clear', '\n/clear', 'clear', 'model haiku', '', '/', '/Clear', '/MODEL haiku', '//clear', '/clear/', '/clear.',
    '/faster', '/fast-mode', 'go /fast', 'fast', '/FAST',
  ])('does not match %j: a command is its name at the prompt’s very start, then its end or white space', (prompt) => {
    expect(interceptedCommand(prompt)).toBeNull();
  });
});

describe('the commands that pass as written (C57, C58)', () => {
  const captures = readdirSync(CAPTURES).filter((name) => name.startsWith('m20b-cmd-')).sort();

  it('are K2’s seven: each capture’s prompt is a command, and none is on the list', () => {
    expect(captures.map((name) => name.replace(/^m20b-cmd-|\.json$/g, ''))).toEqual(['btw', 'compact', 'exit', 'login', 'logout', 'quit', 'resume']);
    for (const name of captures) {
      const [prompt, ...more] = prompts(name);
      expect(more, name).toEqual([]);
      expect(prompt, name).toMatch(/^\/[a-z]+(\s|$)/);
      expect(interceptedCommand(prompt ?? ''), name).toBeNull();
    }
    // `/btw` among them: it is no way to an aside, and passes as any other (C58).
    expect(prompts('m20b-cmd-btw.json')[0]).toMatch(/^\/btw /);
  });

  it('are every other command and every skill: nothing but the list’s names is held back', () => {
    for (const prompt of ['/compact', '/compact keep the plan', '/help', '/review', '/init', '/some-skill with arguments', '/agents', '/mcp', '/status', '/cost']) expect(interceptedCommand(prompt), prompt).toBeNull();
  });
});

describe('the facet (C59)', () => {
  it('hands main the matcher, and holds no other word of a command', () => {
    const facet = createClaudeFacet({ context: {} as never, executable: () => undefined, argsPrefix: [] });
    expect(facet.intercepts).toBe(interceptedCommand);
    // The list lives in one file: no other of the adapter's names a command it holds.
    const folder = import.meta.dirname;
    const naming = readdirSync(folder).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && /'\/(clear|model|fast)'/.test(readFileSync(path.join(folder, name), 'utf8')));
    expect(naming).toEqual(['chat-commands.ts']);
  });
});
