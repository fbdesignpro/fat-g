// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A provider's session with its events collected, and a wait on a condition: what the tests of an
// adapter against its replay fake share (tests/codex/, tests/claude/chat/). No provider is named
// here. Every wait is on an event or a condition, never on a guess at how long something takes.
import type { AgentEvent } from '@shared/contracts/agent-events';
import type { ContextReading } from '@shared/contracts/sessions';
import type { ProviderSession, TurnRequest } from '@shared/provider-kit/sessions';

export interface Watched {
  readonly session: ProviderSession;
  readonly events: AgentEvent[];
  /** The session's context readings (decision 0033), kept apart from `events`, whose lists hold what a session told before it had any. */
  readonly readings: ContextReading[];
  /** Resolves once a reading matches. */
  reading(match: (reading: ContextReading) => boolean, timeoutMs?: number): Promise<ContextReading>;
  /** `extra`: what else the turn carries — a plan turn's `plan` and `plannedBefore` (M22b). */
  send(prompt: string, n?: number, effort?: string | null, extra?: Partial<Pick<TurnRequest, 'plan' | 'plannedBefore'>>): TurnRequest;
  /** Resolves with the turn's end. */
  ended(turnId: string, timeoutMs?: number): Promise<Extract<AgentEvent, { type: 'turn-ended' }>>;
  /** Resolves once an event matches. */
  until(match: (event: AgentEvent) => boolean, timeoutMs?: number): Promise<AgentEvent>;
  types(): string[];
  notices(): string[];
  reference(): string | undefined;
}

/** A session with its events collected. */
export function watch(session: ProviderSession): Watched {
  const events: AgentEvent[] = [];
  const readings: ContextReading[] = [];
  const waiters = new Set<() => void>();
  session.subscribe((event) => { if (event.type === 'context') readings.push(event.reading); else events.push(event); for (const waiter of [...waiters]) waiter(); });
  const reading = (match: (reading: ContextReading) => boolean, timeoutMs = 10_000): Promise<ContextReading> => new Promise((resolve, reject) => {
    const check = (): void => {
      const found = readings.find(match);
      if (found === undefined) return;
      clearTimeout(timer); waiters.delete(check); resolve(found);
    };
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`no matching reading; got ${JSON.stringify(readings.map((one) => one.used))}`)); }, timeoutMs);
    waiters.add(check);
    check();
  });
  const until = (match: (event: AgentEvent) => boolean, timeoutMs = 10_000): Promise<AgentEvent> => new Promise((resolve, reject) => {
    const check = (): void => {
      const found = events.find(match);
      if (found === undefined) return;
      clearTimeout(timer); waiters.delete(check); resolve(found);
    };
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`no matching event; got ${events.map((event) => (event.type === 'notice' ? `notice:${event.kind}` : event.type)).join(', ')}`)); }, timeoutMs);
    waiters.add(check);
    check();
  });
  return {
    session, events, readings, until, reading,
    send(prompt, n = 1, effort = 'low', extra = {}) {
      const request: TurnRequest = { turnId: `turn-${n}`, prompt, effort, speed: null, messageId: `00000000-0000-4000-8000-00000000000${n}`, ...extra };
      session.send(request);
      return request;
    },
    ended: (turnId, timeoutMs) => until((event) => event.type === 'turn-ended' && event.turnId === turnId, timeoutMs) as Promise<Extract<AgentEvent, { type: 'turn-ended' }>>,
    types: () => events.map((event) => event.type),
    notices: () => events.flatMap((event) => (event.type === 'notice' ? [event.kind] : [])),
    reference: () => events.flatMap((event) => (event.type === 'session-started' ? [event.reference] : []))[0],
  };
}

/** Waits until `check` holds, looking every 20 ms. */
export async function eventually<T>(check: () => T | undefined | false, timeoutMs = 10_000, what = 'the condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`${what} did not come to hold`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
