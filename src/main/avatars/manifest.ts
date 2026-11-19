// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// A family's `family.json` (docs/planning/_archive/M102.md, Design 4; C11, C13, C15, C16, C55, C56): read at
// each scan, made with fat-g's defaults where a family has none and written by the family editor
// (authoring.ts; decision 0031), never here. It follows the catalog override's reader step for step
// (M13, C41): its size before any read, the read, JSON, the version envelope, then the schema; a
// manifest fat-g cannot use is refused whole with the first cause that applies, and the family stands
// as its folders (C11). Loose about what it does not know, at every level (C15), strict about the
// form of what it does.
//
// Electron-free: the file system is a parameter (fs.ts).
import type { z } from 'zod';
import { type OverlayLayer, readOverlayLayer } from '@shared/contracts/avatar-overlay';
import { displayText, type AvatarProblem, type Manifest, MANIFEST_MAX_BYTES, MANIFEST_VERSION, ManifestSchema, type ManifestCause, type MatchEntryView, matchView } from '@shared/contracts/avatars';
import { normalizeText } from '@shared/contracts/names';
import { readEnvelope } from '../storage/envelope';
import { errorCode } from '../storage/json-file';
import type { AvatarFs } from './fs';

export type ManifestReading =
  /** No `family.json`: the family is its folders, in name order (C16). */
  | { readonly kind: 'none' }
  | { readonly kind: 'applied'; readonly manifest: Manifest }
  | {
      readonly kind: 'refused';
      readonly cause: ManifestCause;
      /** The path of the first fault, for `invalid`: shown in the tab, never logged. */
      readonly field: string | null;
      /** For `unreadable`: the error's code, never its message, which holds the path. */
      readonly code: string | null;
    };

const CODE = /^[A-Z][A-Z0-9_]*$/;
const BOM = '﻿';

/** Reads `file`. `readerVersion` is this build's, which a test may raise to see an older file refused. */
export async function readManifest(file: string, fs: AvatarFs, readerVersion = MANIFEST_VERSION): Promise<ManifestReading> {
  let size: number;
  try {
    const stat = await fs.lstat(file);
    // A link is never followed (C58), and nothing else is a file to read.
    if (stat.kind !== 'file') return refused('unreadable');
    size = stat.size;
  } catch (error) {
    const code = errorCode(error);
    return code === 'ENOENT' ? { kind: 'none' } : refused('unreadable', null, code);
  }
  if (size > MANIFEST_MAX_BYTES) return refused('too-large');

  let bytes: Uint8Array | null;
  try {
    bytes = await fs.readWhole(file, MANIFEST_MAX_BYTES);
  } catch (error) {
    return refused('unreadable', null, errorCode(error));
  }
  // Grown past the bound since its size was asked.
  if (bytes === null) return refused('too-large');
  return parseManifest(bytes, readerVersion);
}

/** A manifest's bytes, read whole within the bound: JSON, the version envelope, then the schema. */
export function parseManifest(bytes: Uint8Array, readerVersion = MANIFEST_VERSION): ManifestReading {
  let value: unknown;
  try {
    const text = new TextDecoder().decode(bytes);
    value = JSON.parse(text.startsWith(BOM) ? text.slice(1) : text) as unknown;
  } catch {
    return refused('not-json');
  }

  const envelope = readEnvelope(value, readerVersion);
  switch (envelope.kind) {
    case 'corrupt':
      return refused('damaged');
    case 'newer':
      return refused('newer');
    case 'older':
      return refused('older');
    case 'ok':
      break;
  }
  const parsed = ManifestSchema.safeParse(value);
  if (!parsed.success) return refused('invalid', fieldOf(parsed.error.issues));
  return { kind: 'applied', manifest: parsed.data };
}

function refused(cause: ManifestCause, field: string | null = null, code: string | null = null): ManifestReading {
  return { kind: 'refused', cause, field, code: code !== null && CODE.test(code) ? code : null };
}

/** `avatars.2.matches.0`: the first fault's path, cleaned and clamped for display. */
function fieldOf(issues: readonly z.core.$ZodIssue[]): string | null {
  const first = issues[0];
  if (first === undefined) return null;
  return normalizeText(first.path.map(String).join('.'), 200) || null;
}

// ── What a family is, with its manifest or without (C13, C15, C16) ─────────────────────────────

