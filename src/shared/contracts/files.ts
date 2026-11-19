// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Files opened from the chat (docs/planning/_archive/M19b.md, Design 4, 7; C15, C22, C34, C49, C52, C56, C64,
// C65; decision 0022): what reads an address, a target, a code span and the words that say a line
// beside one, the names fat-g shows as text and those it draws as images, and what `files:read` and
// `files:showInFolder` take and answer.
//
// Pure, and it imports nothing: the page reads an address with these to draw a control, and main
// reads it again with the same functions to check it, so the two cannot disagree. The platform is a
// parameter, so each system's rules run in every system's tests (S7). The request schemas are in
// src/shared/ipc/contract.ts, which is where zod is.
//
// Nothing here asks the file system anything, and nothing here is a path the page may resolve: a
// reference is a claim, and main checks it (src/main/files).

// ── Bounds ────────────────────────────────────────────────────────────────────────────────────

/** A target's longest length: `MAX_PATH` of contracts/projects.ts, which the contracts test keeps equal. */
export const MAX_TARGET = 4096;
/** The longest address main hands to the system's browser (C44). */
export const MAX_ADDRESS = 2000;
/** What `shell:openAddress` takes at most, so that an address over `MAX_ADDRESS` reaches the handler and is counted. */
export const MAX_ADDRESS_REQUEST = 8192;
/** A file larger than this is not read at all (C29): 2 MiB. */
export const FILE_BYTES_BOUND = 2 * 1024 * 1024;
/** A Markdown file of more units of text than this is shown as plain text (C38). */
export const MARKDOWN_UNITS_BOUND = 500_000;

// ── The names shown as text (C31, C52, C56) ───────────────────────────────────────────────────

/** A name that ends in one of these, in any letter case, is drawn as Markdown (C31). */
export const MARKDOWN_EXTENSIONS = ['.md', '.markdown'] as const;

/**
 * Until M19c, the text files that are shown as plain text (C52): a name that ends in one of the
 * extensions, or is one of the names, in any letter case. One constant, which main reads to name a
 * file's view and the `file` kind reads to draw it (C56); M19c's view replaces it where it is.
 * `.env` is left off on purpose.
 */
export const TEXT_FILES = Object.freeze({
  extensions: Object.freeze([
    '.txt', '.text', '.log', '.json', '.jsonc', '.json5', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.properties', '.xml', '.svg', '.csv', '.tsv',
    '.diff', '.patch', '.py', '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx', '.css', '.scss', '.html', '.htm', '.vue', '.svelte',
    '.sh', '.bash', '.zsh', '.ps1', '.psm1', '.bat', '.cmd', '.sql', '.rs', '.go', '.java', '.kt', '.kts', '.c', '.h', '.cpp', '.hpp', '.cc', '.cs',
    '.rb', '.php', '.swift', '.lua', '.r', '.dart', '.ex', '.exs', '.erl', '.hs', '.scala', '.clj', '.pl', '.m', '.gradle', '.cmake', '.mk',
    '.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.nvmrc',
  ] as const),
  names: Object.freeze(['Makefile', 'Dockerfile', 'Containerfile', 'Justfile', 'Rakefile', 'Gemfile', 'Procfile', 'LICENSE', 'LICENCE', 'NOTICE', 'CHANGELOG', 'README', 'CODEOWNERS', 'AUTHORS'] as const),
});
export const TEXT_FILE_EXTENSIONS: readonly string[] = TEXT_FILES.extensions;
export const TEXT_FILE_NAMES: readonly string[] = TEXT_FILES.names;

/** How a file is shown: drawn as Markdown, as plain text, or not at all (C31). */
export type FileView = 'markdown' | 'plain' | 'other';

const lowerNames: ReadonlySet<string> = new Set(TEXT_FILE_NAMES.map((name) => name.toLowerCase()));
const endsIn = (name: string, endings: readonly string[]): boolean => endings.some((ending) => name.endsWith(ending));

