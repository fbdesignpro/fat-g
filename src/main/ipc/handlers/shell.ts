// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { MAX_ADDRESS, readAddress } from '@shared/contracts/files';
import type { ProviderDefinition } from '@shared/provider-kit/provider';
import { InvalidIpcRequest, type InvokeHandlers } from '../dispatch';
import type { KindCounts } from './counts';

/** Each registered provider's installation guide, by id: what `shell:openLink` may open (M13, C25). */
export function installationGuides(definitions: readonly Pick<ProviderDefinition, 'descriptor' | 'installationGuide'>[]): ReadonlyMap<string, string> {
  return new Map(definitions.map((definition) => [definition.descriptor.id, definition.installationGuide]));
}

/** Why an address is not handed to the system's browser (M19b, C44): counted by kind, and said nowhere else. */
export type AddressRefusal = 'too-long' | 'unparsable' | 'scheme' | 'credentials';

/**
 * What an external address must be (M19b, C44; decision 0022): at most `MAX_ADDRESS` characters, read
 * as `external` by the function the page drew it with (C15), a URL of `http:` or `https:` that
 * parses, with no user name and no password. What is handed over is the parsed URL's own spelling.
 */
export function checkAddress(address: string, platform: string): { readonly ok: true; readonly href: string } | { readonly ok: false; readonly why: AddressRefusal } {
  if (address.length > MAX_ADDRESS) return { ok: false, why: 'too-long' };
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return { ok: false, why: 'unparsable' };
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || readAddress(address, platform) !== 'external') return { ok: false, why: 'scheme' };
  if (url.username !== '' || url.password !== '') return { ok: false, why: 'credentials' };
  if (url.href.length > MAX_ADDRESS) return { ok: false, why: 'too-long' };
  return { ok: true, href: url.href };
}

export interface ShellHandlerDeps {
  /**
   * Each registered provider's installation guide, by id, from its definition (M13, C25). Checked
   * to be `https:` when the catalog starts (C72); the page sends a provider id, never an address.
   */
  readonly guides: ReadonlyMap<string, string>;
  readonly openExternal: (url: string) => Promise<void>;
  /**
   * Opens fat-g's data folder in the file manager — or its plans' folder (M22b, C75), or its avatars'
   * (M102, C40) — and resolves with `shell.openPath`'s answer: empty on success, else a message —
   * which may hold the path, so it goes no further (C59).
   */
  readonly showDataFolder: (folder: 'plans' | 'avatars' | 'audio' | null) => Promise<string>;
  /** Makes the avatars' folder where it is missing, with nothing in it (M102, C40): before it is opened. */
  readonly createAvatarsFolder: () => Promise<void>;
  /** The addresses `shell:openAddress` refused, by kind (M19b, C44). */
  readonly addresses: KindCounts;
  readonly platform?: string;
}

export function shellHandlers(deps: ShellHandlerDeps): Pick<InvokeHandlers, 'shell:openLink' | 'shell:openAddress' | 'shell:showDataFolder'> {
  const platform = deps.platform ?? process.platform;
  return {
    async 'shell:openLink'({ providerId }) {
      const guide = deps.guides.get(providerId);
      // A provider that is not registered is a bad request, as in providers.ts.
      if (guide === undefined) throw new InvalidIpcRequest();
      await deps.openExternal(guide);
      return null;
    },
    // An address a message or a file wrote (M19b, C44, C45): checked, then handed to the system's
    // browser as parsed. fat-g asks for nothing itself: no title, no icon, no redirect followed.
    async 'shell:openAddress'({ address }) {
      const checked = checkAddress(address, platform);
      if (!checked.ok) {
        deps.addresses.add(checked.why);
        throw new InvalidIpcRequest();
      }
      await deps.openExternal(checked.href);
      return null;
    },
    async 'shell:showDataFolder'(request) {
      const folder = request?.folder ?? null;
      // The one folder fat-g makes for the user to fill (M102, C40): empty, and only where it is missing.
      if (folder === 'avatars') await deps.createAvatarsFolder();
      // The page gets `internal` and its fixed sentence; the dispatcher logs this error's kind.
      if ((await deps.showDataFolder(folder)) !== '') throw new Error('the data folder could not be opened');
      return null;
    },
  };
}
