// Types for mutation-files.mjs, so tests/packaging can import it under strict TypeScript.
export declare const TRANSIENT_CODES: readonly string[];
export declare const RETRY_PAUSES_MS: readonly number[];

export interface RetryOptions {
  pause?: (ms: number) => void;
  pauses?: readonly number[];
}
export declare function retrying<T>(action: () => T, options?: RetryOptions): T;

/** The four calls of `node:fs` the files go through. */
export interface MutationFs {
  existsSync(target: string): boolean;
  readFileSync(target: string): Buffer;
  rmSync(target: string, options?: { force?: boolean }): void;
  writeFileSync(target: string, content: string | Uint8Array): void;
}
export interface MutationFiles {
  original(target: string): Buffer | null;
  read(target: string): Buffer | null;
  write(target: string, content: string | Uint8Array): void;
  remove(target: string): void;
  restore(): string[];
  differing(): string[];
  kept(target: string): Buffer | null;
}
export declare function createMutationFiles(options?: RetryOptions & { fs?: MutationFs }): MutationFiles;

export interface SettleOptions {
  root?: string;
  log?: (text: string) => void;
  rescueDirectory?: string;
  fs?: { mkdirSync(target: string, options: { recursive: true }): unknown; writeFileSync(target: string, content: Uint8Array): void };
}
export declare function settleTree(files: MutationFiles, options?: SettleOptions): string[];

/** What `guardTree` needs of a process: a test gives a stand-in. */
export interface GuardedProcess {
  exitCode?: number | string | null | undefined;
  on(event: string, listener: () => void): unknown;
  exit(code: number): unknown;
}
export declare function guardTree(files: MutationFiles, options?: SettleOptions & { target?: GuardedProcess }): void;
export declare function turn(): Promise<void>;
export declare function leftMutated(failed: readonly string[], root?: string): Error;
