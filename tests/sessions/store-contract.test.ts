// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// V4, V12 (docs/planning/_archive/M18.md; C25): the example provider, in both its forms, passes the store's
// contract — with a history to read back, and with none. Codex passes the same set against its
// replay fake in tests/codex/store.integration.test.ts. A provider with no history capability is
// what M16's Claude will be: its chats show what fat-g recorded, and nothing is asked of it.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ProviderContext } from '@shared/provider-kit/context';
import { exampleDefinitionWithSessions } from '../support/example-provider';
import { describeStoreContract, type StoreHarness } from './store-contract';

function example(history: boolean, messages: 'whole' | 'deltas' = 'whole'): Promise<StoreHarness> {
  const root = mkdtempSync(path.join(tmpdir(), 'fatg-store-contract-'));
  const folder = path.join(root, 'project');
  mkdirSync(folder);
  // One definition is one conversation at the provider: every run of the app reaches the same one.
  const definition = exampleDefinitionWithSessions({ history, messages });
  const facet = definition.factory({} as ProviderContext).sessions;
  if (facet === undefined) throw new Error('the example provider has no facet');
  return Promise.resolve({
    descriptor: definition.descriptor,
    dir: path.join(root, 'data'),
    folder,
    model: 'example-large',
    effort: 'quick',
    prompt: 'Say hello, example provider.',
    facet: () => Promise.resolve(facet),
    dispose: () => { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); return Promise.resolve(); },
  });
}

describeStoreContract('the example provider', () => example(true));
describeStoreContract('the example provider, with no history', () => example(false));
// M19 (C57): the same contract, with every assistant message told in deltas and completed by its whole message.
describeStoreContract('the example provider, telling its messages in deltas', () => example(true, 'deltas'));
describeStoreContract('the example provider, in deltas, with no history', () => example(false, 'deltas'));
