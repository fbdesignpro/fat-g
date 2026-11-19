// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// One runtime per provider instance (docs/planning/_archive/M14b.md, Design 6; C7). Every provider has a first
// instance, which runs as the provider always did; a provider that declares instances also has one
// runtime per account the preferences hold, each the same CLI started in a scope that sets the
// declared variable to the account's folder. Each instance has its own scope, generation, work queue
// and cleanup latch, so one's failure, or its cleanup that could not be confirmed, leaves the others
// as they are.
import { FIRST_INSTANCE_ID, shownFirstLabel, type InstanceEntry, type InstanceRef } from '@shared/contracts/instances';
import type { ProviderActionResult } from '@shared/contracts/provider';
import type { ProviderSnapshot, ProviderStatus } from '@shared/contracts/status';
import type { ProviderContext } from '@shared/provider-kit/context';
import type { EnvironmentConstraints, InstanceEnvironment, ResolveRequest, VariableSet } from '@shared/provider-kit/process';
import type { AgentProvider, ProviderDefinition } from '@shared/provider-kit/provider';
import type { SessionFacet } from '@shared/provider-kit/sessions';
import type { InstanceGuard } from '../instances/admission';
import type { InstanceAdmission } from '../prefs/compatibility';
import type { PreferencesStore } from '../prefs/store';
import type { AppStateStore } from '../state/app-state-store';
import type { CatalogService } from './catalog-service';
import type { UsageService } from './usage-service';
import type { ProviderDiscovery } from './provider-discovery';

export interface ProviderRegistryOptions {
  readonly definitions: readonly ProviderDefinition[];
  readonly store: AppStateStore;
  readonly prefs: PreferencesStore;
  readonly usage: UsageService;
  /** Holds each runtime's model report: attached beside usage, and detached wherever usage is (M13, C31). */
  readonly catalog: Pick<CatalogService, 'attach' | 'detach' | 'stop' | 'setInstances'>;
  /**
   * One process scope per generation, under the provider's environment policy. An added instance's
   * scope also sets the declared variable to its folder and withholds what the module names (C8, C9).
   */
  readonly createContext: (environment?: EnvironmentConstraints, instance?: InstanceEnvironment) => ProviderContext;
  readonly knownDirectories: (definition: ProviderDefinition) => ResolveRequest['knownDirs'];
  readonly discovery?: ProviderDiscovery;
  /** Includes active turns, workers, asides and account setup. */
  readonly busy?: (ref: InstanceRef) => boolean;
  /** What an added instance's folder must pass each time its runtime starts (C37, C59, C72). Without it none is admitted. */
  readonly guard?: Pick<InstanceGuard, 'admit'>;
  /** The names in fat-g's own environment that an added instance does not inherit (C64). */
  readonly startedWithout?: (environment: EnvironmentConstraints | undefined, withhold: VariableSet) => readonly string[];
  /** Counts and kinds only: never a label, a folder or an instance id (C49). */
  readonly log?: Pick<Console, 'info' | 'warn'>;
}

/** What a user can do that stops a runtime (C60). */
export type RegistryAction = 'provider-switch' | 'provider-executable' | 'instance-switch' | 'redetect' | 'remove';

