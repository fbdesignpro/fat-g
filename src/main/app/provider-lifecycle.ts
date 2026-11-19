// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { EventEmitter } from 'node:events';
import type { UsageService } from '../services/usage-service';

export type PowerEvents = Pick<EventEmitter, 'on' | 'removeListener'>;

/** Electron glue kept outside the service: wake and screen unlock revalidate account state. */
export function installProviderLifecycle(power: PowerEvents, usage: UsageService): () => void {
  const suspend = () => usage.suspend();
  const resume = () => usage.resume();
  power.on('suspend', suspend);
  power.on('resume', resume);
  power.on('unlock-screen', resume);
  return () => {
    power.removeListener('suspend', suspend);
    power.removeListener('resume', resume);
    power.removeListener('unlock-screen', resume);
  };
}
