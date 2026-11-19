// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// jsdom 30 knows <dialog> but implements neither showModal() nor close(). This stand-in does enough
// for component tests: open, close, and the `close` event. What it cannot show — the focus trap, the
// inert page, Escape — is checked in the running app (docs/planning/_archive/M11.md, V16).
export function installDialogStandIn(): void {
  const proto = HTMLDialogElement.prototype;
  proto.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  proto.close = function close(this: HTMLDialogElement, returnValue?: string) {
    if (!this.hasAttribute('open')) return;
    if (returnValue !== undefined) this.returnValue = returnValue;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}
