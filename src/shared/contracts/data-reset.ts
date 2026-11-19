// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

/** Main-only diagnostics. The folder never comes from a renderer request. */
export interface DataResetInfo {
  readonly folder: string;
  readonly available: boolean;
}
export type DataResetResult = { readonly status: 'scheduled' } | { readonly status: 'failed' };
