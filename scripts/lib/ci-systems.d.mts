// Types for ci-systems.mjs, so tests/ci can import it under strict TypeScript.
export declare const RUNNERS: Readonly<Record<'windows' | 'macos' | 'linux', string>>;
export declare function chooseRunners(run: { event: string; message?: string; requested?: string }): string[];
