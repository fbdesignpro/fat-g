// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The Codex MCP spike's own MCP server (spikes/codex-mcp/k1.mjs): stdio, newline-delimited
// JSON-RPC, no dependency and no network. Codex launches it from the scratch configuration's
// `config.toml` for the length of one run. Synthetic data only.
//
//   node fixture-server.mjs <output folder>
//
// Its tools, by what their annotations tell Codex:
//   stamp, stamp_other   no annotations: Codex asks leave before each call
//   note                 not read-only, but neither destructive nor reaching outside: Codex runs it
//                        without asking, under every mode
//   ask_color            read-only; it asks the client a question of its own (an MCP elicitation)
// `stamp`, `stamp_other` and `note` each write one small file into `<output folder>/written/`, so a
// run can tell which calls ran. Every message in and out is logged to `<output folder>/messages.jsonl`.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const out = process.argv[2];
if (!out || !path.isAbsolute(out)) { process.stderr.write('usage: node fixture-server.mjs <absolute output folder>\n'); process.exit(2); }
mkdirSync(path.join(out, 'written'), { recursive: true });
const log = (dir, message) => appendFileSync(path.join(out, 'messages.jsonl'), JSON.stringify({ at: Date.now(), dir, message }) + '\n');
const send = (message) => { log('out', message); process.stdout.write(JSON.stringify(message) + '\n'); };
const LABEL = { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] };

const TOOLS = [
  { name: 'stamp', description: 'Writes one stamp file named after `label` into the spike server\'s own output folder.', inputSchema: LABEL },
  { name: 'stamp_other', description: 'Writes one other stamp file named after `label` into the spike server\'s own output folder.', inputSchema: LABEL },
  { name: 'note', description: 'Writes one note file named after `label` into the spike server\'s own output folder.', inputSchema: LABEL, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: 'ask_color', description: 'Asks the user to pick a colour through an MCP elicitation form, and returns what the client answered.', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true, openWorldHint: false } },
];

let clientCapabilities = {};
let nextId = 1;
const pending = new Map();
const text = (value) => ({ content: [{ type: 'text', text: value }] });

function written(tool, label) {
  const safe = String(label ?? 'unlabelled').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
  writeFileSync(path.join(out, 'written', `${tool}-${safe}.txt`), `${tool} ${safe}\n`);
  return text(`${tool} done: ${safe}`);
}

function ask() {
  if (clientCapabilities?.elicitation === undefined) return Promise.resolve(text('ask_color: the client declared no elicitation capability'));
  const id = `spike-${nextId++}`;
  send({ jsonrpc: '2.0', id, method: 'elicitation/create', params: { message: 'Spike question: pick a colour.', requestedSchema: { type: 'object', properties: { color: { type: 'string', enum: ['red', 'green', 'blue'] } }, required: ['color'] } } });
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(id); resolve(text('ask_color: no answer')); }, 120_000);
    pending.set(id, (reply) => { clearTimeout(timer); resolve(text(`ask_color: the client answered ${JSON.stringify(reply.result ?? reply.error ?? null)}`)); });
  });
}

async function call(name, args) {
  switch (name) {
    case 'stamp': case 'stamp_other': case 'note': return written(name, args?.label);
    case 'ask_color': return ask();
    default: return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true };
  }
}

async function handle(message) {
  if (message.method === undefined) { pending.get(message.id)?.(message); pending.delete(message.id); return; }
  if (message.id === undefined) return;
  switch (message.method) {
    case 'initialize':
      clientCapabilities = message.params?.capabilities ?? {};
      return send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'fatg-spike-mcp', version: '1.0.0' } } });
    case 'ping': return send({ jsonrpc: '2.0', id: message.id, result: {} });
    case 'tools/list': return send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } });
    case 'tools/call': return send({ jsonrpc: '2.0', id: message.id, result: await call(message.params?.name, message.params?.arguments) });
    default: return send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  buffer += data;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line === '') continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    log('in', message);
    handle(message).catch(() => {});
  }
});
process.stdin.on('end', () => process.exit(0));
