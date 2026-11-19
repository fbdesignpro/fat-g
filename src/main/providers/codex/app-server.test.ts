// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/require-await */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessFailure, type ProviderProcesses } from '@shared/provider-kit/process';
import type { ProviderContext } from '@shared/provider-kit/context';
import type { ProviderEvent } from '@shared/provider-kit/provider';
import type { RpcConnection, SupervisedConnection, SupervisorLifecycle, SupervisorOptions, SupervisorState } from '@shared/provider-kit/rpc';
import { createCodexAppServer } from './app-server';

afterEach(() => vi.useRealTimers());

function harness(respond: (method: string, params: unknown, signal: AbortSignal | undefined) => Promise<unknown>) {
  let state: SupervisorState = 'ready';
  let generation = 1;
  let configured: SupervisorOptions | undefined;
  const notifications = new Map<string, Set<(params: unknown) => void>>();
  const lifecycle = new Set<(event: SupervisorLifecycle) => void>();
  const request = vi.fn((method: string, params?: unknown, options?: { signal?: AbortSignal }) => respond(method, params, options?.signal));
  const supervisor: SupervisedConnection = {
    get state() { return state; },
    get generation() { return generation; },
    connect: vi.fn(async () => supervisor),
    restart: vi.fn(async () => supervisor),
    reportUnhealthy: vi.fn(async () => undefined),
    markResponsive: vi.fn(),
    onState(listener) { lifecycle.add(listener); return () => lifecycle.delete(listener); },
    request,
    notify: vi.fn(async () => undefined),
    onNotification(method, listener) {
      let listeners = notifications.get(method);
      if (listeners === undefined) { listeners = new Set(); notifications.set(method, listeners); }
      listeners.add(listener);
      return () => listeners?.delete(listener);
    },
    dispose: vi.fn(async () => ({ ok: true })),
  };
  const processes: ProviderProcesses = {
    resolve: vi.fn(), spawn: vi.fn(), run: vi.fn(),
    supervise: vi.fn((options: SupervisorOptions) => { configured = options; return supervisor; }),
    open: vi.fn(), openProcess: vi.fn(), recheck: vi.fn(async () => ({ ok: true })),
    dispose: vi.fn(async () => ({ ok: true })),
  };
  const context: ProviderContext = { processes, logger: { record: vi.fn() }, probeDirectory: 'C:\\probe' };
  const server = createCodexAppServer(context, { path: 'C:\\codex.exe', kind: 'native' }, '1.2.3');
  return {
    server,
    supervisor,
    request,
    configured: () => configured!,
    notify(method: string, params: unknown) { for (const listener of notifications.get(method) ?? []) listener(params); },
    lifecycle(next: SupervisorState, nextGeneration = generation) {
      state = next;
      generation = nextGeneration;
      for (const listener of lifecycle) listener({ state, generation });
    },
  };
}

const account = { account: { type: 'chatgpt', email: 'user@example.test', planType: 'pro' }, requiresOpenaiAuth: true };
const limits = (usedPercent: number, extra: Record<string, unknown> = {}) => ({
  rateLimitsByLimitId: {
    codex: { limitId: 'codex', primary: { usedPercent, windowDurationMins: 300, resetsAt: 1_578_924_800 }, secondary: null },
    ...extra,
  },
});