/** At most this many unknown provider ids are named, as the override names them. */
const MAX_NAMED_UNKNOWN = 16;

export interface FamilyShape {
  readonly provider: string;
  readonly author: string | null;
  readonly licence: string | null;
  /** The avatars' folders in the family's order: the listed ones, then the others by name (C16). */
  readonly order: readonly string[];
  /** Each avatar's match entries, in the manifest's order (C56; M104, C2). */
  readonly matches: ReadonlyMap<string, readonly MatchEntryView[]>;
  /** The registered providers whose starting family the manifest says it is, in its order, once each. */
  readonly defaultFor: readonly string[];
  /** The family's overlay layer, and each avatar's, as far as they were of their form (decision 0032). */
  readonly overlay: OverlayLayer | undefined;
  readonly overlays: ReadonlyMap<string, OverlayLayer>;
  readonly unknownProviders: readonly string[];
  /** The manifest's refusal, an avatar listed with no folder, overlay fields of the wrong form (C15, C55). */
  readonly problems: readonly AvatarProblem[];
}

/**
 * The family a manifest makes of its folders. `folders`: its avatars' folders as listed, in name
 * order. `known`: the provider ids this build registers. `at`: the family's folder, relative to its
 * root, by which each problem is named.
 */
export function familyShape(reading: ManifestReading, folders: readonly string[], known: ReadonlySet<string>, at: string): FamilyShape {
  const manifestAt = `${at}/family.json`;
  if (reading.kind !== 'applied') {
    return {
      provider: 'any',
      author: null,
      licence: null,
      order: folders,
      matches: new Map(),
      defaultFor: [],
      overlay: undefined,
      overlays: new Map(),
      unknownProviders: [],
      problems: reading.kind === 'refused' ? [{ kind: 'manifest', path: manifestAt, cause: reading.cause, field: reading.field }] : [],
    };
  }
  const { manifest } = reading;
  const present = new Set(folders);
  const problems: AvatarProblem[] = [];
  const listed: string[] = [];
  const seen = new Set<string>();
  const matches = new Map<string, readonly MatchEntryView[]>();
  const overlays = new Map<string, OverlayLayer>();
  // The overlay's fields of the wrong form, by their path in the manifest: left out, the rest kept (decision 0032).
  const dropped: string[] = [];
  const under = (at: string, field: string): string => (field === '' ? at : `${at}.${field}`);
  const family = manifest.overlay === undefined ? undefined : readOverlayLayer(manifest.overlay);
  for (const field of family?.dropped ?? []) dropped.push(under('overlay', field));
  for (const [index, entry] of (manifest.avatars ?? []).entries()) {
    // Listed twice: the first stands.
    if (seen.has(entry.folder)) continue;
    seen.add(entry.folder);
    if (!present.has(entry.folder)) {
      problems.push({ kind: 'listed-missing', path: `${at}/${displayText(entry.folder) ?? ''}` });
      continue;
    }
    listed.push(entry.folder);
    matches.set(entry.folder, (entry.matches ?? []).map(matchView));
    if (entry.overlay !== undefined) {
      const own = readOverlayLayer(entry.overlay);
      overlays.set(entry.folder, own.layer);
      for (const field of own.dropped) dropped.push(under(`avatars.${index}.overlay`, field));
    }
  }
  if (dropped.length > 0) problems.push({ kind: 'overlay-field', path: manifestAt, fields: dropped });
  const defaultFor: string[] = [];
  const unknownProviders: string[] = [];
  if (manifest.provider !== 'any' && !known.has(manifest.provider)) {
    const shown = displayText(manifest.provider);
    if (shown !== null) unknownProviders.push(shown);
  }
  for (const providerId of manifest.defaultFor ?? []) {
    if (!known.has(providerId)) {
      const shown = displayText(providerId);
      if (shown !== null && unknownProviders.length < MAX_NAMED_UNKNOWN && !unknownProviders.includes(shown)) unknownProviders.push(shown);
      continue;
    }
    if (!defaultFor.includes(providerId)) defaultFor.push(providerId);
  }
  return {
    provider: manifest.provider,
    author: displayText(manifest.author ?? ''),
    licence: displayText(manifest.licence ?? ''),
    order: [...listed, ...folders.filter((name) => !seen.has(name))],
    matches,
    defaultFor,
    overlay: family?.layer,
    overlays,
    unknownProviders,
    problems,
  };
}
