// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V4, V6 (docs/planning/_archive/M22b.md, Design 6; C20, C62, C64, C72, C73, C75): the plans' seven channels,
// through the real contract — the sender policy, the strict requests, and the handlers on a plan
// service, a plan store, a runtime and a workflow coordinator in the test's hands (decision 0029).
import { describe, expect, it, vi } from 'vitest';
import { MAX_FEEDBACK_TEXT, MAX_PLAN_READ } from '@shared/contracts/plans';
import { INVOKE_SPECS } from '@shared/ipc/contract';
import { resolveTrustedOrigins } from '../../app/origins';
import { dispatchInvoke, type DispatchDeps, type Handler } from '../dispatch';
import { createKindCounts } from './counts';
import { planHandlers, type PlanHandlerDeps } from './plans';

const SESSION = '5e551000-0000-4000-8000-000000000001';
const PLAN = 'a1b2c3d4-0000-4000-8000-000000000001';
const OTHER = 'a1b2c3d4-0000-4000-8000-000000000002';
const PROJECT = '3f0c5c2e-8d4a-4b8e-9a51-2f7d1c0e6b19';
const HASH = 'f'.repeat(64);
const CHANNELS = ['plans:read', 'plans:list', 'plans:remove', 'plans:decide', 'plans:bring', 'plans:storage', 'plans:workflow'] as const;
const log = { warn: vi.fn(), error: vi.fn() };
const deps = (): DispatchDeps => ({ origins: resolveTrustedOrigins({ isPackaged: true, devServerUrl: undefined }), log, detail: 'kinds' });
const from = (kind: 'main' | 'pet', request: unknown) => ({ windowKind: kind, sender: { frameUrl: `app://fatg/${kind === 'main' ? 'index' : 'pet'}.html`, isTopFrame: true }, request });

function world(patch: { writing?: readonly string[]; listed?: ReadonlySet<string> | null; readable?: boolean } = {}) {
  const did: string[] = [];
  const counts = createKindCounts();
  const made: PlanHandlerDeps = {
    plans: {
      read: vi.fn(() => ({ status: 'refused' as const, reason: 'unknown-plan' as const })),
      list: vi.fn(() => []),
      storage: vi.fn(() => ({ count: 2, reviews: 0, bytes: 10, orphans: 0 })),
    },
    store: {
      all: () => [{ id: PLAN }, { id: OTHER }] as never,
      get: (planId) => ([PLAN, OTHER].includes(planId) ? ({ id: planId } as never) : null),
      writing: (planId) => (patch.writing ?? []).includes(planId),
      remove: (planId) => { did.push(`remove ${planId}`); return 'removed'; },
    },
    workflow: {
      decide: vi.fn(() => Promise.resolve({ status: 'decided' as const })),
      forSession: vi.fn(() => ({ kind: 'implemented' as const, sessionId: SESSION, chat: 'Chat 1', at: 5 })),
    },
    listedSession: (sessionId) => sessionId === SESSION,
    runtime: {
      bringPlan: vi.fn(() => Promise.resolve({ status: 'brought' as const, itemId: 'line-1' })),
      settlePlans: vi.fn((planIds: readonly string[]) => { did.push(`settle ${planIds.join(',')}`); return Promise.resolve(1); }),
    },
    listed: () => (patch.listed === undefined ? new Set([PROJECT]) : patch.listed),
    conversationsReadable: () => patch.readable !== false,
    counts,
  };
  const ask = (channel: (typeof CHANNELS)[number], request: unknown, kind: 'main' | 'pet' = 'main') =>
    dispatchInvoke(channel, INVOKE_SPECS[channel], planHandlers(made)[channel] as Handler<unknown, unknown>, from(kind, request), deps());
  return { made, did, counts, ask };
}

const valid = (channel: (typeof CHANNELS)[number]): unknown => {
  switch (channel) {
    case 'plans:read': return { planId: PLAN, version: 1, start: 0, length: MAX_PLAN_READ };
    case 'plans:list': return { projectId: PROJECT };
    case 'plans:remove': return { planId: PLAN };
    case 'plans:decide': return { sessionId: SESSION, planId: PLAN, revision: 3, decision: 'execute' };
    case 'plans:bring': return { sessionId: SESSION, planId: PLAN, version: 1, hash: HASH };
    case 'plans:storage': return null;
    case 'plans:workflow': return { sessionId: SESSION };
  }
};