describe('Codex app-server adapter', () => {
  it('performs the documented handshake with honest client identity before availability', async () => {
    const h = harness(async () => ({}));
    const order: string[] = [];
    const rpc: RpcConnection = {
      request: vi.fn(async (method: string, params?: unknown) => { order.push(method); expect(params).toEqual({ clientInfo: { name: 'fat_g', title: 'fat-g', version: '1.2.3' } }); return {}; }),
      notify: vi.fn(async (method: string, params?: unknown) => { order.push(method); expect(params).toEqual({}); }),
      onNotification: vi.fn(() => () => undefined),
    };

    await h.configured().handshake(rpc, new AbortController().signal);
    expect(h.configured().largeReplyBytes).toEqual({ 'thread/turns/list': 32 * 1024 * 1024 });
    expect(order).toEqual(['initialize', 'initialized']);
    expect(h.configured()).toMatchObject({
      executable: { path: 'C:\\codex.exe', kind: 'native' }, args: ['app-server'], options: { cwd: 'C:\\probe' },
    });
    await h.server.dispose();
  });

  it('requests the reviewed account shape and maps a full usage read', async () => {
    const h = harness(async (method, params) => {
      if (method === 'account/read') { expect(params).toEqual({ refreshToken: false }); return account; }
      return limits(21);
    });
    const signal = new AbortController().signal;

    await expect(h.server.getAccount(signal)).resolves.toEqual({
      kind: 'account', account: { authKind: 'subscription', email: 'user@example.test', plan: 'pro' },
    });
    await expect(h.server.getUsage(signal)).resolves.toMatchObject({
      kind: 'usage', usage: { windows: [expect.objectContaining({ id: 'codex:primary', usedPercent: 21, kind: 'rolling-5h' })] },
    });
    expect(h.request.mock.calls.map(([method]) => method)).toEqual(['account/read', 'account/rateLimits/read']);
    await h.server.dispose();
  });

  it('retries only the first valid empty response in each connection generation', async () => {
    vi.useFakeTimers();
    const h = harness(async () => ({ rateLimitsByLimitId: {} }));
    const signal = new AbortController().signal;
    const first = h.server.getUsage(signal);
    await vi.advanceTimersByTimeAsync(750);
    await expect(first).resolves.toEqual({ kind: 'empty' });
    await expect(h.server.getUsage(signal)).resolves.toEqual({ kind: 'empty' });
    const usageReads = () => h.request.mock.calls.filter(([method]) => method === 'account/rateLimits/read');
    expect(usageReads()).toHaveLength(3);

    h.lifecycle('ready', 2); // which also asks for the models (M13)
    const afterReconnect = h.server.getUsage(signal);
    await vi.advanceTimersByTimeAsync(750);
    await expect(afterReconnect).resolves.toEqual({ kind: 'empty' });
    expect(usageReads()).toHaveLength(5);
    expect(h.request.mock.calls.map(([method]) => method).filter((method) => method === 'model/list')).toHaveLength(1);
    await h.server.dispose();
  });

  it('lets a newer push overtake an older full reply and preserves other buckets', async () => {
    let complete!: (value: unknown) => void;
    const reply = new Promise<unknown>((resolve) => { complete = resolve; });
    const h = harness(async () => reply);
    const events: unknown[] = [];
    h.server.subscribe((event) => events.push(event));
    const pending = h.server.getUsage(new AbortController().signal);
    await Promise.resolve();

    h.notify('account/rateLimits/updated', {
      rateLimits: { limitId: 'codex', primary: { usedPercent: 55, windowDurationMins: 300 }, secondary: null },
      accountId: 'must-not-leak',
    });
    complete(limits(10, {
      model: { limitId: 'model', limitName: 'Fable', primary: { usedPercent: 30, windowDurationMins: 10_080 } },
    }));

    const result = await pending;
    expect(result).toMatchObject({ kind: 'usage' });
    if (result.kind !== 'usage') return;
    expect(result.usage.windows.map((window) => [window.id, window.usedPercent])).toEqual([
      ['codex:primary', 55], ['model:primary', 30],
    ]);
    expect(JSON.stringify(events)).not.toContain('accountId');
    await h.server.dispose();
  });

  it('invalidates on account changes and clears cache before later pushes', async () => {
    const h = harness(async () => limits(20));
    const events: { type: string; [key: string]: unknown }[] = [];
    h.server.subscribe((event) => events.push(event));
    await h.server.getUsage(new AbortController().signal);
    h.notify('account/updated', { account: { email: 'private@example.test' } });
    h.notify('account/rateLimits/updated', { rateLimits: { limitId: 'model', primary: { usedPercent: 9, windowDurationMins: 10_080 } } });

    expect(events.at(-2)).toEqual({ type: 'invalidate' });
    expect(events.at(-1)).toMatchObject({
      type: 'usage', usage: { windows: [expect.objectContaining({ id: 'model:primary', usedPercent: 9 })] },
    });
    expect(JSON.stringify(events)).not.toContain('private@example.test');
    await h.server.dispose();
  });

  it('reports exactly one unhealthy generation after two consecutive timeouts', async () => {
    const outcomes: unknown[] = [
      new ProcessFailure('timeout'),
      new ProcessFailure('timeout'),
      account,
      new ProcessFailure('timeout'),
      new ProcessFailure('rpc-error', -32000),
      new ProcessFailure('timeout'),
    ];
    const h = harness(async () => {
      const outcome = outcomes.shift();
      if (outcome instanceof Error) throw outcome;
      return outcome;
    });
    const signal = new AbortController().signal;

    await h.server.getAccount(signal);
    expect(h.supervisor.reportUnhealthy).not.toHaveBeenCalled();
    await h.server.getAccount(signal);
    expect(h.supervisor.reportUnhealthy).toHaveBeenCalledExactlyOnceWith(1);
    await h.server.getAccount(signal); // successful response clears the streak
    await h.server.getAccount(signal);
    await h.server.getAccount(signal); // RPC response proves the transport answered
    await h.server.getAccount(signal);
    expect(h.supervisor.reportUnhealthy).toHaveBeenCalledTimes(1);
    expect(h.supervisor.markResponsive).toHaveBeenCalled();
    await h.server.dispose();
  });

  it('distinguishes unsupported methods from transient transport failures', async () => {
    const errors = [new ProcessFailure('rpc-error', -32601), new ProcessFailure('transport-closed')];
    const h = harness(async () => {
      const error = errors.shift();
      if (error === undefined) return {};
      throw error;
    });
    const signal = new AbortController().signal;
    await expect(h.server.getAccount(signal)).resolves.toEqual({ kind: 'not-applicable', reason: 'unsupported-cli-version' });
    await expect(h.server.getUsage(signal)).resolves.toEqual({ kind: 'error', reason: 'temporarily-unavailable' });
    await h.server.dispose();
  });
});

