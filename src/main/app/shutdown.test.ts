// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShutdown, QUIT_DEADLINE_MS, quitSteps } from './shutdown';
afterEach(() => vi.useRealTimers());
it('waits for cleanup and resumes quit once; repeat before-quit passes through', async () => {
  let finish!: (r: { ok: boolean }) => void;
  const deps = { beginQuit: vi.fn(), closeAdmission: vi.fn(), killAll: vi.fn(() => new Promise<{ ok: boolean }>((r) => { finish = r; })), emergency: vi.fn(() => ({ ok: true })), resumeQuit: vi.fn(), failure: vi.fn() };
  const shutdown = createShutdown(deps);
  expect(shutdown.readyToQuit).toBe(false);
  const event = { preventDefault: vi.fn() }; shutdown.beforeQuit(event); shutdown.beforeQuit(event);
  expect(shutdown.quitting).toBe(true); expect(deps.resumeQuit).not.toHaveBeenCalled();
  expect(shutdown.readyToQuit).toBe(false);
  await vi.waitFor(() => expect(deps.killAll).toHaveBeenCalledTimes(1));
  finish({ ok: true }); await shutdown.cleanup(); await Promise.resolve(); expect(deps.resumeQuit).toHaveBeenCalledTimes(1);
  expect(shutdown.readyToQuit).toBe(true);
  shutdown.beforeQuit(event); expect(event.preventDefault).toHaveBeenCalledTimes(2);
});
// M14 (V21; C75, C105) and M15 (V40; C117, C118): the sessions settle in the drain, before any tree is asked to end.
const base = () => ({ beginQuit: vi.fn(), closeAdmission: vi.fn(), killAll: vi.fn(() => Promise.resolve({ ok: true })), emergency: vi.fn(() => ({ ok: true })), resumeQuit: vi.fn(), failure: vi.fn() });
it('lets the sessions settle first, then ends the processes, then resumes the quit', async () => {
  let written!: () => void;
  const deps = { ...base(), settle: vi.fn(() => new Promise<void>((resolve) => { written = resolve; })) };
  const shutdown = createShutdown(deps); shutdown.beforeQuit({ preventDefault() {} });
  await Promise.resolve(); await Promise.resolve();
  expect(deps.settle).toHaveBeenCalledTimes(1); expect(deps.killAll).not.toHaveBeenCalled(); expect(deps.resumeQuit).not.toHaveBeenCalled();
  written(); await shutdown.cleanup(); await Promise.resolve();
  expect(deps.killAll).toHaveBeenCalledTimes(1);
  expect(deps.resumeQuit).toHaveBeenCalledTimes(1); expect(deps.failure).not.toHaveBeenCalled();
});
it('asks the trees to end at the settling’s bound, whatever it is still doing', async () => {
  vi.useFakeTimers(); const deps = { ...base(), settle: () => new Promise<void>(() => {}), settleMs: 50, deadlineMs: 100 };
  const shutdown = createShutdown(deps); shutdown.beforeQuit({ preventDefault() {} });
  await vi.advanceTimersByTimeAsync(49); expect(deps.killAll).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(deps.killAll).toHaveBeenCalledTimes(1);
  expect(await shutdown.cleanup()).toEqual({ ok: true }); expect(deps.failure).not.toHaveBeenCalled();
});
it('does not hold the quit, nor count as a failed cleanup, when that write fails', async () => {
  const deps = { ...base(), settle: vi.fn(() => Promise.reject(new Error('EIO'))) };
  const shutdown = createShutdown(deps); shutdown.beforeQuit({ preventDefault() {} });
  expect(await shutdown.cleanup()).toEqual({ ok: true }); await Promise.resolve();
  expect(deps.resumeQuit).toHaveBeenCalledTimes(1); expect(deps.failure).not.toHaveBeenCalled();
});
it('resumes at the deadline when that write never lands', async () => {
  vi.useFakeTimers(); const deps = { ...base(), settle: () => new Promise<void>(() => {}), killAll: () => new Promise<{ ok: boolean }>(() => {}), deadlineMs: 100 };
  const shutdown = createShutdown(deps); shutdown.beforeQuit({ preventDefault() {} }); await vi.advanceTimersByTimeAsync(99);
  expect(deps.resumeQuit).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(1);
  expect(deps.resumeQuit).toHaveBeenCalledTimes(1);
});
it('writes nothing on the emergency path: a logoff leaves the records as they are', () => {
  const deps = { ...base(), settle: vi.fn(() => Promise.resolve()) };
  createShutdown(deps).emergency();
  expect(deps.settle).not.toHaveBeenCalled(); expect(deps.emergency).toHaveBeenCalledTimes(1);
});

