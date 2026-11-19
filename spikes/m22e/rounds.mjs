// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// M22e spike K2's rounds read again from a capture (raw or published), with the comparison as
// lib/common.mjs now makes it: each turn's answer as prose or a round, each round against the one
// before by id and `was`, and the marks the spike gave carried. Prints ids and counts, never a text.
// Launches nothing and spends nothing.
//
//   node spikes/m22e/rounds.mjs <capture.json>
import { readFileSync } from 'node:fs';
import { compareRounds, findingsOf, readAnswer } from './lib/common.mjs';

const VERSION = 2;
const capture = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const recv = capture.frames.filter((f) => f.dir === 'recv');

/** Each turn's final answer: Claude's `result`, Codex's last agent message before its `turn/completed`. */
function answers() {
  if (capture.cli?.name === 'claude') return recv.filter((f) => f.frame?.type === 'result').map((f) => f.frame.result);
  const out = [];
  let last = null;
  for (const f of recv) {
    if (f.frame?.method === 'item/completed' && f.frame.params?.item?.type === 'agentMessage') last = String(f.frame.params.item.text ?? '');
    if (f.frame?.method === 'turn/completed') { out.push(last); last = null; }
  }
  return out;
}

const texts = answers();
const marksOf = (findings) => ({ [findings[0].id]: 'accepted', [findings.at(-1).id]: 'rejected' });
let round = null;
let marks = null;
texts.forEach((text, i) => {
  const read = readAnswer(text, { version: VERSION });
  const findings = findingsOf(text, { version: VERSION });
  const line = { turn: i + 1, answer: read.verdict === 'findings' ? 'a round' : read.jsonBlocks > 0 ? read.verdict : 'prose', units: read.units, before: read.last?.unitsBefore ?? null };
  if (findings && round === null) { round = findings; marks = marksOf(findings); Object.assign(line, { ids: findings.map((f) => f.id), anchored: findings.filter((f) => f.anchor).length }); }
  else if (findings) {
    const c = compareRounds(round, findings, marks);
    Object.assign(line, { ids: findings.map((f) => f.id), was: findings.filter((f) => f.was).map((f) => `${f.id}<-${f.was}`), kept: c.kept, moved: c.moved.map((m) => `${m.from}->${m.to}`), added: c.added, leftOut: c.leftOut, revised: c.revised, carried: Object.fromEntries(Object.entries(c.carried).filter(([, m]) => m !== 'open')), anchored: findings.filter((f) => f.anchor).length });
    round = findings;
    marks = Object.fromEntries(Object.entries(c.carried).filter(([, m]) => m !== 'open'));
  }
  console.log(JSON.stringify(line));
});