/** The view a file's name gives (C31, C52, C56). `name` is the file's own, the last part of its path. */
export function viewOf(name: string): FileView {
  const lower = name.toLowerCase();
  if (endsIn(lower, MARKDOWN_EXTENSIONS)) return 'markdown';
  return endsIn(lower, TEXT_FILE_EXTENSIONS) || lowerNames.has(lower) ? 'plain' : 'other';
}

// ── Images (decision 0022, item 15) ───────────────────────────────────────────────────────────

/**
 * A name that ends in one of these, in any letter case, is an image's: main reads it as one wherever
 * it lies on this machine's own disks, and the page draws it — in the chat and in the pane — through
 * the media route, by the id main gives it for the run. What it is, its header says, never its name.
 */
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'] as const;

/** Whether a file's name is an image's. `name` is the file's own, the last part of its path. */
export const isImageName = (name: string): boolean => endsIn(name.toLowerCase(), IMAGE_EXTENSIONS);

/** The id main gives an image file for the run: what its address names, never its path. */
export const IMAGE_FILE_ID = /^[0-9a-f]{32}$/;

/** Where the page draws an image file from: the media route's `files` source, by its id. */
export function imageFileAddress(id: string): string {
  return `app://media/files/${id}`;
}

// ── An address (C15) ──────────────────────────────────────────────────────────────────────────

/**
 * What an address is (C15): `external` opens in the system's browser, `local` names a file, and
 * `none` is neither, so nothing is made of it.
 */
export type AddressKind = 'external' | 'local' | 'none';

/** A drive and its separator: `C:\` or `C:/`. */
const DRIVE_PATH = /^[A-Za-z]:[\\/]/;
/** A share's path, `\\host\share`, with either separator. */
const SHARE_PATH = /^[\\/]{2}[^\\/]/;
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;

function parsedUrl(address: string): URL | null {
  try {
    return new URL(address);
  } catch {
    return null;
  }
}

/**
 * A bare name with a line, `main.py:10`: by a URL's syntax its name is a scheme. It is read as a
 * path where a code span of the same text is (C49), so `localhost:3000` and `tel:5551234` are not.
 */
const NAME_WITH_LINE = /^[^\\/:]+:\d{1,9}(?::\d{1,9})?$/;

/** A path this system roots: a drive's or a share's on Windows, one that starts with `/` elsewhere. */
const isSystemPath = (text: string, platform: string): boolean => (platform === 'win32' ? DRIVE_PATH.test(text) || SHARE_PATH.test(text) : text.startsWith('/'));

/**
 * Reads an address (C15). A path of this system is looked for before any scheme: `C:/README.md`
 * parses as a URL of scheme `c:`, and Codex writes a file that way. On another system a drive path
 * is a one-letter scheme, and reads `none`. A bare name with a line is a path, though a URL's syntax
 * would call its name a scheme (C22).
 */
export function readAddress(address: string, platform: string): AddressKind {
  const text = address.trim();
  if (text === '' || text.startsWith('#')) return 'none';
  if (isSystemPath(text, platform)) return 'local';
  const scheme = SCHEME.exec(text)?.[1]?.toLowerCase();
  // No scheme: a path, relative or not.
  if (scheme === undefined || scheme === 'file') return 'local';
  if (scheme === 'http' || scheme === 'https') return (parsedUrl(text)?.host ?? '') === '' ? 'none' : 'external';
  return NAME_WITH_LINE.test(text) && readCodeSpanPath(text) !== null ? 'local' : 'none';
}

// ── A target (C22) ────────────────────────────────────────────────────────────────────────────

/** One path to try for a target, with the line and column the target named for it. */
export interface TargetTry {
  readonly path: string;
  readonly line: number | null;
  readonly column: number | null;
}

export interface TargetReading {
  /** In the order they are tried: as written, percent-decoded, and with a fragment that names no line left off. */
  readonly tries: readonly TargetTry[];
  /** A `file:` URL's host, which main refuses unless it is empty or `localhost` (C26); null for any other target. */
  readonly host: string | null;
}

