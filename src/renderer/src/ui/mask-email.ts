// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/**
 * Hides who an address belongs to while leaving it recognizable: `user@example.com` becomes
 * `u•••@example.com`. Anything that is not an address we understand is hidden completely rather
 * than shown in the hope that it is harmless.
 *
 * The single place that decides how much to hide. M8 may go further — a domain still names an
 * employer — and the Pet window shows no address at all, whatever this returns.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '•••';
  return `${email.slice(0, 1)}•••${email.slice(at)}`;
}
