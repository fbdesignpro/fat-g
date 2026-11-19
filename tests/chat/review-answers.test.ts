// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The answers M22e's K1 and K2 captured (docs/planning/_archive/M22e.md, Design 1, 9; V3, V4; C4, C5, C29, C42,
// C48), read by fat-g's parser on both providers: K2's rounds under version 2, K1's blocks, which name
// version 1, refused as invalid, each named fault the fakes replay, and the JSON Schema the prompt
// carries allowing nothing the contract does not read, over all of them.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { carryRound, checkFindings, fencedBlocks, findingsJsonSchema, readFindings, REVIEW_INSTRUCTION_VERSION } from '@shared/contracts/review';
import { faulted, FIRST_ANSWER_FAULTS, LATER_ANSWER_FAULTS } from '../fixtures/review-faults.mjs';

const FIXTURES = path.join(import.meta.dirname, '..', 'fixtures');
const capture = (provider: 'claude' | 'codex', name: string): { frames: { dir: string; frame: Record<string, unknown> }[] } => JSON.parse(readFileSync(path.join(FIXTURES, provider, 'captures', `${name}.json`), 'utf8')) as { frames: { dir: string; frame: Record<string, unknown> }[] };

/** Each turn's answer, as fat-g's store keeps it: Claude's last text of the session's own, Codex's `final_answer` message. */
function answers(provider: 'claude' | 'codex', name: string): string[] {
  const { frames } = capture(provider, name);
  if (provider === 'codex') {
    return frames.flatMap(({ frame }) => {
      const item = (frame['params'] as { item?: { type?: string; phase?: string; text?: string } } | undefined)?.item;
      return frame['method'] === 'item/completed' && item?.type === 'agentMessage' && item.phase === 'final_answer' ? [item.text ?? ''] : [];
    });
  }
  const out: string[] = [];
  for (const { dir, frame } of frames) {
    if (dir === 'send' && frame['type'] === 'user') out.push('');
    const message = frame['message'] as { content?: { type: string; text?: string }[] } | undefined;
    if (dir === 'recv' && frame['type'] === 'assistant' && frame['parent_tool_use_id'] == null && message?.content?.[0]?.type === 'text') out[out.length - 1] = message.content.map((part) => part.text ?? '').join('');
  }
  return out;
}

const blockOf = (text: string): string => {
  const read = readFindings(text, REVIEW_INSTRUCTION_VERSION);
  if (read.verdict !== 'findings') throw new Error(read.verdict);
  return text.slice(read.start, read.end);
};

// ── A JSON Schema check of the subset the findings' schema uses: enough to hold its verdict to the contract's ──

type Schema = Record<string, unknown>;
function validates(schema: Schema, value: unknown): boolean {
  if ('const' in schema && value !== schema['const']) return false;
  if (Array.isArray(schema['enum']) && !schema['enum'].includes(value)) return false;
  const type = schema['type'];
  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const properties = (schema['properties'] ?? {}) as Record<string, Schema>;
    const row = value as Record<string, unknown>;
    if (schema['additionalProperties'] === false && Object.keys(row).some((key) => !(key in properties))) return false;
    if (((schema['required'] ?? []) as string[]).some((key) => !(key in row))) return false;
    return Object.entries(row).every(([key, entry]) => properties[key] === undefined || validates(properties[key], entry));
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return false;
    if (typeof schema['maxItems'] === 'number' && value.length > schema['maxItems']) return false;
    return value.every((entry) => validates(schema['items'] as Schema, entry));
  }
  if (type === 'string') {
    if (typeof value !== 'string') return false;
    if (typeof schema['minLength'] === 'number' && value.length < schema['minLength']) return false;
    if (typeof schema['maxLength'] === 'number' && value.length > schema['maxLength']) return false;
    return typeof schema['pattern'] !== 'string' || new RegExp(schema['pattern']).test(value);
  }
  if (type === 'integer') return Number.isInteger(value) && (schema['minimum'] === undefined || (value as number) >= (schema['minimum'] as number)) && (schema['maximum'] === undefined || (value as number) <= (schema['maximum'] as number));
  return true;
}

const lastJson = (text: string): string => fencedBlocks(text).filter((block) => block.info.toLowerCase() === 'json').at(-1)?.content ?? '';

// ── The faults (C42): each a captured answer with one named change ──