describe('the plans’ channels (C20, C75)', () => {
  it.each(CHANNELS)('refuses %s from the Pet, which shows on screen shares', async (channel) => {
    const { ask } = world();
    expect(await ask(channel, valid(channel), 'pet')).toEqual({ ok: false, error: 'forbidden' });
  });

  it('hands a decision to the workflow, naming the plan and the revision it was drawn from, and a plan to bring with the hash the list showed', async () => {
    const { ask, made } = world();
    expect(await ask('plans:decide', { sessionId: SESSION, planId: PLAN, revision: 3, decision: 'feedback', text: 'Shorter.' })).toEqual({ ok: true, value: { status: 'decided' } });
    expect(made.workflow.decide).toHaveBeenCalledExactlyOnceWith({ sessionId: SESSION, planId: PLAN, revision: 3, decision: 'feedback', text: 'Shorter.' });
    expect(await ask('plans:decide', { sessionId: SESSION, planId: PLAN, revision: 3, decision: 'leave' })).toEqual({ ok: true, value: { status: 'decided' } });
    expect(made.workflow.decide).toHaveBeenLastCalledWith({ sessionId: SESSION, planId: PLAN, revision: 3, decision: 'leave' });
    expect(await ask('plans:bring', valid('plans:bring'))).toEqual({ ok: true, value: { status: 'brought', itemId: 'line-1' } });
    expect(made.runtime.bringPlan).toHaveBeenCalledExactlyOnceWith(SESSION, { planId: PLAN, version: 1, hash: HASH });
  });

  it.each([
    ['feedback with no text', { sessionId: SESSION, planId: PLAN, revision: 3, decision: 'feedback' }],
    ['feedback of whitespace', { sessionId: SESSION, planId: PLAN, revision: 3, decision: 'feedback', text: '  \n' }],
    ['feedback past its bound', { sessionId: SESSION, planId: PLAN, revision: 3, decision: 'feedback', text: 'x'.repeat(MAX_FEEDBACK_TEXT + 1) }],
    ['a text with Execute', { sessionId: SESSION, planId: PLAN, revision: 3, decision: 'execute', text: 'x' }],
    ['a decision it does not know', { sessionId: SESSION, planId: PLAN, revision: 3, decision: 'review' }],
    ['a decision with no revision', { sessionId: SESSION, planId: PLAN, decision: 'execute' }],
    ['a decision naming a line, as before the shared workflow', { sessionId: SESSION, itemId: 'line-1', decision: 'execute' }],
  ])('refuses %s', async (_name, request) => {
    const { ask, made } = world();
    expect((await ask('plans:decide', request)).ok).toBe(false);
    expect(made.workflow.decide).not.toHaveBeenCalled();
  });

  it('reads a listed chat’s part in its plan’s workflow, and refuses one that is not listed', async () => {
    const { ask, made, counts } = world();
    expect(await ask('plans:workflow', { sessionId: SESSION })).toEqual({ ok: true, value: { status: 'read', workflow: { kind: 'implemented', sessionId: SESSION, chat: 'Chat 1', at: 5 } } });
    expect(made.workflow.forSession).toHaveBeenCalledExactlyOnceWith(SESSION);
    expect(await ask('plans:workflow', { sessionId: '5e551000-0000-4000-8000-000000000009' })).toEqual({ ok: true, value: { status: 'refused', reason: 'unknown-session' } });
    expect(counts.snapshot()).toEqual({ 'workflow:read': 1, 'workflow:refused:unknown-session': 1 });
  });

  it('refuses a read past its range’s bound, and a plan id that is not one', async () => {
    const { ask, made } = world();
    expect((await ask('plans:read', { planId: PLAN, start: 0, length: MAX_PLAN_READ + 1 })).ok).toBe(false);
    expect((await ask('plans:read', { planId: '../escape', start: 0, length: 10 })).ok).toBe(false);
    expect(made.plans.read).not.toHaveBeenCalled();
  });

  it('answers the Storage row from the projects the records list, or none where they cannot be read', async () => {
    const { ask, made } = world({ listed: null });
    expect(await ask('plans:storage', null)).toEqual({ ok: true, value: { count: 2, reviews: 0, bytes: 10, orphans: 0 } });
    expect(made.plans.storage).toHaveBeenCalledExactlyOnceWith(null);
  });
});

describe('a removal (C62, C73)', () => {
  it('settles every decision that waits on the plan first, then removes it', async () => {
    const { ask, did } = world();
    expect(await ask('plans:remove', { planId: PLAN })).toEqual({ ok: true, value: { status: 'removed', removed: 1, settled: 1 } });
    expect(did).toEqual([`settle ${PLAN}`, `remove ${PLAN}`]);
  });

  it('removes every plan for Remove all, after settling what waits on any of them', async () => {
    const { ask, did } = world();
    expect(await ask('plans:remove', { all: true })).toEqual({ ok: true, value: { status: 'removed', removed: 2, settled: 1 } });
    expect(did).toEqual([`settle ${PLAN},${OTHER}`, `remove ${PLAN}`, `remove ${OTHER}`]);
  });

  it('settles and removes nothing for an unknown plan, one being written, or while a store cannot be read', async () => {
    for (const [patch, request, reason] of [
      [{}, { planId: 'b0000000-0000-4000-8000-000000000009' }, 'unknown-plan'],
      [{ writing: [OTHER] }, { all: true }, 'writing'],
      [{ listed: null }, { planId: PLAN }, 'records-refused'],
      [{ readable: false }, { planId: PLAN }, 'conversations-refused'],
    ] as const) {
      const { ask, did, counts } = world(patch);
      expect(await ask('plans:remove', request)).toEqual({ ok: true, value: { status: 'refused', reason } });
      expect(did).toEqual([]);
      // Counted by its kind alone (C75).
      expect(Object.keys(counts.snapshot())).toEqual([`remove:refused:${reason}`]);
    }
  });
});