// V7 (M13; S6, C26, C29, C30, C68): the CLI's models, read over the connection the adapter holds.
describe('Codex model reads', () => {
  const PAGE = JSON.parse(readFileSync(path.resolve('tests/fixtures/codex/model-list.json'), 'utf8')) as { data: Record<string, unknown>[]; nextCursor: null };
  const modelCalls = (h: ReturnType<typeof harness>) => h.request.mock.calls.filter(([method]) => method === 'model/list');
  const reports = (events: ProviderEvent[]) => events.flatMap((event) => (event.type === 'models' ? [event.report] : []));
  const listen = (h: ReturnType<typeof harness>) => {
    const events: ProviderEvent[] = [];
    h.server.subscribe((event) => events.push(event));
    return events;
  };

  it('asks with includeHidden when the connection becomes ready, and sends nine models, two hidden, as one report', async () => {
    const h = harness(async (method) => (method === 'model/list' ? PAGE : {}));
    const events = listen(h);
    h.lifecycle('ready', 2);
    await vi.waitFor(() => expect(reports(events)).toHaveLength(1));
    expect(modelCalls(h).map(([method, params]) => [method, params])).toEqual([['model/list', { includeHidden: true }]]);
    expect(modelCalls(h)[0]?.[2]).toMatchObject({ timeoutMs: 10_000 });
    expect(modelCalls(h)[0]?.[2]?.signal).toBeInstanceOf(AbortSignal);
    const [report] = reports(events);
    expect(report?.models).toHaveLength(9);
    expect(report?.models.filter((model) => model.hidden)).toHaveLength(2);
    expect(JSON.stringify(events)).not.toMatch(/upgradeInfo|inputModalities/);
    await h.server.dispose();
  });

  it('asks again after the CLI says the account changed', async () => {
    const h = harness(async (method) => (method === 'model/list' ? PAGE : {}));
    const events = listen(h);
    h.notify('account/updated', {});
    await vi.waitFor(() => expect(reports(events)).toHaveLength(1));
    expect(events.map((event) => event.type)).toEqual(['invalidate', 'models']);
    await h.server.dispose();
  });

  it('follows each next cursor, and stops at the tenth page', async () => {
    let page = 0;
    const h = harness(async (method) => {
      if (method !== 'model/list') return {};
      page += 1;
      return { data: [{ ...PAGE.data[0], id: `m${page}`, model: `m${page}` }], nextCursor: `c${page}` };
    });
    const events = listen(h);
    await h.server.reportModels();
    expect(modelCalls(h).map(([, params]) => params)).toEqual([
      { includeHidden: true },
      ...Array.from({ length: 9 }, (_, index) => ({ includeHidden: true, cursor: `c${index + 1}` })),
    ]);
    expect(reports(events)[0]?.models).toHaveLength(10);
    await h.server.dispose();
  });

  it('reads one at a time: triggers meanwhile cause one more read afterwards, and an ask joins the read under way', async () => {
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const h = harness(async (method) => {
      if (method !== 'model/list') return {};
      calls += 1;
      if (calls === 1) await first;
      return PAGE;
    });
    listen(h);
    h.lifecycle('ready', 2);
    const joined = h.server.reportModels();
    h.notify('account/updated', {});
    h.lifecycle('ready', 2);
    expect(modelCalls(h)).toHaveLength(1);
    release();
    await joined;
    expect(modelCalls(h)).toHaveLength(2);
    await h.server.dispose();
  });

  it.each([
    ['an unsupported method', new ProcessFailure('rpc-error', -32601)],
    ['a timeout', new ProcessFailure('timeout')],
    ['a closed transport', new ProcessFailure('transport-closed')],
  ])('sends nothing after %s, and leaves account, usage and the restart count as they were (C30)', async (_name, failure) => {
    const h = harness(async (method) => {
      if (method === 'model/list') throw failure;
      if (method === 'account/read') return account;
      return limits(21);
    });
    const events = listen(h);
    await h.server.reportModels();
    await h.server.reportModels();
    expect(reports(events)).toEqual([]);
    await expect(h.server.getAccount(new AbortController().signal)).resolves.toMatchObject({ kind: 'account' });
    await expect(h.server.getUsage(new AbortController().signal)).resolves.toMatchObject({ kind: 'usage' });
    expect(h.supervisor.reportUnhealthy).not.toHaveBeenCalled();
    expect(h.supervisor.markResponsive).toHaveBeenCalled(); // the ordinary reads still count
    await h.server.dispose();
  });

  it('two slow model reads never restart the connection, while two slow ordinary reads do', async () => {
    const h = harness(async () => { throw new ProcessFailure('timeout'); });
    await h.server.reportModels();
    await h.server.reportModels();
    expect(h.supervisor.reportUnhealthy).not.toHaveBeenCalled();
    await h.server.getAccount(new AbortController().signal);
    expect(h.supervisor.reportUnhealthy).not.toHaveBeenCalled();
    await h.server.getAccount(new AbortController().signal);
    expect(h.supervisor.reportUnhealthy).toHaveBeenCalledOnce();
    await h.server.dispose();
  });

  it.each([['not a list', { data: 'none' }], ['no data at all', {}], ['a list with no readable row', { data: [{ id: 'bad id' }] }]])('sends nothing for a reply that is %s (C15)', async (_name, reply) => {
    const h = harness(async () => reply);
    const events = listen(h);
    await h.server.reportModels();
    expect(reports(events)).toEqual([]);
    await h.server.dispose();
  });

  it.each(['idle', 'circuit-open', 'backoff', 'starting'] as const)('launches nothing and sends nothing while the connection is %s (S6)', async (state) => {
    const h = harness(async () => PAGE);
    h.lifecycle(state);
    await h.server.reportModels();
    expect(h.request).not.toHaveBeenCalled();
    expect(h.supervisor.connect).not.toHaveBeenCalled();
    await h.server.dispose();
  });

  it('abandons a read when the connection is replaced between pages', async () => {
    let replaced = false;
    const h = harness(async (method) => {
      if (method !== 'model/list') return {};
      if (!replaced) {
        replaced = true;
        h.lifecycle('ready', 7); // a new connection answered while the first page was on its way
        return { data: PAGE.data, nextCursor: 'next' };
      }
      return PAGE;
    });
    const events = listen(h);
    await h.server.reportModels();
    await vi.waitFor(() => expect(reports(events)).toHaveLength(1));
    // The first read stopped; only the read the new connection started reports.
    expect(modelCalls(h).filter(([, params]) => (params as { cursor?: string }).cursor === 'next')).toEqual([]);
    await h.server.dispose();
  });

  it('asks nothing once disposed', async () => {
    const h = harness(async () => PAGE);
    await h.server.dispose();
    h.lifecycle('ready', 2);
    await h.server.reportModels();
    expect(h.request).not.toHaveBeenCalled();
  });
});
