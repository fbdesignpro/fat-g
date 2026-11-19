// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { plainObject, readEnvelope } from './envelope';
import { readJsonFile, serializeJson } from './json-file';
import { writeFileAtomic } from './atomic-write';

export const PROVIDER_DISCOVERY_FILE = 'provider-detection.json';

export interface DiscoveryHistory {
  readonly acknowledged: boolean;
  readonly providers: Readonly<Record<string, boolean>>;
  readonly unavailable: boolean;
  save(providers: Readonly<Record<string, boolean>>): Promise<boolean>;
}

/** Only installation booleans, never paths, account data, CLI output or conversation content. */
export function createDiscoveryHistory(file: string): DiscoveryHistory {
  const read = readJsonFile(file);
  let raw: Record<string, unknown> = { schemaVersion: 1, minReaderVersion: 1, acknowledged: false, providers: {} };
  let unavailable = false;
  if (read.kind === 'parsed') {
    const value = read.value;
    if (readEnvelope(value, 1).kind === 'ok' && plainObject(value) && typeof value['acknowledged'] === 'boolean'
      && plainObject(value['providers']) && Object.values(value['providers']).every((entry) => typeof entry === 'boolean')) raw = value;
    else unavailable = true;
  } else if (read.kind !== 'missing') unavailable = true;
  const providers = unavailable ? {} : raw['providers'] as Record<string, boolean>;
  return {
    acknowledged: !unavailable && raw['acknowledged'] === true,
    providers,
    unavailable,
    async save(next) {
      if (unavailable) return false;
      const document = { ...raw, acknowledged: true, providers: { ...providers, ...next } };
      try {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFileAtomic(file, serializeJson(document));
        raw = document;
        return true;
      } catch { return false; }
    },
  };
}
