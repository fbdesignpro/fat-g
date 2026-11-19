// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { createContext, useContext } from 'react';

/** Only the main chat window owns a gutter; artifact conversations have no host. */
export const HoverTimeHostContext = createContext(false);
/** A message has a usable timestamp, independently of its inline-time preference. */
export const HoverMessageTimeContext = createContext(false);

/** A zero-size decoration in the existing block-margin slot. CSS alone reveals its source. */
export function HoverTimeSource({ kind }: { readonly kind: 'message' | 'block' }) {
  const enabled = useContext(HoverMessageTimeContext);
  return enabled ? <span data-time-source={kind} aria-hidden="true" /> : null;
}

/** Stable callback for Markdown bodies without their own aside controls. */
export const hoverTimeBlock = () => <HoverTimeSource kind="block" />;
