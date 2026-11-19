// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Reading a stored JSON file, with every way it can fail told apart: a file that is not there is a
// first run, one the OS will not hand over is not, and neither is one that is not JSON.
import { readFileSync } from 'node:fs';

export type JsonFileReading =
  | { readonly kind: 'missing' }
  /** The OS refused the read. `code` is the error's code (`EBUSY`, `EACCES` …), never its message. */
  | { readonly kind: 'unreadable'; readonly code: string | null }
  | { readonly kind: 'invalid-json' }
  | { readonly kind: 'parsed'; readonly value: unknown };

export type ReadText = (path: string) => string;

export const readTextFile: ReadText = (path) => readFileSync(path, 'utf8');

export function readJsonFile(path: string, read: ReadText = readTextFile): JsonFileReading {
  let text: string;
  try {
    text = read(path);
  } catch (error) {
    const code = errorCode(error);
    return code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable', code };
  }
  try {
    return { kind: 'parsed', value: JSON.parse(text) as unknown };
  } catch {
    return { kind: 'invalid-json' };
  }
}

export function errorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : null;
}

/** How both stores write: two-space indentation and a final newline, so the file reads well by hand. */
export function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
