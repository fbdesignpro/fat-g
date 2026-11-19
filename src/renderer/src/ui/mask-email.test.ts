// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { maskEmail } from './mask-email';

describe('maskEmail', () => {
  it('keeps the first letter and the domain', () => {
    expect(maskEmail('user@example.com')).toBe('u•••@example.com');
  });

  it('hides how long the local part was', () => {
    expect(maskEmail('a@example.com')).toBe('a•••@example.com');
    expect(maskEmail('averylongname@example.com')).toBe('a•••@example.com');
  });

  it('uses the last @, so an address inside an address stays hidden', () => {
    expect(maskEmail('user@work@example.com')).toBe('u•••@example.com');
  });

  it.each(['', '@example.com', 'not-an-address', '@'])('hides %j completely rather than guessing', (value) => {
    expect(maskEmail(value)).toBe('•••');
  });

  it('never returns the address it was given', () => {
    for (const address of ['user@example.com', 'a@b.co', 'first.last+tag@sub.example.org']) {
      expect(maskEmail(address)).not.toBe(address);
    }
  });
});
