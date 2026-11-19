// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V2 (docs/planning/_archive/M20a.md; C3–C6, C59): the activity's body — its closed types, its statuses, every
// bound of C5 with what a cut says, the body's own bound cut field by field, and a body read back
// from what a store holds.
import { describe, expect, it } from 'vitest';
import {
  type ActivityBody,
  ACTIVITY_CUT_FIELDS,
  ACTIVITY_STATUSES,
  ACTIVITY_TYPES,
  ActivityCutSchema,
  activityEndFields,
  activityStartFields,
  activityUnits,
  boundActivity,
  ChecklistStepSchema,
  cutOutput,
  cutParts,
  EditChangeSchema,
  endedBody,
  FileReferenceSchema,
  GIVES_WAY,
  isEnded,
  MAX_ACTIVITY_FILES,
  MAX_ACTIVITY_INPUT,
  MAX_ACTIVITY_NAME,
  MAX_ACTIVITY_OUTPUT,
  MAX_ACTIVITY_PATH,
  MAX_ACTIVITY_SUMMARY,
  MAX_ACTIVITY_THINKING,
  MAX_ACTIVITY_UNITS,
  MAX_CHANGE_TEXT,
  MAX_CHANGES,
  MAX_STEP_TEXT,
  MAX_STEPS,
  mergeCuts,
  readActivity,
  restartedBody,
  startedBody,
} from './activity';
import { cutFromEnd, cutTo } from './cut';

const body = (patch: Partial<ActivityBody> = {}): ActivityBody => ({
  type: 'command', name: 'commandExecution', summary: 'rg --files', input: 'rg --files', output: null, files: [], status: 'running', exitCode: null, changes: [], steps: [], thinking: null, workerId: null, duration: null, cut: null, declinedBy: null, model: null, agentType: null, ...patch,
});
const text = (length: number, fill = 'x'): string => fill.repeat(length);

describe('the types, the statuses and the bounds (C4–C6)', () => {
  it('are closed lists, with no plan among the types (S2)', () => {
    expect(ACTIVITY_TYPES).toEqual(['read', 'search', 'command', 'edit', 'mcp', 'web-search', 'worker', 'wait', 'thinking', 'checklist', 'other']);
    expect(ACTIVITY_STATUSES).toEqual(['running', 'completed', 'failed', 'unfinished', 'declined']);
    expect(activityStartFields.activityType.safeParse('plan').success).toBe(false);
    expect(activityStartFields.activityType.safeParse('other').success).toBe(true);
  });

  it('are C5’s numbers', () => {
    expect({ MAX_ACTIVITY_NAME, MAX_ACTIVITY_SUMMARY, MAX_ACTIVITY_INPUT, MAX_ACTIVITY_OUTPUT, MAX_ACTIVITY_THINKING, MAX_CHANGE_TEXT, MAX_CHANGES, MAX_ACTIVITY_PATH, MAX_ACTIVITY_FILES, MAX_STEPS, MAX_STEP_TEXT, MAX_ACTIVITY_UNITS }).toEqual({
      MAX_ACTIVITY_NAME: 256, MAX_ACTIVITY_SUMMARY: 2_000, MAX_ACTIVITY_INPUT: 10_000, MAX_ACTIVITY_OUTPUT: 20_000, MAX_ACTIVITY_THINKING: 20_000, MAX_CHANGE_TEXT: 20_000, MAX_CHANGES: 20, MAX_ACTIVITY_PATH: 2_048, MAX_ACTIVITY_FILES: 200, MAX_STEPS: 100, MAX_STEP_TEXT: 500, MAX_ACTIVITY_UNITS: 200_000,
    });
  });

  it.each([
    ['running', false], ['completed', true], ['failed', true], ['unfinished', false],
  ] as const)('a status of %s has ended: %s (C6)', (status, ended) => {
    expect(isEnded(status)).toBe(ended);
  });
});

