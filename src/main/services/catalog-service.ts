// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The catalog in main (docs/planning/_archive/M13.md, Design 5): every provider's defaults, the model list its
// CLI reported, and the user's catalog.json, merged into the app state for the Main window. Created
// before any window opens, so the first snapshot a window receives already has it (C43).
//
//   start            check every defaults → read the override → merge → store.setCatalog
//   registry attach  subscribe to that runtime → 'models' → check → differs? → merge → setCatalog
//   registry detach  drop that runtime's report, if any → merge → setCatalog
//   usage read ended in another account state than the last: drop a report older than the read (C91)
//                    it reported by itself (Claude's usage session): nothing more
//                    otherwise, for a provider that can be asked: ask after its runtime's first
//                    read, an account change, a Refresh, or once the last answer is an hour old (C92)
//   catalog:reload   read the override → merge → setCatalog → answer its status
//   avatars scanned  merge → setCatalog, each model with the avatar it now resolves to (M102, C29)
//
// Memory only (C33): the reports depend on the account's plan, and account data never reaches the
// disk (decision 0004). Electron-free, like the stores: main passes it its folder and clock.
import path from 'node:path';
import type { ModelLabel } from '@shared/contracts/avatar-overlay';
import type { ResolvedAvatar } from '@shared/contracts/avatars';
import { CATALOG_FILE, type CatalogDefaults, type ModelReport, ModelReportSchema, type OverrideStatus } from '@shared/contracts/catalog';
import { FIRST_INSTANCE_ID, type InstanceId, type InstanceRef } from '@shared/contracts/instances';
import type { AgentProvider, ProviderDefinition } from '@shared/provider-kit/provider';
import { parseDefaults } from '../catalog/defaults';
import { mergeCatalog, type OverrideCounts } from '../catalog/merge';
import { latestSmallModel } from '../catalog/small-model';
import { nodeOverrideIo, type OverrideIo, type OverrideReading, readOverride } from '../catalog/override';
import type { AppStateStore } from '../state/app-state-store';
import type { UsageReadEnd } from './usage-service';

/** A provider that can be asked again is asked after a usage read once its last answer is this old (C92). */
export const MODEL_REREAD_MS = 60 * 60_000;

/** One instance's runtime, as the registry attaches it beside usage (C31; M14b, C20). `id` is its provider's. */
export interface CatalogAttachment {
  readonly id: string;
  /** The provider's first instance when none is named. */
  readonly instanceId?: InstanceId;
  readonly generation: number;
  readonly provider: AgentProvider;
}

export interface CatalogServiceOptions {
  readonly definitions: readonly ProviderDefinition[];
  readonly store: AppStateStore;
  /** fat-g's data folder, where catalog.json is read. */
  readonly dir: string;
  readonly now?: () => number;
  /** Counts and kinds only, never a path or a value from the file (C52). */
  readonly log?: Pick<Console, 'info' | 'warn'>;
  readonly io?: OverrideIo;
  /**
   * What a model's tile draws (M102, C29): the avatar catalog's word, in M102 its provider's default
   * face, and M103's assignment before it. Without it no model carries one.
   */
  readonly avatar?: (providerId: string, key: string, resolvedId: string | null) => ResolvedAvatar | null;
  /** What a model's identifiers say of its version and short name, by its provider (decision 0032). */
  readonly label?: (providerId: string, model: { readonly key: string; readonly resolvedId: string | null }) => ModelLabel;
}

export interface CatalogService {
  /**
   * The instances there are, in the registry's order (M14b, C20): an entry for each, with its
   * provider's presentation, labels and override and a report of its own. A new one lists no model
   * until its CLI reports; one that is gone takes its report with it.
   */
  setInstances(refs: readonly InstanceRef[]): void;
  attach(attachment: CatalogAttachment): void;
  /** Drops the runtime's report: its instance was disabled, blocked or started again (C31, C34). */
  detach(ref: InstanceRef): void;
  /** The usage service's hook: how the instance's last read ended (C91, C92). */
  readEnded(ref: InstanceRef, end: UsageReadEnd): void;
  /** Reads the override again and answers its status (C43, C58). */
  reload(): OverrideStatus;
  /** The avatars' scan landed (M102, C57): each model's avatar is asked again. */
  avatarsChanged(): void;
  stop(): void;
}

interface Held {
  readonly report: ModelReport;
  /** When this list was first reported (C32). */
  readonly at: number;
  /** What an equal report is compared by: the list and the reason, not the count of dropped rows. */
  readonly compared: string;
}

