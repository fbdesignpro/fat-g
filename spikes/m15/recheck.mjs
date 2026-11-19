// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M15 spike (C1; Design 1): M10's Codex scenarios T1, T3, T4 and T5, run again on the installed CLI
// through `spikes/m10/trace.mjs`, compared here with the captures M10 published. It launches
// nothing and spends nothing: the turns are trace.mjs's, each announced by it.
//
//   node spikes/m10/trace.mjs --cli codex --scenario t1 --again --confirm-turns 1     (and t3, t4, t5)
//   node spikes/m15/recheck.mjs
//
// For each scenario it takes the newest raw capture that happened and the published fixture, and
// compares what the frames are, not what they say: the methods, whose thread each is on, the item
// types with their kinds and phases, the turn's end, and the key names of each. A capture that
// changed is republished with `node spikes/m10/publish.mjs --only <name>`.
//
// It also records, across the new captures, whether a `reasoning` item carries a summary and
// whether `thread/settings/updated` or `model/rerouted` arrives during a turn (C45).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CODEX_TABLE } from '../m10/codex/frames.mjs';
import { FIXTURES_DIR, isMain, outputPath, writeJson } from '../m10/lib/paths.mjs';
import { log } from '../m10/lib/spike.mjs';
import { m15Path } from './lib/common.mjs';

const SCENARIOS = ['t1-basic', 't3-subagent', 't4-interrupt', 't5-error'];

/** Ids differ between a raw capture and a fixture; whose thread a frame is on does not. */
function sessionThread(capture) {
  const index = capture.sessionStart?.replyIndex;
  return capture.frames.find((f) => f.index === index)?.frame?.result?.thread?.id ?? null;
}

/** One word per received frame: what it is, and on whose thread. */
function shapeOf(capture) {
  const session = sessionThread(capture);
  const promptIndex = capture.frames.find((f) => f.dir === 'send' && f.frame?.method === 'turn/start')?.index ?? 0;
  const shapes = [];
  const keys = {};
  const connection = [];
  for (const { dir, index, frame: raw } of capture.frames) {
    // The table's own scrub first, as publishing applies it, so a raw capture and a fixture compare alike.
    const frame = CODEX_TABLE.scrub(raw);
    if (dir !== 'recv' || index < promptIndex || !frame?.method || frame._reduced) continue;
    const params = frame.params ?? {};
    // A notification that names no thread is the connection's (skills, rate limits, remote control):
    // whether one arrives during a turn is the machine's doing, so it is listed apart.
    if (params.threadId === undefined && !params.thread) { connection.push(frame.method); continue; }
    const item = params.item ?? null;
    const who = params.threadId === undefined ? '' : params.threadId === session ? 'session' : 'worker';
    const detail = item ? [item.type, item.kind ?? item.phase ?? item.tool ?? ''].filter(Boolean).join(':') : params.turn?.status ?? params.status?.type ?? '';
    const shape = [frame.method, who, detail].filter(Boolean).join(' ');
    shapes.push(shape);
    const name = item ? `${frame.method} ${item.type}` : frame.method;
    keys[name] = [...new Set([...(keys[name] ?? []), ...Object.keys(item ?? params)])].sort();
  }
  return { shapes, keys, connection: [...new Set(connection)].sort() };
}

function newestRaw(name) {
  const dir = outputPath('raw', 'codex');
  if (!existsSync(dir)) return null;
  const captures = readdirSync(dir).filter((file) => file.startsWith(`${name}.`) && file.endsWith('.json')).map((file) => JSON.parse(readFileSync(path.join(dir, file), 'utf8'))).filter((capture) => capture.run?.outcome === 'happened');
  captures.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return captures[0] ?? null;
}

const diff = (a, b) => ({ onlyNew: [...new Set(a.filter((x) => !b.includes(x)))], onlyPublished: [...new Set(b.filter((x) => !a.includes(x)))] });

function compare(name) {
  const fixtureFile = path.join(FIXTURES_DIR, 'codex', 'captures', `${name}.json`);
  const published = existsSync(fixtureFile) ? JSON.parse(readFileSync(fixtureFile, 'utf8')) : null;
  const fresh = newestRaw(name);
  if (!published || !fresh) return { name, compared: false, why: !published ? 'no published capture' : 'no raw capture that happened' };
  if (fresh.date <= published.date) return { name, compared: false, why: 'the newest raw capture is the one already published: run trace.mjs with --again first' };
  const now = shapeOf(fresh);
  const then = shapeOf(published);
  const shapes = diff(now.shapes, then.shapes);
  const keyChanges = Object.fromEntries([...new Set([...Object.keys(now.keys), ...Object.keys(then.keys)])].map((frame) => [frame, diff(now.keys[frame] ?? [], then.keys[frame] ?? [])]).filter(([, d]) => d.onlyNew.length || d.onlyPublished.length));
  // The same frames in another number or order is the model's doing, not the protocol's.
  const changed = shapes.onlyNew.length > 0 || shapes.onlyPublished.length > 0 || Object.keys(keyChanges).length > 0;
  return {
    name, compared: true, run: fresh.run.id, cliThen: published.cli?.version ?? null, cliNow: fresh.cli?.version ?? null, changed,
    frameKinds: shapes, keyNames: keyChanges, frames: { now: now.shapes.length, then: then.shapes.length }, connectionNotifications: diff(now.connection, then.connection), sameSequence: JSON.stringify(now.shapes) === JSON.stringify(then.shapes),
  };
}

/** C1's two observations, over the frames of the new captures. */
function observe(capture) {
  const received = capture.frames.filter((f) => f.dir === 'recv');
  const reasoning = received.filter((f) => f.frame?.params?.item?.type === 'reasoning');
  return {
    reasoningItems: reasoning.length,
    reasoningWithSummary: reasoning.filter((f) => Array.isArray(f.frame.params.item.summary) ? f.frame.params.item.summary.length > 0 : Boolean(f.frame.params.item.summary)).length,
    reasoningKeys: [...new Set(reasoning.flatMap((f) => Object.keys(f.frame.params.item)))].sort(),
    settingsUpdated: received.filter((f) => f.frame?.method === 'thread/settings/updated').length,
    modelRerouted: received.filter((f) => f.frame?.method === 'model/rerouted').length,
    methods: [...new Set(received.map((f) => f.frame?.method).filter(Boolean))].sort(),
  };
}

function recheck() {
  const rows = SCENARIOS.map(compare);
  const observations = Object.fromEntries(SCENARIOS.map((name) => [name, newestRaw(name)]).filter(([, capture]) => capture).map(([name, capture]) => [name, observe(capture)]));
  const report = { date: new Date().toISOString(), scenarios: rows, observations, republish: rows.filter((row) => row.changed).map((row) => `node spikes/m10/publish.mjs --only ${row.name}`) };
  writeJson(m15Path('recheck.json'), report);
  log(JSON.stringify(report, null, 2));
  return rows.every((row) => row.compared) ? 0 : 10;
}

if (isMain(import.meta.url)) process.exitCode = recheck();
