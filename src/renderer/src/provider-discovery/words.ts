// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { DiscoveredProvider } from '@shared/contracts/provider-discovery';

export function discoveryProviderText(provider: DiscoveredProvider): string {
  switch (provider.presence) {
    case 'checking': return 'Checking installation...';
    case 'blocked': return 'Detection paused until provider preferences are repaired.';
    case 'unknown': return 'Could not check installation. Check Accounts settings.';
    case 'missing': return provider.overrideInvalid ? 'Saved executable not found. Inactive until its path is repaired.' : 'CLI not found. Install it or choose its executable in Accounts settings.';
    case 'present': return provider.enabled ? 'Detected and enabled.' : 'Detected. Kept off by your choice.';
  }
}
