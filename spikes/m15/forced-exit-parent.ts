// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Windows acceptance diagnostic's disposable parent. Uses fat-g's real process layer;
// the controller kills this parent alone while one real CLI turn is running.
// No conversation text or CLI error text is printed or saved.
import { createProcessServices } from '../../src/main/process';
import { openSessionProcess, SESSION_TIMINGS } from '../../src/main/providers/codex/session-process';
import { sendRequest } from '../../src/main/providers/codex/methods';
import { takeStartReply } from '../../src/main/providers/codex/session-schemas';

const [dataDir, folder, executablePath, model, effort] = process.argv.slice(2) as string[];
const say = (value: Record<string, unknown>): void => { process.stdout.write(`${JSON.stringify(value)}\n`); };
const services = createProcessServices(dataDir!);
const context = services.createContext();
try {
  const connection = await openSessionProcess({
    context, executable: { path: executablePath!, kind: /\.(cmd|bat)$/i.test(executablePath!) ? 'cmd-shim' : 'native' },
    argsPrefix: [], applicationVersion: '0.0.0-diagnostic', launchMs: SESSION_TIMINGS.launchMs,
    signal: new AbortController().signal, onDropped: () => say({ dropped: true }),
    unhandled: () => undefined,
  });
  const opened = takeStartReply(await sendRequest('session', connection, 'thread/start', {
    cwd: folder, model, sandbox: 'read-only', approvalPolicy: 'never',
  }, { timeoutMs: SESSION_TIMINGS.openMs }));
  if (opened === null || !opened.readOnly) throw new Error('sandbox-check');
  connection.onNotification('turn/started', () => say({ ready: true, reference: opened.threadId }));
  connection.onNotification('turn/completed', () => say({ ended: true }));
  say({ submittingTurn: true });
  await sendRequest('session', connection, 'turn/start', {
    threadId: opened.threadId,
    input: [{ type: 'text', text: 'Write ten substantial paragraphs about the history of public libraries. Use only your existing knowledge. Do not use tools, read files, or change anything. Number the paragraphs.', text_elements: [] }],
    model, effort, clientUserMessageId: '00000000-0000-4000-8000-000000000001',
  }, { timeoutMs: SESSION_TIMINGS.sendMs });
  setInterval(() => undefined, 60_000);
} catch {
  say({ error: 'parent-failed' });
  await context.processes.dispose();
  process.exitCode = 1;
}