export interface ProviderRegistry {
  start(): void;
  has(providerId: string): boolean;
  hasInstance(ref: InstanceRef): boolean;
  /** One read, at once, of that instance alone (C22). */
  refresh(ref: InstanceRef): ProviderActionResult;
  /** Replaces that instance's runtime alone (C60). */
  redetect(ref: InstanceRef): ProviderActionResult;
  /**
   * The instances an action reaches (C60): every instance of the provider for its switch and its
   * executable, the instance itself for its own switch, its Redetect and its Remove. Whatever guards
   * an action against running sessions asks this.
   */
  reachOf(action: RegistryAction, ref: InstanceRef): InstanceRef[];
  /**
   * Ends an added instance's runtime, for Remove (C23, C69), and answers once its process tree is
   * confirmed gone. When that cannot be confirmed the instance reads as a provider does after an
   * unconfirmed cleanup, and its preferences entry must stay. It starts nothing again by itself: the
   * entry's removal retires it, and a Redetect starts it again.
   */
  end(ref: InstanceRef): Promise<{ readonly confirmed: boolean }>;
  /**
   * Whether the registry holds a runtime for the instance whose CLI was found (M15, C112): true from
   * the moment its detection found the CLI until that runtime is replaced or ended. False while it
   * is detecting, and when the CLI could not be started. It says nothing of usage or of an account.
   */
  hasRuntime(ref: InstanceRef): boolean;
  /** The session facet of the instance's current runtime (M15, C12), or undefined: no runtime, or a provider without sessions. */
  facet(ref: InstanceRef): SessionFacet | undefined;
  /**
   * The CLI file the instance's runtime found by a manual override or in a known install folder,
   * where a terminal would not find it by name; null for one found on PATH, or with no runtime. Main
   * only: its sign-in terminal runs it by this path, and app state never holds it.
   */
  executableOffPath(ref: InstanceRef): string | null;
  /** Told whenever an instance gains or loses its runtime (M15, C126). Returns the function that stops it. */
  onRuntimeChanged(listener: () => void): () => void;
  /**
   * The quit's first step (M15, C118): stops new work alone — the watch on the preferences, the
   * usage and catalog services with their timers and the reads under way, and the detections under
   * way. It disposes no runtime and ends no process: a session's process stays up for its Stop.
   */
  quiesce(): void;
  /** The quit's last step: disposes every runtime, and with it every process scope. Resolves once each has answered. */
  dispose(): Promise<void>;
  /** Both at once, as before M15: stops timers and listeners, and starts the disposal of every runtime without waiting for it. */
  stop(): void;
}

interface Runtime {
  readonly generation: number;
  readonly context: ProviderContext;
  readonly provider: AgentProvider;
  readonly controller: AbortController;
  /** Its detection found the CLI: the instance has a runtime to ask (C112). */
  found: boolean;
  /** What `executableOffPath` answers for it, set when its detection found the CLI. */
  offPath?: string;
}

interface Slot {
  readonly definition: ProviderDefinition;
  /** The instance's place in the app state: the first instance's fixed id, or the entry's key. */
  readonly ref: InstanceRef;
  readonly first: boolean;
  label: string;
  readonly startedWithout: readonly string[];
  generation: number;
  desired: number;
  handled: number;
  runtime?: Runtime;
  work?: Promise<void>;
  fingerprint: string;
  cleanupBlocked: boolean;
  /** The scope whose cleanup could not be confirmed; only its recorded children are rechecked. */
  blocked?: ProviderContext;
  /** Set by an explicit Redetect only: disable/re-enable or an override edit never infers safety. */
  recheckRequested: boolean;
  /** Ended for a Remove: nothing starts until the entry goes or a Redetect asks (C69). */
  held: boolean;
  /** Its entry left the preferences: once its runtime has ended, the slot goes too. */
  retired: boolean;
}

