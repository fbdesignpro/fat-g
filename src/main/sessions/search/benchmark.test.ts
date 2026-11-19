// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { expect, it } from 'vitest';
import { DEFAULT_SEARCH_FILTERS } from '@shared/contracts/session-search';
import { sessionEntry } from '../../../../tests/support/sessions';
import type { SearchMessage } from '../../conversations/search';
import { createSessionSearch } from './service';

/** Opt-in synthetic workload: FATG_SEARCH_BENCHMARK=1 npx vitest run <this file>. */
it.skipIf(process.env['FATG_SEARCH_BENCHMARK'] !== '1')('measures 10,000 messages and 50 MiB without reading personal data', async () => {
  const sessions = Array.from({ length: 1000 }, (_, at) => sessionEntry(`Archive ${at}`));
  const vocabulary = Array.from({ length: 4096 }, (_, at) => `term${at.toString(36).padStart(3, '0')}`);
  const messages: SearchMessage[] = Array.from({ length: 10_000 }, (_, at) => ({
    id: `message-${at}`, sessionId: sessions[Math.floor(at / 10)]!.record.id, role: at % 2 === 0 ? 'user' : 'assistant',
    text: `${at === 400 ? 'distinctive avatar rendering ' : ''}${Array.from({ length: 656 }, (_, word) => vocabulary[(at * 13 + word * 7) % vocabulary.length]).join(' ')}`,
  }));
  const before = process.memoryUsage().heapUsed;
  let yields = 0;
  let lastYield = performance.now();
  let longestBatchMs = 0;
  const service = createSessionSearch({
    sessions: () => sessions,
    records: { isRefused: () => false, subscribe: () => () => undefined },
    conversations: {
      status: () => ({ kind: 'ok' }), subscribeSearch: () => () => undefined,
      searchMessages: (after) => ({ messages: messages.slice(after, after + 48), next: after >= messages.length ? null : after + 48 }),
      searchMessage: (id) => messages[Number(id.slice('message-'.length))] ?? null,
    },
    yield: () => {
      yields += 1;
      longestBatchMs = Math.max(longestBatchMs, performance.now() - lastYield);
      return new Promise((resolve) => setImmediate(() => { lastYield = performance.now(); resolve(); }));
    },
  });
  try {
    const request = { ...DEFAULT_SEARCH_FILTERS, query: 'distintive avatr render', offset: 0 };
    const started = performance.now();
    let result = await service.search(request);
    while (result.status === 'indexing') {
      await new Promise((resolve) => setTimeout(resolve, 25));
      result = await service.search(request);
    }
    const coldMs = performance.now() - started;
    expect(result.total).toBe(1);
    const warm: number[] = [];
    for (let run = 0; run < 10; run += 1) {
      const at = performance.now();
      expect((await service.search(request)).total).toBe(1);
      warm.push(performance.now() - at);
    }
    const commonAt = performance.now();
    const common = await service.search({ ...request, query: 'term' });
    const commonMs = performance.now() - commonAt;
    expect(common.total).toBe(1000);
    const uncachedAt = performance.now();
    expect((await service.search({ ...request, query: 'distinctive avatar' })).total).toBe(1);
    const uncachedMs = performance.now() - uncachedAt;
    expect(yields).toBeGreaterThan(200);
    console.info(JSON.stringify({ messages: messages.length, MiB: Math.round(messages.reduce((sum, message) => sum + message.text.length, 0) / 1024 / 1024), coldMs: Math.round(coldMs), cachedMaxMs: Math.round(Math.max(...warm)), uncachedMs: Math.round(uncachedMs), commonMs: Math.round(commonMs), longestBatchMs: Math.round(longestBatchMs), heapGrowthMiB: Math.round((process.memoryUsage().heapUsed - before) / 1024 / 1024), yields }));
  } finally { service.stop(); }
}, 60_000);
