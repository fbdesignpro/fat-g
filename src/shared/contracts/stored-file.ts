// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What Start fresh and Try again answer, for either stored file (docs/planning/_archive/M12.md, Design 3).
// Both act only on a file fat-g refused: for a file it reads, there is nothing to start over from.

export type StartFreshResult =
  /** The refused file was moved aside, unchanged, to `keptAs` — a full path in fat-g's data folder. */
  | { readonly status: 'done'; readonly keptAs: string }
  | { readonly status: 'refused'; readonly reason: 'not-refused' };

export type RetryResult =
  /** The file was read again and loaded. */
  | { readonly status: 'loaded' }
  /** Nothing to retry, or the new read refused the file too — the status says why. */
  | { readonly status: 'refused'; readonly reason: 'not-refused' | 'still-refused' };
