// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The parent of ./forced-exit.test.ts (docs/planning/_archive/M15.md, Design 11; C49, C114; M16.md, Design 9;
// C47): fat-g's real process layer with both adapters, two Codex sessions and one Claude session
// open on their replay fakes, each in a turn and each with a descendant. The test kills this
// process alone, with no cleanup, then watches what is left of its trees. The test bundles this
// file, so it runs on plain Node, outside Vitest. It is here and not in tests/support/, which the
// renderer's TypeScript project compiles too.
//
// argv: the data folder, the project folder, Codex's fake and its prompt, Claude's fake, its fixture
// folder and its prompt. The fakes' other files come through the environment, as in
// tests/codex/harness.ts and tests/claude/chat/harness.ts.
import type { SessionFacet } from '@shared/provider-kit/sessions';
import { createProcessServices } from '../../src/main/process';
import { createClaudeProvider } from '../../src/main/providers/claude';
import { CLAUDE_INSTANCES } from '../../src/main/providers/claude/descriptor';
import { CLAUDE_CHILD_ENVIRONMENT } from '../../src/main/providers/claude/environment';
import { createCodexProvider } from '../../src/main/providers/codex';
import { CODEX_INSTANCES } from '../../src/main/providers/codex/descriptor';

const [dataDir, project, codexFake, codexPrompt, claudeFake, claudeFixture, claudePrompt] = process.argv.slice(2) as [string, string, string, string, string, string, string];
const say = (value: Record<string, unknown>): void => { process.stdout.write(`${JSON.stringify(value)}\n`); };

const services = createProcessServices(dataDir, { protectedVariables: [CODEX_INSTANCES.variable, CLAUDE_INSTANCES.variable] });
const codex = createCodexProvider(services.createContext(), { applicationVersion: '0.0.0-test', argsPrefix: [codexFake], requestTimeoutMs: 5000 });
const claude = createClaudeProvider(services.createContext(CLAUDE_CHILD_ENVIRONMENT), { argsPrefix: [claudeFake, '--fixture-dir', claudeFixture] });
const found = await Promise.all([codex, claude].map((provider) => provider.detect({ override: process.execPath, knownDirs: [] }, new AbortController().signal)));
const facets = { codex: codex.sessions, claude: claude.sessions };
if (found.some((detection) => detection.kind !== 'found') || facets.codex === undefined || facets.claude === undefined) {
  say({ error: found.map((detection) => detection.kind).join(',') });
  process.exit(1);
}

/** A session, sent a prompt whose replay waits for an interrupt: it stays in its turn until this process is killed. */
function inTurn(facet: SessionFacet, n: number, model: string, prompt: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const session = facet.start({ folder: project, model, effort: 'low', speed: null, otherFolders: [], mode: null, processKey: 'process-1' });
    const timer = setTimeout(() => reject(new Error(`turn ${n} did not start`)), 20_000);
    session.subscribe((event) => {
      if (event.type === 'turn-started') { clearTimeout(timer); resolve(); }
      if (event.type === 'turn-ended') { clearTimeout(timer); reject(new Error(`turn ${n} ended: ${event.outcome}`)); }
    });
    session.send({ turnId: `turn-${n}`, prompt, effort: 'low', speed: null, messageId: `00000000-0000-4000-8000-00000000000${n}` });
  });
}

try {
  await Promise.all([
    inTurn(facets.codex, 1, 'gpt-6-astra', codexPrompt),
    inTurn(facets.codex, 2, 'gpt-6-astra', codexPrompt),
    inTurn(facets.claude, 3, 'sonnet', claudePrompt),
  ]);
} catch (error) {
  say({ error: error instanceof Error ? error.message : 'failed' });
  process.exit(1);
}

say({ ready: true, pid: process.pid });
// Held open until killed: nothing here ends the sessions.
setInterval(() => undefined, 60_000);
