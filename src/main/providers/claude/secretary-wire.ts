// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The secretary's one writer on Claude (docs/planning/_archive/M26.md, Design 2; decision 0028): the third
// kind of session's process, beside the usage client and a chat's wire, with a closed set of its
// own. It writes `initialize`, carrying the task's instruction as the system prompt, then one user
// message holding the task's text, and refuses whatever the CLI asks, as the usage client does.
// Nothing else is representable. It takes no output subscription: the secretary reads.
import type { ManagedProcess } from '@shared/provider-kit/process';

export type SecretarySend =
  /** The task's instruction in place of Claude Code's own system prompt (M26, K1). */
  | { readonly kind: 'initialize'; readonly instructions: string }
  /** The one prompt: the task's text, with no id of fat-g's, as nothing follows its echo. */
  | { readonly kind: 'prompt'; readonly text: string }
  /** The reply to a request the CLI made: the usage client's own refusal. */
  | { readonly kind: 'unsupported'; readonly requestId: string };

export const SECRETARY_WIRE_LIMITS = {
  /** Longest request id echoed back in a refusal: a longer one is not answered. */
  requestIdChars: 128,
} as const;

/** The frame of one send. `requestId` names the one control request, `initialize`. */
export function encodeSecretarySend(send: SecretarySend, requestId: string): unknown {
  switch (send.kind) {
    case 'initialize': return { type: 'control_request', request_id: requestId, request: { subtype: 'initialize', systemPrompt: [send.instructions] } };
    case 'prompt': return { type: 'user', message: { role: 'user', content: send.text }, parent_tool_use_id: null, session_id: '' };
    case 'unsupported': return { type: 'control_response', response: { subtype: 'error', request_id: send.requestId, error: 'unsupported' } };
    default: throw new TypeError('not one of the three sends');
  }
}

export interface SecretaryWire {
  /** Writes one frame. `requestId`: the control request's id, for `initialize`; null otherwise. */
  send(what: SecretarySend): { readonly requestId: string | null; readonly written: Promise<void> };
  /** Ends the process's input, once: the CLI ends after its reply. */
  end(): void;
}

export function createSecretaryWire(child: Pick<ManagedProcess, 'write' | 'end'>): SecretaryWire {
  const encoder = new TextEncoder();
  let ended = false;
  const line = (frame: unknown): Uint8Array => encoder.encode(`${JSON.stringify(frame)}\n`);
  return {
    send(what) {
      if (ended || (what.kind === 'unsupported' && what.requestId.length > SECRETARY_WIRE_LIMITS.requestIdChars)) return { requestId: null, written: Promise.resolve() };
      const requestId = what.kind === 'initialize' ? 'fatg_1' : null;
      return { requestId, written: child.write(line(encodeSecretarySend(what, requestId ?? ''))) };
    },
    end() {
      if (ended) return;
      ended = true;
      child.end();
    },
  };
}
