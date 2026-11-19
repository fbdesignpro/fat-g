// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// fat-g's words for what a session did between its messages (docs/planning/_archive/M20a.md, Design 8;
// C36, C37, C39–C41, C45): a group's summary line, each kind's row, a status and a cut, in words.
// Every word the activity shows that the conversation did not say is here. Pure: the components
// draw what these answer.
//
// A status is told by its word, never by colour alone (C45). A thinking item has no row and counts
// in no summary line (C9): how thinking is shown is later presentation work.
//
// An action that was refused leave reads declined, a status of its own and no failure of the
// agent's (docs/planning/_archive/M22.md, Design 4, 10; C76): by whom, where its adapter knows.
import { type ActivityBody, type ActivityStatus, type ActivityType, type ChangeKind, type DeclinedBy, fileName, type StepState } from '@shared/contracts/activity';
import type { ConversationItem } from '@shared/contracts/conversation';
import { formatElapsed } from '../ui/format';

/** An item of a group that is drawn: an activity that is no thinking. */
export interface Activity {
  readonly item: ConversationItem;
  readonly body: ActivityBody;
}

/** The activities of a group that have a row, in their order (C9, C39). */
export function rowsOf(items: readonly ConversationItem[]): Activity[] {
  return items.flatMap((item) => (item.activity === null || item.activity.type === 'thinking' ? [] : [{ item, body: item.activity }]));
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;
const times = (count: number): string => (count === 1 ? 'once' : count === 2 ? 'twice' : `${count} times`);

/** One phrase a type, in the order they are said. */
const PHRASES: readonly (readonly [ActivityType, (count: number) => string])[] = [
  ['read', (count) => `read ${plural(count, 'file', 'files')}`],
  ['search', (count) => `searched ${times(count)}`],
  ['command', (count) => `ran ${plural(count, 'command', 'commands')}`],
  ['edit', (count) => `edited ${plural(count, 'file', 'files')}`],
  ['mcp', (count) => `called ${plural(count, 'tool', 'tools')}`],
  ['web-search', (count) => `searched the web ${times(count)}`],
  ['worker', (count) => `started ${plural(count, 'sub-agent', 'sub-agents')}`],
  ['wait', (count) => `waited ${times(count)}`],
  ['checklist', () => 'kept a task list'],
  ['other', (count) => `used ${plural(count, 'other tool', 'other tools')}`],
];

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * A group's summary, from its types' counts, thinking apart (C36): "Read 3 files, searched twice,
 * ran 1 command". An action that failed, or that never finished, counts in its type's phrase — it
 * was run — and is said again after them: no group opens by itself, so the line is all a closed
 * group says of it (maintainer) — "Ran 2 commands, 1 failed". An action that was
 * declined never ran (M22, C76), and neither did one whose card was withdrawn or dropped before
 * any decision (C110), given here by its item's id: each is counted apart, last, and in no type's
 * phrase — "Read 1 file, 1 action declined, 1 not run".
 */
export function groupWords(rows: readonly Activity[], unrun: ReadonlySet<string> = NONE): string {
  const counts = new Map<ActivityType, number>();
  let declined = 0;
  let notRun = 0;
  let failed = 0;
  let unfinished = 0;
  for (const { item, body } of rows) {
    if (body.status === 'declined') declined += 1;
    else if (unrun.has(item.id)) notRun += 1;
    else {
      counts.set(body.type, (counts.get(body.type) ?? 0) + 1);
      if (body.status === 'failed') failed += 1;
      else if (body.status === 'unfinished') unfinished += 1;
    }
  }
  const done = PHRASES.flatMap(([type, phrase]) => { const count = counts.get(type) ?? 0; return count === 0 ? [] : [phrase(count)]; });
  const apart = [
    ...(failed === 0 ? [] : [`${failed} failed`]),
    ...(unfinished === 0 ? [] : [`${unfinished} did not finish`]),
    ...(declined === 0 ? [] : [`${plural(declined, 'action', 'actions')} declined`]),
    ...(notRun === 0 ? [] : [done.length === 0 && declined === 0 ? `${plural(notRun, 'action', 'actions')} not run` : `${notRun} not run`]),
  ];
  return capitalize([...done, ...apart].join(', '));
}

const NONE: ReadonlySet<string> = new Set();

/** The status an action that never ran for want of leave reads (M22, C110): its card was withdrawn or dropped before any decision, whatever its provider said of it. */
export const NOT_RUN_WORDS = 'Not run';

/**
 * A group's span (C36): from its first start to its last end, by main's own receipts. `running`:
 * an item of it still runs, and the span is counted to `now`. Null where it cannot be said: items
 * read from a provider's history have no time of their own.
 */
export function groupSpan(rows: readonly Activity[], now: number): { readonly ms: number; readonly running: boolean } | null {
  let first: number | null = null;
  let last: number | null = null;
  let running = false;
  for (const { item, body } of rows) {
    const at = item.time.receivedAt;
    if (at === null) return null;
    first = first === null ? at : Math.min(first, at);
    if (body.status === 'running') { running = true; continue; }
    const end = at + (body.duration?.ms ?? 0);
    last = last === null ? end : Math.max(last, end);
  }
  if (first === null) return null;
  const end = running ? Math.max(now, last ?? now) : last ?? first;
  return { ms: Math.max(0, end - first), running };
}

/** An item's status, in words (C37, C45). */
export const STATUS_WORDS: Readonly<Record<ActivityStatus, string>> = { running: 'Running', completed: 'Completed', failed: 'Failed', unfinished: 'Did not finish', declined: 'Declined' };

/** Who declined an action, where its adapter knows (M22, C76): the user, on its card, or a rule of the user's own configuration. */
export const DECLINED_WORDS: Readonly<Record<DeclinedBy, string>> = { user: 'Declined by you', rule: 'Declined by a rule of your configuration' };

/**
 * An item's status as its row says it: a failed one's with its exit code, where it has one that is
 * no zero; a declined one's with who declined it, where that is known, and never an exit code — it
 * did not run (M22, C76).
 */
export function statusWords(body: Pick<ActivityBody, 'status' | 'exitCode'> & Partial<Pick<ActivityBody, 'declinedBy'>>): string {
  if (body.status === 'declined') return body.declinedBy == null ? STATUS_WORDS.declined : DECLINED_WORDS[body.declinedBy];
  return body.status === 'failed' && body.exitCode !== null && body.exitCode !== 0 ? `${STATUS_WORDS.failed} (exit code ${body.exitCode})` : STATUS_WORDS[body.status];
}

/**
 * An item's duration, as its row shows it; null for one that has none and does not run, and for an
 * action that was only asked for — declined, or never given leave (`asked`): nothing ran to take any time.
 */
export function durationWords(item: ConversationItem, body: ActivityBody, now: number, asked = body.status === 'declined'): string | null {
  if (asked) return null;
  if (body.status === 'running') return item.time.receivedAt === null ? null : formatElapsed(Math.max(0, now - item.time.receivedAt));
  return body.duration === null ? null : formatElapsed(body.duration.ms);
}

/** The first word of a command's line (C37): what its row names it by. */
export function firstWord(line: string): string {
  return line.trim().split(/\s+/)[0] ?? '';
}

export const CHANGE_WORDS: Readonly<Record<ChangeKind, string>> = { add: 'added', delete: 'deleted', update: 'changed', write: 'written', other: 'changed' };
export const STEP_WORDS: Readonly<Record<StepState, string>> = { pending: 'To do', 'in-progress': 'In progress', completed: 'Done' };

/** A checklist's row (C39): how many of its steps are done. */
export function tasksWords(body: Pick<ActivityBody, 'steps'>): string {
  return `Tasks: ${body.steps.filter((step) => step.state === 'completed').length} of ${body.steps.length} done`;
}

/** What a row reads, by its kind (C37–C41): the type's word, and what it is said of. `file`: the path its word names as a control. */
export interface RowWords {
  readonly word: string;
  /** Text after the word, or null where a file control, or nothing, follows it. */
  readonly text: string | null;
  /** The file the row names, for a read and an edit: drawn as a control with the opener. */
  readonly file: { readonly path: string; readonly line: number | null; readonly name: string } | null;
  /** More said after the file: an edit's kind of change, and how many more files it changed. */
  readonly more: string | null;
}

export function rowWords(body: ActivityBody, asked = body.status === 'declined'): RowWords {
  const plain = (word: string, text: string | null = null): RowWords => ({ word, text: text === '' ? null : text, file: null, more: null });
  // An action that was declined never ran (M22, C76), nor one whose leave never came (C110): its row
  // says what was asked, never that it was done.
  switch (body.type) {
    case 'read': {
      const [file] = body.files;
      const word = asked ? 'Asked to read' : 'Read';
      return file === undefined ? plain(word, body.summary) : { word, text: null, file: { ...file, name: body.summary === '' ? fileName(file.path) : body.summary }, more: null };
    }
    case 'search': return plain(asked ? 'Asked to search' : 'Searched', body.summary);
    case 'command': return plain(asked ? 'Asked to run' : 'Ran', firstWord(body.summary));
    case 'edit': {
      const [change] = body.changes;
      const word = asked ? 'Asked to edit' : 'Edited';
      if (change === undefined) return plain(word, body.summary);
      const rest = body.changes.length - 1 + (body.cut?.changes ?? 0);
      // What a change did to its file is said of one that was made alone.
      const more = asked ? (rest > 0 ? `and ${rest} more` : null) : `${CHANGE_WORDS[change.kind]}${rest > 0 ? `, and ${rest} more` : ''}`;
      return { word, text: null, file: { path: change.path, line: null, name: fileName(change.path) }, more };
    }
    case 'mcp': return plain(asked ? 'Asked to call' : 'Called', body.summary === '' ? body.name : body.summary);
    case 'web-search': return plain(asked ? 'Asked to search the web' : 'Searched the web', body.summary);
    case 'worker': return plain('Sub-agent', body.summary);
    case 'wait': return plain('Waited');
    case 'checklist': return plain(tasksWords(body));
    // A thinking item has no row; it reads as any tool fat-g does not know, should one ever be asked for.
    case 'thinking':
    case 'other': return plain(asked ? 'Asked to use' : 'Used', body.name);
  }
}

/** Whether a row has anything to open (C37): a wait has none, and is no disclosure. */
export function hasDetail(body: ActivityBody): boolean {
  return (body.input ?? '') !== '' || (body.output ?? '') !== '' || body.files.length > 0 || body.changes.length > 0 || body.steps.length > 0 || body.cut !== null;
}

/** fat-g's lines, where something of an item was cut (C5, C37). */
export const CUT_WORDS = {
  /** Between an output's two halves. */
  output: (omitted: number): string => `… ${omitted.toLocaleString('en-US')} characters left out here …`,
  outputGone: 'The output was too long to keep.',
  input: 'The input was cut: it was too long to keep whole.',
  inputGone: 'The input was too long to keep.',
  files: (count: number): string => `${plural(count, 'more file was', 'more files were')} named, and not kept.`,
  steps: (count: number): string => `${plural(count, 'more step was', 'more steps were')} listed, and not kept.`,
  changes: (count: number): string => `${plural(count, 'more change was', 'more changes were')} reported, and not kept.`,
  changesCut: 'A change was cut: it was too long to keep whole.',
} as const;

/** The names of a row's parts, and of its controls (C37, C40, C42). */
export const ACTIVITY_LABELS = {
  group: 'Activity',
  input: 'Input',
  output: 'Output',
  report: 'Report',
  files: 'Files',
  copyInput: 'Copy input',
  copyOutput: 'Copy output',
  copyReport: 'Copy report',
  copyChange: 'Copy change',
  openWorker: 'Open',
  /** Above an edit's changes (C10, C41): what was reported then, never the file's present state. */
  reported: (when: string | null): string => (when === null ? 'As reported: the file may have changed since.' : `As reported at ${when}: the file may have changed since.`),
  show: (what: string): string => `Show ${what}`,
  hide: (what: string): string => `Hide ${what}`,
} as const;