interface Entry {
  /** The provider's id. */
  readonly id: string;
  readonly instanceId: InstanceId;
  /** Its provider's, parsed once. */
  readonly defaults: CatalogDefaults;
  attached?: { readonly attachment: CatalogAttachment; readonly controller: AbortController; readonly unsubscribe: () => void };
  report: Held | null;
  /** When the runtime last sent its models, whatever they were. Null until it has. */
  lastAnswer: number | null;
  /** The last model answer, or ask. Null until either happens for this runtime. */
  lastAsk: number | null;
  /** How the runtime's last read that said ended: signed in, signed out, API key, cloud provider (C91). */
  lastOutcome: Exclude<UsageReadEnd['outcome'], 'other'> | null;
}

export function createCatalogService(options: CatalogServiceOptions): CatalogService {
  const now = options.now ?? Date.now;
  const log = options.log ?? console;
  const io = options.io ?? nodeOverrideIo;
  const file = path.join(options.dir, CATALOG_FILE);
  // Throws on the first defaults that fail the contract: a defect of the build stops the start (C24).
  const defaults = new Map<string, CatalogDefaults>(options.definitions.map((definition) => [definition.descriptor.id, parseDefaults(definition)]));
  const smallModelVersions = new Map(options.definitions.map((definition) => [definition.descriptor.id, definition.smallModelVersion]));
  const known: ReadonlySet<string> = new Set(defaults.keys());
  const keyOf = (ref: InstanceRef): string => `${ref.providerId}\u0000${ref.instanceId}`;
  const newEntry = (ref: InstanceRef, providerDefaults: CatalogDefaults): Entry =>
    ({ id: ref.providerId, instanceId: ref.instanceId, defaults: providerDefaults, report: null, lastAnswer: null, lastAsk: null, lastOutcome: null });
  // In order, and each provider's first instance from the start: the first snapshot a window gets
  // has an entry for every provider, before the registry has said which instances there are.
  let entries = new Map<string, Entry>([...defaults].map(([id, providerDefaults]) => {
    const ref = { providerId: id, instanceId: FIRST_INSTANCE_ID };
    return [keyOf(ref), newEntry(ref, providerDefaults)];
  }));
  let override: OverrideReading = { kind: 'none' };
  let status: OverrideStatus = { kind: 'none', path: file };
  let stopped = false;

  function rebuild(): void {
    const totals = { changed: 0, added: 0, hidden: 0 };
    const providers = [...entries.values()].map((entry) => {
      const { provider, counts } = mergeCatalog({
        id: entry.id,
        instanceId: entry.instanceId,
        defaults: entry.defaults,
        report: entry.report,
        override: override.kind === 'applied' ? override.providers.get(entry.id) ?? null : null,
      });
      totals.changed += counts.changed;
      totals.added += counts.added;
      totals.hidden += counts.hidden;
      const { avatar, label } = options;
      const smallModel = latestSmallModel(provider.models, smallModelVersions.get(entry.id));
      return {
        ...provider,
        ...(smallModel === undefined ? {} : { smallModel }),
        models: provider.models.map((model) => ({
          ...model,
          ...(avatar === undefined ? {} : { avatar: avatar(entry.id, model.key, model.resolvedId) }),
          ...(label === undefined ? {} : { label: label(entry.id, model) }),
        })),
      };
    });
    status = statusOf(override, totals);
    options.store.setCatalog({ providers, override: status });
  }

  function load(): OverrideStatus {
    override = readOverride(file, known, io);
    rebuild();
    switch (override.kind) {
      case 'none':
        break;
      case 'applied':
        if (status.kind === 'applied') log.info(`[catalog] override applied: ${status.changed} changed, ${status.added} added, ${status.hidden} hidden`);
        break;
      case 'ignored':
        log.warn(override.cause === 'unreadable' ? `[catalog] override could not be read (${override.code ?? 'unknown'})` : `[catalog] override ignored (${override.cause})`);
        break;
    }
    return status;
  }

  function statusOf(reading: OverrideReading, counts: OverrideCounts): OverrideStatus {
    switch (reading.kind) {
      case 'none':
        return { kind: 'none', path: file };
      case 'applied':
        return { kind: 'applied', path: file, ...counts, unknownProviders: reading.unknownProviders };
      case 'ignored':
        return { kind: 'ignored', path: file, cause: reading.cause, field: reading.field };
    }
  }

  /** The latest report wins (C91): each adapter runs its model reads one at a time. */
  function receive(entry: Entry, report: ModelReport): void {
    entry.lastAnswer = now();
    entry.lastAsk = entry.lastAnswer;
    const parsed = ModelReportSchema.safeParse(report);
    if (!parsed.success) {
      log.warn(`[catalog] ${entry.id} sent a model report fat-g refused`);
      return;
    }
    // A report with no model never replaces a list (C15).
    if (parsed.data.models.length === 0) return;
    const compared = JSON.stringify({ models: parsed.data.models, speedTierReason: parsed.data.speedTierReason });
    if (compared === entry.report?.compared) return; // C32: no merge, no new seq
    entry.report = { report: parsed.data, at: now(), compared };
    const hidden = parsed.data.models.filter((model) => model.hidden).length;
    log.info(`[catalog] ${entry.id} reported ${parsed.data.models.length} models, ${hidden} hidden, ${parsed.data.dropped} dropped`);
    rebuild();
  }

  /** Unsubscribes at once, so an event from this runtime is never taken afterwards. True when a report went. */
  function release(entry: Entry): boolean {
    entry.attached?.unsubscribe();
    entry.attached?.controller.abort();
    entry.attached = undefined;
    entry.lastAnswer = null;
    entry.lastAsk = null;
    entry.lastOutcome = null;
    const held = entry.report !== null;
    entry.report = null;
    return held;
  }

  function ask(entry: Entry, provider: AgentProvider, signal: AbortSignal): void {
    if (provider.reportModels === undefined) return;
    entry.lastAsk = now();
    try {
      provider.reportModels(signal).catch(() => undefined);
    } catch { /* an adapter's fault never reaches the poll */ }
  }

  load();

  return {
    setInstances(refs) {
      if (stopped) return;
      const next = new Map<string, Entry>();
      for (const ref of refs) {
        const providerDefaults = defaults.get(ref.providerId);
        if (providerDefaults === undefined || next.has(keyOf(ref))) continue;
        next.set(keyOf(ref), entries.get(keyOf(ref)) ?? newEntry(ref, providerDefaults));
      }
      const before = [...entries.keys()];
      for (const [key, entry] of entries) if (!next.has(key)) release(entry);
      entries = next;
      const after = [...entries.keys()];
      if (before.length !== after.length || before.some((key, index) => key !== after[index])) rebuild();
    },

    attach(attachment) {
      const entry = entries.get(keyOf({ providerId: attachment.id, instanceId: attachment.instanceId ?? FIRST_INSTANCE_ID }));
      if (stopped || entry === undefined) return;
      if (release(entry)) rebuild();
      const controller = new AbortController();
      const unsubscribe = attachment.provider.subscribe?.((event) => {
        if (event.type === 'models' && entry.attached?.attachment === attachment) receive(entry, event.report);
      }) ?? (() => undefined);
      entry.attached = { attachment, controller, unsubscribe };
    },

    detach(ref) {
      const entry = entries.get(keyOf(ref));
      if (entry !== undefined && release(entry) && !stopped) rebuild();
    },

    readEnded(ref, end) {
      const entry = entries.get(keyOf(ref));
      const attached = entry?.attached;
      if (stopped || entry === undefined || attached === undefined) return;
      // A failed read says nothing of the account.
      if (end.outcome === 'other') return;
      const changed = entry.lastOutcome !== null && entry.lastOutcome !== end.outcome;
      entry.lastOutcome = end.outcome;
      const answered = entry.lastAnswer !== null && entry.lastAnswer >= end.startedAt;
      // Signed out, signed in, onto an API key: a list from before the read belongs to the account
      // before; one that came during it is the account now (C91).
      if (changed && !answered && entry.report !== null) {
        entry.report = null;
        rebuild();
      }
      // Claude's usage session sends the models it was given: nothing to ask for (C92).
      if (answered) return;
      const stale = entry.lastAsk === null || now() - entry.lastAsk >= MODEL_REREAD_MS;
      if (changed || stale || end.byRefresh) ask(entry, attached.attachment.provider, attached.controller.signal);
    },

    reload() {
      return stopped ? status : load();
    },

    avatarsChanged() {
      if (!stopped) rebuild();
    },

    stop() {
      if (stopped) return;
      stopped = true;
      for (const entry of entries.values()) release(entry);
    },
  };
}
