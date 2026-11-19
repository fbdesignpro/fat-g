// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Publish only allowlisted research facts, never account data, paths, IDs or arbitrary text.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const input = path.join(root, 'spikes/output/chat');
const read = (name) => JSON.parse(readFileSync(path.join(input, name), 'utf8'));
const sha = (name) => createHash('sha256').update(readFileSync(path.join(input, name))).digest('hex');
const inspection = read('inspection.json');
const ledger = read('ledger.json');
const facts = {
  format: 'fat-g.chat-protocol-evidence/1',
  inspectedAt: inspection.at,
  versions: { ...inspection.versions, claudeSdkTypes: '0.3.278 (read only; newer than installed CLI)' },
  platform: 'Windows x64',
  submittedInputs: ledger.runs.reduce((n, r) => n + r.turns, 0),
  schemaHashes: Object.fromEntries(['plain/ClientRequest.json', 'experimental/ClientRequest.json', 'plain/v2/ThreadItemsListResponse.json'].map((p) => [p, sha(p)])),
  runs: [],
};
for (const run of ledger.runs) {
  const report = read(`${run.id}-report.json`);
  const raw = read(`${run.id}-raw.json`);
  const frames = raw.frames.filter((f) => f.dir === 'recv').map((f) => f.frame);
  const entry = {
    run: run.id, cli: run.cli, scenario: run.scenario, inputs: run.turns,
    result: report.result, cleanupConfirmed: report.cleanupConfirmed,
    captureSha256: sha(`${run.id}-raw.json`),
    terminal: report.resultFrames.map((r) => ({ status: r.status ?? r.subtype, durationMs: r.durationMs ?? r.duration_ms, apiDurationMs: r.duration_api_ms })),
  };
  for (const key of ['forkAccepted', 'forkTurns', 'resumeTurnCount', 'historyOk', 'itemPaging', 'steerAccepted', 'midTurnInputWritten', 'secondResult', 'interruptAccepted', 'questionInterruptAccepted', 'questionRoute', 'idleHistoryMessage', 'asyncAnsweredWithNewTurn', 'deleted']) if (key in report) entry[key] = report[key];
  if (run.cli === 'codex') {
    entry.deltaFinalMatches = report.deltaFinalMatches;
    entry.historyItemTypes = [...new Set(report.history?.flatMap((t) => t.items.map((i) => i.type)) ?? [])];
    entry.questionRequests = frames.filter((f) => f.method === 'item/tool/requestUserInput').map((f) => ({ isBlocking: f.params.isBlocking, autoResolutionMs: f.params.autoResolutionMs, count: f.params.questions.length }));
    entry.asyncQuestionItems = frames.filter((f) => f.method === 'item/completed' && f.params.item?.delivery === 'async').length;
    entry.resolvedRequests = frames.filter((f) => f.method === 'serverRequest/resolved').length;
    entry.itemTimestamps = frames.some((f) => f.method === 'item/started' && typeof f.params.startedAtMs === 'number');
    entry.lastUsage = frames.filter((f) => f.method === 'thread/tokenUsage/updated').at(-1)?.params.tokenUsage.last;
    entry.partialDeltaCharacters = frames.filter((f) => f.method === 'item/agentMessage/delta').reduce((n, f) => n + f.params.delta.length, 0);
    entry.completedAssistantItems = frames.filter((f) => f.method === 'item/completed' && f.params.item?.type === 'agentMessage').length;
  } else {
    const texts = new Map(); let messageId;
    for (const f of frames) {
      if (f.type === 'stream_event' && f.event?.type === 'message_start') messageId = f.event.message.id;
      if (f.type === 'stream_event' && f.event?.delta?.type === 'text_delta') texts.set(messageId, (texts.get(messageId) ?? '') + f.event.delta.text);
    }
    const finalTexts = new Map();
    for (const f of frames.filter((f) => f.type === 'assistant')) {
      const text = f.message.content?.filter((b) => b.type === 'text').map((b) => b.text).join('') ?? '';
      if (text) finalTexts.set(f.message.id, (finalTexts.get(f.message.id) ?? '') + text);
    }
    entry.streamTextMatches = [...finalTexts].map(([id, text]) => ({ hasDeltas: texts.has(id), matches: texts.get(id) === text }));
    entry.streamEventKinds = [...new Set(frames.filter((f) => f.type === 'stream_event').map((f) => f.event.type))];
    entry.blockTypes = [...new Set(frames.flatMap((f) => f.message?.content instanceof Array ? f.message.content.map((b) => b.type) : []))];
    entry.assistantTimestamps = frames.filter((f) => f.type === 'assistant').map((f) => typeof f.timestamp === 'string');
    entry.cancelledRequests = frames.filter((f) => f.type === 'control_cancel_request').length;
    entry.resultReasons = frames.filter((f) => f.type === 'result').map((f) => f.terminal_reason ?? null);
    const init = frames.find((f) => f.type === 'control_response')?.response;
    entry.pendingArraysPresent = ['pending_permission_requests', 'pending_user_dialog_requests'].filter((k) => Array.isArray(init?.[k]));
    entry.lastUsage = frames.filter((f) => f.type === 'result').at(-1)?.usage;
    entry.permissionDecisions = report.requests.map((r) => ({ tool: r.tool, answer: r.answer, held: r.held }));
  }
  // Assertions are about controlled fixture output, never publish arbitrary model text.
  const text = report.assistantTexts.join('\n');
  if (run.scenario === 'fork') entry.forkMarkerCheck = { firstPresent: text.includes('FIRST-741'), secondAbsent: !text.includes('SECOND-953') };
  if (run.scenario === 'steer') entry.steeredMarkerPresent = text.includes('STEERED-627');
  if (run.scenario === 'async-answer') entry.answerIsBlue = report.assistantTexts.at(-1)?.trim() === 'Blue';
  facts.runs.push(entry);
}
const target = path.join(root, 'spikes/chat/evidence.json');
writeFileSync(target, `${JSON.stringify(facts, null, 2)}\n`);
console.log(JSON.stringify({ runs: facts.runs.length, inputs: facts.submittedInputs, cleanup: facts.runs.every((r) => r.cleanupConfirmed), target: 'spikes/chat/evidence.json' }));
