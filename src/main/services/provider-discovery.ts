// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { PreferencesSnapshot } from '@shared/contracts/prefs';
import type { DiscoveredProvider, ExecutablePresence, ProviderDiscoveryState } from '@shared/contracts/provider-discovery';
import type { ProviderDefinition } from '@shared/provider-kit/provider';
import type { ResolveRequest } from '@shared/provider-kit/process';
import type { PreferencesStore } from '../prefs/store';
import type { AppStateStore } from '../state/app-state-store';
import type { DiscoveryHistory } from '../storage/provider-discovery-history';

export const DISCOVERY_COOLDOWN_MS = 60_000;
export const DISCOVERY_DEADLINE_MS = 3_000;

export interface ProviderDiscovery {
  start(): void;
  scan(force?: boolean): Promise<void>;
  acknowledge(revision: number): Promise<boolean>;
  getSnapshot(): ProviderDiscoveryState;
  subscribe(listener: () => void): () => void;
  stop(): void;
}

export interface DiscoveryOptions {
  readonly definitions: readonly ProviderDefinition[];
  readonly prefs: Pick<PreferencesStore, 'getProviderAdmission' | 'subscribe'> & { readonly getSnapshot?: () => Pick<PreferencesSnapshot, 'providerIssues'> };
  readonly store: Pick<AppStateStore, 'setProviderDiscovery'>;
  readonly history: DiscoveryHistory;
  readonly resolve: (request: ResolveRequest) => Promise<ExecutablePresence>;
  readonly knownDirectories: (definition: ProviderDefinition) => ResolveRequest['knownDirs'];
  readonly cwd: string;
  readonly now?: () => number;
}