const K2 = answers('claude', 'm22e-claude-rounds')[0] ?? '';
const removeBlock = (text: string): string => { const read = readFindings(text, 2); return read.verdict === 'findings' ? read.before : text; };
const FAULTS: Readonly<Record<string, { readonly text: string; readonly verdict: string }>> = {
  'review-no-block': { text: removeBlock(K2), verdict: 'no-block' },
  'review-two-blocks': { text: `${K2}\n\n${blockOf(K2)}`, verdict: 'several' },
  'review-invalid': { text: K2.replace(/\}\s*\n```\s*$/, '\n```'), verdict: 'invalid' },
  // One finding with no correction is set aside, and a field past the length asked is read whole (the maintainer).
  'review-set-aside': { text: K2.replace(/"correction": "[^"]*",?\n/, ''), verdict: 'findings' },
  'review-long': { text: K2.replace(/("correction": ")[^"]*(")/, (_, open: string, shut: string) => `${open}${'x'.repeat(601)}${shut}`), verdict: 'findings' },
  'review-v1': { text: answers('claude', 'm22e-claude-review')[0] ?? '', verdict: 'invalid' },
  'review-unclosed': { text: K2.replace(/\n```\s*$/, ''), verdict: 'findings' },
};

describe('the answers K1 and K2 captured (C5; V3)', () => {
  it('reads each of K2’s answers on both providers as a round under version 2, the asking note’s prose above it', () => {
    for (const provider of ['claude', 'codex'] as const) {
      const turns = answers(provider, `m22e-${provider}-rounds`);
      expect(turns).toHaveLength(4);
      for (const text of turns) {
        const read = readFindings(text, 2);
        expect(read.verdict, provider).toBe('findings');
        if (read.verdict !== 'findings') continue;
        expect(read.after).toBe('');
        expect(read.setAside).toEqual([]);
        expect(read.block.issues.length).toBeGreaterThanOrEqual(3);
        // Version 2 asks for an anchor wherever an issue concerns one place: both anchored every one (K2).
        expect(read.block.issues.every((issue) => issue.anchor !== undefined)).toBe(true);
      }
      // The note that only asked was answered in prose, above the review sent again (K2).
      const asked = readFindings(turns[2] ?? '', 2);
      expect(asked.verdict === 'findings' && asked.before.length).toBeGreaterThan(40);
    }
  });

  it('refuses K1’s blocks, which name version 1, as invalid, and reads them under version 1', () => {
    for (const provider of ['claude', 'codex'] as const) {
      for (const text of answers(provider, `m22e-${provider}-review`)) {
        expect(readFindings(text, 2)).toMatchObject({ verdict: 'invalid', problem: 'version' });
        expect(readFindings(text, 1).verdict).toBe('findings');
      }
    }
  });

  it('carries the settling note’s move by `was` and every other id, on both providers (C29)', () => {
    for (const provider of ['claude', 'codex'] as const) {
      const [first, settled] = answers(provider, `m22e-${provider}-rounds`).map((text) => { const read = readFindings(text, 2); return read.verdict === 'findings' ? read.block.issues : []; });
      const moved = (settled ?? []).filter((finding) => finding.was !== undefined && finding.was !== finding.id);
      expect(moved).toHaveLength(1);
      const marks = Object.fromEntries((first ?? []).map((finding, index) => [finding.id, index === 0 ? 'accepted' as const : 'open' as const]));
      const carried = carryRound(first ?? [], settled ?? [], marks, {});
      expect(carried.withdrawn).toEqual([]);
      expect(carried.carried.find((one) => one.id === moved[0]?.id)?.from).toBe(moved[0]?.was);
      expect(carried.carried.filter((one) => one.mark === 'accepted')).toHaveLength(1);
    }
  });
});

describe('the parser (C5, C48; V3)', () => {
  it('gives each fault its verdict', () => {
    for (const [name, fault] of Object.entries(FAULTS)) expect(readFindings(fault.text, 2).verdict, name).toBe(fault.verdict);
  });

  it('reads an unclosed last block to the end, a round where its content is whole and invalid where it is cut (C48)', () => {
    const whole = readFindings(FAULTS['review-unclosed']?.text ?? '', 2);
    expect(whole.verdict === 'findings' && whole.after).toBe('');
    const cut = (FAULTS['review-unclosed']?.text ?? '').slice(0, -40);
    expect(readFindings(cut, 2)).toMatchObject({ verdict: 'invalid', problem: 'json' });
  });

  it('reads the last json block, a tilde fence and a block’s case included, and passes over other fences', () => {
    const block = JSON.stringify({ version: 2, appraisal: 'One line.', issues: [] });
    expect(readFindings(`Text.\n\n~~~JSON\n${block}\n~~~\n`, 2).verdict).toBe('findings');
    expect(readFindings(`\`\`\`ts\nconst a = 1;\n\`\`\`\n\n\`\`\`json\n${block}\n\`\`\``, 2)).toMatchObject({ verdict: 'findings', before: '```ts\nconst a = 1;\n```' });
    // A failed block before the last one does not count against it; the last decides.
    expect(readFindings(`\`\`\`json\n{"no": 1}\n\`\`\`\n\n\`\`\`json\n${block}\n\`\`\``, 2).verdict).toBe('findings');
    expect(readFindings(`\`\`\`json\n${block}\n\`\`\`\n\n\`\`\`json\n{"no": 1}\n\`\`\``, 2).verdict).toBe('invalid');
    // A fence inside a longer fence is its content, and a CRLF answer reads as an LF one.
    expect(readFindings(`\`\`\`\`md\n\`\`\`json\n${block}\n\`\`\`\n\`\`\`\``, 2).verdict).toBe('no-block');
    expect(readFindings(`A.\r\n\r\n\`\`\`json\r\n${block}\r\n\`\`\`\r\n`, 2).verdict).toBe('findings');
  });

  // The maintainer: one finding that does not read leaves the rest a round, and a length past the one asked is read whole.
  it('sets aside the finding a fault leaves with no correction, and reads a correction past its asked length whole', () => {
    const asideRead = readFindings(FAULTS['review-set-aside']?.text ?? '', 2);
    const whole = readFindings(K2, 2);
    if (asideRead.verdict !== 'findings' || whole.verdict !== 'findings') throw new Error('not a round');
    expect(asideRead.setAside).toEqual([{ position: 1, id: whole.block.issues[0]?.id, problem: 'correction' }]);
    expect(asideRead.block.issues).toEqual(whole.block.issues.slice(1));
    const long = readFindings(FAULTS['review-long']?.text ?? '', 2);
    expect(long.verdict === 'findings' && long.block.issues[0]?.correction).toBe('x'.repeat(601));
  });
});

describe('the JSON Schema the prompt carries (C4)', () => {
  // The maintainer: it asks the lengths and the count, and the contract reads past them.
  it('allows nothing the contract does not read as a round, over the captures and every fault, and refuses what is past its lengths, which the contract reads', () => {
    const schema = findingsJsonSchema(2) as Schema;
    const texts = [...(['claude', 'codex'] as const).flatMap((provider) => [...answers(provider, `m22e-${provider}-rounds`), ...answers(provider, `m22e-${provider}-review`)]), ...Object.values(FAULTS).map((fault) => fault.text)];
    let allowed = 0;
    for (const text of texts) {
      const content = lastJson(text);
      let value: unknown;
      try { value = JSON.parse(content); } catch { value = undefined; }
      if (value === undefined || !validates(schema, value)) continue;
      allowed += 1;
      const checked = checkFindings(content, 2);
      expect(checked.ok && checked.setAside).toEqual([]);
    }
    expect(allowed).toBeGreaterThanOrEqual(8);
    const long = lastJson(FAULTS['review-long']?.text ?? '');
    expect(validates(schema, JSON.parse(long))).toBe(false);
    expect(checkFindings(long, 2).ok).toBe(true);
  });
});

describe('the fakes’ named faults, made of K2’s answers on both providers (C42, C46, C48)', () => {
  const VERDICTS: Readonly<Record<string, string>> = {
    'review-no-block': 'no-block', 'review-invalid': 'invalid', 'review-set-aside': 'findings', 'review-two-blocks': 'several', 'review-long': 'findings', 'review-unclosed': 'findings',
    'review-prose-only': 'no-block', 'review-drop': 'findings', 'review-renumber': 'findings', 'review-ambiguous': 'findings',
  };
  it.each(['claude', 'codex'] as const)('gives each its verdict on %s’s answers, the first answer’s faults on the review and the later ones on the settling round', (provider) => {
    const [review = '', settled = ''] = answers(provider, `m22e-${provider}-rounds`);
    for (const name of FIRST_ANSWER_FAULTS) expect(readFindings(faulted(name, review), 2).verdict, name).toBe(VERDICTS[name]);
    for (const name of LATER_ANSWER_FAULTS) expect(readFindings(faulted(name, settled), 2).verdict, name).toBe(VERDICTS[name]);
  });

  it.each(['claude', 'codex'] as const)('carries no mark through a drop, a renumbering or an ambiguous `was` on %s as it would through the round as captured', (provider) => {
    const [review = '', settled = ''] = answers(provider, `m22e-${provider}-rounds`);
    const first = readFindings(review, 2);
    if (first.verdict !== 'findings') throw new Error(first.verdict);
    const before = first.block.issues;
    const marks = Object.fromEntries(before.map((issue) => [issue.id, 'accepted' as const]));
    const round = (name: string) => { const read = readFindings(faulted(name, settled), 2); if (read.verdict !== 'findings') throw new Error(read.verdict); return read.block.issues; };
    // Dropped: one finding fewer, the one it came from withdrawn.
    expect(carryRound(before, round('review-drop'), marks, {}).carried.length).toBe(round('review-drop').length);
    // Renumbered with no `was`: that finding is new, open.
    expect(carryRound(before, round('review-renumber'), marks, {}).carried[0]).toMatchObject({ from: null, mark: 'open' });
    // Ambiguous: no acceptance becomes two.
    const ambiguous = carryRound(before, round('review-ambiguous'), marks, {});
    const froms = ambiguous.carried.flatMap((one) => (one.from === null ? [] : [one.from]));
    expect(new Set(froms).size).toBe(froms.length);
  });
});