describe('what an event may carry (C5, C59)', () => {
  it('takes each field at its bound and refuses it one past', () => {
    expect(activityStartFields.name.safeParse(text(MAX_ACTIVITY_NAME)).success).toBe(true);
    expect(activityStartFields.name.safeParse(text(MAX_ACTIVITY_NAME + 1)).success).toBe(false);
    expect(activityStartFields.summary.safeParse(text(MAX_ACTIVITY_SUMMARY + 1)).success).toBe(false);
    expect(activityStartFields.input.safeParse(text(MAX_ACTIVITY_INPUT + 1)).success).toBe(false);
    expect(activityEndFields.output.safeParse(text(MAX_ACTIVITY_OUTPUT + 1)).success).toBe(false);
    expect(activityEndFields.thinking.safeParse(text(MAX_ACTIVITY_THINKING + 1)).success).toBe(false);
    expect(FileReferenceSchema.safeParse({ path: text(MAX_ACTIVITY_PATH), line: 1 }).success).toBe(true);
    expect(FileReferenceSchema.safeParse({ path: text(MAX_ACTIVITY_PATH + 1), line: null }).success).toBe(false);
    expect(FileReferenceSchema.safeParse({ path: 'a.md', line: 0 }).success).toBe(false);
    expect(EditChangeSchema.safeParse({ path: 'a.md', kind: 'update', text: text(MAX_CHANGE_TEXT + 1) }).success).toBe(false);
    expect(ChecklistStepSchema.safeParse({ text: text(MAX_STEP_TEXT + 1), state: 'pending' }).success).toBe(false);
    expect(activityStartFields.files.safeParse(Array.from({ length: MAX_ACTIVITY_FILES + 1 }, () => ({ path: 'a', line: null }))).success).toBe(false);
    expect(activityStartFields.changes.safeParse(Array.from({ length: MAX_CHANGES + 1 }, () => ({ path: 'a', kind: 'add', text: null }))).success).toBe(false);
    expect(activityStartFields.steps.safeParse(Array.from({ length: MAX_STEPS + 1 }, () => ({ text: 'a', state: 'pending' }))).success).toBe(false);
  });

  it('is strict: an entry with a key it does not know is refused', () => {
    expect(FileReferenceSchema.safeParse({ path: 'a', line: null, extra: 1 }).success).toBe(false);
    expect(ActivityCutSchema.safeParse({ fields: ['output'], output: { omitted: 4, at: 2 }, files: 0, steps: 0, changes: 0 }).success).toBe(true);
    expect(ActivityCutSchema.safeParse({ fields: ['nonsense'], output: null, files: 0, steps: 0, changes: 0 }).success).toBe(false);
  });
});

