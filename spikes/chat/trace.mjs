// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Targeted chat protocol research. No SDK runtime; shares M10's bounded wire/process cleanup.
// Raw captures and provider references stay in ignored spikes/output/chat.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { CodexDriver } from '../m10/codex/driver.mjs';
import { ClaudeDriver, tracingArgs } from '../m10/claude/driver.mjs';
import { cleanEnvironment } from '../m10/lib/env.mjs';
import { resolveExecutable } from '../m10/lib/executable.mjs';
import { runSpike } from '../m10/lib/spike.mjs';
import { Ledger } from '../m10/lib/ledger.mjs';
import { SPIKES_DIR, writeJson } from '../m10/lib/paths.mjs';

const out = path.join(SPIKES_DIR, 'output', 'chat');
const scratch = path.join(os.tmpdir(), 'fat-g-chat-protocol');
mkdirSync(out, { recursive: true }); mkdirSync(scratch, { recursive: true });
const stateFile = path.join(out, 'state.json');
const loadState = () => existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
const saveState = (patch) => writeJson(stateFile, { ...loadState(), ...patch });
const textInput = (text) => ({ type: 'text', text, text_elements: [] });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; };
function testImage() {
  const chunk = (name, bytes) => { const n = Buffer.from(name); const b = Buffer.alloc(12 + bytes.length); b.writeUInt32BE(bytes.length); n.copy(b, 4); bytes.copy(b, 8); b.writeUInt32BE(crc(Buffer.concat([n, bytes])), b.length - 4); return b; };
  const header = Buffer.alloc(13); header.writeUInt32BE(64); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(64 * 193); for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) pixels[y * 193 + 1 + x * 3 + (x < 32 ? 0 : 2)] = 255;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
const imageBytes = testImage();
const imageFile = path.join(scratch, 'two-colours.png');
writeFileSync(imageFile, imageBytes);
writeFileSync(path.join(scratch, 'sample.txt'), 'The protocol test marker is ORCHID-482.\n');

class StreamingCodex extends CodexDriver {
  async open() {
    this.session.recorderOptions.isDelta = () => false;
    await this.startWire();
    const answer = await this.request('initialize', { clientInfo: { name: 'fat_g', title: 'fat-g chat protocol spike', version: '0.0.0' }, capabilities: { experimentalApi: true } }, 'startup');
    await this.session.send({ method: 'initialized' }); return answer;
  }
}
class StreamingClaude extends ClaudeDriver {
  async open() { this.session.recorderOptions.isDelta = () => false; return super.open(); }
  incoming(frame) {
    if (this.holdQuestion && frame.type === 'control_request' && frame.request?.tool_name === 'AskUserQuestion') {
      this.requestsSeen.push({ kind: 'can_use_tool', tool: 'AskUserQuestion', held: true });
      return;
    }
    super.incoming(frame);
  }
}
const budgets = { stream: 1, followup: 1, fork: 1, question: 1, 'question-cancel': 1, async: 1, 'async-answer': 2, steer: 2, interrupt: 1, inspect: 0, cleanup: 0 };

