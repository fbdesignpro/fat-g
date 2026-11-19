// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Why a session cannot take a prompt (docs/planning/_archive/M15.md, Design 9; C30–C32, C105, C112): the
// first check that fails, in one order, as one word. Main puts it in each session's entry, and
// asks it again when a prompt is sent: it stands before every start and every resume, which is
// when a CLI loads a folder's own configuration.
//
// Pure: what it reads is handed in. It reads the registry's word on an instance's runtime and the
// account's own answer, never the usage status: a session's process is its own, so an instance
// whose usage reading failed or went stale takes a prompt (C112).
//
// The last two reasons are the chat's mode's (docs/planning/_archive/M22.md, Design 3; C43, C46, C89): its
// last start did not confirm it, or its account cannot use it. They stand before a prompt and an
// aside's question alone: a change of the chat's mode asks for every reason but them, since the
// change is their remedy.
import type { InstanceRef } from '@shared/contracts/instances';
import type { TrustAnswer } from '@shared/contracts/projects';
import type { SendBlock, SessionHold } from '@shared/contracts/sessions';
import type { ProviderSnapshot } from '@shared/contracts/status';
import type { SessionRecord } from '../records/format';
import { comparable } from '../records/paths';

export interface GateFacts {
  readonly recordsRefused: boolean;
  /** The conversation store is refused (M18, C33): a prompt could not be recorded. */
  readonly conversationsRefused: boolean;
  /** The demo source is on: its sessions are scripted (C32). */
  readonly demo: boolean;
  /** What the session service holds the session for, as far as it knows (M14b, C29, C62). */
  readonly hold: SessionHold | null;
  /** The instance's CLI was looked for and not found. */
  readonly notInstalled: boolean;
  readonly hasSessions: boolean;
  /** The project still lists the provider (M12, C21). */
  readonly offered: boolean;
  /** The instance's latest account read said that no one is signed in. */
  readonly signedOut: boolean;
  /** The registry holds a runtime for the instance whose CLI was found. */
  readonly connected: boolean;
  /** The folder the session would start or resume in; null when its project has none to give. */
  readonly folder: { readonly isRoot: boolean; readonly trust: TrustAnswer | null; readonly missing: boolean } | null;
  /** The account's list, once reported, no longer names the session's model (decision 0016). Left out, it does. */
  readonly modelUnlisted?: boolean;
  /** What the chat's mode blocks a prompt for (M22, C43, C46), or null. Left out, none. */
  readonly mode?: 'mode-unconfirmed' | 'mode-unavailable' | null;
}

/** The first check that fails, in Design 9's order, or null. */
export function sendBlock(facts: GateFacts): SendBlock | null {
  if (facts.recordsRefused) return 'records-refused';
  if (facts.conversationsRefused) return 'conversations-refused';
  if (facts.demo) return 'demo';
  if (facts.hold === 'provider-unavailable' || facts.notInstalled) return 'provider-unavailable';
  if (!facts.hasSessions) return 'no-sessions';
  if (facts.hold === 'instance-unavailable') return 'instance-unavailable';
  if (facts.hold === 'folder-moved') return 'folder-moved';
  if (!facts.offered) return 'not-offered';
  if (facts.signedOut) return 'signed-out';
  if (!facts.connected) return 'not-connected';
  if (facts.folder === null || !facts.folder.isRoot) return 'folder-not-root';
  if (facts.folder.trust !== 'trusted') return 'folder-not-trusted';
  if (facts.folder.missing) return 'folder-missing';
  if (facts.modelUnlisted === true) return 'model-not-listed';
  return facts.mode ?? null;
}

/**
 * The reasons for which a session's earlier messages are not read either (C57): its provider, its
 * instance, its folder — and a refused conversation store, which has nowhere to put them (M18, C33).
 */
export function blocksHistory(block: SendBlock | null): boolean {
  return block === 'records-refused' || block === 'conversations-refused' || block === 'demo' || block === 'provider-unavailable' || block === 'no-sessions' || block === 'instance-unavailable' || block === 'folder-moved';
}

/** What the gate reads of a project's record: the providers it lists, and each root with its trust answer. */
export interface ProjectRoots {
  readonly providers: readonly string[];
  readonly roots: readonly { readonly path: string; readonly answer: TrustAnswer | null }[];
}