describe('the cut, field by field (C5)', () => {
  it('leaves what is within its bounds as it is, and says nothing was cut', () => {
    const parts = { name: 'Read', summary: 'Read a.md', input: '{}', output: 'ok', thinking: null, files: [{ path: 'a.md', line: 3 }], changes: [], steps: [] };
    expect(cutParts(parts)).toEqual({ parts, cut: null });
  });

  it('leaves out a field that was not read, and keeps one that reads null', () => {
    expect(cutParts({ name: 'x' })).toEqual({ parts: { name: 'x' }, cut: null });
    expect(cutParts({ input: null, output: null, thinking: null }).parts).toEqual({ input: null, output: null, thinking: null });
  });

  it('cuts a name, an input and a thinking text at their ends, and names each', () => {
    const taken = cutParts({ name: text(MAX_ACTIVITY_NAME + 5), input: text(MAX_ACTIVITY_INPUT + 5), thinking: text(MAX_ACTIVITY_THINKING + 5) });
    expect(taken.parts.name).toHaveLength(MAX_ACTIVITY_NAME);
    expect(taken.parts.input).toHaveLength(MAX_ACTIVITY_INPUT);
    expect(taken.parts.thinking).toHaveLength(MAX_ACTIVITY_THINKING);
    expect(taken.cut).toEqual({ fields: ['name', 'input', 'thinking'], output: null, files: 0, steps: 0, changes: 0 });
  });

  it('makes a summary one line: the first that holds anything, cut', () => {
    expect(cutParts({ summary: '\n  \nfirst line  \nsecond' }).parts.summary).toBe('first line');
    const long = cutParts({ summary: text(MAX_ACTIVITY_SUMMARY + 1) });
    expect(long.parts.summary).toHaveLength(MAX_ACTIVITY_SUMMARY);
    expect(long.cut?.fields).toEqual(['summary']);
    // Lines after the first are no cut: a summary is one line.
    expect(cutParts({ summary: 'a\nb' }).cut).toBeNull();
  });

  it('keeps an output’s first and last half, with how much was left out between them', () => {
    const output = `${text(10_000, 'a')}${text(4_321, 'm')}${text(10_000, 'z')}`;
    const taken = cutOutput(output);
    expect(taken.text).toBe(`${text(10_000, 'a')}${text(10_000, 'z')}`);
    expect(taken.cut).toEqual({ omitted: 4_321, at: 10_000 });
    expect(cutOutput(text(MAX_ACTIVITY_OUTPUT))).toEqual({ text: text(MAX_ACTIVITY_OUTPUT), cut: null });
    const parts = cutParts({ output });
    expect(parts.cut).toEqual({ fields: ['output'], output: { omitted: 4_321, at: 10_000 }, files: 0, steps: 0, changes: 0 });
  });

  it('never cuts between the two halves of a surrogate pair, at either end', () => {
    const pair = '\u{1F600}';
    // A pair straddles the end of the first half, and another the start of the last.
    const output = `${text(9_999)}${pair}${text(5_000)}${pair}${text(9_999)}`;
    const taken = cutOutput(output);
    expect(taken.text.slice(0, taken.cut?.at ?? 0)).toBe(text(9_999));
    expect(taken.text.slice(taken.cut?.at ?? 0)).toBe(text(9_999));
    expect(taken.cut?.omitted).toBe(output.length - 2 * 9_999);
    expect(cutTo(`${text(3)}${pair}`, 4).text).toBe(text(3));
    expect(cutFromEnd(`${pair}${text(3)}`, 4)).toBe(text(3));
    expect(cutFromEnd('abcdef', 3)).toBe('def');
  });

  it('cuts files, changes and steps to their counts, and says how many were left out', () => {
    const files = Array.from({ length: MAX_ACTIVITY_FILES + 7 }, (_, n) => ({ path: `f${n}`, line: null }));
    const changes = Array.from({ length: MAX_CHANGES + 3 }, (_, n) => ({ path: `c${n}`, kind: 'update' as const, text: 'diff' }));
    const steps = Array.from({ length: MAX_STEPS + 2 }, (_, n) => ({ text: `s${n}`, state: 'pending' as const }));
    const taken = cutParts({ files, changes, steps });
    expect(taken.parts.files).toHaveLength(MAX_ACTIVITY_FILES);
    expect(taken.parts.changes).toHaveLength(MAX_CHANGES);
    expect(taken.parts.steps).toHaveLength(MAX_STEPS);
    expect(taken.cut).toEqual({ fields: ['changes', 'steps', 'files'], output: null, files: 7, steps: 2, changes: 3 });
  });

  it('cuts a change’s text and a step’s text to theirs, and names the field with none left out', () => {
    const taken = cutParts({ changes: [{ path: 'a', kind: 'add', text: text(MAX_CHANGE_TEXT + 1) }], steps: [{ text: text(MAX_STEP_TEXT + 1), state: 'completed' }] });
    expect(taken.parts.changes?.[0]?.text).toHaveLength(MAX_CHANGE_TEXT);
    expect(taken.parts.steps?.[0]?.text).toHaveLength(MAX_STEP_TEXT);
    expect(taken.cut).toEqual({ fields: ['changes', 'steps'], output: null, files: 0, steps: 0, changes: 0 });
  });

  it('takes a path over its bound for no path: its entry is left out, and counted', () => {
    const taken = cutParts({ files: [{ path: 'ok.md', line: null }, { path: text(MAX_ACTIVITY_PATH + 1), line: null }, { path: '', line: null }] });
    expect(taken.parts.files).toEqual([{ path: 'ok.md', line: null }]);
    expect(taken.cut?.files).toBe(2);
  });

  it('passes every schema once cut, whatever it was given', () => {
    const taken = cutParts({
      name: text(1_000), summary: text(9_000), input: text(50_000), output: text(90_000), thinking: text(90_000),
      files: Array.from({ length: 500 }, (_, n) => ({ path: `f${n}`, line: n + 1 })),
      changes: Array.from({ length: 50 }, (_, n) => ({ path: `c${n}`, kind: 'write' as const, text: text(30_000) })),
      steps: Array.from({ length: 300 }, () => ({ text: text(900), state: 'in-progress' as const })),
    });
    expect(activityStartFields.name.safeParse(taken.parts.name).success).toBe(true);
    expect(activityStartFields.summary.safeParse(taken.parts.summary).success).toBe(true);
    expect(activityStartFields.input.safeParse(taken.parts.input).success).toBe(true);
    expect(activityEndFields.output.safeParse(taken.parts.output).success).toBe(true);
    expect(activityEndFields.thinking.safeParse(taken.parts.thinking).success).toBe(true);
    expect(activityStartFields.files.safeParse(taken.parts.files).success).toBe(true);
    expect(activityStartFields.changes.safeParse(taken.parts.changes).success).toBe(true);
    expect(activityStartFields.steps.safeParse(taken.parts.steps).success).toBe(true);
    expect(ActivityCutSchema.safeParse(taken.cut).success).toBe(true);
    expect(taken.cut?.fields).toEqual([...ACTIVITY_CUT_FIELDS]);
  });
});

