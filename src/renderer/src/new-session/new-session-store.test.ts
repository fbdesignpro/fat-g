// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { beforeEach, describe, expect, it } from 'vitest';
import { sampleProvider } from '../../../../tests/support/app-state';
import { installFakeBridge } from '../test/fake-bridge';
import { project } from '../test/records';
import { showState } from '../test/sessions';
import { closeNewSession, createNewSession, openNewSession, useNewSession } from './new-session-store';

const A = project('first', { providers: ['codex'] });
const B = project('second', { providers: ['codex'] });
const preset = { providerId: 'codex', instanceId: 'default', model: 'sample-1', effort: 'high', speed: null };
beforeEach(() => {
  closeNewSession();
  showState({ projects: [A, B], providers: [sampleProvider({ id: 'codex' })] });
});

describe('an initial visit while main is creating its draft', () => {
  it('coalesces repeated + and create calls before main answers', async () => {
    const bridge = installFakeBridge();
    let answer!: (value: unknown) => void;
    bridge.setInvoke(() => new Promise((resolve) => { answer = resolve; }));
    openNewSession(A.id);
    const first = createNewSession(preset);
    openNewSession(A.id);
    expect(await createNewSession(preset)).toBe(false);
    expect(bridge.calls).toEqual(['invoke:sessions:create']);
    answer({ ok: true, value: { status: 'saved', id: 'created' } });
    expect(await first).toBe(true);
    expect(useNewSession.getState().sessionId).toBe('created');
  });

  it('does not reopen a departed screen and cleans up its never-shown empty record', async () => {
    const bridge = installFakeBridge();
    let answer!: (value: unknown) => void;
    const requests: unknown[] = [];
    bridge.setInvoke((channel, request) => {
      requests.push([channel, request]);
      return channel === 'sessions:create' ? new Promise((resolve) => { answer = resolve; }) : Promise.resolve({ ok: true, value: { status: 'saved' } });
    });
    openNewSession(A.id);
    const first = createNewSession(preset);
    openNewSession(B.id);
    answer({ ok: true, value: { status: 'saved', id: 'abandoned' } });
    expect(await first).toBe(false);
    expect(useNewSession.getState()).toMatchObject({ projectId: B.id, sessionId: null, creating: false });
    expect(requests).toContainEqual(['sessions:remove', { id: 'abandoned' }]);
  });
});
