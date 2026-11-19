// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M15 spike (C97, C102, C123; Design 1): the saved thread's turns read back, with the two paged
// reads, before and after a resume, at page sizes 1 and 2 and at each item view. No turn is spent.
//
//   node spikes/m15/history.mjs [--confirm-turns 0]
//
// It answers: which read returns both the user's and the assistant's messages, and whether it needs
// a resumed thread (C57); whether a cursor from a page read without items continues a read with
// items (C102); and whether an item's id in a history read is the id its live frame carried (C123).
// Run after `resume.mjs --scenario saved` and `--scenario resume`, which leave the thread and the
// ids its live frames carried.
import { isMain } from '../m10/lib/paths.mjs';
import { runSpike } from '../m10/lib/spike.mjs';
import { FAMILY } from './resume.mjs';
import { SANDBOX, happened, notRun, readState, runScenario } from './lib/common.mjs';

const VIEWS = ['full', 'summary', 'notLoaded'];

const errorOf = (reply) => ({ code: reply.error?.code ?? null, hasMessage: typeof reply.error?.message === 'string' });

/** What a page of turns holds, without its text. */
function describeTurns(reply) {
  if (!reply.ok) return { ok: false, error: errorOf(reply) };
  const data = Array.isArray(reply.value?.data) ? reply.value.data : [];
  return {
    ok: true, turns: data.length, bytes: Buffer.byteLength(JSON.stringify(reply.value)),
    nextCursor: typeof reply.value?.nextCursor === 'string', backwardsCursor: typeof reply.value?.backwardsCursor === 'string',
    perTurn: data.map((turn) => ({ status: turn.status ?? null, itemsView: turn.itemsView ?? null, items: (turn.items ?? []).map((item) => (item.type === 'agentMessage' ? `agentMessage:${item.phase ?? '?'}` : item.type)) })),
  };
}

function describeItems(reply) {
  if (!reply.ok) return { ok: false, error: errorOf(reply) };
  const data = Array.isArray(reply.value?.data) ? reply.value.data : [];
  return { ok: true, items: data.map((entry) => (entry.item?.type === 'agentMessage' ? `agentMessage:${entry.item.phase ?? '?'}` : entry.item?.type ?? null)), entryKeys: data[0] ? Object.keys(data[0]).sort() : null, bytes: Buffer.byteLength(JSON.stringify(reply.value)), nextCursor: typeof reply.value?.nextCursor === 'string' };
}

const turnIdsOf = (reply) => (reply.ok ? (reply.value?.data ?? []).map((turn) => turn.id) : []);
const itemsOf = (reply) => (reply.ok ? (reply.value?.data ?? []).flatMap((turn) => (turn.items ?? []).map((item) => ({ ...item, turnId: turn.id }))) : []);

/** Every read this spike makes, on a thread that is or is not resumed in this process. */
async function reads(driver, threadId) {
  const turns = (params) => driver.requestWithin('thread/turns/list', { threadId, ...params }, 30_000);
  const items = (params) => driver.requestWithin('thread/items/list', { threadId, ...params }, 30_000);
  const out = { views: {}, paging: {}, items: {} };
  const full = await turns({ limit: 2, itemsView: 'full' });
  for (const view of VIEWS) out.views[view] = describeTurns(view === 'full' ? full : await turns({ limit: 2, itemsView: view }));
  out.views.defaulted = describeTurns(await turns({ limit: 2 }));
  out.views.ascending = describeTurns(await turns({ limit: 2, itemsView: 'full', sortDirection: 'asc' }));

  // Page size 1, newest first: the second page by the first page's cursor.
  const first = await turns({ limit: 1, itemsView: 'full' });
  const cursor = first.ok ? first.value?.nextCursor ?? null : null;
  const second = cursor ? await turns({ limit: 1, itemsView: 'full', cursor }) : null;
  out.paging.sizeOne = { first: describeTurns(first), second: second ? describeTurns(second) : 'no cursor to follow', distinctTurns: second ? turnIdsOf(first)[0] !== turnIdsOf(second)[0] : null, newestFirst: full.ok && first.ok ? turnIdsOf(first)[0] === turnIdsOf(full)[0] : null };

  // C102: a cursor from a page read without items, given to a read with items.
  const bare = await turns({ limit: 1, itemsView: 'notLoaded' });
  const bareCursor = bare.ok ? bare.value?.nextCursor ?? null : null;
  const after = bareCursor ? await turns({ limit: 1, itemsView: 'full', cursor: bareCursor }) : null;
  out.paging.notLoadedCursor = {
    page: describeTurns(bare), sameCursorAsFullRead: bareCursor !== null && bareCursor === cursor,
    continuedWithItems: after ? describeTurns(after) : 'no cursor to follow',
    continuesToTheOlderTurn: after && second ? turnIdsOf(after)[0] === turnIdsOf(second)[0] : null,
  };

  // thread/items/list: across the thread, in pages of 2, then one turn's alone.
  const pages = [];
  let itemCursor = null;
  for (let page = 0; page < 12; page++) {
    const reply = await items({ limit: 2, ...(itemCursor ? { cursor: itemCursor } : {}) });
    pages.push(describeItems(reply));
    itemCursor = reply.ok ? reply.value?.nextCursor ?? null : null;
    if (!itemCursor) break;
  }
  out.items.pagesOfTwo = pages;
  const newest = turnIdsOf(full)[0];
  out.items.oneTurn = newest ? describeItems(await items({ turnId: newest, limit: 50 })) : 'no turn to ask for';
  out.items.descending = describeItems(await items({ limit: 3, sortDirection: 'desc' }));

  // The app's own reads (M15, Design 12; C95, C102, C134), so the replay fake answers each from a
  // captured frame: pages of 8, 4, 2 and 1 turns with every item, newest first; one turn as a
  // summary; one turn without items; and each of the three again from the cursor past the newest turn.
  const app = {};
  for (const limit of [8, 4]) app[`full-${limit}`] = describeTurns(await turns({ limit, itemsView: 'full' }));
  const summaryOne = await turns({ limit: 1, itemsView: 'summary' });
  app['summary-1'] = describeTurns(summaryOne);
  app['summary-cursor-same'] = summaryOne.ok ? (summaryOne.value?.nextCursor ?? null) === cursor : null;
  if (cursor) {
    app['full-8-after-cursor'] = describeTurns(await turns({ limit: 8, itemsView: 'full', cursor }));
    app['summary-1-after-cursor'] = describeTurns(await turns({ limit: 1, itemsView: 'summary', cursor }));
    app['notLoaded-1-after-cursor'] = describeTurns(await turns({ limit: 1, itemsView: 'notLoaded', cursor }));
  }
  out.appReads = app;
  return { out, full };
}