const LINE_AS_FRAGMENT = /#L(\d{1,9})(?:-L\d{1,9})?$/;
const LINE_AS_COLON = /:(\d{1,9})(?::(\d{1,9}))?$/;
/** A slash and then a drive: how Codex writes a Windows path in a link (K2). */
const SLASH_DRIVE = /^[\\/][A-Za-z]:[\\/]/;

const positive = (digits: string | undefined): number | null => {
  const value = Number(digits);
  return digits !== undefined && Number.isInteger(value) && value >= 1 ? value : null;
};

/** Whether the colon at `index` is a Windows drive's: the second character of a drive path, or of one spelled `/C:/…`. */
const isDriveColon = (text: string, index: number, platform: string): boolean =>
  platform === 'win32' && ((index === 1 && /^[A-Za-z]/.test(text)) || (index === 2 && /^[\\/][A-Za-z]/.test(text)));

/**
 * A text with the line it names taken off its end (C22): `path:line`, `path:line:column`,
 * `path#Lline` or `path#Lline-Lline`, the first line of a range. A drive's colon is never a line.
 */
function takeLine(text: string, platform: string): TargetTry & { readonly named: boolean } {
  const fragment = LINE_AS_FRAGMENT.exec(text);
  if (fragment !== null) return { path: text.slice(0, fragment.index), line: positive(fragment[1]), column: null, named: true };
  const colon = LINE_AS_COLON.exec(text);
  if (colon !== null && !isDriveColon(text, colon.index, platform)) {
    return { path: text.slice(0, colon.index), line: positive(colon[1]), column: positive(colon[2]), named: true };
  }
  return { path: text, line: null, column: null, named: false };
}

/** On Windows `/C:/a/b.md` is that drive's path, the slash dropped; elsewhere a path is as written. */
const withoutSlashBeforeDrive = (path: string, platform: string): string => (platform === 'win32' && SLASH_DRIVE.test(path) ? path.slice(1) : path);

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** A `file:` URL: its path decoded, its line from its fragment or from its path's end. */
function readFileUrl(text: string, platform: string): TargetReading | null {
  const url = parsedUrl(text);
  if (url === null) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  const fromFragment = /^#L(\d{1,9})(?:-L\d{1,9})?$/.exec(url.hash);
  const taken = fromFragment === null ? takeLine(pathname, platform) : { path: pathname, line: positive(fromFragment[1]), column: null };
  const path = withoutSlashBeforeDrive(taken.path, platform);
  if (path === '' || path.includes('\0')) return null;
  return { tries: [{ path, line: taken.line, column: taken.column }], host: url.host };
}

/**
 * Takes a local address apart (C22): the paths to try, each with its line and column. Null for a
 * target that holds U+0000 or is longer than `MAX_TARGET`, and for one that names nothing.
 *
 * The line is taken off before any path is resolved. An address that is no `file:` URL is tried as
 * written and then percent-decoded, where the two differ; one that ends in a fragment naming no
 * line, a heading's address, is tried last without it, so the file opens at its start. `~` and
 * environment variables are not expanded.
 */
export function readTarget(address: string, platform: string): TargetReading | null {
  if (address.length > MAX_TARGET || address.includes('\0')) return null;
  const text = address.trim();
  if (text === '') return null;
  if (!isSystemPath(text, platform) && /^file:/i.test(text)) return readFileUrl(text, platform);
  const taken = takeLine(text, platform);
  const paths = [taken.path, decoded(taken.path)];
  const tries: TargetTry[] = paths.map((path) => ({ path, line: taken.line, column: taken.column }));
  // A fragment that names no line: the file itself, tried after the name that holds the `#`.
  const fragment = taken.named ? -1 : taken.path.indexOf('#');
  if (fragment > 0) {
    const bare = taken.path.slice(0, fragment);
    tries.push({ path: bare, line: null, column: null }, { path: decoded(bare), line: null, column: null });
  }
  const seen = new Set<string>();
  const kept = tries
    .map((entry) => ({ ...entry, path: withoutSlashBeforeDrive(entry.path, platform) }))
    .filter((entry) => {
      if (entry.path === '' || entry.path.includes('\0') || seen.has(entry.path)) return false;
      seen.add(entry.path);
      return true;
    });
  return kept.length === 0 ? null : { tries: kept, host: null };
}

