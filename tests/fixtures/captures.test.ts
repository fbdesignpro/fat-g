// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V23 (docs/planning/_archive/M19b.md; C62): a capture's deltas say what its complete frames say. A reply is
// in a capture twice: in pieces, as it was written, and whole, in the frame that completes it. The
// redaction reaches the whole text as one string; a path or a name that the CLI wrote across several
// deltas is in no one of them, and seven published captures held the trace's own folder that way,
// three of them with a user's name in it.
//
// So this holds every capture to it, on any machine: the pieces of a text add up to the text its
// complete frame holds. A capture whose deltas were left as the CLI sent them, where the complete
// frame was redacted, fails here.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
type Json = Record<string, unknown>;
interface Entry { readonly index: number; readonly dir: string; readonly frame: Json }
const at = (value: unknown, ...keys: (string | number)[]): unknown => keys.reduce<unknown>((current, key) => (current !== null && typeof current === 'object' ? (current as Record<string | number, unknown>)[key] : undefined), value);
/** Whose a frame is: a worker's tool use, or the session's own. */
const parentOf = (frame: Json): string => (typeof frame['parent_tool_use_id'] === 'string' ? frame['parent_tool_use_id'] : '');
const captures = (cli: string): { readonly name: string; readonly frames: readonly Entry[] }[] => {
  const dir = path.join(ROOT, 'tests/fixtures', cli, 'captures');
  return readdirSync(dir).filter((file) => file.endsWith('.json')).map((file) => ({ name: file.replace(/\.json$/, ''), frames: (JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as { frames: Entry[] }).frames.filter((entry) => entry.dir === 'recv') }));
};

