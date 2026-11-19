// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { FatgBridge } from '@shared/ipc/bridge';

declare global {
  interface Window {
    readonly fatg: FatgBridge;
  }
}

export {};
