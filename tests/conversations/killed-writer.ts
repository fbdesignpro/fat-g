// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The writer the killed-writer tests kill (docs/planning/_archive/M18.md, Verification: V7, V18, V23, V24). It
// is the app's own session side (tests/sessions/app.ts) on a data folder, with a provider in its own
// hands. It plays one turn and a removal, and at the point it is told to stop it says so on its
// output and never goes on: the test then ends it with no cleanup, as a crash would.
//
//   node killed-writer.mjs <data folder> <project folder> <point> [format version]
//
// A point named `stream-…` plays the turn's answer as a message that is written (M19: V6, V7, V26):
// opened, told in deltas, saved at the store's own two seconds, and completed by its whole message.
//
// Bundled by the test with esbuild, as tests/process/forced-exit-parent.ts is. Never run by hand.
import { writeSync } from 'node:fs';
import { MAX_MESSAGE_TEXT } from '@shared/contracts/agent-events';
import type { ProviderDescriptor } from '@shared/contracts/provider';
import type { SessionFacet } from '@shared/provider-kit/sessions';
import { fakeFacet } from '../../src/main/sessions/runtime-test-support';
import { EXAMPLE_DESCRIPTOR } from '../support/example-provider';
import { launchApp, S } from '../sessions/app';

const [dir = '', folder = '', point = '', version] = process.argv.slice(2);
const PROMPT = 'killed-writer: what is the cat’s name?';
/** A provider that labels no phase: its answer arrives as commentary, and the turn's completed end names it (M16, C74). */
const NAMED = point === 'answer-commit' || point === 'answer-committed';
const REFERENCE = 'provider-session-1';
/** The answer is told in deltas. */
const STREAMED = point.startsWith('stream-');
/** Its deltas run past a message's bound (M19, C64). */
const PAST_BOUND = point === 'stream-cut';

/** Says where it is, on a write that has left the process when it returns, and stops for good. */
function stop(name: string): void {
  if (name !== point) return;
  writeSync(1, `AT ${name}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

const descriptor: ProviderDescriptor = { ...EXAMPLE_DESCRIPTOR, capabilities: { ...EXAMPLE_DESCRIPTOR.capabilities, sessions: true, history: false } };
const fake = fakeFacet({ history: false });
// The dispatch is the session's `send`: stopped inside it, the prompt is recorded and nothing was sent.
const facet: SessionFacet = {
  start(options) {
    const session = fake.facet.start(options);
    return { subscribe: (listener) => session.subscribe(listener), send(turn) { stop('before-dispatch'); session.send(turn); }, stop: () => session.stop(), closed: session.closed, close: () => session.close(), recheck: () => session.recheck() };
  },
  resume: (options) => fake.facet.resume(options),
};

let progressWrites = 0;
const waiters: { readonly count: number; readonly resolve: () => void }[] = [];
/** The message's `count`th write, committed: its first puts it in the store, at its first text. */
const progressWrite = (count: number): Promise<void> => new Promise((resolve) => { waiters.push({ count, resolve }); });

const app = launchApp({
  dir, descriptor, facet: () => facet,
  store: {
    ...(version === undefined ? {} : { version: Number(version) }),
    // Inside the transaction, before its commit: killed here, the commit never happened.
    hook(name) {
      if (name === 'provider-end') { stop('terminal-commit'); stop('answer-commit'); }
      if (name === 'delete') stop('removal-delete');
      // A write of a message that is being written is one synchronous transaction: by the next turn
      // of the loop it is committed.
      if (name === 'progress') { progressWrites += 1; const reached = progressWrites; setImmediate(() => { for (const waiter of waiters) if (waiter.count <= reached) waiter.resolve(); }); }
      if (name === 'complete') stop('stream-complete-commit');
    },
  },
});

const accepted = await app.runtime.send(S(1), PROMPT);
if (accepted.status !== 'accepted') throw new Error(`the prompt was refused: ${accepted.reason}`);
await app.service.settled();
stop('after-dispatch');

const live = fake.latest();
const sent = live.sent[0];
if (sent === undefined) throw new Error('nothing was sent');
const { turnId } = sent;
live.emit({ type: 'turn-started', turnId, providerTurnId: 'provider-turn-1' });
live.emit({ type: 'session-started', reference: REFERENCE, folder });
live.emit({ type: 'message', turnId, role: 'user', itemId: 'provider-item-1', phase: null, text: PROMPT, clientId: sent.messageId });
if (STREAMED) {
  // The answer as it is written: opened empty, then its text in pieces. The first text puts it in the store.
  const saved = progressWrite(2);
  live.emit({ type: 'message-delta', turnId, itemId: 'provider-item-2', phase: 'final', text: '' });
  for (const text of PAST_BOUND ? ['The cat is ', 'x'.repeat(MAX_MESSAGE_TEXT), 'never shown'] : ['The cat ', 'is called ']) live.emit({ type: 'message-delta', turnId, itemId: 'provider-item-2', phase: 'final', text });
  // The store's own two seconds: the write of what has arrived since the message's first text.
  await saved;
  // Past the bound and stored so: killed here, the flag is in the store with the text.
  stop('stream-cut');
  // What arrives after a write is in memory alone until the next one.
  live.emit({ type: 'message-delta', turnId, itemId: 'provider-item-2', phase: 'final', text: 'Miso' });
  stop('stream-progress');
  // The whole message completes it, in one transaction: stopped inside it, nothing of it is committed.
  live.emit({ type: 'message', turnId, role: 'assistant', itemId: 'provider-item-2', phase: 'final', text: 'The cat is called Miso.' });
  await app.service.settled();
  stop('stream-completed');
  throw new Error(`the writer has no point ${point}`);
}
live.emit({ type: 'message', turnId, role: 'assistant', itemId: 'provider-item-2', phase: 'commentary', text: 'Looking for the cat.' });
await app.service.settled();
stop('between-items');

if (point === 'worker-after-end') live.emit({ type: 'worker-started', workerId: 'worker-1' });
live.emit({ type: 'message', turnId, role: 'assistant', itemId: 'provider-item-3', phase: NAMED ? 'commentary' : 'final', text: 'Miso.' });
// Stopped inside this end's transaction, the answer's phase and the provider's end are both written and neither is committed.
live.emit({ type: 'turn-ended', turnId, outcome: 'completed', reported: true, ...(NAMED ? { answerItemId: 'provider-item-3' } : {}) });
await app.service.settled();
stop('answer-committed');
// The provider's turn is over, and its worker still runs.
stop('worker-after-end');

const saved = (answer: { status: string }): boolean => answer.status === 'saved';
// Marked, and the records write under way: it never lands.
if (point === 'removal-marked') await app.removal.run([S(1)], () => { stop('removal-marked'); return app.service.remove(S(1)); }, saved);
// The record is gone, and the rows' deletion is cut short inside its transaction.
await app.removal.run([S(1)], () => app.service.remove(S(1)), saved);
stop('done');
