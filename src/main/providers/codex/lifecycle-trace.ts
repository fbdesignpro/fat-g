// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { RpcTracePolicy } from '@shared/provider-kit/lifecycle-trace';

/** Only used with the opt-in developer trace. Discards raw text after a fixed classification. */
export const codexSessionTrace: RpcTracePolicy = {
  operation(method) {
    switch (method) {
      case 'initialize': return 'initialize';
      case 'thread/start': return 'open';
      case 'thread/resume': return 'resume';
      case 'turn/start': return 'send';
      case 'turn/interrupt': return 'interrupt';
      default: return 'other';
    }
  },
  refusal(method, message) {
    return method === 'thread/resume' && typeof message === 'string' && /^thread [0-9a-f-]{36} already has an active writer$/i.test(message) ? 'active-writer' : 'other';
  },
  notification(method, params) {
    if (method === 'turn/started') return { phase: 'turn-started' };
    if (method !== 'turn/completed') return null;
    const turn = params !== null && typeof params === 'object' && 'turn' in params ? params.turn : null;
    const status = turn !== null && typeof turn === 'object' && 'status' in turn ? turn.status : null;
    return { phase: 'turn-completed', outcome: status === 'completed' || status === 'interrupted' || status === 'failed' ? status : 'unknown' };
  },
};
