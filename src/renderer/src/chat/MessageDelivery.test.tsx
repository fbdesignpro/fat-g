// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V8 (docs/planning/_archive/M23.md; C38–C44): a message sent into a running turn says what became of it under
// it — Sent until settled, then Taken, Not sent with the CLI's own word, Not confirmed, the next
// prompt's, or Cancelled by Stop — and a message sent as any prompt says nothing of the kind.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DELIVERY_WORDS, type DeliveryView } from '@shared/contracts/composer';
import { chatItem } from '../test/chat';
import { AsideSourceContext } from './ExplainControl';
import { Message } from './Message';

const S = '11111111-1111-4111-8111-111111111111';
afterEach(cleanup);

const show = (delivery?: DeliveryView) =>
  render(
    <AsideSourceContext value={{ sessionId: S, workerId: null }}>
      <Message item={chatItem(S, 'user', 'Also the tests', delivery === undefined ? {} : { delivery })} modelName="GPT-6 Sol" providerName="Codex" current />
    </AsideSourceContext>,
  );

describe('a message’s delivery (V8; C38–C44)', () => {
  it.each(['sent', 'taken', 'next-prompt', 'not-confirmed', 'cancelled'] as const)('says %s under the message, after its text', (state) => {
    show({ state, detail: null });
    const line = screen.getByText(DELIVERY_WORDS[state]);
    expect(line.getAttribute('data-delivery')).toBe(state);
    const article = screen.getByRole('article');
    expect(article.textContent?.indexOf('Also the tests')).toBeLessThan(article.textContent?.indexOf(DELIVERY_WORDS[state]) ?? 0);
  });

  it('says Not sent with the CLI’s own word', () => {
    show({ state: 'not-sent', detail: 'code -32000' });
    expect(screen.getByText(DELIVERY_WORDS['not-sent']).textContent).toBe(`${DELIVERY_WORDS['not-sent']} (code -32000)`);
  });

  it('says nothing for a message sent as a prompt', () => {
    show();
    expect(document.querySelector('[data-delivery]')).toBeNull();
  });
});
