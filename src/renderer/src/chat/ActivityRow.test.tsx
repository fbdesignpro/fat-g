// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V9, V21 (docs/planning/_archive/M22.md, Design 4, 10; C36, C76): an activity's row for an action that was
// refused leave — declined, a status of its own with who declined it where that is known, and never
// an exit code — and a worker's row while an approval of its waits. The row's other words and its
// detail are ActivityGroup.test.tsx's.
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActivityBody } from '@shared/contracts/activity';
import type { ConversationItem } from '@shared/contracts/conversation';
import { chatActivity } from '../test/chat';
import { ActivityRow } from './ActivityRow';
import { CARD_WORDS } from './card-words';
import { CardContext, type CardScope } from './InteractionCard';
import { resetWaiting, setWaiting } from './questions-store';

const SESSION = '5e551000-0000-4000-8000-000000000001';
const SCOPE: CardScope = { sessionId: SESSION, providerName: 'Codex', asker: null, running: true, workerRunning: null };

beforeEach(resetWaiting);
afterEach(cleanup);

type Given = Partial<ActivityBody> & Pick<ActivityBody, 'type'>;
const activity = (body: Given): ConversationItem => chatActivity(SESSION, 't1', body);
function show(item: ConversationItem, unrun = false) {
  return render(
    <CardContext value={SCOPE}>
      <ul>
        <ActivityRow item={item} onOpenWorker={null} unrun={unrun} />
      </ul>
    </CardContext>,
  );
}
const row = () => screen.getByRole('listitem');
const status = () => [...row().querySelectorAll('span')].at(-1)?.textContent;

describe('a declined action’s row (V9, V21; C76)', () => {
  it.each([
    [null, 'Declined'],
    ['user', 'Declined by you'],
    ['rule', 'Declined by a rule of your configuration'],
  ] as const)('reads its status in words, by who declined it: %s', (declinedBy, words) => {
    show(activity({ type: 'command', summary: 'touch notes.txt', status: 'declined', declinedBy }));
    expect(row().dataset['status']).toBe('declined');
    expect(status()).toBe(words);
    // It never ran: its row says what was asked, by the command's first word, and gives no time for it.
    expect(row().textContent).toBe(`Asked to run touch ${words}`);
    expect(row().textContent).not.toMatch(/Ran|under 1 s/);
  });

  it('says no exit code, whatever its provider gave: it did not run', () => {
    show(activity({ type: 'command', summary: 'touch notes.txt', status: 'declined', declinedBy: 'user', exitCode: 1 }));
    expect(status()).toBe('Declined by you');
    expect(row().textContent).not.toMatch(/exit code/);
  });

  it('is told from a failure: an action that ran keeps the status its provider gave', () => {
    show(activity({ type: 'command', summary: 'false', status: 'failed', exitCode: 1 }));
    expect(status()).toBe('Failed (exit code 1)');
    cleanup();
    show(activity({ type: 'edit', summary: 'notes.txt', status: 'completed' }));
    expect(status()).toBe('Completed');
    cleanup();
    // A file change declined on its card reads the same way.
    show(activity({ type: 'edit', summary: 'notes.txt', status: 'declined', declinedBy: 'user', changes: [{ path: 'notes.txt', kind: 'update', text: null }] }));
    expect(status()).toBe('Declined by you');
    expect(row().dataset['status']).toBe('declined');
  });
});

describe('an action whose leave never came (M22, C110)', () => {
  it('says what was asked and that it did not run, whatever its provider said of it, with no time', () => {
    for (const status of ['failed', 'unfinished'] as const) {
      show(activity({ type: 'edit', summary: 'made-outside.txt', status, changes: [{ path: 'outside/made-outside.txt', kind: 'write', text: 'delta' }], duration: { ms: 2_000, provenance: 'local' } }), true);
      expect(row().textContent).toBe('Asked to edit made-outside.txt Not run');
      expect(row().dataset['notRun']).toBe('');
      expect(row().dataset['status']).toBe(status);
      cleanup();
    }
  });

  it('is told apart from an action that ran and failed, which keeps its own words', () => {
    show(activity({ type: 'edit', summary: 'notes.txt', status: 'failed', changes: [{ path: 'notes.txt', kind: 'update', text: null }], duration: { ms: 2_000, provenance: 'local' } }));
    expect(row().textContent).toBe('Edited notes.txt changed 2 s Failed');
    expect(row().dataset['notRun']).toBeUndefined();
  });
});

describe('a worker’s row while something of its waits (C36)', () => {
  const WORKER: Given = { type: 'worker', summary: 'Tidy the notes', status: 'running', workerId: 'worker-1' };

  it('says that it waits for an approval, in place of its status, and for an answer where a question waits too', () => {
    show(activity(WORKER));
    expect(status()).toBe('Running');
    expect(row().hasAttribute('data-waits')).toBe(false);
    act(() => { setWaiting(SESSION, [{ workerId: 'worker-1', itemId: 'a1', kind: 'approval' }]); });
    expect(status()).toBe(CARD_WORDS.rowWaitsApproval);
    expect(row().dataset['waits']).toBe('approval');
    act(() => { setWaiting(SESSION, [{ workerId: 'worker-1', itemId: 'a1', kind: 'approval' }, { workerId: 'worker-1', itemId: 'q1', kind: 'question' }]); });
    expect(status()).toBe(CARD_WORDS.rowWaits);
    expect(row().dataset['waits']).toBe('question');
    // Another worker's, and another session's, are not this row's.
    act(() => { setWaiting(SESSION, [{ workerId: 'worker-2', itemId: 'a2', kind: 'approval' }]); });
    expect(status()).toBe('Running');
    act(() => { setWaiting('5e55ffff-0000-4000-8000-00000000ffff', [{ workerId: 'worker-1', itemId: 'a1', kind: 'approval' }]); });
    expect(status()).toBe('Running');
  });
});
