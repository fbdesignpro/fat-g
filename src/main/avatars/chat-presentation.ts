// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Conversation presentation is resolved in main, including models absent from the CLI catalog.
// Only identifiers already projected for the selected session are retained; never message text.
import type { ChatPresentation } from '@shared/contracts/chat';
import type { ConversationItem } from '@shared/contracts/conversation';
import type { CatalogState } from '@shared/contracts/catalog';
import type { InstanceRef } from '@shared/contracts/instances';
import type { AvatarResolver } from './assignments';

export interface ChatPresentationOptions {
  readonly selected: () => string | null;
  readonly session: (id: string) => (InstanceRef & { readonly model: string }) | null;
  readonly catalog: () => CatalogState | undefined;
  readonly resolver: Pick<AvatarResolver, 'forSession'>;
}

export interface ChatPresentationProjector {
  project(sessionId: string, items: readonly ConversationItem[], worker?: { readonly id: string; readonly item: ConversationItem | null }): ChatPresentation | undefined;
  /** Clear identities when selection changes or its record is removed. */
  select(): void;
  forget(sessionId: string): void;
  changed(): void;
  subscribe(listener: (sessionId: string, presentation: ChatPresentation) => void): () => void;
}

export function createChatPresentation(options: ChatPresentationOptions): ChatPresentationProjector {
  let selected: string | null = null;
  let revision = 0;
  const models = new Set<string>();
  const workers = new Map<string, string | null>();
  const listeners = new Set<(sessionId: string, presentation: ChatPresentation) => void>();
  const select = (): void => {
    const id = options.selected();
    const next = id !== null && options.session(id) !== null ? id : null;
    if (selected === next) return;
    selected = next;
    models.clear(); workers.clear();
  };
  const resolve = (session: InstanceRef & { readonly model: string }, keys: Iterable<string>, held: ReadonlyMap<string, string | null>): ChatPresentation => {
    const projectedWorkers = Object.fromEntries([...held].map(([id, model]) => [id, { model: model ?? session.model, assumed: model === null }]));
    const all = new Set([...keys, session.model, ...Object.values(projectedWorkers).map((worker) => worker.model)]);
    return {
      revision,
      models: Object.fromEntries([...all].map((model) => [model, options.resolver.forSession(options.catalog(), session, model)])),
      workers: projectedWorkers,
    };
  };
  return {
    select,
    forget(id) { if (id === selected) { selected = null; models.clear(); workers.clear(); } },
    project(sessionId, items, worker) {
      select();
      const session = options.session(sessionId);
      if (session === null) return undefined;
      const keys = new Set(items.flatMap((item) => item.model === null ? [] : [item.model]));
      const ownWorkers = new Map<string, string | null>();
      for (const item of items) {
        if (item.activity?.type === 'worker' && item.activity.workerId !== null) ownWorkers.set(item.activity.workerId, item.activity.model);
      }
      if (worker !== undefined) ownWorkers.set(worker.id, worker.item?.activity?.model ?? null);
      if (selected === sessionId) {
        for (const key of keys) models.add(key);
        for (const [id, model] of ownWorkers) workers.set(id, model);
      }
      return resolve(session, keys, ownWorkers);
    },
    changed() {
      revision += 1;
      select();
      if (selected === null) return;
      const session = options.session(selected);
      if (session === null) return;
      const result = resolve(session, models, workers);
      for (const listener of [...listeners]) listener(selected, result);
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