describe('a Codex capture’s deltas (C62)', () => {
  const DELTA = 'item/agentMessage/delta';
  const withDeltas = captures('codex').filter((capture) => capture.frames.some((entry) => entry.frame['method'] === DELTA));

  it('are in the captures taken since M19, and in no earlier one', () => {
    expect(withDeltas.map((capture) => capture.name).sort()).toEqual(['codex-mcp-annotated-read-only', 'codex-mcp-approval-deny', 'codex-mcp-approval-once', 'codex-mcp-approval-session', 'codex-mcp-server-form', 'm106-codex-activity', 'm106-codex-spawn', 'm19-answer', 'm19-interrupt', 'm19-markdown', 'm19-worker', 'm19b-line', 'm19b-readme', 'm19b-space', 'm20a-collab-spawn', 'm20a-steps-main', 'm20a-steps-tool-main', 'm20a-steps-tool-on-main', 'm20a-steps-tracked-main', 'm20b-fork-again', 'm20b-fork-during', 'm20b-fork-followup', 'm20b-fork-read', 'm20b-fork-seed', 'm20b-fork-two', 'm21-codex-async', 'm22-codex-amendment', 'm22-codex-ask-first-files', 'm22-codex-auto-review-main', 'm22-codex-auto-review-resumed', 'm22-codex-berserk-main', 'm22-codex-file-session-main', 'm22-codex-file-session-resumed', 'm22-codex-file-session-same-main', 'm22-codex-file-session-same-resumed', 'm22-codex-files', 'm22-codex-on-request', 'm22-codex-once', 'm22-codex-read-only-turn', 'm22-codex-reviewer-turn-main', 'm22-codex-sandbox-ask-first', 'm22-codex-sandbox-ask-write', 'm22-codex-sandbox-commands', 'm22-codex-sandbox-files', 'm22-codex-sandbox-temp', 'm22-codex-worker', 'm22b-codex-chain', 'm22b-codex-empty', 'm22b-codex-modes', 'm22b-codex-resumed-resumed', 'm22b-codex-skip', 'm22e-codex-review', 'm22e-codex-rounds', 'm23-codex-async', 'm23-codex-big-image', 'm23-codex-commands', 'm23-codex-image', 'm23-codex-skills', 'm23-codex-steer']);
  });

  it.each(withDeltas.map((capture) => [capture.name, capture] as const))('%s: each message’s deltas add up to the text its completing frame holds', (_name, capture) => {
    const written = new Map<string, string>();
    for (const entry of capture.frames) {
      if (entry.frame['method'] === DELTA) written.set(String(at(entry.frame, 'params', 'itemId')), (written.get(String(at(entry.frame, 'params', 'itemId'))) ?? '') + String(at(entry.frame, 'params', 'delta')));
    }
    let completed = 0;
    for (const [item, text] of written) {
      const done = capture.frames.find((entry) => entry.frame['method'] === 'item/completed' && at(entry.frame, 'params', 'item', 'id') === item);
      // A message its turn's interrupt cut has no completing frame: nothing to hold it to.
      if (done === undefined) continue;
      completed += 1;
      expect(text, item).toBe(at(done.frame, 'params', 'item', 'text'));
    }
    expect(completed).toBeGreaterThan(capture.name === 'm19-interrupt' ? -1 : 0);
  });

  // M22b's K2 keeps a plan item's deltas too (M22b, C14): the same rule holds for them.
  const PLAN_DELTA = 'item/plan/delta';
  const withPlanDeltas = captures('codex').filter((capture) => capture.frames.some((entry) => entry.frame['method'] === PLAN_DELTA));

  it('of a plan are in M22b’s captures alone', () => {
    expect(withPlanDeltas.map((capture) => capture.name).sort()).toEqual(['m22b-codex-chain', 'm22b-codex-modes', 'm22b-codex-resumed-first']);
  });

  it.each(withPlanDeltas.map((capture) => [capture.name, capture] as const))('%s: each plan’s deltas add up to the text its completing frame holds', (_name, capture) => {
    const written = new Map<string, string>();
    for (const entry of capture.frames) {
      if (entry.frame['method'] === PLAN_DELTA) written.set(String(at(entry.frame, 'params', 'itemId')), (written.get(String(at(entry.frame, 'params', 'itemId'))) ?? '') + String(at(entry.frame, 'params', 'delta')));
    }
    expect(written.size).toBeGreaterThan(0);
    for (const [item, text] of written) {
      const done = capture.frames.find((entry) => entry.frame['method'] === 'item/completed' && at(entry.frame, 'params', 'item', 'id') === item);
      expect(done, item).toBeDefined();
      expect(text, item).toBe(at(done?.frame, 'params', 'item', 'text'));
    }
  });
});