export function createProviderRegistry(options: ProviderRegistryOptions): ProviderRegistry {
  const log = options.log ?? console;
  const keyOf = (ref: InstanceRef): string => `${ref.providerId}\u0000${ref.instanceId}`;
  const providerIds = new Set<string>();
  const slots = new Map<string, Slot>();
  /** In the app state's order: by provider, the first instance, then the added ones as stored. */
  let order: Slot[] = [];

  function newSlot(definition: ProviderDefinition, instanceId: string, label: string): Slot {
    const first = instanceId === FIRST_INSTANCE_ID;
    return {
      definition,
      ref: { providerId: definition.descriptor.id, instanceId },
      first,
      label,
      startedWithout: first || definition.instances === undefined ? [] : [...(options.startedWithout?.(definition.environment, definition.instances.withhold) ?? [])],
      generation: 0,
      desired: 0,
      handled: 0,
      fingerprint: '',
      cleanupBlocked: false,
      recheckRequested: false,
      held: false,
      retired: false,
    };
  }

  const held = (providerId: string) => options.prefs.getSnapshot().instances[providerId];
  for (const definition of options.definitions) {
    const id = definition.descriptor.id;
    if (providerIds.has(id)) throw new Error('duplicate provider id');
    providerIds.add(id);
    const slot = newSlot(definition, FIRST_INSTANCE_ID, shownFirstLabel(held(id)?.firstLabel ?? null));
    slots.set(keyOf(slot.ref), slot);
    order.push(slot);
  }
  /** How many instances each provider had at the last look, for the log: a count, never which. */
  const counts = new Map<string, number>();
  let started = false;
  let stopped = false;
  let disposing: Promise<void> | undefined;
  let unsubscribe: (() => void) | undefined;
  let unsubscribeDiscovery: (() => void) | undefined;
  let availabilityTimer: ReturnType<typeof setTimeout> | undefined;
  const discovered = (id: string) => options.discovery?.getSnapshot().providers.find((provider) => provider.id === id);
  const runtimeListeners = new Set<() => void>();
  /** An instance gained or lost its runtime: whoever reads `hasRuntime` is told (C126). */
  function runtimeChanged(): void {
    for (const listener of [...runtimeListeners]) {
      try { listener(); } catch { /* a listener's failure is its own */ }
    }
  }
  let pollInterval = options.prefs.getSnapshot().values.usage.pollIntervalSec;

  /** The preferences' entry of an added instance, by its key. */
  function entryOf(slot: Slot): InstanceEntry | undefined {
    return held(slot.ref.providerId)?.added.find((entry) => entry.key === slot.ref.instanceId);
  }

  function admissionOf(slot: Slot): InstanceAdmission {
    if (slot.first) return options.prefs.getInstanceAdmission(slot.ref);
    const entry = entryOf(slot);
    if (entry === undefined) return { kind: 'blocked', reason: 'not-configured' };
    // An entry with no usable id is known by its run key alone, and by its issue.
    if (entry.id === null) return { kind: 'blocked', reason: 'invalid-instance', issue: entry.issue ?? 'invalid-id' };
    return options.prefs.getInstanceAdmission({ providerId: slot.ref.providerId, instanceId: entry.id });
  }

  function blockedStatus(admission: Extract<InstanceAdmission, { kind: 'blocked' }>): ProviderStatus {
    switch (admission.reason) {
      case 'invalid-instance': return { kind: 'blocked', reason: 'invalid-instance', issue: admission.issue };
      // Gone from the preferences: the slot is on its way out, and shows as switched off until it is.
      case 'not-configured': return { kind: 'disabled' };
      case 'preferences-unavailable':
      case 'invalid-preferences': return { kind: 'blocked', reason: admission.reason };
    }
  }

  /**
   * Makes the slots follow the preferences (C7): a new entry gets one, a label that changed is shown,
   * and an entry that is gone has its runtime ended and then loses its slot. Answers the new slots.
   */
  function sync(): Slot[] {
    const wanted: Slot[] = [];
    const created: Slot[] = [];
    for (const definition of options.definitions) {
      const id = definition.descriptor.id;
      const first = slots.get(keyOf({ providerId: id, instanceId: FIRST_INSTANCE_ID }));
      if (first === undefined) continue;
      first.label = shownFirstLabel(held(id)?.firstLabel ?? null);
      wanted.push(first);
      // A module without the declaration has one instance, whatever its entry holds (C5).
      const entries = definition.instances === undefined ? [] : held(id)?.added ?? [];
      for (const entry of entries) {
        let slot = slots.get(keyOf({ providerId: id, instanceId: entry.key }));
        if (slot === undefined || slot.retired) {
          slot = newSlot(definition, entry.key, entry.label ?? '');
          slots.set(keyOf(slot.ref), slot);
          created.push(slot);
        }
        slot.label = entry.label ?? '';
        wanted.push(slot);
      }
      // An instance whose entry is gone stays listed, after its provider's others, until its runtime has ended.
      for (const slot of order) {
        if (slot.ref.providerId !== id || wanted.includes(slot)) continue;
        if (!slot.retired) retire(slot);
        if (slots.get(keyOf(slot.ref)) === slot) wanted.push(slot);
      }
      const count = wanted.filter((slot) => slot.ref.providerId === id && !slot.retired).length;
      if (count !== (counts.get(id) ?? 1)) log.info(`[providers] ${id}: ${count} ${count === 1 ? 'instance' : 'instances'}`);
      counts.set(id, count);
    }
    order = wanted;
    options.catalog.setInstances(order.filter((slot) => !slot.retired).map((slot) => slot.ref));
    options.store.updateProviders((providers) => order.map((slot) => {
      const current = providers.find((provider) => provider.id === slot.ref.providerId && provider.instanceId === slot.ref.instanceId);
      if (current === undefined) return baseSnapshot(slot, initialStatus(slot));
      return current.label === slot.label ? current : { ...current, label: slot.label };
    }));
    return created;
  }

  function start(): void {
    if (started || stopped) return;
    sync();
    started = true;
    for (const slot of order) {
      slot.fingerprint = preferenceFingerprint(slot);
      replace(slot);
    }
    unsubscribeDiscovery = options.discovery?.subscribe(availabilityChanged);
    unsubscribe = options.prefs.subscribe((snapshot) => {
      if (stopped) return;
      if (snapshot.values.usage.pollIntervalSec !== pollInterval) {
        pollInterval = snapshot.values.usage.pollIntervalSec;
        options.usage.preferencesChanged();
      }
      // A new entry starts at once (C22).
      sync();
      for (const slot of order) {
        if (slot.retired) continue;
        const next = preferenceFingerprint(slot);
        if (next === slot.fingerprint) continue;
        // Availability can be awaiting idle. An unrelated preference write must not bypass that hold.
        if (options.discovery !== undefined && slot.runtime !== undefined && options.busy?.(slot.ref) === true) {
          availabilityTimer ??= setTimeout(availabilityChanged, 1000);
          continue;
        }
        slot.fingerprint = next;
        replace(slot);
      }
    });
  }

  /** Apply installation changes; defer runtime replacement until affected work is idle. */
  function availabilityChanged(): void {
    if (!started || stopped) return;
    clearTimeout(availabilityTimer);
    availabilityTimer = undefined;
    let changed = false;
    options.store.updateProviders((providers) => {
      const next = providers.map((provider) => {
        const presence = discovered(provider.id)?.presence;
        if (presence === provider.presence) return provider;
        changed = true;
        return { ...provider, presence };
      });
      return changed ? next : providers;
    });
    let deferred = false;
    for (const slot of order) {
      if (slot.retired) continue;
      const next = preferenceFingerprint(slot);
      if (next === slot.fingerprint) continue;
      if (slot.runtime !== undefined && options.busy?.(slot.ref) === true) { deferred = true; continue; }
      slot.fingerprint = next;
      replace(slot);
    }
    if (changed) runtimeChanged();
    // Only while cleanup waits for work to finish; this never rescans or launches a CLI.
    if (deferred) availabilityTimer = setTimeout(availabilityChanged, 1000);
  }

  /**
   * What a change of must replace the runtime (C60): the provider's switch and executable, then the
   * instance's own switch and folder. A label is not in it: a rename replaces nothing.
   */
  function preferenceFingerprint(slot: Slot): string {
    const admission = admissionOf(slot);
    const presence = discovered(slot.ref.providerId)?.presence;
    const availability = presence === 'checking' || presence === 'missing' || presence === 'blocked' ? presence : 'ready';
    if (admission.kind !== 'blocked') return `${admission.kind}:${admission.preferences.enabled}:${admission.preferences.executablePath ?? ''}:${admission.folder ?? ''}:${availability}`;
    return `blocked:${admission.reason}:${admission.reason === 'invalid-instance' ? admission.issue : ''}`;
  }

  function replace(slot: Slot, hold = false): void {
    if (stopped) return;
    slot.held = hold;
    slot.desired += 1;
    slot.runtime?.controller.abort();
    // Replaced from here on: it is no runtime to start a session on.
    if (slot.runtime?.found === true) { slot.runtime.found = false; runtimeChanged(); }
    options.usage.detach(slot.ref);
    options.catalog.detach(slot.ref);
    publish(slot, hold ? { kind: 'disabled' } : initialStatus(slot));
    ensureDrain(slot);
  }

  /** Its entry is gone: end its runtime, and drop the slot once that is confirmed. */
  function retire(slot: Slot): void {
    slot.retired = true;
    slot.desired += 1;
    slot.runtime?.controller.abort();
    if (slot.runtime?.found === true) { slot.runtime.found = false; runtimeChanged(); }
    options.usage.forget(slot.ref);
    options.catalog.detach(slot.ref);
    // Nothing to end and nothing unconfirmed: it goes at once.
    if (slot.runtime === undefined && slot.work === undefined && !slot.cleanupBlocked) {
      slots.delete(keyOf(slot.ref));
      slot.handled = slot.desired;
      return;
    }
    ensureDrain(slot);
  }

  function ensureDrain(slot: Slot): void {
    if (slot.work === undefined) {
      slot.work = drain(slot).finally(() => {
        slot.work = undefined;
        if (!stopped && slot.handled < slot.desired) ensureDrain(slot);
      });
    }
  }

  /** A retired slot whose runtime has ended leaves the list; one that could not be confirmed stays, saying so. */
  function drop(slot: Slot): void {
    const current = slots.get(keyOf(slot.ref));
    order = order.filter((other) => other !== slot);
    // An entry of the same key came back meanwhile: the place in the list is that slot's now.
    if (current !== undefined && current !== slot) return;
    slots.delete(keyOf(slot.ref));
    options.store.updateProviders((providers) => providers.filter((provider) => provider.id !== slot.ref.providerId || provider.instanceId !== slot.ref.instanceId));
  }

  async function drain(slot: Slot): Promise<void> {
    while (!stopped && slot.handled < slot.desired) {
      const target = slot.desired;
      const recheck = slot.recheckRequested;
      slot.recheckRequested = false;
      const old = slot.runtime;
      slot.runtime = undefined;
      if (old !== undefined && !(await disposeRuntime(old))) block(slot, old.context);
      if (slot.cleanupBlocked) {
        // A new generation must never overlap an unconfirmed one. Only an explicit Redetect may
        // re-examine the recorded children; a timeout or a preference toggle proves nothing.
        if (!recheck || !(await recover(slot))) {
          publish(slot, recheck ? restartRequired() : cleanupFailure());
          slot.handled = target;
          return;
        }
      }
      if (slot.retired) {
        slot.handled = slot.desired;
        drop(slot);
        return;
      }
      if (stopped || target !== slot.desired) {
        slot.handled = target;
        continue;
      }
      if (slot.held) {
        slot.handled = target;
        continue;
      }

      const admission = admissionOf(slot);
      if (admission.kind === 'blocked') {
        publish(slot, blockedStatus(admission));
        slot.handled = target;
        continue;
      }
      if (admission.kind === 'disabled') {
        publish(slot, { kind: 'disabled' });
        slot.handled = target;
        continue;
      }

      const presence = discovered(slot.ref.providerId)?.presence;
      if (presence === 'checking' || presence === 'missing' || presence === 'blocked') {
        publish(slot, initialStatus(slot));
        slot.handled = target;
        continue;
      }

      // An added instance's folder is checked again at each start (C59), before anything is launched.
      let instance: InstanceEnvironment | undefined;
      if (!slot.first) {
        const support = slot.definition.instances;
        const refused = support === undefined || admission.folder === null ? { kind: 'blocked', reason: 'folder-missing' } as const : await folderStatus(slot);
        if (stopped || target !== slot.desired) {
          slot.handled = target;
          continue;
        }
        if (refused !== null || support === undefined || admission.folder === null) {
          if (refused !== null) publish(slot, refused);
          slot.handled = target;
          continue;
        }
        instance = { variable: support.variable, folder: admission.folder, withhold: support.withhold };
      }

      let context: ProviderContext;
      try {
        context = options.createContext(slot.definition.environment, instance);
      } catch {
        publish(slot, { kind: 'error', message: 'The CLI process service is unavailable.' });
        slot.handled = target;
        continue;
      }
      let provider: AgentProvider;
      try {
        provider = slot.definition.factory(context);
      } catch {
        let cleaned = false;
        try { cleaned = (await context.processes.dispose()).ok; } catch { /* handled below */ }
        if (!cleaned) block(slot, context);
        publish(slot, cleaned ? { kind: 'error', message: 'The provider could not be started.' } : cleanupFailure());
        slot.handled = target;
        continue;
      }
      const runtime: Runtime = { generation: ++slot.generation, context, provider, controller: new AbortController(), found: false };
      slot.runtime = runtime;
      publish(slot, { kind: 'detecting' });
      const detection = await provider.detect(
        { override: admission.preferences.executablePath, knownDirs: options.knownDirectories(slot.definition) },
        runtime.controller.signal,
      ).catch(() => ({ kind: 'error', reason: 'launch-failed' } as const));

      if (stopped || target !== slot.desired || slot.runtime !== runtime) {
        if (!(await disposeRuntime(runtime))) block(slot, runtime.context);
        if (slot.runtime === runtime) slot.runtime = undefined;
        slot.handled = target;
        if (slot.cleanupBlocked) {
          publish(slot, cleanupFailure());
          return;
        }
        continue;
      }
      if (detection.kind === 'found') {
        runtime.found = true;
        if (detection.installation.source !== 'path' && detection.executable !== undefined) runtime.offPath = detection.executable.path;
        runtimeChanged();
        publish(slot, { kind: 'detecting' }, detection.installation);
        // What this account can use of its provider's modes (M22, C43), now and whenever its module says it changed.
        publishModes(slot, runtime);
        runtime.provider.sessions?.onModesChanged?.(() => { publishModes(slot, runtime); });
        // Before usage: its attach starts a read at once, and that read may report models.
        options.catalog.attach({ id: slot.ref.providerId, instanceId: slot.ref.instanceId, generation: runtime.generation, provider });
        options.usage.attach({
          id: slot.ref.providerId,
          instanceId: slot.ref.instanceId,
          generation: runtime.generation,
          provider,
          descriptor: slot.definition.descriptor,
          installation: detection.installation,
        });
      } else {
        slot.runtime = undefined;
        if (!(await disposeRuntime(runtime))) {
          block(slot, runtime.context);
          publish(slot, cleanupFailure());
        } else {
          publish(
            slot,
            detection.kind === 'not-installed'
              ? { kind: 'not-installed', overrideInvalid: detection.overrideInvalid }
              : { kind: 'error', message: detection.reason === 'probe-failed' ? 'The CLI version check failed.' : 'The CLI could not be started.' },
          );
        }
      }
      slot.handled = target;
    }
  }

  /** The status an added instance's folder gives it, or null when it may start. Logs the kind alone. */
  async function folderStatus(slot: Slot): Promise<ProviderStatus | null> {
    let start: Awaited<ReturnType<InstanceGuard['admit']>>;
    try {
      start = options.guard === undefined ? { kind: 'folder-unchecked' } : await options.guard.admit(slot.ref.providerId, slot.ref.instanceId);
    } catch {
      start = { kind: 'folder-unchecked' };
    }
    if (start.kind === 'admitted') return null;
    log.warn(`[providers] an instance was blocked (${start.kind === 'folder-refused' ? `folder-refused: ${start.refusal.rule}` : start.kind})`);
    switch (start.kind) {
      case 'folder-missing': return { kind: 'blocked', reason: 'folder-missing' };
      case 'folder-refused': return { kind: 'blocked', reason: 'folder-refused', rule: start.refusal.rule };
      // Nothing is known of the folder, so nothing is launched; a Redetect asks again (C72).
      case 'folder-unchecked': return { kind: 'error', message: 'The account’s folder could not be checked.' };
    }
  }

  function block(slot: Slot, context: ProviderContext): void {
    slot.cleanupBlocked = true;
    slot.blocked = context;
  }

  /** Read-only recheck of the recorded children; only confirmed evidence clears the latch. */
  async function recover(slot: Slot): Promise<boolean> {
    const context = slot.blocked;
    if (context === undefined) return false;
    let clean: boolean;
    try { clean = (await context.processes.recheck()).ok && (await context.processes.dispose()).ok; } catch { clean = false; }
    if (!clean) return false;
    slot.cleanupBlocked = false;
    slot.blocked = undefined;
    return true;
  }

  async function disposeRuntime(runtime: Runtime): Promise<boolean> {
    runtime.controller.abort();
    let providerOk = true;
    try { await runtime.provider.dispose(); } catch { providerOk = false; }
    let processOk: boolean;
    try { processOk = (await runtime.context.processes.dispose()).ok; } catch { processOk = false; }
    return providerOk && processOk;
  }

  function initialStatus(slot: Slot): ProviderStatus {
    const admission = admissionOf(slot);
    if (admission.kind === 'blocked') return blockedStatus(admission);
    if (admission.kind === 'disabled') return { kind: 'disabled' };
    const discovery = discovered(slot.ref.providerId);
    if (discovery?.presence === 'missing') return { kind: 'not-installed', overrideInvalid: discovery.overrideInvalid };
    return { kind: 'detecting' };
  }

  /**
   * What an account can use of its provider's modes, and where its sandbox setup stands (M22, C43,
   * C60, C72): its module's word, put on the instance's snapshot for the Main window. Nothing of a
   * runtime that is no longer the slot's is published, and a snapshot made anew carries none until
   * its runtime says again.
   */
  function publishModes(slot: Slot, runtime: Runtime): void {
    const facet = runtime.provider.sessions;
    if (stopped || slot.runtime !== runtime || facet?.modes === undefined) return;
    let modes: ProviderSnapshot['modes'];
    let sandboxSetup: ProviderSnapshot['sandboxSetup'];
    // And whether its CLI takes a plan turn now (M22b, C13, C80): said by the same change.
    let plans: ProviderSnapshot['plans'];
    try {
      modes = facet.modes();
      sandboxSetup = facet.sandbox?.state();
      plans = facet.plans?.();
    } catch {
      log.warn('[providers] an instance could not say which modes it runs');
      return;
    }
    options.store.updateProviders((providers) => providers.map((provider) => (provider.id !== slot.ref.providerId || provider.instanceId !== slot.ref.instanceId
      ? provider
      : { ...provider, modes, ...(sandboxSetup === undefined ? {} : { sandboxSetup }), ...(plans === undefined ? {} : { plans }) })));
  }

  function publish(slot: Slot, status: ProviderStatus, installation: ProviderSnapshot['installation'] = null): void {
    options.store.updateProviders((providers) => {
      const index = providers.findIndex((provider) => provider.id === slot.ref.providerId && provider.instanceId === slot.ref.instanceId);
      if (index < 0) return providers;
      const next = [...providers];
      next[index] = { ...baseSnapshot(slot, status, installation), ...(options.discovery === undefined ? {} : { presence: discovered(slot.ref.providerId)?.presence }) };
      return next;
    });
  }

  /** The slot a request names: the first instance by its fixed id, an added one by its id or its key. */
  function find(ref: InstanceRef): Slot | undefined {
    const slot = slots.get(keyOf(ref)) ?? order.find((other) => other.ref.providerId === ref.providerId && other.ref.instanceId.toLowerCase() === ref.instanceId.toLowerCase());
    return slot === undefined || slot.retired ? undefined : slot;
  }

  /** Why an action on an instance is refused by its preferences, or null. */
  function refusal(slot: Slot): Extract<ProviderActionResult, { status: 'refused' }> | null {
    const admission = admissionOf(slot);
    if (admission.kind === 'blocked') return { status: 'refused', reason: 'preferences-blocked' };
    if (admission.kind === 'disabled') return { status: 'refused', reason: 'disabled' };
    return null;
  }

  return {
    start,
    has: (providerId) => providerIds.has(providerId),
    hasInstance: (ref) => find(ref) !== undefined,
    refresh(ref) {
      const slot = find(ref);
      if (slot === undefined) return { status: 'refused', reason: 'not-ready' };
      return refusal(slot) ?? options.usage.refresh(slot.ref);
    },
    redetect(ref) {
      const slot = find(ref);
      if (slot === undefined) return { status: 'refused', reason: 'not-ready' };
      const refused = refusal(slot);
      if (refused !== null) return refused;
      const presence = discovered(slot.ref.providerId)?.presence;
      // Saved controls discovery cannot use: Accounts says which to repair.
      if (presence === 'blocked') return { status: 'refused', reason: 'preferences-blocked' };
      // No CLI found yet: looking again is the redetect, and a find starts the runtime as at launch.
      if (presence === 'checking' || presence === 'missing') {
        void options.discovery?.scan(true);
        return { status: 'accepted' };
      }
      slot.recheckRequested = true;
      replace(slot);
      return { status: 'accepted' };
    },
    reachOf(action, ref) {
      const slot = find(ref);
      if (slot === undefined) return [];
      if (action === 'provider-switch' || action === 'provider-executable') return order.filter((other) => !other.retired && other.ref.providerId === ref.providerId).map((other) => other.ref);
      return [slot.ref];
    },
    async end(ref) {
      const slot = find(ref);
      if (slot === undefined || slot.first || stopped) return { confirmed: false };
      replace(slot, true);
      while (slot.work !== undefined) await slot.work;
      return { confirmed: !slot.cleanupBlocked };
    },
    hasRuntime: (ref) => {
      const presence = discovered(ref.providerId)?.presence;
      return presence !== 'missing' && presence !== 'checking' && presence !== 'blocked' && find(ref)?.runtime?.found === true;
    },
    facet(ref) {
      const runtime = find(ref)?.runtime;
      return runtime?.found === true ? runtime.provider.sessions : undefined;
    },
    executableOffPath(ref) {
      const runtime = find(ref)?.runtime;
      return runtime?.found === true ? runtime.offPath ?? null : null;
    },
    onRuntimeChanged(listener) {
      runtimeListeners.add(listener);
      return () => runtimeListeners.delete(listener);
    },
    quiesce,
    dispose,
    stop() {
      quiesce();
      void dispose();
    },
  };

  function quiesce(): void {
    if (stopped) return;
    stopped = true;
    unsubscribe?.();
    unsubscribe = undefined;
    unsubscribeDiscovery?.();
    clearTimeout(availabilityTimer);
    options.discovery?.stop();
    options.usage.stop();
    options.catalog.stop();
    // A detection under way is cancelled; a runtime that was found is left as it is.
    for (const slot of slots.values()) slot.runtime?.controller.abort();
  }

  function dispose(): Promise<void> {
    quiesce();
    disposing ??= Promise.all([...slots.values()].flatMap((slot) => (slot.runtime === undefined ? [] : [disposeRuntime(slot.runtime)]))).then(() => undefined);
    return disposing;
  }
}

function cleanupFailure(): ProviderStatus {
  return { kind: 'error', message: 'The previous CLI process could not be stopped safely.' };
}

function restartRequired(): ProviderStatus {
  return { kind: 'error', message: 'The previous CLI process could not be confirmed stopped. Restart fat-g to continue.' };
}

function baseSnapshot(slot: Slot, status: ProviderStatus, installation: ProviderSnapshot['installation'] = null): ProviderSnapshot {
  const descriptor = slot.definition.descriptor;
  return {
    id: descriptor.id,
    instanceId: slot.ref.instanceId,
    label: slot.label,
    instanceVariable: slot.definition.instances?.variable ?? null,
    startedWithout: slot.startedWithout,
    displayName: descriptor.displayName,
    descriptor,
    installation,
    status,
    account: null,
    usage: null,
    asOf: null,
    nextRefreshAt: null,
    refreshing: false,
  };
}
