import type { ProviderSnapshot } from '@shared/contracts/status';

/** Shared by the usage strip and its box sizing so hidden accounts reserve no space. */
export function isUsageVisible(provider: ProviderSnapshot): boolean {
  return provider.status.kind !== 'disabled' && provider.presence !== 'missing' && provider.presence !== 'checking';
}