await runSpike('chat-trace', async ({ args, launcher, signal, waits }) => {
  const cli = args.cli, scenario = args.scenario;
  if (!['codex', 'claude'].includes(cli) || !(scenario in budgets)) throw new Error(`use --cli codex|claude --scenario ${Object.keys(budgets).join('|')} --confirm-turns N`);
  if ((scenario === 'async-answer' || scenario === 'cleanup') && cli !== 'codex') throw new Error(`${scenario} is Codex-only`);
  if (scenario === 'question-cancel' && cli !== 'claude') throw new Error('question-cancel is Claude-only');
  const budget = budgets[scenario];
  console.log(`Plan: ${cli}/${scenario}; at most ${budget} submitted model inputs; read-only except scratch fixtures; all unrelated approvals declined.`);
  if (String(args['confirm-turns']) !== String(budget)) return 0;
  const ledger = new Ledger(path.join(out, 'ledger.json'));
  if (ledger.turnsSpent() + budget > 18) throw new Error('chat investigation total budget of 18 inputs reached');
  const run = ledger.open(cli, scenario, { again: Boolean(args.again) });
  const state = loadState();
  const notes = { cli, scenario, startup: null, result: 'not-run' };
  let driver;
  const received = (from = 0) => driver.session.frames.filter((f) => f.dir === 'recv' && f.index >= from);
  const waitFrame = (predicate, from = 0, ms = 120000) => driver.session.waitFor(predicate, { wait: 'scenario', ms, fromIndex: from });
  const end = (from) => waitFrame((f) => cli === 'codex' ? f.method === 'turn/completed' && f.params.threadId === driver.threadId : f.type === 'result', from);
  const spend = () => { if (run.turns >= budget) throw new Error('scenario input budget reached'); ledger.countTurn(run); };
  const send = async (text, extra = {}) => {
    const from = driver.nextIndex; spend();
    if (cli === 'codex') { driver.nextTurn = { model: state.codexModel, effort: 'low', ...extra }; const answer = await driver.prompt(text); if (!answer.ok) throw new Error(`turn refused: ${JSON.stringify(answer.error)}`); }
    else { driver.turnActive = true; await driver.session.send({ type: 'user', uuid: randomUUID(), message: { role: 'user', content: extra.content ?? text }, parent_tool_use_id: null, session_id: '' }); }
    return from;
  };
  try {
    let launchArgs;
    if (cli === 'claude') {
      launchArgs = tracingArgs({ tools: scenario.startsWith('question') || scenario.startsWith('async') ? ['AskUserQuestion'] : scenario === 'steer' ? ['Bash'] : ['Read'], effort: 'low' }).filter((a) => a !== '--no-session-persistence');
      launchArgs.push('--include-partial-messages', '--replay-user-messages');
      if (['followup', 'fork', 'inspect'].includes(scenario)) {
        if (!state.claudeSession) throw new Error('run claude stream first');
        launchArgs.push('--resume', state.claudeSession);
        if (scenario === 'fork') launchArgs.push('--fork-session', '--resume-session-at', state.claudeFirstAssistant);
      } else launchArgs.push('--name', `fat-g chat protocol ${scenario}`);
    }
    driver = cli === 'codex'
      ? new StreamingCodex({ launcher, executable: resolveExecutable(cli), cwd: scratch, env: cleanEnvironment(cli).env, waits, signal })
      : new StreamingClaude({ launcher, executable: resolveExecutable(cli), args: launchArgs, cwd: scratch, env: cleanEnvironment(cli).env, waits, signal });
    driver.holdQuestion = scenario === 'question-cancel';
    driver.onRequest((q) => {
      if (q.requestKind === 'question' || q.tool === 'AskUserQuestion') return { decision: 'answer-first' };
      // Permit only the timing fixture, never arbitrary commands or file writes.
      if (scenario === 'steer' && q.tool === 'Bash' && /^(sleep 6|(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\s+(?:-NoProfile\s+)?-Command\s+["']?Start-Sleep -Seconds 6["']?)$/i.test(q.input?.command?.trim() ?? '')) return { decision: 'allow' };
      return { decision: 'deny' };
    });
    notes.startup = (await driver.open()).ok;
    if (cli === 'codex') {
      const models = await driver.request('model/list', { limit: 100 });
      const model = models.value?.data?.find((m) => m.isDefault) ?? models.value?.data?.[0];
      if (!model) throw new Error('no model');
      state.codexModel = model.model; saveState({ codexModel: model.model }); notes.model = model.model;
      if (scenario === 'cleanup') {
        notes.deleted = [];
        const remaining = [];
        // Children precede parents: the CLI protects parents referenced by forks.
        for (const id of [...(state.codexThreads ?? [])].reverse()) {
          const answer = await driver.request('thread/delete', { threadId: id });
          notes.deleted.push(answer.ok);
          if (!answer.ok) remaining.push(id);
        }
        saveState({ codexThreads: remaining.reverse() });
      } else if (['followup', 'inspect'].includes(scenario)) {
        const r = await driver.request('thread/resume', { threadId: state.codexThread, cwd: scratch, sandbox: 'read-only', approvalPolicy: 'never' });
        if (!r.ok) throw new Error('resume refused'); driver.threadId = r.value.thread.id;
        notes.resumeTurnCount = r.value.thread.turns?.length;
      } else if (scenario === 'fork') {
        const r = await driver.request('thread/fork', { threadId: state.codexThread, lastTurnId: state.codexFirstTurn, cwd: scratch, sandbox: 'read-only', approvalPolicy: 'never' });
        notes.forkAccepted = r.ok;
        if (!r.ok) throw new Error(`fork refused: ${JSON.stringify(r.error)}`);
        driver.threadId = r.value.thread.id;
        saveState({ codexThreads: [...(loadState().codexThreads ?? []), driver.threadId] });
        notes.forkTurns = r.value.thread.turns?.length;
      } else {
        const r = await driver.startThread({ cwd: scratch, sandbox: 'read-only', approvalPolicy: 'never', model: model.model, ephemeral: false });
        if (!r.ok) throw new Error('thread start refused');
        saveState({ codexThreads: [...(loadState().codexThreads ?? []), driver.threadId], ...(scenario === 'stream' ? { codexThread: driver.threadId } : {}) });
      }
    }
    if (scenario === 'stream') {
      const prompt = 'Protocol fixture test. Read only sample.txt in the current directory. Inspect the attached image. Reply in Markdown with the marker from the file, the left and right colours, and a short code block. Remember FIRST-741 for later. Use no MCP or other external tools.';
      const from = await send(prompt, cli === 'codex' ? { input: [textInput(prompt), { type: 'localImage', path: imageFile }] } : { content: [{ type: 'text', text: prompt }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBytes.toString('base64') } }] });
      await end(from);
      if (cli === 'codex') saveState({ codexFirstTurn: driver.turnId });
      else {
        const messages = received(from).filter(({ frame }) => frame.type === 'assistant');
        saveState({ claudeSession: driver.sessionIds.at(-1), claudeFirstAssistant: messages.at(-1)?.frame.uuid, claudeSessions: [...(loadState().claudeSessions ?? []), driver.sessionIds.at(-1)] });
      }
    } else if (scenario === 'followup') {
      notes.beforePromptTypes = received().map(({ frame }) => frame.type ?? frame.method ?? 'response');
      const from = await send('Remember SECOND-953 as well. Say only FIRST-741 and SECOND-953. Use no tools.'); await end(from);
    } else if (scenario === 'fork') {
      notes.beforePromptTypes = received().map(({ frame }) => frame.type ?? frame.method ?? 'response');
      const from = await send('Which FIRST- and SECOND- markers were given in this conversation before this question? Report only the markers you saw, or absent. Do not use tools.'); await end(from);
      if (cli === 'claude') saveState({ claudeSessions: [...(loadState().claudeSessions ?? []), driver.sessionIds.at(-1)] });
    } else if (scenario.startsWith('question') || scenario.startsWith('async')) {
      let extra = {};
      if (cli === 'codex' && scenario === 'question') extra = { collaborationMode: { mode: 'plan', settings: { model: state.codexModel, reasoning_effort: 'low', developer_instructions: null } } };
      const from = await send('Protocol UI test: ask me to choose between Amber and Blue using your structured user-question tool, not prose. After my answer reply with the selected colour only. Do not use any other tools or make changes.', extra);
      const found = await waitFrame((f) => (cli === 'codex' ? f.method === 'item/tool/requestUserInput' || (f.method === 'item/completed' && f.params.item?.questions?.length) || f.method === 'turn/completed' : f.type === 'control_request' || f.type === 'result'), from);
      notes.questionRoute = found.frame.method ?? found.frame.request?.subtype ?? found.frame.type;
      if (scenario === 'question-cancel') notes.questionInterruptAccepted = (await driver.interrupt()).ok;
      if (cli === 'codex' && found.frame.params?.item?.questions?.length) {
        notes.legacyAsyncMessage = true;
        // No request id exists to reply to. A further input would exceed this scenario's budget.
        if (scenario !== 'async-answer') await driver.interrupt();
      }
      await end(from);
      if (scenario === 'async-answer') {
        if (!notes.legacyAsyncMessage) throw new Error('no asynchronous question observed');
        const answerFrom = await send('Answer to your question "Choose a colour": Blue. Reply only with the chosen colour.');
        await end(answerFrom);
        notes.asyncAnsweredWithNewTurn = true;
      }
    } else if (scenario === 'steer') {
      const from = await send('Protocol timing test. Run a shell command that waits 6 seconds without reading or writing files (PowerShell Start-Sleep -Seconds 6, or Bash sleep 6). Then reply ORIGINAL. Do not use any other tools.');
      await waitFrame((f) => cli === 'codex' ? f.method === 'item/started' && f.params.item?.type === 'commandExecution' : f.type === 'assistant' && f.message?.content?.some((c) => c.type === 'tool_use' && c.name === 'Bash'), from);
      spend();
      if (cli === 'codex') {
        const response = await driver.request('turn/steer', { threadId: driver.threadId, expectedTurnId: driver.turnId, input: [textInput('New instruction: reply STEERED-627 instead of ORIGINAL.')], clientUserMessageId: randomUUID() });
        notes.steerAccepted = response.ok;
      } else {
        await driver.prompt('New instruction: reply STEERED-627 instead of ORIGINAL.'); notes.midTurnInputWritten = true;
      }
      await end(from);
      if (cli === 'claude') { try { await waitFrame((f) => f.type === 'result', driver.nextIndex, 8000); notes.secondResult = true; } catch { notes.secondResult = false; } }
    } else if (scenario === 'interrupt') {
      const from = await send('Write a numbered list of 250 distinct short facts about arithmetic. No tools.');
      await waitFrame((f) => cli === 'codex' ? f.method === 'item/agentMessage/delta' : f.type === 'stream_event' && f.event?.type === 'content_block_delta', from);
      notes.interruptAccepted = (await driver.interrupt()).ok; await end(from);
    } else if (scenario === 'inspect' && cli === 'claude') {
      // Give a resumed CLI a bounded idle window to replay history, without submitting a prompt.
      try { await waitFrame((f) => f.type === 'assistant' || f.type === 'user', 0, 3000); notes.idleHistoryMessage = true; } catch { notes.idleHistoryMessage = false; }
      notes.initializeReplyKeys = Object.keys(received().find(({ frame }) => frame.type === 'control_response')?.frame.response ?? {});
    }
    if (cli === 'codex' && scenario !== 'cleanup') {
      const history = await driver.request('thread/turns/list', { threadId: driver.threadId, limit: 20, itemsView: 'full' });
      notes.historyOk = history.ok;
      notes.history = (history.value?.data ?? []).map((t) => ({ status: t.status, keys: Object.keys(t), items: (t.items ?? []).map((i) => ({ type: i.type, keys: Object.keys(i), contentTypes: i.content?.map((c) => c.type) })) }));
      const itemPage = await driver.request('thread/items/list', { threadId: driver.threadId, limit: 3 }); notes.itemPaging = itemPage.ok;
    }
    notes.result = 'observed';
  } catch (error) { notes.result = error.name === 'DeadlineExpired' ? 'timed-out' : 'failed'; notes.error = String(error.message).slice(0, 400); }
  finally {
    if (driver) {
      const cleanup = await driver.close(); notes.cleanupConfirmed = cleanup.confirmed;
      const frames = driver.session.frames;
      writeJson(path.join(out, `${run.id}-raw.json`), { at: new Date().toISOString(), frames });
      notes.types = {};
      for (const { frame, dir } of frames) if (dir === 'recv') { const key = frame.method ?? `${frame.type}${frame.subtype ? '/' + frame.subtype : ''}`; notes.types[key] = (notes.types[key] ?? 0) + 1; }
      notes.requests = driver.requestsSeen;
      notes.assistantTexts = frames.filter(({ dir, frame }) => dir === 'recv' && (cli === 'codex' ? frame.method === 'item/completed' && frame.params.item?.type === 'agentMessage' : frame.type === 'assistant')).map(({ frame }) => cli === 'codex' ? frame.params.item.text : frame.message.content?.filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
      notes.resultFrames = frames.filter(({ dir, frame }) => dir === 'recv' && (cli === 'codex' ? frame.method === 'turn/completed' : frame.type === 'result')).map(({ frame }) => cli === 'codex' ? { status: frame.params.turn.status, keys: Object.keys(frame.params.turn), durationMs: frame.params.turn.durationMs } : { subtype: frame.subtype, duration_ms: frame.duration_ms, duration_api_ms: frame.duration_api_ms, usage: frame.usage, is_error: frame.is_error });
      if (cli === 'codex') {
        const deltas = new Map();
        for (const { frame } of frames) if (frame.method === 'item/agentMessage/delta') deltas.set(frame.params.itemId, (deltas.get(frame.params.itemId) ?? '') + frame.params.delta);
        notes.deltaFinalMatches = frames.filter(({ frame }) => frame.method === 'item/completed' && frame.params.item?.type === 'agentMessage').map(({ frame }) => ({ phase: frame.params.item.phase, hasDeltas: deltas.has(frame.params.item.id), matches: deltas.get(frame.params.item.id) === frame.params.item.text }));
      }
    }
    notes.turnsSpent = run.turns;
    writeJson(path.join(out, `${run.id}-report.json`), notes);
    ledger.close(run, { status: notes.result === 'observed' ? 'happened' : notes.result === 'timed-out' ? 'timed-out' : 'did-not-happen', cleanupConfirmed: notes.cleanupConfirmed });
    console.log(JSON.stringify({ cli, scenario, result: notes.result, turns: run.turns, cleanup: notes.cleanupConfirmed, error: notes.error, questionRoute: notes.questionRoute, totalInputs: ledger.turnsSpent() }));
  }
  return notes.cleanupConfirmed === false ? 3 : notes.result === 'observed' ? 0 : 10;
});