describe('the body’s own bound (C5)', () => {
  const change = (n: number) => ({ path: `src/file-${n}.ts`, kind: 'update' as const, text: text(MAX_CHANGE_TEXT) });
  const manyFiles = Array.from({ length: MAX_ACTIVITY_FILES }, (_, n) => ({ path: `${text(MAX_ACTIVITY_PATH - 4)}${String(n).padStart(4, '0')}`, line: null }));

  it('returns a body within its bounds as it is', () => {
    const held = body({ output: 'ok', status: 'completed' });
    expect(boundActivity(held)).toBe(held);
  });

  it('gives way in C5’s order: an edit’s changes, the output, the input, a checklist’s steps, a thinking text, the files', () => {
    expect(GIVES_WAY).toEqual(['changes', 'output', 'input', 'steps', 'thinking', 'files']);
  });

  it.each([
    // What the body holds, and which fields are given up for it to fit.
    ['changes alone are enough', { changes: Array.from({ length: 12 }, (_, n) => change(n)), output: 'kept', input: 'kept' }, ['changes'], { changes: 12, files: 0, steps: 0 }],
    ['the files hold it over: everything before them goes first', { files: manyFiles, output: text(500), input: text(500), steps: [{ text: 'a', state: 'pending' as const }], thinking: 'thought' }, ['input', 'output', 'thinking', 'steps', 'files'], { changes: 0, files: MAX_ACTIVITY_FILES, steps: 1 }],
    ['an empty field is no cut', { files: manyFiles, input: null }, ['files'], { changes: 0, files: MAX_ACTIVITY_FILES, steps: 0 }],
  ] as const)('%s', (_name, patch, fields, counts) => {
    const bound = boundActivity(body({ ...patch, files: [...(('files' in patch ? patch.files : undefined) ?? [])], changes: [...(('changes' in patch ? patch.changes : undefined) ?? [])], steps: [...(('steps' in patch ? patch.steps : undefined) ?? [])] }));
    expect(activityUnits(bound)).toBeLessThanOrEqual(MAX_ACTIVITY_UNITS);
    expect(bound.cut?.fields).toEqual(fields);
    expect({ changes: bound.cut?.changes, files: bound.cut?.files, steps: bound.cut?.steps }).toEqual(counts);
    for (const field of fields) {
      if (field === 'changes' || field === 'steps' || field === 'files') expect(bound[field]).toEqual([]);
      else expect(bound[field]).toBeNull();
    }
  });

  it('stops at the first field that makes it fit, and keeps the rest', () => {
    const bound = boundActivity(body({ changes: Array.from({ length: 11 }, (_, n) => change(n)), output: 'the error', input: 'the command', thinking: 'a thought', files: [{ path: 'a.md', line: 1 }] }));
    expect(bound.changes).toEqual([]);
    expect(bound).toMatchObject({ output: 'the error', input: 'the command', thinking: 'a thought', files: [{ path: 'a.md', line: 1 }] });
  });

  it('counts every string of the body: its name and its line among them', () => {
    expect(activityUnits(body({ name: 'ab', summary: 'cde', input: 'f', output: 'gh', thinking: 'i', files: [{ path: 'jk', line: 1 }], changes: [{ path: 'l', kind: 'add', text: 'mn' }], steps: [{ text: 'o', state: 'pending' }] }))).toBe(15);
  });
});

