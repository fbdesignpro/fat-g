// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// fat-g's own client for the Claude CLI's stdio control protocol (decision 0006). Protocol only: over
// one managed child it writes `control_request` lines and matches `control_response` lines by request
// ID; it knows nothing about accounts or usage. It can send exactly the two subtypes below, and
// anything the CLI asks of fat-g is refused, never acted on. Raw output never leaves this file:
// callers get parsed values or a bounded error string, and every other line is counted, then dropped.
import { NdjsonDecoder } from '@shared/provider-kit/ndjson';
import { ProcessFailure, type FailureCode, type ManagedProcess } from '@shared/provider-kit/process';

/** The only requests fat-g ever sends. Login and OAuth subtypes are unrepresentable here. */
export type ControlSubtype = 'initialize' | 'get_usage';

export type ControlReply =
  | { readonly kind: 'success'; readonly value: unknown }
  /** The CLI's own error text, cut to a bounded length: compared exactly, never logged or shown. */
  | { readonly kind: 'error'; readonly error: string };

/** What the client saw besides its own replies. Counts only, for tests and diagnostics. */
export interface ControlCounts {
  /** Requests the CLI addressed to fat-g, all refused. */
  readonly cliRequests: number;
  /** `assistant`, `result` or `user` messages: a model turn, which an idle session never has. */
  readonly turnMessages: number;
  /** Everything else, including non-JSON lines. */
  readonly ignored: number;
}

export interface ControlClient {
  /**
   * The matching reply. Rejects with a ProcessFailure when `signal` aborts, the transport closes or
   * fails first, or the output breaks the framing limits.
   */
  request(subtype: ControlSubtype, payload: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<ControlReply>;
  /** Ends stdin (EOF) once and rejects whatever is still pending. */
  close(): void;
  counts(): ControlCounts;
}

export const CONTROL_LIMITS = {
  /** Longest CLI error text kept for the one exact comparison fat-g makes. */
  errorChars: 256,
  /** Longest request ID fat-g echoes back when refusing a CLI-initiated request. */
  requestIdChars: 128,
  /** Total stdout per session. S1/S2 usage replies are tens of KiB; lines are capped separately. */
  outputBytes: 4 * 1024 * 1024,
} as const;

const TURN_TYPES: ReadonlySet<string> = new Set(['assistant', 'result', 'user']);

interface Pending { resolve(reply: ControlReply): void; reject(error: ProcessFailure): void }

/** Takes the child's only output subscription. */
export function createControlClient(child: ManagedProcess): ControlClient {
  const pending = new Map<string, Pending>();
  const counts = { cliRequests: 0, turnMessages: 0, ignored: 0 };
  const encoder = new TextEncoder();
  let nextId = 1;
  let outputBytes = 0;
  let failure: ProcessFailure | undefined;
  let closed = false;

  function fail(code: FailureCode): void {
    failure ??= new ProcessFailure(code);
    const entries = [...pending.values()];
    pending.clear();
    for (const entry of entries) entry.reject(failure);
  }

  function send(frame: unknown, signal?: AbortSignal): Promise<void> {
    return child.write(encoder.encode(`${JSON.stringify(frame)}\n`), signal);
  }

  function settle(response: unknown): void {
    if (!isRecord(response) || typeof response['request_id'] !== 'string') { counts.ignored += 1; return; }
    const entry = pending.get(response['request_id']);
    if (entry === undefined) { counts.ignored += 1; return; }
    pending.delete(response['request_id']);
    const error = response['error'];
    entry.resolve(response['subtype'] === 'success'
      ? { kind: 'success', value: response['response'] }
      : { kind: 'error', error: typeof error === 'string' ? error.slice(0, CONTROL_LIMITS.errorChars) : '' });
  }

  function refuse(id: unknown): void {
    counts.cliRequests += 1;
    if (closed || typeof id !== 'string' || id.length > CONTROL_LIMITS.requestIdChars) return;
    // The SDK's answer to a request it does not handle: fat-g offers the CLI nothing.
    void send({ type: 'control_response', response: { subtype: 'error', request_id: id, error: 'unsupported' } }).catch(() => undefined);
  }

  function receive(message: unknown): void {
    if (!isRecord(message)) { counts.ignored += 1; return; }
    const type = message['type'];
    if (type === 'control_response') settle(message['response']);
    else if (type === 'control_request') refuse(message['request_id']);
    else if (typeof type === 'string' && TURN_TYPES.has(type)) counts.turnMessages += 1;
    else counts.ignored += 1;
  }

  // Non-JSON lines are counted and dropped, as the SDK did; an oversized line or invalid UTF-8
  // breaks the framing itself and fails the session.
  const decoder = new NdjsonDecoder(receive, () => { counts.ignored += 1; });
  child.consume((event) => {
    switch (event.type) {
      case 'stdout':
        outputBytes += event.data.byteLength;
        if (outputBytes > CONTROL_LIMITS.outputBytes) { decoder.discard(); fail('output-limit'); return; }
        try { decoder.push(event.data); } catch { fail('protocol-error'); }
        return;
      case 'eof':
        try { decoder.end(); } catch { fail('protocol-error'); }
        fail('transport-closed');
        return;
      case 'close':
        fail('transport-closed');
        return;
      case 'error':
        fail(event.code);
        return;
      // `exit` can precede the last stdout bytes, so replies still in the pipe are awaited until
      // EOF; a write failure surfaces through the write itself.
      case 'exit':
      case 'stdin-error':
        return;
    }
  });

  return {
    request(subtype, payload, signal) {
      if (failure !== undefined) return Promise.reject(failure);
      if (closed) return Promise.reject(new ProcessFailure('transport-closed'));
      if (signal.aborted) return Promise.reject(new ProcessFailure('aborted'));
      const id = `fatg_${nextId++}`;
      return new Promise<ControlReply>((resolve, reject) => {
        const abort = () => { if (pending.delete(id)) reject(new ProcessFailure('aborted')); };
        pending.set(id, {
          resolve: (reply) => { signal.removeEventListener('abort', abort); resolve(reply); },
          reject: (error) => { signal.removeEventListener('abort', abort); reject(error); },
        });
        signal.addEventListener('abort', abort, { once: true });
        // `subtype` last: a payload can never change which request this is.
        send({ type: 'control_request', request_id: id, request: { ...payload, subtype } }, signal).catch((error: unknown) => {
          const entry = pending.get(id);
          if (entry === undefined) return;
          pending.delete(id);
          entry.reject(error instanceof ProcessFailure ? error : new ProcessFailure('transport-closed'));
        });
      });
    },
    close() {
      if (closed) return;
      closed = true;
      child.end();
      fail('transport-closed');
    },
    counts: () => ({ ...counts }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
