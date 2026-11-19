// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { ConnectionOptions, OpenConnection, SupervisedConnection, SupervisorOptions } from './rpc';

/** `cleanup-failed` doubles as the refusal of a scope latched by an unconfirmed cleanup. */
export type FailureCode = 'spawn-failed' | 'aborted' | 'timeout' | 'output-limit' | 'transport-closed' | 'protocol-error' | 'rpc-error' | 'circuit-open' | 'disposed' | 'cleanup-failed';
/** Only these reviewed fields may cross a diagnostic boundary. Never attach a raw cause. */
export class ProcessFailure extends Error {
  constructor(readonly code: FailureCode, readonly numericCode?: number) {
    super(code);
    this.name = 'ProcessFailure';
  }
}
export interface Executable { readonly path: string; readonly kind: 'native' | 'cmd-shim' }
/**
 * What a launch through a `.cmd` shim cannot carry (M16, C20): cmd's expansion and a batch file's
 * second parse are not lossless for a value holding one of these characters, so the process layer
 * refuses the launch rather than pass on altered text. One rule in one place: the process layer
 * applies it to a shim's path and to every argument, and an adapter applies it first to a value it
 * can leave out. A native executable, and so every launch outside Windows, refuses none.
 */
export function shimRefuses(value: string): boolean {
  return /[%!\r\n"&|<>^()]/.test(value);
}
/** A bounded search of a provider-declared runtime installation folder: its children, and at most one level inside each. */
export interface VersionedInstallDirectory {
  readonly root: string;
  readonly children: 'version' | 'hash';
  /** A second level of build folders inside each child, read newest child first, before `suffix`. */
  readonly nested?: 'version' | 'hash';
  readonly suffix: readonly string[];
  /** An executable directly in the root, used when no child holds one: an app can leave a stale copy there. */
  readonly includeRoot?: boolean;
}
export type InstallDirectory = string | VersionedInstallDirectory;
export interface ResolveRequest {
  readonly override: string | null;
  readonly names: readonly string[];
  readonly knownDirs: readonly InstallDirectory[];
  readonly cwd: string;
  /** Without an override, name every CLI found (`others`), not the first alone: detection keeps the newest (newest.ts). */
  readonly every?: boolean;
}
export type Resolution = {
  readonly status: 'found';
  readonly executable: Executable;
  readonly source: 'override' | 'path' | 'known-dir';
  /** With `every`: the other CLIs found, in the resolver's order, each once, eight at most in all. */
  readonly others?: readonly { readonly executable: Executable; readonly source: 'path' | 'known-dir' }[];
}
  | { readonly status: 'not-found'; readonly reason: 'invalid-override' | 'missing'; readonly overrideInvalid: boolean };
export interface RunOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly stdoutLimit?: number;
}
export interface ExitInfo { readonly code: number | null; readonly signal: string | null }
export interface CleanupResult { readonly ok: boolean }
export type ProcessEvent = { type: 'stdout'; data: Uint8Array } | { type: 'eof' } | { type: 'exit'; info: ExitInfo }
  | { type: 'close'; info: ExitInfo } | { type: 'error'; code: FailureCode } | { type: 'stdin-error' };
export interface ManagedProcess {
  readonly pid: number | undefined;
  /** Exactly one consumer. Events produced before attachment are bounded and retained. */
  consume(listener: (event: ProcessEvent) => void): () => void;
  /** onSent runs when bytes enter the OS stream, before a response can arrive. */
  write(data: Uint8Array, signal?: AbortSignal, onSent?: () => void): Promise<void>;
  end(): void;
  readonly exited: Promise<ExitInfo>;
  readonly closed: Promise<ExitInfo>;
  stop(): Promise<CleanupResult>;
}
/**
 * Reviewed changes a provider makes to the environment its children inherit. Names compare
 * case-insensitively on Windows. `removeNames` wins over the keep lists.
 */
export interface EnvironmentConstraints {
  /** Inherited variables starting with one of these prefixes are dropped unless kept below. */
  readonly removePrefixes?: readonly string[];
  /** Exceptions to `removePrefixes`: persistent user settings the CLI legitimately needs. */
  readonly keepNames?: readonly string[];
  readonly keepPrefixes?: readonly string[];
  /** Always dropped, whatever their prefix: debug switches, parent-session markers. */
  readonly removeNames?: readonly string[];
}
/** Variables named one by one and by prefix. Names compare case-insensitively on Windows. */
export interface VariableSet {
  readonly names: readonly string[];
  readonly prefixes: readonly string[];
}
/**
 * The instance part of a scope's environment (M14b, C8, C9), applied after the provider's
 * constraints: every child of an added instance's scope gets `variable` set to `folder` in place
 * of any inherited value, and none of `withhold`. The first instance's scope has none of this, so
 * its children inherit what the provider's do.
 */
export interface InstanceEnvironment {
  readonly variable: string;
  /** Absolute. The process layer sets it and never looks inside it. */
  readonly folder: string;
  readonly withhold: VariableSet;
}
/**
 * A process opened once and never started again (M16, C71): a session's process that speaks no
 * JSON-RPC. The scope's launch rules, environment and confirmed cleanup are its own; its output is
 * handed raw to its one consumer, with no total limit of the layer's (C16).
 */
export interface OpenedProcess {
  /** The child, for its owner to write to and to take its one output subscription. */
  readonly process: ManagedProcess;
  /** Resolves when the process has ended, with whether its tree is confirmed gone. */
  readonly done: Promise<CleanupResult>;
  /** Ends the process and its tree. Idempotent; resolves as `done` does. */
  close(): Promise<CleanupResult>;
  /**
   * After an end that was not confirmed: the tree's own read-only recheck, true once its recorded
   * root has exited and its pipes have closed. It never kills.
   */
  recheck(): Promise<CleanupResult>;
}
export interface ProviderProcesses {
  resolve(request: ResolveRequest): Promise<Resolution>;
  spawn(executable: Executable, args: readonly string[], options: RunOptions): Promise<ManagedProcess>;
  run(executable: Executable, args: readonly string[], options: RunOptions): Promise<ExitInfo & { stdout: string }>;
  supervise(options: SupervisorOptions): SupervisedConnection;
  /**
   * A connection opened once (M15, C84, C116). Its tree is the scope's, so disposing the scope ends
   * it; but an unconfirmed end of it holds that connection alone and closes the scope to nothing. The
   * scope still counts it when it is disposed or rechecked.
   */
  open(options: ConnectionOptions): Promise<OpenConnection>;
  /**
   * A process opened once, on `open`'s ownership (M16, C71): disposing the scope ends its tree, an
   * unconfirmed end of it holds that process alone and closes the scope to nothing, and the scope
   * still counts it when it is disposed or rechecked. The child is handed over raw.
   */
  openProcess(executable: Executable, args: readonly string[], options: RunOptions): Promise<OpenedProcess>;
  /**
   * A failed cleanup closes this scope to new launches. This read-only recheck releases children
   * whose recorded root has since exited with its pipes closed; when none remain, `ok` is true and
   * an undisposed scope admits launches again. It never kills and never trusts a timeout.
   */
  recheck(): Promise<CleanupResult>;
  dispose(): Promise<CleanupResult>;
}
