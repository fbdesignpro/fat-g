// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { ZoomChange } from '@shared/contracts/zoom';
import type { InvokeHandlers } from '../dispatch';

/** `changeZoom` is the zoom control's (src/main/windows/zoom.ts): it applies the step and tells the app state. */
export function zoomHandlers(changeZoom: (to: ZoomChange) => void): Pick<InvokeHandlers, 'zoom:change'> {
  return {
    'zoom:change': ({ to }) => {
      changeZoom(to);
      return null;
    },
  };
}
