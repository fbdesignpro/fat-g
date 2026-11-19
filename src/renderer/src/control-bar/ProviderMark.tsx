// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { ProviderPresentation } from '@shared/contracts/catalog';

/**
 * A fallback mark drawn from the catalog's path data, an attribute value, never markup.
 *
 * `decorative` hides it from assistive technology where the provider's name is already written
 * beside it; otherwise it is an image named after the provider. `fill` draws it in another colour,
 * as on the provider's colour where it has no logo (M100, C69).
 */
export function ProviderMark({ name, presentation, size = 28, decorative = false, fill }: {
  readonly name: string;
  readonly presentation: ProviderPresentation;
  readonly size?: number;
  readonly decorative?: boolean;
  readonly fill?: string;
}) {
  const { barColor, icon } = presentation;
  const naming = decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': name };
  return (
    <svg viewBox={icon.viewBox} width={size} height={size} focusable="false" {...naming}>
      <path d={icon.path} fill={fill ?? barColor} fillRule="evenodd" />
    </svg>
  );
}
