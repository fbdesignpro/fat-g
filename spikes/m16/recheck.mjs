// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M16 spike K1: M10's Claude scenarios T1, T3, T4, T5 and T7, run again on the installed CLI
// through `spikes/m10/trace.mjs`, compared here with the captures M10 published. It launches
// nothing and spends nothing: the turns are trace.mjs's, each announced by it.
//
//   node spikes/m10/trace.mjs --cli claude --scenario t1 --again --confirm-turns 1     (and t3, t4, t5, t7)
//   node spikes/m16/recheck.mjs
//
// For each scenario it takes the newest raw capture that happened and the published fixture, and
// compares what the frames are, not what they say: the frame types, whether each is the session's
// own or a worker's, the blocks of each message, the turn's end, and the key names of each. A
// capture that changed is republished with `node spikes/m10/publish.mjs --only <name>`.
//
// It also records what K1 asks: whether `tool_use_summary`, a `task_progress` `summary`,
// `system/status` or `session_state_changed` arrives (M14, C21, C117), whether
// `--permission-mode default` is still accepted, and the name the CLI reports for that mode.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CLAUDE_TABLE, typeKey } from '../m10/claude/frames.mjs';
import { FIXTURES_DIR, isMain, outputPath, writeJson } from '../m10/lib/paths.mjs';
import { log } from '../m10/lib/spike.mjs';
import { m16Path } from './lib/common.mjs';

const SCENARIOS = ['t1-basic', 't3-subagent', 't4-interrupt', 't5-error', 't7-declined'];

const blocksOf = (frame) => (Array.isArray(frame.message?.content) ? frame.message.content.map((b) => (b.type === 'tool_use' ? `tool_use:${b.name}` : b.type === 'tool_result' ? `tool_result${b.is_error ? ':error' : ''}` : b.type)) : [typeof frame.message?.content]);

/** One line per received frame from the first prompt on: what it is, and whose. */
function shapeOf(capture) {
  const promptIndex = capture.frames.find((f) => f.dir === 'send' && f.frame?.type === 'user')?.index ?? 0;
  const shapes = [];
  const keys = {};
  for (const { dir, index, frame: raw } of capture.frames) {
    // The table's own scrub first, as publishing applies it, so a raw capture and a fixture compare alike.
    const frame = CLAUDE_TABLE.scrub(raw);
    if (dir !== 'recv' || index < promptIndex || frame?._reduced) continue;
    const type = typeKey(frame);
    // A usage reading arrives when the CLI has one: its place in a turn is the account's doing.
    if (type === 'rate_limit_event') continue;
    const who = frame.parent_tool_use_id != null ? 'worker' : '';
    const detail = type === 'assistant' || type === 'user' ? blocksOf(frame).join('+') + (frame.error ? ` error:${frame.error}` : '')
      : type === 'result' ? `${frame.subtype} is_error:${frame.is_error === true} ${frame.terminal_reason ?? ''}`
        : type === 'system/task_updated' ? `status:${frame.patch?.status ?? ''}`
          : type === 'system/task_notification' ? `status:${frame.status ?? ''}`
            : type === 'control_request/can_use_tool' ? String(frame.request?.tool_name ?? '') : '';
    shapes.push([type, who, detail].filter(Boolean).join(' ').trim());
    const subject = type.startsWith('control_request/') ? frame.request ?? {} : frame;
    keys[type] = [...new Set([...(keys[type] ?? []), ...Object.keys(subject)])].sort();
  }
  return { shapes, keys };
}

function newestRaw(name) {
  const dir = outputPath('raw', 'claude');
  if (!existsSync(dir)) return null;
  const captures = readdirSync(dir).filter((file) => file.startsWith(`${name}.`) && file.endsWith('.json')).map((file) => JSON.parse(readFileSync(path.join(dir, file), 'utf8'))).filter((capture) => capture.run?.outcome === 'happened');
  captures.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return captures[0] ?? null;
}

const diff = (a, b) => ({ onlyNew: [...new Set(a.filter((x) => !b.includes(x)))], onlyPublished: [...new Set(b.filter((x) => !a.includes(x)))] });

function compare(name) {
  const fixtureFile = path.join(FIXTURES_DIR, 'claude', 'captures', `${name}.json`);
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
    frameKinds: shapes, keyNames: keyChanges, frames: { now: now.shapes.length, then: then.shapes.length }, sameSequence: JSON.stringify(now.shapes) === JSON.stringify(then.shapes),
  };
}

/** K1's observations, over the frames of one new capture. */
function observe(capture) {
  const received = capture.frames.filter((f) => f.dir === 'recv');
  const count = (type) => received.filter((f) => typeKey(f.frame) === type).length;
  const init = received.find((f) => typeKey(f.frame) === 'system/init')?.frame ?? null;
  const reply = received.find((f) => f.frame?.type === 'control_response')?.frame.response?.response ?? null;
  const mode = capture.launch.args[capture.launch.args.indexOf('--permission-mode') + 1];
  return {
    toolUseSummary: count('tool_use_summary'), systemStatus: count('system/status'), sessionStateChanged: count('system/session_state_changed'), backgroundTasksChanged: count('system/background_tasks_changed'),
    taskProgress: count('system/task_progress'), taskProgressWithSummary: received.filter((f) => typeKey(f.frame) === 'system/task_progress' && 'summary' in f.frame).length,
    permissionModeLaunchedWith: mode, launchAccepted: Boolean(reply), initializeReplyMode: reply?.current_permission_mode ?? null, initPermissionMode: init?.permissionMode ?? null, initTools: init?.tools ?? null,
    types: [...new Set(received.map((f) => typeKey(f.frame)))].sort(),
  };
}

function recheck() {
  const rows = SCENARIOS.map(compare);
  const observations = Object.fromEntries(SCENARIOS.map((name) => [name, newestRaw(name)]).filter(([, capture]) => capture).map(([name, capture]) => [name, observe(capture)]));
  const report = { date: new Date().toISOString(), scenarios: rows, observations, republish: rows.filter((row) => row.changed).map((row) => `node spikes/m10/publish.mjs --cli claude --only ${row.name}`) };
  writeJson(m16Path('recheck.json'), report);
  log(JSON.stringify(report, null, 2));
  return rows.every((row) => row.compared) ? 0 : 10;
}

if (isMain(import.meta.url)) process.exitCode = recheck();