// M15 (V40, V48, V52; C117, C118): the app's quit, step by step, as index.ts hands it to createShutdown.
describe('quitSteps', () => {
  function parts(overrides: { stopAll?: () => Promise<void>; endRunningTurns?: () => Promise<void> } = {}) {
    const order: string[] = [];
    const made = {
      order,
      providers: { quiesce: vi.fn(() => { order.push('quiesce'); }), dispose: vi.fn(() => { order.push('dispose'); return Promise.resolve(); }) },
      runtime: { stopAll: vi.fn((ms?: number) => { order.push(`stopAll ${ms}`); return overrides.stopAll?.() ?? Promise.resolve(); }) },
      sessions: { endRunningTurns: vi.fn((ms?: number) => { order.push(`endRunningTurns ${ms}`); return overrides.endRunningTurns?.() ?? Promise.resolve(); }) },
      processes: { closeAdmission: vi.fn(() => { order.push('closeAdmission'); }), killAll: vi.fn(() => { order.push('killAll'); return Promise.resolve({ ok: true }); }), emergency: vi.fn(() => { order.push('emergency'); return { ok: true }; }) },
      demo: { stop: vi.fn(() => { order.push('demo.stop'); }) },
      windows: { beginQuit: vi.fn(() => { order.push('windows.beginQuit'); }) },
      beforeQuit: vi.fn(() => { order.push('lifecycle removed'); }),
      resumeQuit: vi.fn(() => { order.push('resumeQuit'); }),
      failure: vi.fn(),
    };
    return { ...made, demo: () => made.demo, demoSource: made.demo };
  }

  it('runs the steps in their order, each with its time, and resumes the quit at the end', async () => {
    const p = parts();
    const shutdown = createShutdown(quitSteps(p));
    shutdown.beforeQuit({ preventDefault() {} });
    expect(await shutdown.cleanup()).toEqual({ ok: true });
    await Promise.resolve();
    expect(p.order).toEqual(['lifecycle removed', 'quiesce', 'demo.stop', 'windows.beginQuit', 'closeAdmission', 'stopAll 5000', 'endRunningTurns 2000', 'dispose', 'killAll', 'resumeQuit']);
    expect(p.failure).not.toHaveBeenCalled();
  });

  it('has a deadline of twelve seconds, the sum of its steps', () => {
    expect(QUIT_DEADLINE_MS).toBe(12_000);
    expect(quitSteps(parts()).deadlineMs).toBe(12_000);
  });

  it('ends no runtime and no process before the sessions have settled', async () => {
    let stopped!: () => void;
    const p = parts({ stopAll: () => new Promise<void>((resolve) => { stopped = resolve; }) });
    const shutdown = createShutdown(quitSteps(p));
    shutdown.beforeQuit({ preventDefault() {} });
    await Promise.resolve(); await Promise.resolve();
    expect(p.providers.dispose).not.toHaveBeenCalled();
    expect(p.processes.killAll).not.toHaveBeenCalled();
    expect(p.sessions.endRunningTurns).not.toHaveBeenCalled();
    stopped();
    await shutdown.cleanup();
    expect(p.order.slice(-4)).toEqual(['endRunningTurns 2000', 'dispose', 'killAll', 'resumeQuit']);
  });

  it('writes the turns still running even when the Stops fail, and ends the trees when the writes fail', async () => {
    const p = parts({ stopAll: () => Promise.reject(new Error('stop')), endRunningTurns: () => Promise.reject(new Error('EIO')) });
    const shutdown = createShutdown(quitSteps(p));
    shutdown.beforeQuit({ preventDefault() {} });
    expect(await shutdown.cleanup()).toEqual({ ok: true });
    expect(p.order).toContain('endRunningTurns 2000');
    expect(p.order).toContain('killAll');
  });

  it('asks the trees to end once the steps’ own times are spent, though a step does not answer', async () => {
    vi.useFakeTimers();
    const p = parts({ stopAll: () => new Promise<void>(() => {}) });
    const shutdown = createShutdown(quitSteps({ ...p, waits: { stopMs: 100, writeMs: 50, killMs: 100 } }));
    shutdown.beforeQuit({ preventDefault() {} });
    await vi.advanceTimersByTimeAsync(649);
    expect(p.processes.killAll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(p.processes.killAll).toHaveBeenCalledOnce();
    expect(p.providers.dispose).toHaveBeenCalledOnce();
  });

  it('stops nothing gracefully on the emergency path', () => {
    const p = parts();
    createShutdown(quitSteps(p)).emergency();
    expect(p.order).toEqual(['lifecycle removed', 'quiesce', 'demo.stop', 'windows.beginQuit', 'closeAdmission', 'emergency']);
  });

  // M18 (V21; C45): the conversation store is closed in the quit's last step, once the runtimes are disposed.
  it('closes the conversation store once the runtimes have answered, and not before', async () => {
    const p = parts();
    let disposed!: () => void;
    p.providers.dispose.mockImplementation(() => { p.order.push('dispose'); return new Promise<void>((resolve) => { disposed = resolve; }); });
    const conversations = { close: vi.fn(() => { p.order.push('close store'); }) };
    const shutdown = createShutdown(quitSteps({ ...p, conversations }));
    shutdown.beforeQuit({ preventDefault() {} });
    await vi.waitFor(() => expect(p.processes.killAll).toHaveBeenCalledTimes(1));
    // A runtime that is still being disposed may still write its turn's end: the store stays open.
    expect(conversations.close).not.toHaveBeenCalled();
    disposed();
    expect(await shutdown.cleanup()).toEqual({ ok: true });
    expect(p.order.slice(-4)).toEqual(['dispose', 'killAll', 'close store', 'resumeQuit']);
    expect(conversations.close).toHaveBeenCalledTimes(1);
  });

  it('finishes returned-image writes before closing their store', async () => {
    const p = parts();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const conversations = { close: vi.fn() };
    const images = { flush: vi.fn(() => pending) };
    const shutdown = createShutdown(quitSteps({ ...p, conversations, images }));
    shutdown.beforeQuit({ preventDefault() {} });
    await vi.waitFor(() => expect(images.flush).toHaveBeenCalledOnce());
    expect(conversations.close).not.toHaveBeenCalled();
    finish();
    await shutdown.cleanup();
    expect(conversations.close).toHaveBeenCalledOnce();
  });

  // M23 (V7; C31): the page's unsent drafts are asked for first, so main holds them when the Stops write every draft.
  it('asks the page for its drafts before the Stops, and bounds the wait with the others', async () => {
    const p = parts();
    const drafts = { flush: vi.fn(() => { p.order.push('drafts'); return Promise.resolve(); }) };
    const steps = quitSteps({ ...p, drafts, waits: { draftsMs: 1000 } });
    expect(steps.deadlineMs).toBe(13_000);
    const shutdown = createShutdown(steps);
    shutdown.beforeQuit({ preventDefault() {} });
    expect(await shutdown.cleanup()).toEqual({ ok: true });
    expect(p.order.slice(p.order.indexOf('closeAdmission'))).toEqual(['closeAdmission', 'drafts', 'stopAll 5000', 'endRunningTurns 2000', 'dispose', 'killAll', 'resumeQuit']);
  });

  it('goes on to the Stops when the drafts’ ask fails', async () => {
    const p = parts();
    const shutdown = createShutdown(quitSteps({ ...p, drafts: { flush: () => Promise.reject(new Error('gone')) } }));
    shutdown.beforeQuit({ preventDefault() {} });
    expect(await shutdown.cleanup()).toEqual({ ok: true });
    expect(p.order).toContain('stopAll 5000');
  });

  it('closes it also when a runtime’s disposal fails, and leaves it to will-quit on the emergency path', async () => {
    const p = parts();
    p.providers.dispose.mockImplementation(() => Promise.reject(new Error('gone')));
    const conversations = { close: vi.fn() };
    const shutdown = createShutdown(quitSteps({ ...p, conversations }));
    shutdown.beforeQuit({ preventDefault() {} });
    expect(await shutdown.cleanup()).toEqual({ ok: true });
    expect(conversations.close).toHaveBeenCalledTimes(1);

    const again = parts();
    const untouched = { close: vi.fn() };
    createShutdown(quitSteps({ ...again, conversations: untouched })).emergency();
    // A logoff runs nothing of the drain: the store is closed where the last write is, or opened next time as after a crash.
    expect(untouched.close).not.toHaveBeenCalled();
  });
});
it('resumes at the deadline with a failure and has one synchronous emergency path', async () => {
  vi.useFakeTimers(); const deps = { beginQuit: vi.fn(), closeAdmission: vi.fn(), killAll: () => new Promise<{ ok: boolean }>(() => {}), emergency: vi.fn(() => ({ ok: true })), resumeQuit: vi.fn(), failure: vi.fn(), deadlineMs: 100 };
  const shutdown = createShutdown(deps); shutdown.beforeQuit({ preventDefault() {} }); await vi.advanceTimersByTimeAsync(100);
  expect(deps.resumeQuit).toHaveBeenCalledTimes(1); expect(deps.failure).toHaveBeenCalledTimes(1); shutdown.emergency(); shutdown.emergency(); expect(deps.emergency).toHaveBeenCalledTimes(1);

});
