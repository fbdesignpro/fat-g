// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CHAT_LINES } from '@shared/contracts/chat';
import { chatTurn } from '../test/chat';
import { TurnLines } from './TurnLines';

afterEach(cleanup);

describe('turn outcome lines', () => {
  it('keeps unfinished and storage-gap warnings together', () => {
    const { container } = render(<TurnLines turn={chatTurn('t', { state: 'unfinished', gap: true })} providerName="Codex" />);
    expect([...container.querySelectorAll('[data-turn-line]')].map((line) => line.textContent)).toEqual([CHAT_LINES.unfinished, CHAT_LINES.gap]);
  });
  it('retains the unacknowledged explanation and leaves elapsed time to the speaker bar', () => {
    const { container, rerender } = render(<TurnLines turn={chatTurn('t', { state: 'unacknowledged' })} providerName="Codex" />);
    expect(container.textContent).toBe(CHAT_LINES.unacknowledged('Codex'));
    rerender(<TurnLines turn={chatTurn('t')} providerName="Codex" />);
    expect(container.textContent).toBe('');
  });
});