describe('a Claude capture’s deltas (C62)', () => {
  const withEvents = captures('claude').filter((capture) => capture.frames.some((entry) => entry.frame['type'] === 'stream_event'));

  it('are in the captures taken under the launch that asks for partial messages', () => {
    expect(withEvents.length).toBeGreaterThanOrEqual(9);
    expect(withEvents.map((capture) => capture.name)).toEqual(expect.arrayContaining(['m19-t1-basic', 'm19-t3-subagent', 'm19-t4-interrupt', 'm19-markdown', 'm19b-line', 'm19b-readme', 'm19b-space']));
  });

  it.each(withEvents.map((capture) => [capture.name, capture] as const))('%s: each text’s deltas, and each tool input’s, add up to what the reply’s `assistant` frames hold', (_name, capture) => {
    // What each reply's complete frames hold, by the reply's id: its texts, and its tools' inputs.
    const texts = new Map<string, string[]>();
    const inputs = new Map<string, string[]>();
    for (const entry of capture.frames) {
      if (entry.frame['type'] !== 'assistant') continue;
      const id = `${parentOf(entry.frame)}|${String(at(entry.frame, 'message', 'id'))}`;
      for (const block of (at(entry.frame, 'message', 'content') as Json[] | undefined) ?? []) {
        if (block['type'] === 'text') texts.set(id, [...(texts.get(id) ?? []), String(block['text'])]);
        if (block['type'] === 'tool_use') inputs.set(id, [...(inputs.get(id) ?? []), JSON.stringify(block['input'])]);
      }
    }
    // Each run of deltas: one block of one reply.
    const runs = new Map<string, { readonly reply: string; readonly field: string; text: string }>();
    const replies = new Map<string, string>();
    for (const entry of capture.frames) {
      if (entry.frame['type'] !== 'stream_event') continue;
      const parent = parentOf(entry.frame);
      if (at(entry.frame, 'event', 'type') === 'message_start') replies.set(parent, `${parent}|${String(at(entry.frame, 'event', 'message', 'id'))}`);
      if (at(entry.frame, 'event', 'type') !== 'content_block_delta') continue;
      const delta = at(entry.frame, 'event', 'delta') as Json;
      const field = ['text', 'partial_json'].find((name) => typeof delta[name] === 'string');
      if (field === undefined) continue;
      const reply = replies.get(parent) ?? '';
      const key = `${reply}|${String(at(entry.frame, 'event', 'index'))}|${field}`;
      const run = runs.get(key) ?? { reply, field, text: '' };
      run.text += String(delta[field]);
      runs.set(key, run);
    }
    let held = 0;
    for (const run of runs.values()) {
      if (run.field === 'text') {
        // A reply cut by force before its frame has none to hold its text to.
        const whole = texts.get(run.reply);
        if (whole === undefined) continue;
        held += 1;
        expect(whole, run.text.slice(0, 40)).toContain(run.text);
      } else {
        const whole = inputs.get(run.reply);
        if (whole === undefined) continue;
        held += 1;
        // A tool called with no argument streams no input at all, and the complete frame can hold a
        // field the model did not write — `Edit`'s `replace_all`, at the CLI's default (M22's
        // captures): each field the stream wrote is held to the complete input's, and no more.
        const streamed = JSON.parse(run.text === '' ? '{}' : run.text) as Json;
        const holds = (input: string): boolean => Object.keys(streamed).every((key) => JSON.stringify((JSON.parse(input) as Json)[key]) === JSON.stringify(streamed[key]));
        expect(whole.some(holds), run.text.slice(0, 40)).toBe(true);
      }
    }
    // Every capture that streams holds at least one text or one input to hold its pieces to — but the
    // one whose process was ended by force during its first text, which has no complete frame at all.
    expect(held).toBeGreaterThan(_name === 'm19-cut-cut' ? -1 : 0);
  });
});

describe('the seven captures republished for C62', () => {
  it('say so in their own note, and keep their frames’ count', () => {
    for (const [cli, name, deltas] of [
      ['codex', 'm19b-line', 55], ['codex', 'm19b-readme', 92], ['claude', 'm19-t3-subagent', null],
      ['claude', 'm19-t1-basic', null], ['claude', 'm19-t4-interrupt', null], ['claude', 'm19b-readme', null], ['claude', 'm19b-space', null],
    ] as const) {
      const data = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures', cli, 'captures', `${name}.json`), 'utf8')) as { _fixture: { redacted: string[] }; frames: Entry[] };
      expect(data._fixture.redacted.some((note) => note.includes('deltas rewritten as the one text they are')), name).toBe(true);
      if (deltas !== null) expect(data.frames.filter((entry) => entry.frame['method'] === 'item/agentMessage/delta'), name).toHaveLength(deltas);
    }
  });

  it('hold the folder as one piece where a path began, and nothing of it in the pieces after', () => {
    const data = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/codex/captures/m19b-line.json'), 'utf8')) as { frames: Entry[] };
    const pieces = data.frames.filter((entry) => entry.frame['method'] === 'item/agentMessage/delta').map((entry) => String(at(entry.frame, 'params', 'delta')));
    expect(pieces.filter((piece) => piece === '<scratch>')).toHaveLength(1);
    expect(pieces.join('')).toContain('[src/tides.js:12](/<scratch>/src/tides.js:12)');
    expect(pieces.join('')).not.toMatch(/Users|AppData/);
  });
});
