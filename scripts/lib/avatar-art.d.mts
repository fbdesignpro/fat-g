// Types for avatar-art.mjs, so tests/packaging can import it under strict TypeScript.
export declare const AVATAR_ART_SOURCE: string;
export declare const AVATAR_ART_FOLDER: string;
export declare const AVATAR_ART_LIMIT: number;
export declare function avatarNoticeLine(name: string, licence: string): string;
export declare function familyCredit(folder: string, manifest: unknown): { name: string; licence: string | null };
export declare function avatarFamilyAssets(root: string, prefix?: string): { line: string; licenseFile: string }[];
export declare function auditAvatarArt(input: { files: readonly { path: string; bytes: number }[]; manifests: Readonly<Record<string, unknown>>; notices: string }): string[];
export declare function avatarArtLeaks(files: readonly { path: string; text: string }[], contains: (text: string) => boolean): string[];
