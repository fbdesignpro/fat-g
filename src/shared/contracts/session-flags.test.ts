// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { FLAGS_KEPT_AT_DONE, flagsClearedAtDone, isSessionFlag, NO_FLAGS, SESSION_FLAGS } from './session-flags';

describe('the session flags', () => {
  it('are the star, To do and To verify, in the order the menu lists them, none set on a new session', () => {
    expect(SESSION_FLAGS).toEqual(['starred', 'toDo', 'toVerify']);
    expect(NO_FLAGS).toEqual({ starred: false, toDo: false, toVerify: false });
  });

  it('keep the star at Done, and clear every other flag', () => {
    expect(FLAGS_KEPT_AT_DONE).toEqual(['starred']);
    expect(flagsClearedAtDone()).toEqual({ toDo: false, toVerify: false });
  });

  it('know their own names alone', () => {
    expect(SESSION_FLAGS.every(isSessionFlag)).toBe(true);
    expect([isSessionFlag('pinned'), isSessionFlag(''), isSessionFlag(null)]).toEqual([false, false, false]);
  });
});