describe('a body, from its start to its end (C6, C59)', () => {
  it('starts running, with what its start said and nothing more', () => {
    expect(startedBody({ type: 'read', name: 'Read', summary: 'Read a.md', input: '{"file_path":"a.md"}', files: [{ path: 'a.md', line: null }] })).toEqual({
      type: 'read', name: 'Read', summary: 'Read a.md', input: '{"file_path":"a.md"}', output: null, files: [{ path: 'a.md', line: null }], status: 'running', exitCode: null, changes: [], steps: [], thinking: null, workerId: null, duration: null, cut: null, declinedBy: null, model: null, agentType: null,
    });
  });

  it('bounds what its start said, whatever it was handed', () => {
    const started = startedBody({ type: 'command', name: 'x', summary: 'x', input: text(MAX_ACTIVITY_INPUT + 9) });
    expect(started.input).toHaveLength(MAX_ACTIVITY_INPUT);
    expect(started.cut?.fields).toEqual(['input']);
  });

  it('a second start replaces what the first said, and opens nothing: a checklist’s each update (C59)', () => {
    const first = startedBody({ type: 'checklist', name: 'plan', summary: 'Tasks', steps: [{ text: 'one', state: 'in-progress' }, { text: 'two', state: 'pending' }] });
    const second = restartedBody(first, { type: 'checklist', name: 'plan', summary: 'Tasks', steps: [{ text: 'one', state: 'completed' }, { text: 'two', state: 'in-progress' }] });
    expect(second.steps).toEqual([{ text: 'one', state: 'completed' }, { text: 'two', state: 'in-progress' }]);
    expect(second.status).toBe('running');
  });

  it('a second start keeps what it does not give: the output, the status, the duration', () => {
    const ended = endedBody(startedBody({ type: 'worker', name: 'Agent', summary: 'Worker 1', input: '{}' }), { status: 'completed', output: 'report', duration: { ms: 40, provenance: 'provider' } });
    const paired = restartedBody(ended, { type: 'worker', name: 'Agent', summary: 'Reads notes', workerId: 'w1' });
    expect(paired).toMatchObject({ summary: 'Reads notes', workerId: 'w1', input: '{}', output: 'report', status: 'completed', duration: { ms: 40, provenance: 'provider' } });
    // A start that names no worker leaves the one already paired.
    expect(restartedBody(paired, { type: 'worker', name: 'Agent', summary: 'Reads notes' }).workerId).toBe('w1');
  });

  it('a worker item keeps its model and its agent definition, a later start replacing the model it names and keeping the rest (M106, C19, C20)', () => {
    const started = startedBody({ type: 'worker', name: 'Agent', summary: 'Reads notes', model: 'haiku', agentType: 'general-purpose' });
    expect(started).toMatchObject({ model: 'haiku', agentType: 'general-purpose' });
    const named = restartedBody(started, { type: 'worker', name: 'Agent', summary: 'Reads notes', workerId: 'w1', model: 'claude-haiku-4-5-20251001' });
    expect(named).toMatchObject({ model: 'claude-haiku-4-5-20251001', agentType: 'general-purpose', workerId: 'w1' });
    // A start that names neither leaves both, and an end keeps them.
    expect(endedBody(restartedBody(named, { type: 'worker', name: 'Agent', summary: 'Reads notes' }), { status: 'completed' })).toMatchObject({ model: 'claude-haiku-4-5-20251001', agentType: 'general-purpose' });
    expect(readActivity(JSON.parse(JSON.stringify(named)))).toEqual(named);
    // A body written before them reads both as none.
    expect(readActivity({ type: 'worker', name: 'Agent', summary: 's' })).toMatchObject({ model: null, agentType: null });
  });

  it.each([
    ['completed', 0], ['failed', 2], ['unfinished', null],
  ] as const)('ends %s, with what its end said over what its start did', (status, exitCode) => {
    const ended = endedBody(startedBody({ type: 'command', name: 'commandExecution', summary: 'ls', input: 'ls' }), { status, output: 'out', exitCode, duration: { ms: 0, provenance: 'provider' } });
    expect(ended).toMatchObject({ status, output: 'out', exitCode, input: 'ls', duration: { ms: 0, provenance: 'provider' } });
  });

  it('an end that says nothing of a field leaves it as it was', () => {
    const started = startedBody({ type: 'edit', name: 'Write', summary: 'a.md', changes: [{ path: 'a.md', kind: 'write', text: 'hello' }] });
    expect(endedBody(started, { status: 'completed' }).changes).toEqual(started.changes);
  });

  it('joins a start’s cut and an end’s: each names its own fields', () => {
    const started = startedBody({ type: 'command', name: 'x', summary: 'x', input: text(MAX_ACTIVITY_INPUT + 1) });
    const output = cutOutput(text(MAX_ACTIVITY_OUTPUT + 50));
    const ended = endedBody(started, { status: 'completed', output: output.text, cut: { fields: ['output'], output: output.cut, files: 0, steps: 0, changes: 0 } });
    expect(ended.cut).toEqual({ fields: ['input', 'output'], output: { omitted: 50, at: 10_000 }, files: 0, steps: 0, changes: 0 });
    expect(mergeCuts(null, null)).toBeNull();
    expect(mergeCuts(started.cut, null)).toBe(started.cut);
  });
});