const HISTORY = {
  id: 'm15-history', name: 'm15-history', family: FAMILY, turns: 0,
  title: "The saved thread's turns read back, before and after a resume",
  successCondition: 'A paged read returned the turns of the saved thread with their items',
  async run(ctx) {
    const state = readState();
    if (!state.savedThreadId || !Array.isArray(state.turns) || state.turns.length < 2) return notRun('the saved thread needs two turns: run resume.mjs --scenario saved, then --scenario resume');
    const driver = await ctx.open();
    driver.sessionIds = [state.savedThreadId];
    driver.threadId = state.savedThreadId;
    const before = await reads(driver, state.savedThreadId);
    const resumeParams = { threadId: state.savedThreadId, cwd: ctx.scratch, ...SANDBOX, excludeTurns: true };
    const resumed = await driver.resumeThread(resumeParams);
    driver.sessionStart = { request: resumeParams, replyIndex: resumed.index, ok: resumed.ok, check: null };
    const afterResume = resumed.ok ? await reads(driver, state.savedThreadId) : null;

    // C123: each live item's id beside the id the history read gives it.
    const source = before.full.ok ? before.full : afterResume?.full ?? before.full;
    const history = itemsOf(source);
    const liveTurnIds = state.turns.map((turn) => turn.turnId);
    const historyTurnIds = turnIdsOf(source);
    const compare = state.turns.flatMap((turn) => turn.items.filter((item) => item.type === 'userMessage' || item.type === 'agentMessage').map((item) => {
      const same = history.find((h) => h.id === item.id);
      return { type: item.type, phase: item.phase, sameIdInHistory: Boolean(same), sameTypeThere: same ? same.type === item.type : null, clientIdKept: item.type === 'userMessage' && same ? same.clientId === turn.clientUserMessageId : null };
    }));
    const notes = {
      withoutAResume: before.out,
      resume: resumed.ok ? { ok: true } : { ok: false, error: errorOf(resumed) },
      afterAResume: afterResume?.out ?? 'the resume was refused',
      ids: {
        turnIdsMatchLive: liveTurnIds.length > 0 && liveTurnIds.every((id) => historyTurnIds.includes(id)),
        items: compare, everyMessageIdMatches: compare.length > 0 && compare.every((row) => row.sameIdInHistory),
        historyItemTypes: [...new Set(history.map((item) => item.type))].sort(),
        userMessageKeys: Object.keys(history.find((item) => item.type === 'userMessage') ?? {}).sort(),
        agentMessageKeys: Object.keys(history.find((item) => item.type === 'agentMessage') ?? {}).sort(),
      },
    };
    const readable = before.full.ok || Boolean(afterResume?.full.ok);
    return readable ? happened(notes) : { outcome: 'did-not-happen', successIndex: null, notes: { why: 'no paged read returned the turns', ...notes } };
  },
};

if (isMain(import.meta.url)) await runSpike('m15-history', (frame) => runScenario('m15-history', HISTORY, frame));
