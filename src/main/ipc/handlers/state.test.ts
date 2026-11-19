// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { SAMPLE_EMAIL, sampleSnapshot } from '../../../../tests/support/app-state';
import { createAppStateStore } from '../../state/app-state-store';
import { stateHandlers } from './state';

function storeWithSampleState() {
  const store = createAppStateStore();
  store.updateProviders(() => sampleSnapshot().providers);
  return store;
}

describe('state:getSnapshot', () => {
  it('gives the Main window the full snapshot', async () => {
    const store = storeWithSampleState();
    const snapshot = await stateHandlers(store)['state:getSnapshot'](null, { windowKind: 'main' });
    expect(snapshot).toBe(store.getSnapshot());
  });

  it('gives the Pet window a projected snapshot — its first snapshot must be redacted too', async () => {
    const store = storeWithSampleState();
    const snapshot = await stateHandlers(store)['state:getSnapshot'](null, { windowKind: 'pet' });
    expect(snapshot.seq).toBe(store.getSnapshot().seq);
    expect(JSON.stringify(snapshot)).not.toContain(SAMPLE_EMAIL);
  });

  it('always answers with the latest state', async () => {
    const store = storeWithSampleState();
    const handler = stateHandlers(store)['state:getSnapshot'];
    store.updateProviders(() => []);
    expect(await handler(null, { windowKind: 'main' })).toEqual({ seq: 2, appearance: { theme: 'light' }, providers: [] });
  });

  it('gives both windows the theme, the Pet included', async () => {
    const store = storeWithSampleState();
    store.setAppearance({ theme: 'dark' });
    const handler = stateHandlers(store)['state:getSnapshot'];
    expect((await handler(null, { windowKind: 'main' })).appearance).toEqual({ theme: 'dark' });
    expect((await handler(null, { windowKind: 'pet' })).appearance).toEqual({ theme: 'dark' });
  });
});
