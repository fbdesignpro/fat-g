// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V17 (docs/planning/_archive/M23.md; C83): whether a session's draft or queue holds something, read from the
// store as ids alone, and never taken for "nothing" while the store cannot say.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Scratch, scratch } from '../conversations/test-support';
import { createContentPresence } from './content';

let area: Scratch;
beforeEach(() => { area = scratch(); });
afterEach(() => { area.dispose(); });

const ONE = '0b6f2c1e-5a4d-4e0b-9a51-7f3d1c0e6b19';
const TWO = '1c7f3d2f-6b5e-4f1c-8b62-8f4e2d1f7c20';
const NO_INTENT = { plan: false, skill: null } as const;

describe('content presence', () => {
  it('says yes for a draft with text, no for one without, and changes as the drafts do', () => {
    const store = area.open();
    store.ensure(ONE, 1);
    store.ensure(TWO, 1);
    const presence = createContentPresence(store);
    expect(presence.has(ONE)).toBe(false);
    store.saveDraft(ONE, 1, { text: 'A prompt in the making', intent: NO_INTENT }, 2, false);
    // Read again only when asked to: and then it says what changed.
    expect(presence.has(ONE)).toBe(false);
    expect(presence.refresh()).toBe(true);
    expect(presence.has(ONE)).toBe(true);
    expect(presence.has(TWO)).toBe(false);
    expect(presence.refresh()).toBe(false);
    store.clearDraft(ONE, 2, 3);
    expect(presence.refresh()).toBe(true);
    expect(presence.has(ONE)).toBe(false);
  });

  it('answers neither yes nor no while the store cannot say', () => {
    const store = area.open();
    const presence = createContentPresence({ status: () => ({ kind: 'refused', cause: 'unreadable' }) as unknown as ReturnType<typeof store.status>, withContent: () => [ONE] });
    expect(presence.has(ONE)).toBeNull();
    const throwing = createContentPresence({ status: () => store.status(), withContent: () => { throw new Error('SQLITE_IOERR'); } });
    expect(throwing.has(ONE)).toBeNull();
  });
});
