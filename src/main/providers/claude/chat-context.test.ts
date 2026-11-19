// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Decision 0033: how full a Claude chat's context is, read from M10's discovery reply to
// `get_context_usage` (CLI 2.1.268) and from the usage an assistant frame carries.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ContextReadingSchema, MAX_CONTEXT_PARTS } from '@shared/contracts/sessions';
import { takeAssistantUsage, takeContextReply } from './chat-context';

const frames = (JSON.parse(readFileSync(path.resolve('tests/fixtures/claude/captures/discovery-idle.json'), 'utf8')) as { frames: { dir: string; frame: { response?: { response?: Record<string, unknown> } } }[] }).frames;
const REPLY = frames.find((entry) => entry.dir === 'recv' && entry.frame.response?.response?.['totalTokens'] !== undefined)?.frame.response?.response as Record<string, unknown>;
const SENTINEL = (JSON.parse(readFileSync(path.resolve('tests/fixtures/claude/fake-cli-constants.json'), 'utf8')) as { sentinel: string }).sentinel;

describe('a context reply', () => {
  it('gives M10’s count, window and line, the used parts in the CLI’s order, and what the messages hold', () => {
    const reading = takeContextReply(REPLY);
    expect(reading).toEqual({
      used: 23_605, window: 1_000_000, compactAt: 967_000,
      parts: [{ label: 'System prompt', tokens: 3_183 }, { label: 'System tools', tokens: 18_363 }, { label: 'Skills', tokens: 2_059 }],
      messages: { toolCalls: 0, toolResults: 0, answers: 0, prompts: 0, attachments: 0, other: 0 },
    });
    expect(ContextReadingSchema.safeParse(reading).success).toBe(true);
  });

  it('says the CLI compacts nothing where it says so, and leaves the line out where it names none', () => {
    expect(takeContextReply({ ...REPLY, isAutoCompactEnabled: false })?.compactAt).toBeNull();
    const silent = takeContextReply({ ...REPLY, autoCompactThreshold: undefined });
    expect(silent).not.toBeNull();
    expect(silent !== null && 'compactAt' in silent).toBe(false);
  });

  it('classes parts by the CLI’s kind and never by name: an unclassed row is no part, an unplain label is Other, and past the bound the rest are Other', () => {
    const categories = [
      { name: 'System prompt', tokens: 10, kind: 'used' },
      { name: 'Messages', tokens: 20 },
      { name: 'C:\\Users\\me\\CLAUDE.md', tokens: 5, kind: 'used' },
      { name: 'Memory files', tokens: 7, kind: 'deferred' },
      { name: 'Free space', tokens: 900, kind: 'free' },
    ];
    expect(takeContextReply({ ...REPLY, categories })?.parts).toEqual([{ label: 'System prompt', tokens: 10 }, { label: 'Other', tokens: 5 }]);
    expect(takeContextReply({ ...REPLY, categories: [{ name: 'Free space', tokens: 900, kind: 'free' }] })?.parts).toBeUndefined();
    const many = Array.from({ length: MAX_CONTEXT_PARTS + 4 }, (_unused, at) => ({ name: `Part ${'x'.repeat(at % 3)}`, tokens: 1, kind: 'used' }));
    const parts = takeContextReply({ ...REPLY, categories: many })?.parts ?? [];
    expect(parts).toHaveLength(MAX_CONTEXT_PARTS);
    expect(parts.at(-1)).toEqual({ label: 'Other', tokens: 5 });
  });

  it('reads the last call’s usage where the CLI gives it', () => {
    expect(takeContextReply({ ...REPLY, apiUsage: { input_tokens: 4, output_tokens: 800, cache_creation_input_tokens: 120, cache_read_input_tokens: 30_000 } })?.lastCall).toEqual({ input: 4, cacheRead: 30_000, cacheWrite: 120, output: 800 });
  });

  it('reads nothing of the paths and the configured names the reply holds', () => {
    const named = (name: string) => ({ name: `${SENTINEL}-${name}`, tokens: 5 });
    const exposed = {
      ...REPLY,
      memoryFiles: [{ path: `C:\\Users\\${SENTINEL}\\CLAUDE.md`, type: 'User', tokens: 120 }],
      mcpTools: [{ ...named('tool'), serverName: `${SENTINEL}-server`, isLoaded: true }],
      agents: [{ agentType: `${SENTINEL}-agent`, source: 'userSettings', tokens: 30 }],
      skills: { totalSkills: 1, includedSkills: 1, tokens: 5, skillFrontmatter: [named('skill')] },
      messageBreakdown: { toolCallTokens: 1, toolResultTokens: 2, assistantMessageTokens: 3, userMessageTokens: 4, attachmentTokens: 5, redirectedContextTokens: 6, unattributedTokens: 7, toolCallsByType: [named('call')], attachmentsByType: [named('attachment')] },
      categories: [{ name: `${SENTINEL} files`, tokens: 7, kind: 'used' }],
    };
    const reading = takeContextReply(exposed);
    expect(JSON.stringify(reading)).not.toContain(SENTINEL);
    expect(reading?.messages).toEqual({ toolCalls: 1, toolResults: 2, answers: 3, prompts: 4, attachments: 5, other: 13 });
    expect(reading?.parts).toEqual([{ label: 'Other', tokens: 7 }]);
  });

  it('is no reading without a count and a window', () => {
    for (const reply of [null, 'text', [], { ...REPLY, totalTokens: undefined }, { ...REPLY, maxTokens: 0 }, { ...REPLY, totalTokens: -1 }, { ...REPLY, maxTokens: 1.5 }]) {
      expect(takeContextReply(reply), JSON.stringify(reply).slice(0, 60)).toBeNull();
    }
  });
});

describe('an assistant frame’s usage', () => {
  const frame = (usage: unknown, parent: string | null = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { id: 'm', content: [], usage } });

  it('counts what the session’s own call read and wrote', () => {
    expect(takeAssistantUsage(frame({ input_tokens: 4, cache_creation_input_tokens: 120, cache_read_input_tokens: 30_000, output_tokens: 800 }))).toEqual({ used: 30_924, call: { input: 4, cacheRead: 30_000, cacheWrite: 120, output: 800 } });
  });

  it('is nothing for a sub-agent’s call, a call that read nothing, a frame with no usage, and any other frame', () => {
    expect(takeAssistantUsage(frame({ input_tokens: 4, output_tokens: 8 }, 'tool-1'))).toBeNull();
    expect(takeAssistantUsage(frame({ input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 8 }))).toBeNull();
    expect(takeAssistantUsage(frame(undefined))).toBeNull();
    expect(takeAssistantUsage(frame({ input_tokens: 'many', output_tokens: 8 }))).toBeNull();
    expect(takeAssistantUsage({ type: 'result', usage: { input_tokens: 4, output_tokens: 8 } })).toBeNull();
  });
});
