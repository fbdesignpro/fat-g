// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { useEffect, useState } from 'react';

export interface CspViolation {
  readonly directive: string;
  readonly blockedUri: string;
}

/**
 * Collects Content-Security-Policy violations reported by the browser. A healthy build shows
 * zero: anything listed here is either a bug in our markup or an asset trying to load from
 * somewhere it shouldn't.
 */
export function useCspViolations(): readonly CspViolation[] {
  const [violations, setViolations] = useState<readonly CspViolation[]>([]);

  useEffect(() => {
    const onViolation = (event: SecurityPolicyViolationEvent): void => {
      setViolations((current) => [...current, { directive: event.effectiveDirective, blockedUri: event.blockedURI }]);
    };
    document.addEventListener('securitypolicyviolation', onViolation);
    return () => document.removeEventListener('securitypolicyviolation', onViolation);
  }, []);

  return violations;
}
