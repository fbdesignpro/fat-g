// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V8 (docs/planning/_archive/M20a.md, Design 8; C36, C37, C39–C41, C45): fat-g's words for what a session did.
// A group's summary line from its types' counts and what became of its actions, its span, each
// kind's row, a status in words and the lines that say something was cut.
import { describe, expect, it } from 'vitest';
import { ACTIVITY_STATUSES, ACTIVITY_TYPES, type ActivityBody } from '@shared/contracts/activity';
import { chatActivity } from '../test/chat';
import { ACTIVITY_LABELS, CUT_WORDS, durationWords, firstWord, groupSpan, groupWords, hasDetail, rowsOf, rowWords, STATUS_WORDS, statusWords, tasksWords } from './activity-words';

const item = (body: Partial<ActivityBody> & Pick<ActivityBody, 'type'>, receivedAt: number | null = 1_000) => chatActivity('c', 't', body, { time: { receivedAt, providerAt: null } });
const rows = (...bodies: (Partial<ActivityBody> & Pick<ActivityBody, 'type'>)[]) => rowsOf(bodies.map((body) => item(body)));
const body = (given: Partial<ActivityBody> & Pick<ActivityBody, 'type'>): ActivityBody => item(given).activity as ActivityBody;

describe('a group’s summary line (C36)', () => {
  it('says what was done by its types’ counts, in one order, in fat-g’s words', () => {
    expect(groupWords(rows({ type: 'read' }, { type: 'read' }, { type: 'read' }, { type: 'search' }, { type: 'search' }, { type: 'command' }))).toBe('Read 3 files, searched twice, ran 1 command');
    expect(groupWords(rows({ type: 'command' }, { type: 'read' }))).toBe('Read 1 file, ran 1 command');
    expect(groupWords(rows({ type: 'search' }))).toBe('Searched once');
    expect(groupWords(rows({ type: 'search' }, { type: 'search' }, { type: 'search' }))).toBe('Searched 3 times');
    expect(groupWords(rows({ type: 'edit' }, { type: 'edit' }, { type: 'mcp' }, { type: 'web-search' }))).toBe('Edited 2 files, called 1 tool, searched the web once');
    expect(groupWords(rows({ type: 'worker' }, { type: 'wait' }, { type: 'wait' }, { type: 'checklist' }, { type: 'other' }))).toBe('Started 1 sub-agent, waited twice, kept a task list, used 1 other tool');
  });

  it('has a phrase for every type but thinking, which has no row and counts in no line (C9)', () => {
    for (const type of ACTIVITY_TYPES.filter((each) => each !== 'thinking')) expect(groupWords(rows({ type })), type).not.toBe('');
    expect(rowsOf([item({ type: 'thinking' }), item({ type: 'read' })])).toHaveLength(1);
    expect(groupWords(rowsOf([item({ type: 'thinking' }), item({ type: 'read' })]))).toBe('Read 1 file');
    expect(rowsOf([item({ type: 'thinking' })])).toEqual([]);
  });

  // No group opens by itself (maintainer): what became of an action is the closed line's to say.
  it('says what failed and what never finished after the phrases of what was done, each counted in its type too', () => {
    expect(groupWords(rows({ type: 'read' }, { type: 'command', status: 'failed' }))).toBe('Read 1 file, ran 1 command, 1 failed');
    expect(groupWords(rows({ type: 'command', status: 'failed' }, { type: 'command', status: 'failed' }))).toBe('Ran 2 commands, 2 failed');
    expect(groupWords(rows({ type: 'read', status: 'unfinished' }))).toBe('Read 1 file, 1 did not finish');
    expect(groupWords(rows({ type: 'command', status: 'failed' }, { type: 'read', status: 'unfinished' }))).toBe('Read 1 file, ran 1 command, 1 failed, 1 did not finish');
    // An item that runs, and one that ended well, add nothing to the line.
    expect(groupWords(rows({ type: 'read' }, { type: 'command', status: 'running' }))).toBe('Read 1 file, ran 1 command');
    // A declined action, and one that never ran, are counted apart as before, after what was run.
    expect(groupWords(rows({ type: 'command', status: 'failed' }, { type: 'command', status: 'declined' }))).toBe('Ran 1 command, 1 failed, 1 action declined');
  });

  it('spans from its first start to its last end, counted to now while an item runs, and has none where an item has no time', () => {
    const first = item({ type: 'read', duration: { ms: 2_000, provenance: 'local' } }, 10_000);
    const second = item({ type: 'command', duration: { ms: 3_000, provenance: 'provider' } }, 15_000);
    expect(groupSpan(rowsOf([first, second]), 99_000)).toEqual({ ms: 8_000, running: false });
    // An item that ends before one that started earlier ended: the last end is the latest one.
    expect(groupSpan(rowsOf([item({ type: 'read', duration: { ms: 9_000, provenance: 'local' } }, 10_000), second]), 0)).toEqual({ ms: 9_000, running: false });
    expect(groupSpan(rowsOf([first, item({ type: 'command', status: 'running' }, 15_000)]), 21_000)).toEqual({ ms: 11_000, running: true });
    // Read from a provider's history: no time of fat-g's own.
    expect(groupSpan(rowsOf([first, item({ type: 'command' }, null)]), 0)).toBeNull();
    expect(groupSpan([], 0)).toBeNull();
  });
});

