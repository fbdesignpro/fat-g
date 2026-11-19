// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Presentation has its own revision: an avatar change never rereads or appends conversation text.
import { create } from 'zustand';
import type { ChatPresentation } from '@shared/contracts/chat';

interface PresentationState {
  readonly sessionId: string | null;
  readonly value: ChatPresentation | null;
}

export const useChatPresentation = create<PresentationState>()(() => ({ sessionId: null, value: null }));

export function takePresentation(sessionId: string, incoming: ChatPresentation | undefined): void {
  if (incoming === undefined) return;
  useChatPresentation.setState((state) => {
    const held = state.sessionId === sessionId ? state.value : null;
    if (held !== null && incoming.revision < held.revision) return state;
    const models = { ...held?.models, ...incoming.models };
    const workers = { ...held?.workers, ...incoming.workers };
    // Preserve object identities when equivalent metadata arrives with another message.
    for (const [key, value] of Object.entries(models)) if (JSON.stringify(value) === JSON.stringify(held?.models[key])) models[key] = held?.models[key] ?? null;
    for (const [key, value] of Object.entries(workers)) if (JSON.stringify(value) === JSON.stringify(held?.workers[key])) workers[key] = held?.workers[key] ?? value;
    if (held !== null && incoming.revision === held.revision && Object.keys(models).length === Object.keys(held.models).length && Object.keys(workers).length === Object.keys(held.workers).length
      && Object.entries(models).every(([key, value]) => held.models[key] === value) && Object.entries(workers).every(([key, value]) => held.workers[key] === value)) return state;
    return { sessionId, value: { revision: incoming.revision, models, workers } };
  });
}

export function clearPresentation(sessionId: string): void {
  if (useChatPresentation.getState().sessionId === sessionId) useChatPresentation.setState({ sessionId: null, value: null });
}
