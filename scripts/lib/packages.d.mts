// Types for packages.mjs, so tests/packaging can import it under strict TypeScript.
export interface ShippedPackage { key: string; name: string; version: string; license: string | null }
export interface Lockfile { packages?: Record<string, { name?: string; version: string; license?: string; dev?: boolean; devOptional?: boolean; optional?: boolean; peer?: boolean; link?: boolean }> }
export declare function nameAt(key: string): string;
export declare function shippedPackages(lock: Lockfile): ShippedPackage[];
export declare function installed(lock: Lockfile, name: string): ShippedPackage | undefined;
export declare function licenseText(packageDirectory: string): string | null;
export declare function packageNoticeProblems(entries: readonly { name: string; version: string; license: string | null; text: string | null }[], notices?: string): string[];
export declare const PACKAGED_ASSETS: readonly { line: string; licenseFile?: string; text?: string }[];
export declare function renderNotices(
  entries: readonly { name: string; version: string; license: string | null; text: string | null; how: string }[],
  assets?: readonly { line: string; text: string }[],
): string;
