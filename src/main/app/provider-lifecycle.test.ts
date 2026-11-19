// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/unbound-method */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { UsageService } from '../services/usage-service';
import { installProviderLifecycle } from './provider-lifecycle';

describe('provider power lifecycle', () => {
  it('handles suspend, resume and unlock, then removes every listener', () => {
    const power = new EventEmitter();
    const usage: UsageService = {
      attach: vi.fn(), detach: vi.fn(), forget: vi.fn(), refresh: vi.fn(() => ({ status: 'accepted' } as const)), preferencesChanged: vi.fn(),
      suspend: vi.fn(), resume: vi.fn(), stop: vi.fn(),
    };
    const remove = installProviderLifecycle(power, usage);
    power.emit('suspend');
    power.emit('resume');
    expect(usage.suspend).toHaveBeenCalledOnce();
    expect(usage.resume).toHaveBeenCalledOnce();

    power.emit('unlock-screen');
    expect(usage.resume).toHaveBeenCalledTimes(2);

    remove();
    power.emit('suspend');
    power.emit('resume');
    power.emit('unlock-screen');
    expect(usage.suspend).toHaveBeenCalledOnce();
    expect(usage.resume).toHaveBeenCalledTimes(2);
    expect(power.eventNames()).toEqual([]);
  });
});
