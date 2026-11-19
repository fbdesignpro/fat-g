// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The secretary on Claude (docs/planning/_archive/M26.md, Design 2; decision 0028): one short process per
// request, in the instance's scope and fat-g's probe folder. It offers no tool, loads none of the
// user's settings, hooks or MCP servers, thinks not, and writes no transcript (M26's K1). Its sends
// are its wire's: `initialize` with the task's instruction as the system prompt, then one prompt.
// It reads the session's own final text up to the `result` frame, then ends the process the way the
// usage session does — the end of its input, a grace to exit, then the tree confirmed gone.
//
// Nothing of what it sends or reads is kept, logged or passed on but the answer's text.
import { cutTo, MAX_MESSAGE_TEXT } from '@shared/contracts/agent-events';
import type { ProviderContext } from '@shared/provider-kit/context';
import { NdjsonDecoder } from '@shared/provider-kit/ndjson';
import type { Executable, OpenedProcess } from '@shared/provider-kit/process';
import type { SecretaryAnswer, SecretaryRequest } from '@shared/provider-kit/sessions';
import { takeAssistant, takeResult } from './chat-frames';
import { createSecretaryWire } from './secretary-wire';

/**
 * Stream-json both ways, no settings files, no MCP server, no transcript, no tool and no thinking.
 * `--thinking disabled` is the CLI's own flag for a disabled thinking configuration, which `--help`
 * does not list: without it a model with no level thinks at length (M26, K1).
 */
export const SECRETARY_ARGS: readonly string[] = Object.freeze([
  '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
  '--setting-sources=', '--strict-mcp-config', '--no-session-persistence', '--tools', '', '--thinking', 'disabled',
]);

/** The whole argument line: the fixed list, the model's key and its level where it has one. No text of the request goes on it. */
export function secretaryArgs(model: string, effort: string | null): readonly string[] {
  return [...SECRETARY_ARGS, '--model', model, ...(effort === null ? [] : ['--effort', effort])];
}

export const SECRETARY_LIMITS = {
  /** All the process may write: a title's exchange is a few KiB. */
  outputBytes: 1024 * 1024,
  /** The longest line. */
  lineBytes: 512 * 1024,
  /** After the end of its input, before its tree is ended by force. */
  closeGraceMs: 2_000,
} as const;

export interface ClaudeSecretaryOptions {
  readonly context: ProviderContext;
  /** What the instance's detection found: undefined until it has. */
  readonly executable: () => Executable | undefined;
  readonly argsPrefix: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export async function runClaudeSecretary(options: ClaudeSecretaryOptions, request: SecretaryRequest, signal: AbortSignal): Promise<SecretaryAnswer> {
  const executable = options.executable();
  if (executable === undefined) return { kind: 'failed', reason: 'unavailable' };
  if (signal.aborted) return { kind: 'failed', reason: 'aborted' };
  let opened: OpenedProcess;
  try {
    opened = await options.context.processes.openProcess(executable, [...options.argsPrefix, ...secretaryArgs(request.model, request.effort)], { cwd: options.context.probeDirectory });
  } catch {
    return { kind: 'failed', reason: 'unavailable' };
  }
  const wire = createSecretaryWire(opened.process);

  const answer = await new Promise<SecretaryAnswer>((resolve) => {
    let settled = false;
    let initializeId: string | null = null;
    let last: string | null = null;
    let outputBytes = 0;
    const finish = (value: SecretaryAnswer): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      resolve(value);
    };
    const abort = (): void => finish({ kind: 'failed', reason: 'aborted' });
    const unavailable = (): void => finish({ kind: 'failed', reason: 'unavailable' });
    signal.addEventListener('abort', abort, { once: true });

    function route(frame: unknown): void {
      if (settled || !isRecord(frame)) return;
      switch (frame['type']) {
        case 'control_response': {
          const response = frame['response'];
          if (!isRecord(response) || initializeId === null || response['request_id'] !== initializeId) return;
          initializeId = null;
          if (response['subtype'] !== 'success') { unavailable(); return; }
          wire.send({ kind: 'prompt', text: request.text }).written.catch(unavailable);
          return;
        }
        case 'control_request':
          // Nothing is offered the CLI: it has no tool to ask leave for.
          if (typeof frame['request_id'] === 'string') void wire.send({ kind: 'unsupported', requestId: frame['request_id'] }).written.catch(() => undefined);
          return;
        case 'assistant': {
          const taken = takeAssistant(frame);
          if (taken === null || !taken.own || taken.error || !taken.fromModel) return;
          const text = taken.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');
          if (text.trim() !== '') last = cutTo(text, MAX_MESSAGE_TEXT).text;
          return;
        }
        case 'result':
          finish(takeResult(frame).isError || last === null ? { kind: 'failed', reason: 'unavailable' } : { kind: 'answered', text: last });
          return;
        default:
          return;
      }
    }

    const decoder = new NdjsonDecoder(route, () => undefined, SECRETARY_LIMITS.lineBytes);
    opened.process.consume((event) => {
      switch (event.type) {
        case 'stdout':
          outputBytes += event.data.byteLength;
          if (outputBytes > SECRETARY_LIMITS.outputBytes) { decoder.discard(); unavailable(); return; }
          try { decoder.push(event.data); } catch { unavailable(); }
          return;
        case 'eof':
          try { decoder.end(); } catch { /* the last line was no text */ }
          unavailable();
          return;
        case 'error':
          unavailable();
          return;
        case 'exit':
        case 'close':
        case 'stdin-error':
          return;
      }
    });
    void opened.done.then(unavailable);
    if (signal.aborted) { abort(); return; }
    const sent = wire.send({ kind: 'initialize', instructions: request.instructions });
    initializeId = sent.requestId;
    sent.written.catch(unavailable);
  });

  // The end of its input and a grace to exit, then the tree confirmed gone; a request let go of is ended at once.
  wire.end();
  if (!(answer.kind === 'failed' && answer.reason === 'aborted')) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([opened.done, new Promise((resolve) => { timer = setTimeout(resolve, SECRETARY_LIMITS.closeGraceMs); })]);
    clearTimeout(timer);
  }
  await opened.close();
  return answer;
}