export interface GateOptions {
  readonly recordsRefused: () => boolean;
  /** Without it the conversation store is taken as readable. */
  readonly conversationsRefused?: () => boolean;
  readonly demo: () => boolean;
  /** The app state's snapshot of an instance, or undefined for one it does not list. */
  readonly snapshot: (ref: InstanceRef) => Pick<ProviderSnapshot, 'status' | 'descriptor' | 'presence'> | undefined;
  /** Whether the app state lists any instance yet: false at the launch, until the providers start (M23, C89). Left out, it does. */
  readonly listed?: () => boolean;
  /** True from the moment an instance's detection has found its CLI until that runtime is replaced or ended. */
  readonly hasRuntime: (ref: InstanceRef) => boolean;
  readonly project: (id: string) => ProjectRoots | undefined;
  readonly isMissing: (root: string) => boolean;
  /** A reference the runtime keeps because the record could not store it, with its folder (C108). */
  readonly kept: (sessionId: string) => { readonly folder: string } | undefined;
  /** What the chat's mode blocks a prompt for (M22, C43, C46), or null: the runtime's word. Without it no mode blocks. */
  readonly modeBlock?: (record: SessionRecord) => 'mode-unconfirmed' | 'mode-unavailable' | null;
  /**
   * Whether the session's account lists its model (decision 0016): null while the list is
   * not reported. Asked for every check, a change of mode's too, which is no remedy for it. Without it, every model is listed.
   */
  readonly modelListed?: (record: SessionRecord) => boolean | null;
  readonly platform?: string;
}

export interface Gate {
  /**
   * The reason for a record, given what it is held for. `modes`: false for a change of the chat's
   * mode (M22, C89), which asks for every reason but the two that change remedies.
   */
  block(record: SessionRecord, hold: SessionHold | null, modes?: boolean): SendBlock | null;
  /**
   * Its instance is still being detected (M23, C89): listed as detecting, or not listed because the app
   * state lists no instance yet — the launch, before the providers start. A refusal for no runtime or
   * no instance then waits, rather than pausing a queue.
   */
  detecting(record: SessionRecord): boolean;
  /**
   * The folder a prompt would start or resume the session in (C30): the stored folder of a started
   * session, the project's first root at this moment for one not yet started. Null when there is none.
   */
  folder(record: SessionRecord): string | null;
  /**
   * The project's other folders a session may be handed (M16, C19, C61): its registered roots other
   * than the working folder, each answered trusted and not missing — the gate's own word for the
   * working folder, asked of the others. Read anew at each call, in the project's own order.
   */
  otherFolders(record: SessionRecord): readonly string[];
}

export function createGate(options: GateOptions): Gate {
  const platform = options.platform ?? process.platform;
  const refOf = (record: SessionRecord): InstanceRef => ({ providerId: record.providerId, instanceId: record.instanceId });

  function folder(record: SessionRecord): string | null {
    // A reference kept unsaved is a started session's, its folder kept beside it (C108).
    const started = record.folder ?? options.kept(record.id)?.folder ?? null;
    if (started !== null) return started;
    return options.project(record.projectId)?.roots[0]?.path ?? null;
  }

  return {
    folder,
    otherFolders(record) {
      const working = folder(record);
      const project = options.project(record.projectId);
      if (working === null || project === undefined) return [];
      const own = comparable(working, platform);
      return project.roots.filter((root) => comparable(root.path, platform) !== own && root.answer === 'trusted' && !options.isMissing(root.path)).map((root) => root.path);
    },
    detecting(record) {
      const snapshot = options.snapshot(refOf(record));
      return snapshot === undefined ? options.listed?.() === false : snapshot.status.kind === 'detecting';
    },
    block(record, hold, modes = true) {
      const ref = refOf(record);
      const snapshot = options.snapshot(ref);
      const project = options.project(record.projectId);
      const path = folder(record);
      const root = path === null ? undefined : project?.roots.find((candidate) => comparable(candidate.path, platform) === comparable(path, platform));
      return sendBlock({
        recordsRefused: options.recordsRefused(),
        conversationsRefused: options.conversationsRefused?.() === true,
        demo: options.demo(),
        hold,
        notInstalled: snapshot?.presence === 'missing' || snapshot?.status.kind === 'not-installed',
        hasSessions: snapshot?.descriptor.capabilities.sessions === true,
        offered: project?.providers.includes(record.providerId) === true,
        // Only an account read that answered gives this status; `error` and `stale` are the usage service's.
        signedOut: snapshot?.status.kind === 'not-logged-in',
        connected: options.hasRuntime(ref),
        folder: path === null ? null : { isRoot: root !== undefined, trust: root?.answer ?? null, missing: options.isMissing(root?.path ?? path) },
        modelUnlisted: options.modelListed?.(record) === false,
        mode: modes ? options.modeBlock?.(record) ?? null : null,
      });
    },
  };
}