/** Whether a path holds a separator of either kind. */
export const hasSeparator = (path: string): boolean => /[\\/]/.test(path);

/** A path's last part, by either separator: a file's own name. */
export function lastPart(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
}

// ── A code span (C49) ─────────────────────────────────────────────────────────────────────────

/** A code span read as a path: the path, and the line it names. */
export interface CodeSpanPath {
  readonly path: string;
  readonly line: number | null;
  readonly column: number | null;
}

/** Plainly a path: a drive's, one rooted at a separator, or one that starts `./`, `../` or `~/`. */
const PLAINLY_A_PATH = /^(?:[A-Za-z]:[\\/]|[\\/]|\.{1,2}[\\/]|~[\\/])/;
/** An address with a scheme and `//`: a code span that holds one is code. */
const URL_LIKE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
/** What no file's name holds, or a pattern does — and any control character: a code span with one of these is code. */
const NEVER_A_PATH = /[`*?<>|"]|\p{Cc}/u;
/** A version at a name's end: a digit, a dot and a digit. */
const VERSION_END = /\d\.\d+$/;
const SYSTEM_ROOTS = ['/Users/', '/home/', '/root/', '/tmp/', '/var/', '/etc/', '/opt/', '/usr/', '/mnt/', '/media/', '/srv/', '/private/', '/Volumes/'] as const;
/** The generic top-level domains a host's name most often ends in. Any two-letter label is a country's. */
const GENERIC_DOMAINS: ReadonlySet<string> = new Set([
  'com', 'net', 'org', 'edu', 'gov', 'mil', 'int', 'info', 'biz', 'name', 'pro', 'xyz', 'dev', 'app', 'tech', 'cloud', 'site', 'online', 'page', 'blog',
  'wiki', 'news', 'shop', 'store', 'test', 'example', 'invalid', 'local', 'localhost',
]);
const LISTED_ENDINGS: readonly string[] = [...MARKDOWN_EXTENSIONS, ...TEXT_FILE_EXTENSIONS];
/** The listed endings that are a file's whole name: `.gitignore` is a file, `.md` alone is an extension. */
const WHOLE_NAME_ENDINGS: ReadonlySet<string> = new Set(['.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.nvmrc']);

/** Whether a name ends in a listed ending, with something before it or being a file's whole name. */
function hasListedEnding(name: string): boolean {
  const lower = name.toLowerCase();
  return LISTED_ENDINGS.some((ending) => lower.endsWith(ending) && (lower.length > ending.length || WHOLE_NAME_ENDINGS.has(ending)));
}

/** Whether a first segment is a host's name: `localhost`, a dotted number, or a name whose last label is a top-level domain and on no list. */
function isHostName(segment: string): boolean {
  // An address may carry a user before the host and a port after it.
  const lower = (segment.split('@').at(-1) ?? '').split(':')[0]?.toLowerCase() ?? '';
  if (lower === 'localhost' || /^\d+(?:\.\d+)+$/.test(lower)) return true;
  const dot = lower.lastIndexOf('.');
  if (dot <= 0) return false;
  const label = lower.slice(dot + 1);
  if (!/^[a-z]+$/.test(label)) return false;
  // `.md`, `.py`, `.rs` and `.sh` are countries' too.
  if (LISTED_ENDINGS.includes(`.${label}`)) return false;
  return label.length === 2 || GENERIC_DOMAINS.has(label);
}

/**
 * Reads a code span's whole text as a path, with its line, or as none (C49). The file system is not
 * asked: a name that is no file says so when it is pressed (C19). A name in bold or in italics is
 * read by this too, and by nothing else (C64).
 *
 * In order: no backtick, and no white space unless the text is plainly a path; a separator, a line
 * at its end, or a bare name with a listed ending; with a line and no separator, a last part with an
 * extension or a known name; where it is not plainly a path, a first segment that is no host's name,
 * a last part that is no version, and — unless it has a line — one with an extension or a known
 * name; and rooted at `/`, a known system root, a line or an extension.
 */
export function readCodeSpanPath(text: string): CodeSpanPath | null {
  if (text === '' || text.length > MAX_TARGET || NEVER_A_PATH.test(text) || URL_LIKE.test(text)) return null;
  const plain = PLAINLY_A_PATH.test(text);
  // A space is let into a path that is plainly one: a home folder with a space in its name.
  if (/\s/.test(text) && !(plain && !/[^\S ]/.test(text) && text === text.trim())) return null;
  // A drive's colon is no line on any system: the same span reads the same wherever it is drawn.
  const { path, line, column, named: hasLine } = takeLine(text, 'win32');
  if (path === '') return null;
  const last = lastPart(path);
  const hasName = /^.+\.[A-Za-z0-9_+-]+$/.test(last) || lowerNames.has(last.toLowerCase()) || hasListedEnding(last);
  if (!hasSeparator(path)) {
    if (hasLine ? !hasName : !hasListedEnding(last)) return null;
  }
  if (!plain) {
    if (isHostName(path.split(/[\\/]/, 1)[0] ?? '')) return null;
    if (VERSION_END.test(last)) return null;
    if (!hasLine && !hasName) return null;
  }
  if (path.startsWith('/') && !SYSTEM_ROOTS.some((root) => path.startsWith(root)) && !hasLine && !/^.+\.[A-Za-z0-9_+-]+$/.test(last)) return null;
  return { path, line, column };
}

// ── A line said in words (C65) ────────────────────────────────────────────────────────────────

/** How much of the text before a reference is read for its line, and how much beside one a drawing gathers: the words that touch it, and no sentence further. */
export const LINE_WORDS_SPAN = 64;

/** A line's number, with nothing of a longer number after it: `1,024` and `12345678901` name none. */
const LINE_NUMBER = String.raw`(\d{1,9})(?!\d|,\d)`;
/**
 * Right after a reference: `at line 12`, `on line 12`, `, line 12`, ` (lines 12–20)`, `: line 12`,
 * ` — starting at line 12`, and a label's `Line: 12`.
 */
const LINE_AFTER = new RegExp(String.raw`^\s*(?:[,;:(]\s*|[—–-]\s+)?(?:(?:starting|beginning)\s+)?(?:(?:at|on|in|from|around|near)\s+)?lines?(?:\s*:\s*|\s+)${LINE_NUMBER}`, 'i');
/** Right before one: `line 12 of `, `lines 12–20 in `, `line 12 of the file `. */
const LINE_BEFORE = new RegExp(String.raw`(?<![A-Za-z0-9])lines?\s+${LINE_NUMBER}(?:\s*[-–—]\s*\d{1,9}|\s+(?:to|through)\s+\d{1,9})?\s+(?:of|in|at|within|inside)\s+(?:the\s+)?(?:file\s+)?$`, 'i');

/**
 * The line the words right after a reference say (C65): `src/tides.js at line 12`. The first line
 * of a range; null where the words that follow say none. Words only: what the reference itself
 * names, `path:line`, is the target's own to say (C22) and is read before these.
 */
export function readLineAfter(text: string): number | null {
  return positive(LINE_AFTER.exec(text)?.[1]);
}

/** The line the words right before a reference say (C65): `line 12 of src/tides.js`. Read where none follows it. */
export function readLineBefore(text: string): number | null {
  const cut = text.length > LINE_WORDS_SPAN;
  const match = LINE_BEFORE.exec(cut ? text.slice(-LINE_WORDS_SPAN) : text);
  // Where the text was cut, what starts at the cut may be the end of a longer word: `deadline 12 of`.
  return match === null || (cut && match.index === 0) ? null : positive(match[1]);
}

// ── `files:read` and `files:showInFolder` (C25, C34, C43) ─────────────────────────────────────

export interface FileReadRequest {
  readonly sessionId: string;
  /** An address as a message or a file wrote it, or the path a tab holds. */
  readonly target: string;
  /** For a reference inside a shown file, that file's path: a relative target resolves against its folder. */
  readonly from?: string | undefined;
}

/** A best-effort change detector, held only while a file is displayed. */
export interface FileRevision {
  readonly mtimeMs: number;
  readonly size: number;
}

export function sameFileRevision(a: FileRevision | null, b: FileRevision | null): boolean {
  return a !== null && b !== null && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

export interface FileRefreshRequest {
  readonly sessionId: string;
  /** The exact absolute path of the open tab; never a reference to resolve or search for. */
  readonly path: string;
  readonly revision: FileRevision | null;
}

/**
 * Why a file was not opened (C24): no tab is made for one of these. `not-regular`: a device, a socket
 * or a pipe. `not-image` (item 15): a file outside the project's folders, by an image's name, that is
 * too large or no image fat-g draws.
 */
export const FILE_REFUSALS = ['outside', 'not-found', 'several', 'folder', 'not-regular', 'no-answer', 'not-image'] as const;
export type FileRefusal = (typeof FILE_REFUSALS)[number];

/** Why a file that was found shows no text (C42): its tab says which. */
export const FILE_UNSHOWN = ['other-kind', 'too-large', 'not-text'] as const;
export type FileUnshown = (typeof FILE_UNSHOWN)[number];

interface FileFound {
  /** The file's real path: the tab's reference (C8). */
  readonly path: string;
  /** The real path of the trusted root it lies in (C59): the page draws the file's path from this root's own name. */
  readonly root: string;
  /** What the target named, for the try that found the file. */
  readonly line: number | null;
  readonly column: number | null;
}

/**
 * An image file (item 15): its real path — an image tab's reference — the id its address names for
 * the run, and its size in pixels. None of its bytes crosses: the page draws it by the id.
 */
export interface FileImage {
  readonly path: string;
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

/** A visible image tab only: its exact previously admitted path and the revision it is drawing. */
export interface ImageRefreshRequest {
  readonly sessionId: string;
  readonly path: string;
  readonly id: string;
}

export type ImageRefreshAnswer =
  | (FileImage & { readonly outcome: 'image' })
  | { readonly outcome: 'unchanged' | 'retry' }
  | { readonly outcome: 'refused'; readonly why: FileRefusal };

export type FileReadAnswer =
  | (FileImage & { readonly outcome: 'image' })
  | (FileFound & { readonly outcome: 'text'; readonly view: 'markdown' | 'plain'; readonly text: string; readonly revision: FileRevision | null })
  | (FileFound & { readonly outcome: 'unshown'; readonly why: FileUnshown })
  | { readonly outcome: 'refused'; readonly why: FileRefusal };

export type FileRefreshAnswer = FileReadAnswer | { readonly outcome: 'unchanged' | 'retry' };

export interface FileShowRequest {
  readonly sessionId: string;
  /** The path a tab holds. Main checks it as it checks a read's (C43). */
  readonly path: string;
}

/**
 * Where a reference leads (`files:locate`, decision 0022): the real path of its file or its folder,
 * which a reference's menu copies and shows in the file manager; or why it leads nowhere, as a read
 * is refused. `files:openFolder` takes the same request as a read, and opens a folder alone.
 */
export type FileLocateAnswer = { readonly outcome: 'file' | 'folder'; readonly path: string } | { readonly outcome: 'refused'; readonly why: FileRefusal };

export interface OpenAddressRequest {
  readonly address: string;
}
