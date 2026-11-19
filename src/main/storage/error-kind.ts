// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What a log may say about an error: its class and its code, never its message or stack. A file
// system error's message holds the file's path, and with it the user's name (M12, C54, C77).

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const CODE = /^[A-Z][A-Z0-9_]*$/;

/** `Error EPERM`, `TypeError`, `IpcError` … — or `unknown` for something that is not an object. */
export function errorKind(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'unknown';
  const constructorName: unknown = (error as { constructor?: { name?: unknown } }).constructor?.name;
  const name = typeof constructorName === 'string' && IDENTIFIER.test(constructorName) ? constructorName : 'unknown';
  const code = 'code' in error ? error.code : undefined;
  return typeof code === 'string' && CODE.test(code) ? `${name} ${code}` : name;
}
