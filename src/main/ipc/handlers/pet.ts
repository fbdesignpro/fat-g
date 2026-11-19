// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { PetSize } from '@shared/contracts/pet';
import type { InvokeHandlers } from '../dispatch';

export interface PetHandlerDeps {
  /** The WindowManager's: it hides the window and remembers that it is not wanted. */
  readonly hidePet: () => void;
  /** Sets the size the Pet draws its capsules at, for this run and in the preferences. */
  readonly setPetSize: (size: PetSize) => void;
  /** Brings the Main window forward and asks its page to open the session; nothing for an id of no active session. */
  readonly openSession: (id: string) => void;
  /** Brings Main forward without changing its selected session. */
  readonly showMain: () => void;
}

/** The Pet's asks (decision 0010): its ×, size, session or empty-area press. */
export function petHandlers({ hidePet, setPetSize, openSession, showMain }: PetHandlerDeps): Pick<InvokeHandlers, 'pet:hide' | 'pet:setSize' | 'pet:open' | 'pet:showMain'> {
  return {
    'pet:hide': () => {
      hidePet();
      return null;
    },
    'pet:setSize': ({ size }) => {
      setPetSize(size);
      return null;
    },
    'pet:open': ({ id }) => {
      openSession(id);
      return null;
    },
    'pet:showMain': () => {
      showMain();
      return null;
    },
  };
}
