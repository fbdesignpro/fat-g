// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The speed a Claude turn ran at (decision 0020; models research §6), as Claude 2.1.302's frames say it.
import { describe, expect, it } from 'vitest';
import { overageReason, servedSpeed } from './chat-speed';

const rateLimit = (info: Record<string, unknown>) => ({ type: 'rate_limit_event', session_id: 's', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', ...info } });
const result = (usage: Record<string, unknown> | undefined, state = 'on') => ({ type: 'result', subtype: 'success', is_error: false, fast_mode_state: state, ...(usage === undefined ? {} : { usage }) });

describe('the speed a Claude turn ran at', () => {
  it('reads why extra usage was refused from a rate-limit frame, null where it was allowed, and nothing from another frame', () => {
    expect(overageReason(rateLimit({ overageStatus: 'rejected', overageDisabledReason: 'out_of_credits', isUsingOverage: false }))).toBe('out_of_credits');
    expect(overageReason(rateLimit({ overageStatus: 'rejected' }))).toBe('overage_rejected');
    expect(overageReason(rateLimit({ overageStatus: 'rejected', overageDisabledReason: 'not an id' }))).toBe('overage_rejected');
    expect(overageReason(rateLimit({ overageStatus: 'allowed', overageDisabledReason: null }))).toBeNull();
    expect(overageReason(result({ speed: 'fast' }))).toBeUndefined();
    expect(overageReason({ type: 'rate_limit_event' })).toBeUndefined();
  });

  it('reads a result’s served speed, `service_tier` aside: fast, or standard with the reason — paused, else the refused extra usage', () => {
    expect(servedSpeed(result({ speed: 'fast', service_tier: 'standard' }), null)).toEqual({ served: 'fast', reason: null });
    expect(servedSpeed(result({ speed: 'standard', service_tier: 'standard' }), 'out_of_credits')).toEqual({ served: 'standard', reason: 'out_of_credits' });
    expect(servedSpeed(result({ speed: 'standard' }, 'cooldown'), 'out_of_credits')).toEqual({ served: 'standard', reason: 'cooldown' });
    expect(servedSpeed(result({ speed: 'standard' }), null)).toEqual({ served: 'standard', reason: null });
  });

  it('says nothing for a result that names no speed, or for another frame', () => {
    expect(servedSpeed(result(undefined), null)).toBeNull();
    expect(servedSpeed(result({ speed: 'turbo' }), null)).toBeNull();
    expect(servedSpeed(rateLimit({ overageStatus: 'rejected' }), null)).toBeNull();
  });
});