describe('a stored body, read (C28)', () => {
  it('reads back what was written', () => {
    const written = endedBody(startedBody({ type: 'command', name: 'commandExecution', summary: 'ls', input: 'ls', files: [{ path: 'a', line: 4 }] }), { status: 'failed', output: 'no', exitCode: 1, duration: { ms: 12, provenance: 'local' } });
    expect(readActivity(JSON.parse(JSON.stringify(written)))).toEqual(written);
  });

  it('is no activity for what is no object', () => {
    for (const value of [null, undefined, 'x', 4, []]) expect(readActivity(value)).toBeNull();
  });

  it('reads the keys it knows and fails for none it does not', () => {
    const read = readActivity({ type: 'a-later-type', name: 7, status: 'a-later-status', files: [{ path: 'ok', line: 'x' }, { nope: 1 }, 'x'], steps: [{ text: 's', state: 'odd' }], changes: [{ path: 'p', kind: 'odd', text: 4 }], duration: { ms: -4 }, later: { any: 'thing' } });
    expect(read).toEqual({
      type: 'other', name: '', summary: '', input: null, output: null, files: [{ path: 'ok', line: null }], status: 'unfinished', exitCode: null,
      changes: [{ path: 'p', kind: 'other', text: null }], steps: [{ text: 's', state: 'pending' }], thinking: null, workerId: null, duration: { ms: 0, provenance: 'local' }, cut: null, declinedBy: null, model: null, agentType: null,
    });
  });

  it('reads a cut, the fields it knows alone', () => {
    expect(readActivity({ type: 'command', cut: { fields: ['output', 'later', 'input'], output: { omitted: 9, at: 3 }, files: 2 } })?.cut).toEqual({ fields: ['input', 'output'], output: { omitted: 9, at: 3 }, files: 2, steps: 0, changes: 0 });
  });
});
