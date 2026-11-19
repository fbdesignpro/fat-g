// Types for package-audit.mjs, so tests/packaging can import it under strict TypeScript.
export declare const LIMITS: { readonly archiveBytes: number; readonly fileBytes: number };
export declare function packageKey(file: string): string | undefined;
export declare function auditArchive(files: readonly string[], expected: readonly string[]): { unexpected: string[]; missing: string[] };
export declare function forbiddenPaths(paths: readonly string[]): string[];
export declare function privacyNeedles(input: { home?: string; repo?: string; fixtureStrings: readonly string[] }): string[];
export declare function containsNeedle(text: string, needles: readonly string[], caseInsensitive: boolean): boolean;
export declare const EXPECTED_FUSES: Readonly<Record<string, boolean>>;
export declare function fuseMismatches(wire: Readonly<Record<number, number>>, options: Readonly<Record<string, number>>): string[];
export declare function flavorProblems(flavor: 'release' | 'smoke', mainFiles: readonly { path: string; text: string }[]): string[];
export declare function noticesMissing(notices: string, packages: readonly { name: string; version: string }[]): string[];
export declare function assetNoticesMissing(notices: string, lines: readonly string[]): string[];
export declare const FONT_DIRECTORY: string;
export declare const FONT_FILES: Readonly<Record<string, string>>;
export declare function assetProblems(files: readonly { path: string; sha256?: string }[]): string[];
