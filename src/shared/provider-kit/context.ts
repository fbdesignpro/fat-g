// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { DiagnosticLogger } from './logger';
import type { ProviderProcesses } from './process';
export interface ProviderContext {
  readonly processes: ProviderProcesses;
  readonly logger: DiagnosticLogger;
  readonly probeDirectory: string;
}