describe('a row’s words (C37–C41)', () => {
  it('names a read by its file, as a control’s, and an edit by its first file with the kind of change', () => {
    expect(rowWords(body({ type: 'read', summary: 'sample.txt', files: [{ path: 'C:\\work\\sample.txt', line: 12 }] }))).toEqual({ word: 'Read', text: null, file: { path: 'C:\\work\\sample.txt', line: 12, name: 'sample.txt' }, more: null });
    // With no summary, the file's own name; with no file, the summary as text.
    expect(rowWords(body({ type: 'read', files: [{ path: 'src/tides.js', line: null }] })).file?.name).toBe('tides.js');
    expect(rowWords(body({ type: 'read', summary: 'two files' }))).toEqual({ word: 'Read', text: 'two files', file: null, more: null });
    const edit = body({ type: 'edit', changes: [{ path: 'src/a.ts', kind: 'update', text: '+x' }, { path: 'src/b.ts', kind: 'add', text: null }] });
    expect(rowWords(edit)).toEqual({ word: 'Edited', text: null, file: { path: 'src/a.ts', line: null, name: 'a.ts' }, more: 'changed, and 1 more' });
    expect(rowWords(body({ type: 'edit', changes: [{ path: 'new.md', kind: 'add', text: null }] })).more).toBe('added');
    // Changes that were left out count in "more".
    expect(rowWords({ ...edit, cut: { fields: ['changes'], output: null, files: 0, steps: 0, changes: 3 } }).more).toBe('changed, and 4 more');
  });

  it('names each other kind in fat-g’s words: a search, a command by its first word, a tool, a web search, a wait, a task list', () => {
    expect(rowWords(body({ type: 'search', summary: 'nextHighTide' }))).toMatchObject({ word: 'Searched', text: 'nextHighTide' });
    expect(rowWords(body({ type: 'command', summary: 'rg --files --hidden' }))).toMatchObject({ word: 'Ran', text: 'rg' });
    expect(firstWord('   npm   run check ')).toBe('npm');
    expect(rowWords(body({ type: 'mcp', name: 'docs: search', summary: 'docs: search' }))).toMatchObject({ word: 'Called', text: 'docs: search' });
    expect(rowWords(body({ type: 'mcp', name: 'docs: search' }))).toMatchObject({ word: 'Called', text: 'docs: search' });
    expect(rowWords(body({ type: 'web-search', summary: 'tide tables' }))).toMatchObject({ word: 'Searched the web', text: 'tide tables' });
    expect(rowWords(body({ type: 'wait', summary: 'wait' }))).toEqual({ word: 'Waited', text: null, file: null, more: null });
    expect(rowWords(body({ type: 'other', name: 'ALaterTool' }))).toMatchObject({ word: 'Used', text: 'ALaterTool' });
    expect(rowWords(body({ type: 'worker', summary: 'Worker 1' }))).toMatchObject({ word: 'Sub-agent', text: 'Worker 1' });
    const list = body({ type: 'checklist', steps: [{ text: 'One', state: 'completed' }, { text: 'Two', state: 'in-progress' }, { text: 'Three', state: 'pending' }] });
    expect(tasksWords(list)).toBe('Tasks: 1 of 3 done');
    expect(rowWords(list)).toMatchObject({ word: 'Tasks: 1 of 3 done', text: null });
  });

  it('tells a status by its word, a failure with its exit code where it has one (C45)', () => {
    expect(ACTIVITY_STATUSES.map((status) => STATUS_WORDS[status])).toEqual(['Running', 'Completed', 'Failed', 'Did not finish', 'Declined']);
    expect(statusWords({ status: 'failed', exitCode: 2 })).toBe('Failed (exit code 2)');
    expect(statusWords({ status: 'failed', exitCode: null })).toBe('Failed');
    expect(statusWords({ status: 'failed', exitCode: 0 })).toBe('Failed');
    expect(statusWords({ status: 'completed', exitCode: 0 })).toBe('Completed');
  });

  // M22, V9, V21 (C76): refused leave is a status of its own, and no failure of the agent's.
  it('never says that a declined action ran: its row says what was asked, its group counts it apart, and it has no duration (M22, C76)', () => {
    const declined = { status: 'declined' as const, declinedBy: 'user' as const };
    expect(rowWords(body({ type: 'command', summary: 'touch notes.txt', ...declined }))).toMatchObject({ word: 'Asked to run', text: 'touch' });
    expect(rowWords(body({ type: 'mcp', name: 'search', summary: '', ...declined }))).toMatchObject({ word: 'Asked to call', text: 'search' });
    expect(rowWords(body({ type: 'other', name: 'Tool', ...declined }))).toMatchObject({ word: 'Asked to use', text: 'Tool' });
    // An edit that was not made did nothing to its file: only how many more files it named is said.
    const edit = body({ type: 'edit', ...declined, changes: [{ path: 'src/a.ts', kind: 'update', text: null }, { path: 'src/b.ts', kind: 'add', text: null }] });
    expect(rowWords(edit)).toEqual({ word: 'Asked to edit', text: null, file: { path: 'src/a.ts', line: null, name: 'a.ts' }, more: 'and 1 more' });
    expect(rowWords({ ...edit, changes: edit.changes.slice(0, 1) }).more).toBeNull();
    // Counted apart in its group, after what was done.
    expect(groupWords(rows({ type: 'command', ...declined }))).toBe('1 action declined');
    expect(groupWords(rows({ type: 'read' }, { type: 'command', ...declined }, { type: 'edit', ...declined }, { type: 'command' }))).toBe('Read 1 file, ran 1 command, 2 actions declined');
    const refused = item({ type: 'command', ...declined, duration: { ms: 120, provenance: 'local' } });
    expect(durationWords(refused, refused.activity as ActivityBody, 5_000)).toBeNull();
  });

  it('counts an action whose leave never came apart, after what was done and what was declined (M22, C110)', () => {
    const one = rows({ type: 'edit', status: 'unfinished' });
    expect(groupWords(one, new Set([one[0]?.item.id ?? '']))).toBe('1 action not run');
    const mixed = rows({ type: 'read' }, { type: 'edit', status: 'failed' }, { type: 'command', status: 'declined', declinedBy: 'user' });
    expect(groupWords(mixed, new Set([mixed[1]?.item.id ?? '']))).toBe('Read 1 file, 1 action declined, 1 not run');
    // Given none, the edit is an action that ran and failed, and the line says so.
    expect(groupWords(mixed)).toBe('Read 1 file, edited 1 file, 1 failed, 1 action declined');
  });

  it('tells a declined action by one of three wordings, by who declined it, and never with an exit code (M22, C76)', () => {
    expect(statusWords({ status: 'declined', exitCode: null, declinedBy: null })).toBe('Declined');
    expect(statusWords({ status: 'declined', exitCode: null })).toBe('Declined');
    expect(statusWords({ status: 'declined', exitCode: null, declinedBy: 'user' })).toBe('Declined by you');
    expect(statusWords({ status: 'declined', exitCode: null, declinedBy: 'rule' })).toBe('Declined by a rule of your configuration');
    // It did not run: whatever code its provider gave is not said.
    expect(statusWords({ status: 'declined', exitCode: 1, declinedBy: 'user' })).toBe('Declined by you');
    // Who declined is said of a declined item alone.
    expect(statusWords({ status: 'failed', exitCode: 2, declinedBy: 'user' })).toBe('Failed (exit code 2)');
  });

  it('times a row by its duration once ended, from the page’s clock while it runs, and not at all where neither is known', () => {
    const ended = item({ type: 'command', duration: { ms: 14_000, provenance: 'provider' } });
    expect(durationWords(ended, ended.activity as ActivityBody, 0)).toBe('14 s');
    const running = item({ type: 'command', status: 'running' }, 10_000);
    expect(durationWords(running, running.activity as ActivityBody, 75_000)).toBe('1 min 5 s');
    const unfinished = item({ type: 'command', status: 'unfinished' });
    expect(durationWords(unfinished, unfinished.activity as ActivityBody, 0)).toBeNull();
    const imported = item({ type: 'command', status: 'running' }, null);
    expect(durationWords(imported, imported.activity as ActivityBody, 0)).toBeNull();
  });

  it('opens to a detail only where there is one: a wait has none (C37)', () => {
    expect(hasDetail(body({ type: 'wait' }))).toBe(false);
    expect(hasDetail(body({ type: 'command', input: 'ls' }))).toBe(true);
    expect(hasDetail(body({ type: 'read', output: 'x' }))).toBe(true);
    expect(hasDetail(body({ type: 'read', files: [{ path: 'a', line: null }] }))).toBe(true);
    expect(hasDetail(body({ type: 'checklist', steps: [{ text: 'One', state: 'pending' }] }))).toBe(true);
    // Something was cut away whole: the row opens to the line that says so.
    expect(hasDetail(body({ type: 'command', cut: { fields: ['output'], output: null, files: 0, steps: 0, changes: 0 } }))).toBe(true);
    expect(hasDetail(body({ type: 'command', input: '', output: '' }))).toBe(false);
  });
});

describe('the lines that say something was cut (C5, C37)', () => {
  it('say how much of an output was left out, where it was, and each other cut in a line of its own', () => {
    expect(CUT_WORDS.output(1_234_567)).toBe('… 1,234,567 characters left out here …');
    expect(CUT_WORDS.files(1)).toBe('1 more file was named, and not kept.');
    expect(CUT_WORDS.files(12)).toBe('12 more files were named, and not kept.');
    expect(CUT_WORDS.steps(2)).toBe('2 more steps were listed, and not kept.');
    expect(CUT_WORDS.changes(1)).toBe('1 more change was reported, and not kept.');
  });

  it('say above an edit’s changes when they were reported, never that the file reads so now (C10, C41)', () => {
    expect(ACTIVITY_LABELS.reported('29 Jan 2020, 14:05')).toBe('As reported at 29 Jan 2020, 14:05: the file may have changed since.');
    expect(ACTIVITY_LABELS.reported(null)).toBe('As reported: the file may have changed since.');
    expect(ACTIVITY_LABELS.show('Read sample.txt')).toBe('Show Read sample.txt');
    expect(ACTIVITY_LABELS.hide('Read sample.txt')).toBe('Hide Read sample.txt');
  });
});
