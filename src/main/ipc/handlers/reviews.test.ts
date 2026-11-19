// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V3, V4 (docs/planning/_archive/M22e.md, Design 8; C14, C16, C44): the reviews' eight channels, through the real
// contract — the sender policy, the strict requests, and the handlers on a review service in the
// test's hands — each outcome counted by its kind alone.
import { describe, expect, it, vi } from 'vitest';
import { REVIEW_BOUNDS } from '@shared/contracts/review';
import { INVOKE_SPECS } from '@shared/ipc/contract';
import { resolveTrustedOrigins } from '../../app/origins';
import { dispatchInvoke, type DispatchDeps, type Handler } from '../dispatch';
import { createKindCounts } from './counts';
import { reviewHandlers, type ReviewHandlerDeps } from './reviews';

const PRESET = { providerId: 'codex', instanceId: 'default', model: 'gpt-6-sol', effort: 'high', speed: null };
const SESSION = '5e551000-0000-4000-8000-000000000001';
const PLAN = 'a1b2c3d4-0000-4000-8000-000000000001';
const REVIEW = 'b2c3d4e5-0000-4000-8000-000000000001';
const CHANNELS = ['reviews:start', 'reviews:mark', 'reviews:note', 'reviews:send', 'reviews:explain', 'reviews:integrate', 'reviews:close', 'reviews:read'] as const;
const log = { warn: vi.fn(), error: vi.fn() };
const deps = (): DispatchDeps => ({ origins: resolveTrustedOrigins({ isPackaged: true, devServerUrl: undefined }), log, detail: 'kinds' });
const from = (kind: 'main' | 'pet', request: unknown) => ({ windowKind: kind, sender: { frameUrl: `app://fatg/${kind === 'main' ? 'index' : 'pet'}.html`, isTopFrame: true }, request });

function world() {
  const counts = createKindCounts();
  const made: ReviewHandlerDeps = {
    reviews: {
      start: vi.fn(() => Promise.resolve({ status: 'started' as const, reviewId: REVIEW, sessionId: SESSION })),
      mark: vi.fn(() => ({ status: 'saved' as const, marks: { 'T1.1': 'accepted' as const } })),
      note: vi.fn(() => ({ status: 'refused' as const, reason: 'not-live' as const })),
      send: vi.fn(() => Promise.resolve({ status: 'sent' as const })),
      explain: vi.fn(() => Promise.resolve({ status: 'accepted' as const, asideId: 'aside-1' })),
      integrate: vi.fn(() => Promise.resolve({ status: 'refused' as const, reason: 'too-long' as const, excess: 12 })),
      close: vi.fn(() => Promise.resolve({ status: 'closed' as const })),
      read: vi.fn(() => ({ status: 'session' as const, review: null })),
    },
    counts,
  };
  const ask = (channel: (typeof CHANNELS)[number], request: unknown, kind: 'main' | 'pet' = 'main') =>
    dispatchInvoke(channel, INVOKE_SPECS[channel], reviewHandlers(made)[channel] as Handler<unknown, unknown>, from(kind, request), deps());
  return { made, counts, ask };
}

const valid = (channel: (typeof CHANNELS)[number]): unknown => {
  switch (channel) {
    case 'reviews:start': return { sessionId: SESSION, planId: PLAN, version: 1, revision: 4, preset: PRESET };
    case 'reviews:mark': return { reviewId: REVIEW, findingId: 'T1.1', mark: 'accepted' };
    case 'reviews:note': return { reviewId: REVIEW, findingId: 'T1.1', note: 'A note.' };
    case 'reviews:send': return { reviewId: REVIEW };
    case 'reviews:explain': return { reviewId: REVIEW, findingId: 'T1.1', place: { range: { start: 0, end: 10 }, digest: '0123abcd' } };
    case 'reviews:integrate': return { reviewId: REVIEW, target: { preset: PRESET } };
    case 'reviews:close': return { reviewId: REVIEW, as: 'cancel' };
    case 'reviews:read': return { sessionId: SESSION };
  }
};

describe('the reviews’ channels (C44)', () => {
  it.each(CHANNELS)('refuses %s from the Pet, which shows on screen shares', async (channel) => {
    const { ask } = world();
    expect(await ask(channel, valid(channel), 'pet')).toEqual({ ok: false, error: 'forbidden' });
  });

  it.each(CHANNELS)('hands %s to the review service, and counts its outcome by kind alone', async (channel) => {
    const { ask, counts } = world();
    expect((await ask(channel, valid(channel))).ok).toBe(true);
    const kinds = Object.keys(counts.snapshot());
    expect(kinds).toHaveLength(1);
    // A kind, never a text, a title, an id or a path.
    expect(kinds[0]).not.toMatch(/T1\.1|A note|[0-9a-f]{8}-/);
  });

  it('says why an integration was refused, with the excess past the bound (C10)', async () => {
    const { ask, counts } = world();
    expect(await ask('reviews:integrate', { reviewId: REVIEW, target: { sessionId: SESSION } })).toEqual({ ok: true, value: { status: 'refused', reason: 'too-long', excess: 12 } });
    expect(counts.snapshot()).toEqual({ 'integrate:listed:refused:too-long': 1 });
  });

  it.each([
    ['a mark it does not know', 'reviews:mark', { reviewId: REVIEW, findingId: 'T1.1', mark: 'maybe' }],
    ['a finding id that is not one', 'reviews:mark', { reviewId: REVIEW, findingId: 'T6.1', mark: 'accepted' }],
    ['a tier past five', 'reviews:mark', { reviewId: REVIEW, tier: 6, mark: 'accepted' }],
    ['a note of 2,001 units', 'reviews:note', { reviewId: REVIEW, findingId: 'T1.1', note: 'x'.repeat(REVIEW_BOUNDS.note + 1) }],
    ['a close it does not know', 'reviews:close', { reviewId: REVIEW, as: 'hide' }],
    ['a start with no revision', 'reviews:start', { sessionId: SESSION, planId: PLAN, version: 1, preset: PRESET }],
    ['a start with no preset', 'reviews:start', { sessionId: SESSION, planId: PLAN, version: 1, revision: 4 }],
    ['an integration into a new session with no preset', 'reviews:integrate', { reviewId: REVIEW, target: 'new' }],
    ['a target that is a path', 'reviews:integrate', { reviewId: REVIEW, target: { path: 'C:\\x' } }],
    ['a place whose end is before its start', 'reviews:explain', { reviewId: REVIEW, findingId: 'T1.1', place: { range: { start: 9, end: 1 }, digest: '0123abcd' } }],
    ['a read naming two things', 'reviews:read', { reviewId: REVIEW, planId: PLAN }],
    ['a review id that is not one', 'reviews:send', { reviewId: '../escape' }],
  ] as const)('refuses %s', async (_name, channel, request) => {
    const { ask } = world();
    expect((await ask(channel, request)).ok).toBe(false);
  });

  it('takes a note of 2,000 units, and an empty one, which removes it', async () => {
    const { ask, made } = world();
    expect((await ask('reviews:note', { reviewId: REVIEW, findingId: 'T1.1', note: 'x'.repeat(REVIEW_BOUNDS.note) })).ok).toBe(true);
    expect((await ask('reviews:note', { reviewId: REVIEW, findingId: 'T1.1', note: '' })).ok).toBe(true);
    expect(made.reviews.note).toHaveBeenCalledTimes(2);
  });
});
