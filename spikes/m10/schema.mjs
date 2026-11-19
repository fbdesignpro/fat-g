// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// B3: Codex's app-server schema, generated twice by the installed CLI and compared (C13). A method
// present in both is stable; one present only with --experimental is experimental. The same
// comparison is made per field. No turn, no session: the CLI only writes schema files.
//
//   node spikes/m10/schema.mjs [--path <codex executable>]
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { EXIT } from './lib/deadlines.mjs';
import { resolveExecutable } from './lib/executable.mjs';
import { runOnce } from './lib/oneshot.mjs';
import { isMain, outputPath, writeJson } from './lib/paths.mjs';
import { buildScratch } from './lib/scratch.mjs';
import { log, runSpike, warn } from './lib/spike.mjs';

/** Topics M10 needs listed (B3): models, effort, sessions, configuration, projects. */
const TOPICS = {
  models: /model/i,
  effort: /effort|reasoning|collaborationMode|serviceTier|fast/i,
  sessions: /^(thread|turn|item|review)\//i,
  configuration: /^config|permission|sandbox|approval/i,
  projects: /^project\//i,
};

/** Definitions whose fields the drivers and discovery rely on. */
const INTEREST = /^(ThreadStart|TurnStart|ThreadRead|ThreadList|ThreadNameSet|TurnInterrupt|ModelList|Model$|ReasoningEffortOption|ConfigRead|Initialize|ClientInfo|Thread$|Turn$|TurnStartedNotification|TurnCompletedNotification|ThreadStartedNotification|PermissionsRequestApproval|ToolRequestUserInput|CommandExecutionRequestApproval|FileChangeRequestApproval|CollabAgentToolCall|SandboxPolicy|AskForApproval|ApprovalsReviewer|ReasoningEffort|ServiceTier|CollaborationMode)/;

function readSchemas(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.json')) files.push(full);
    }
  };
  walk(dir);
  return files.map((file) => ({ file: path.relative(dir, file).split(path.sep).join('/'), json: JSON.parse(readFileSync(file, 'utf8')) }));
}

/** Every `{ method: { enum: [name] } }` object, with the file it came from and its params' ref. */
export function methodsOf(schemas) {
  const methods = new Map();
  const visit = (node, file) => {
    if (Array.isArray(node)) { node.forEach((n) => visit(n, file)); return; }
    if (!node || typeof node !== 'object') return;
    const method = node.properties?.method;
    const names = method?.enum ?? (typeof method?.const === 'string' ? [method.const] : null);
    if (Array.isArray(names) && names.length === 1 && typeof names[0] === 'string') {
      const category = /ServerNotification/i.test(file) ? 'server-notification' : /ServerRequest/i.test(file) ? 'server-request' : /ClientNotification/i.test(file) ? 'client-notification' : /ClientRequest/i.test(file) ? 'client-request' : 'other';
      // The bundle files repeat every method; the per-kind files say what kind it is. Keyed by
      // method, a specific category replaces "other".
      const params = node.properties?.params?.$ref ?? null;
      const known = methods.get(names[0]);
      if (!known || (known.category === 'other' && category !== 'other')) methods.set(names[0], { method: names[0], category, params: params ? params.split('/').pop() : known?.params ?? null });
    }
    for (const value of Object.values(node)) visit(value, file);
  };
  for (const { file, json } of schemas) visit(json, file);
  return methods;
}

/** Definition name → property names, across every file. */
export function fieldsOf(schemas) {
  const fields = new Map();
  const collect = (name, node) => {
    if (!node || typeof node !== 'object') return;
    const props = new Set(Object.keys(node.properties ?? {}));
    for (const variant of [...(node.oneOf ?? []), ...(node.anyOf ?? []), ...(node.allOf ?? [])]) for (const key of Object.keys(variant?.properties ?? {})) props.add(key);
    if (props.size === 0) return;
    const existing = fields.get(name) ?? new Set();
    for (const p of props) existing.add(p);
    fields.set(name, existing);
  };
  for (const { file, json } of schemas) {
    collect(path.basename(file, '.json'), json);
    for (const [name, node] of Object.entries(json.definitions ?? json.$defs ?? {})) collect(name, node);
  }
  return fields;
}

export async function generate(launcher, waits, executable, experimental) {
  const out = outputPath('schema', experimental ? 'experimental' : 'plain', '.keep');
  const dir = path.dirname(out);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  const { dir: cwd } = buildScratch('probe');
  const args = ['app-server', 'generate-json-schema', ...(experimental ? ['--experimental'] : []), '--out', dir];
  const result = await runOnce(launcher, 'codex', executable, args, { cwd, waits: { ...waits, request: 60_000 } });
  if (result.code !== 0 || !existsSync(dir)) throw new Error(`generate-json-schema${experimental ? ' --experimental' : ''} failed (exit ${result.code})`);
  return readSchemas(dir);
}

if (isMain(import.meta.url)) {
  await runSpike('schema', async ({ args, launcher, waits }) => {
    const executable = resolveExecutable('codex', args.path);
    const plain = await generate(launcher, waits, executable, false);
    const experimental = await generate(launcher, waits, executable, true);
    const stableMethods = methodsOf(plain);
    const allMethods = methodsOf(experimental);
    const methods = [...allMethods.values()].map((m) => ({ ...m, stability: stableMethods.has(m.method) ? 'stable' : 'experimental' }))
      .sort((a, b) => a.category.localeCompare(b.category) || a.method.localeCompare(b.method));
    const plainFields = fieldsOf(plain);
    const experimentalFields = [];
    for (const [name, props] of fieldsOf(experimental)) {
      const stable = plainFields.get(name);
      const extra = [...props].filter((p) => !stable?.has(p));
      if (extra.length) experimentalFields.push({ definition: name, fields: stable ? extra : ['<whole definition>'] });
    }
    const relevant = Object.fromEntries(Object.entries(TOPICS).map(([topic, pattern]) => [topic, methods.filter((m) => pattern.test(m.method) || pattern.test(m.params ?? '')).map((m) => `${m.method} (${m.category}, ${m.stability})`)]));
    const summary = { date: new Date().toISOString(), files: { plain: plain.length, experimental: experimental.length }, counts: { methods: methods.length, stable: methods.filter((m) => m.stability === 'stable').length }, relevant };
    // The shapes the drivers depend on, stable and experimental fields together, marked.
    const allFields = fieldsOf(experimental);
    const interest = {};
    for (const [name, props] of allFields) {
      if (!INTEREST.test(name)) continue;
      const stable = plainFields.get(name);
      interest[name] = [...props].sort();
      interest[`${name}:experimental`] = [...props].filter((p) => !stable?.has(p)).sort();
    }
    writeJson(outputPath('schema', 'fields-of-interest.json'), interest);
    writeJson(outputPath('schema', 'methods.json'), methods);
    writeJson(outputPath('schema', 'experimental-fields.json'), experimentalFields.sort((a, b) => a.definition.localeCompare(b.definition)));
    writeJson(outputPath('schema', 'summary.json'), summary);
    log(JSON.stringify(summary, null, 2));
    if (methods.length === 0) { warn('no methods found: the schema layout may have changed'); return EXIT.error; }
    return EXIT.happened;
  });
}