export function createProviderDiscovery(options: DiscoveryOptions): ProviderDiscovery {
  const now = options.now ?? (() => performance.now());
  let acknowledged = options.history.acknowledged;
  let baseline = { ...options.history.providers };
  let state: ProviderDiscoveryState = {
    checking: false, notice: null, historyIssue: options.history.unavailable ? 'unavailable' : null,
    providers: options.definitions.map(({ descriptor }) => ({ id: descriptor.id, displayName: descriptor.displayName, presence: 'checking', enabled: false, overrideInvalid: false, checkFailed: false })),
  };
  let revision = 0;
  let epoch = 0;
  let stopped = false;
  let started = false;
  let lastScan = -Infinity;
  let running: Promise<void> | undefined;
  let rerun = false;
  let saving = false;
  let unsubscribe: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const lifetime = new AbortController();
  // Reuse an OS lookup that outlives its deadline rather than accumulating hung scans.
  const lookups = new Map<string, Promise<ExecutablePresence>>();
  const invalidControls = (id: string): boolean => {
    const issue = options.prefs.getSnapshot?.().providerIssues[id];
    return issue === 'invalid-executable-path' || issue === 'invalid-enabled' || issue === 'invalid-provider-entry' || issue === 'invalid-provider-section';
  };
  const controls = () => options.definitions.map(({ descriptor }) => {
    const admission = options.prefs.getProviderAdmission(descriptor.id);
    return JSON.stringify(admission.kind === 'blocked' ? admission : { kind: admission.kind, path: admission.preferences.executablePath, invalid: invalidControls(descriptor.id) });
  });
  let fingerprints = controls();

  function publish(): void {
    const initial = !acknowledged;
    const providers = state.providers.filter((provider) => {
      if (provider.presence === 'blocked' || provider.presence === 'checking') return false;
      if (initial) return true;
      if (provider.presence === 'unknown' || provider.checkFailed) return false;
      const present = provider.presence === 'present';
      return baseline[provider.id] !== present && (baseline[provider.id] !== undefined || present);
    });
    // Refused history has no trustworthy startup baseline. Only changes observed this run are reported.
    const ready = !state.providers.some((provider) => provider.presence === 'checking');
    const proposed = ready && providers.length > 0 ? { initial, providers } : null;
    const before = state.notice === null ? null : { initial: state.notice.initial, providers: state.notice.providers };
    const notice = JSON.stringify(proposed) === JSON.stringify(before) ? state.notice : proposed === null ? null : { ...proposed, revision: ++revision };
    state = { ...state, notice };
    options.store.setProviderDiscovery(state);
    for (const listener of listeners) listener();
  }

  async function probe(request: ResolveRequest): Promise<ExecutablePresence> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const key = JSON.stringify(request);
    let lookup = lookups.get(key);
    if (lookup === undefined) {
      lookup = Promise.resolve().then(() => lifetime.signal.aborted ? { kind: 'unknown', overrideInvalid: false } as const : options.resolve(request)).catch(() => ({ kind: 'unknown', overrideInvalid: false } as const));
      lookups.set(key, lookup);
      void lookup.finally(() => { if (lookups.get(key) === lookup) lookups.delete(key); });
    }
    let abort = (): void => {};
    try {
      return await Promise.race([
        lookup,
        new Promise<ExecutablePresence>((resolve) => {
          abort = () => resolve({ kind: 'unknown', overrideInvalid: false });
          timer = setTimeout(abort, DISCOVERY_DEADLINE_MS);
          lifetime.signal.addEventListener('abort', abort, { once: true });
        }),
      ]);
    } finally { clearTimeout(timer); lifetime.signal.removeEventListener('abort', abort); }
  }

  async function scan(force = false): Promise<void> {
    if (stopped) return;
    if (running !== undefined) return running;
    if (!force && now() - lastScan < DISCOVERY_COOLDOWN_MS) return;
    lastScan = now();
    const generation = epoch;
    state = { ...state, checking: true };
    publish();
    running = (async () => {
      const providers = await Promise.all(options.definitions.map(async (definition, index): Promise<DiscoveredProvider> => {
        const previous = state.providers[index]!;
        const admission = options.prefs.getProviderAdmission(definition.descriptor.id);
        if (admission.kind === 'blocked' || invalidControls(definition.descriptor.id)) return { ...previous, presence: 'blocked', enabled: false, checkFailed: false };
        let result: ExecutablePresence;
        try { result = await probe({ override: admission.preferences.executablePath, names: definition.executableNames, knownDirs: options.knownDirectories(definition), cwd: options.cwd }); }
        catch { result = { kind: 'unknown', overrideInvalid: false }; }
        const presence = result.kind === 'unknown' && (previous.presence === 'present' || previous.presence === 'missing') ? previous.presence : result.kind;
        return { ...previous, presence, enabled: admission.kind === 'enabled', overrideInvalid: result.kind === 'unknown' ? previous.overrideInvalid : result.overrideInvalid, checkFailed: result.kind === 'unknown' };
      }));
      if (stopped || generation !== epoch) return;
      if (options.history.unavailable && !acknowledged) {
        acknowledged = true;
        baseline = Object.fromEntries(providers.filter((provider) => provider.presence === 'present' || provider.presence === 'missing').map((provider) => [provider.id, provider.presence === 'present']));
      }
      state = { ...state, checking: false, providers };
      publish();
    })().finally(() => {
      running = undefined;
      if (!stopped && rerun) { rerun = false; void scan(true); }
    });
    return running;
  }

  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    scan,
    start() {
      if (started || stopped) return;
      started = true;
      unsubscribe = options.prefs.subscribe(() => {
        const next = controls();
        if (next.every((value, index) => value === fingerprints[index])) return;
        epoch += 1;
        state = { ...state, providers: state.providers.map((provider, index) => next[index] === fingerprints[index] ? provider : { ...provider, presence: 'checking', checkFailed: false }) };
        fingerprints = next;
        publish();
        if (running !== undefined) rerun = true;
        else void scan(true);
      });
      void scan(true);
    },
    async acknowledge(noticeRevision) {
      const notice = state.notice;
      if (stopped || saving || notice === null || notice.revision !== noticeRevision) return false;
      saving = true;
      const next = { ...baseline };
      for (const provider of notice.providers) if ((provider.presence === 'present' || provider.presence === 'missing') && !provider.checkFailed) next[provider.id] = provider.presence === 'present';
      const saved = options.history.unavailable ? false : await options.history.save(next).catch(() => false);
      saving = false;
      if (stopped) return saved;
      // Even a failed save can be dismissed for this run; it is said in Accounts and retried next launch.
      acknowledged = true;
      baseline = next;
      state = { ...state, historyIssue: options.history.unavailable ? 'unavailable' : saved ? null : 'save-failed' };
      publish();
      return true;
    },
    stop() { stopped = true; epoch += 1; lifetime.abort(); unsubscribe?.(); listeners.clear(); lookups.clear(); },
  };
}
