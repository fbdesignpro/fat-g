// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The version envelope every stored format carries (decision 0005): `schemaVersion`, the format
// the file is written in, and `minReaderVersion`, the oldest reader that may read and edit it.
// Shared by preferences and records; what a refusal means for each file is that store's business.

export type EnvelopeReading =
  | { readonly kind: 'ok'; readonly schemaVersion: number; readonly minReaderVersion: number }
  /** Not an object, or the numbers are missing, not positive integers, or out of order. */
  | { readonly kind: 'corrupt' }
  /** The file needs a newer reader than this one. */
  | { readonly kind: 'newer'; readonly schemaVersion: number; readonly minReaderVersion: number }
  /** An older format. Before the first public release it is refused, not migrated (decision 0014). */
  | { readonly kind: 'older'; readonly schemaVersion: number; readonly minReaderVersion: number };

export function readEnvelope(document: unknown, readerVersion: number): EnvelopeReading {
  if (!plainObject(document)) return { kind: 'corrupt' };
  const schemaVersion = positiveInteger(document['schemaVersion']);
  const minReaderVersion = positiveInteger(document['minReaderVersion']);
  if (schemaVersion === null || minReaderVersion === null || minReaderVersion > schemaVersion) return { kind: 'corrupt' };
  if (minReaderVersion > readerVersion) return { kind: 'newer', schemaVersion, minReaderVersion };
  if (schemaVersion < readerVersion) return { kind: 'older', schemaVersion, minReaderVersion };
  return { kind: 'ok', schemaVersion, minReaderVersion };
}

export function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : null;
}

export function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
