// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The user's catalog.json (docs/planning/_archive/M13.md, Design 6; C35–C45): read at start and on Reload,
// never watched, and never written, renamed or deleted — so it has no Start fresh either (C45). A file
// fat-g cannot use is ignored whole, with the first cause that applies; the defaults and the reports
// still apply (C41, C44).
//
// It is loose about what it does not know, at every level, `presentation` included (C39, C42), and
// strict about the type and bounds of what it does (C9). Decision 0014's envelope and refusal are
// complete from version 1; its unknown-field preservation and atomic writes concern writing, which
// arrives with the first editor.
import { statSync } from 'node:fs';
import { z } from 'zod';
import {
  CATALOG_MAX_BYTES,
  CATALOG_VERSION,
  catalogDescription,
  catalogId,
  catalogName,
  MAX_EFFORTS,
  MAX_MODELS,
  MAX_SPEED_TIERS,
  type OverrideCause,
} from '@shared/contracts/catalog';
import { normalizeText } from '@shared/contracts/names';
import { readEnvelope } from '../storage/envelope';
import { errorCode, readJsonFile, type ReadText, readTextFile } from '../storage/json-file';
import type { ModelOverride, ProviderOverride } from './merge';

export interface OverrideIo {
  /** The file's size in bytes; throws as `fs.statSync` does. */
  readonly size: (path: string) => number;
  readonly readText: ReadText;
}

export const nodeOverrideIo: OverrideIo = { size: (path) => statSync(path).size, readText: readTextFile };

export type OverrideReading =
  /** No file: no override and no error (C40). */
  | { readonly kind: 'none' }
  | {
      readonly kind: 'applied';
      /** By provider id, for the providers this build has. */
      readonly providers: ReadonlyMap<string, ProviderOverride>;
      /** The ids it names that this build does not have, skipped (C42). */
      readonly unknownProviders: readonly string[];
    }
  | {
      readonly kind: 'ignored';
      readonly cause: OverrideCause;
      /** The path of the first fault, for `invalid`: shown in Settings, never logged (C52). */
      readonly field: string | null;
      /** For `unreadable`: the error's code (`EBUSY` …), never its message, which holds the path. */
      readonly code: string | null;
    };

/** At most this many unknown provider ids are named. */
const MAX_NAMED_UNKNOWN = 16;
const CODE = /^[A-Z][A-Z0-9_]*$/;

// ── The format (C37, C38) ─────────────────────────────────────────────────────────────────────

const id = z.string().refine((value) => catalogId(value) !== null, 'not an id');
const tier = z.union([id, z.looseObject({ id, name: z.string().optional(), description: z.string().nullable().optional() })]);
const ModelSchema = z.looseObject({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  resolvedId: id.nullable().optional(),
  efforts: z.array(id).max(MAX_EFFORTS).optional(),
  listedDefaultEffort: id.nullable().optional(),
  speedTiers: z.array(tier).max(MAX_SPEED_TIERS).optional(),
  hidden: z.boolean().optional(),
});
const ProviderSchema = z.looseObject({
  efforts: z.record(id, z.looseObject({ label: z.string().optional(), caution: z.boolean().optional() })).optional(),
  models: z.record(id, ModelSchema).refine((models) => Object.keys(models).length <= MAX_MODELS, `more than ${MAX_MODELS} models`).optional(),
});
const DocumentSchema = z.looseObject({ providers: z.record(z.string(), z.unknown()).optional() });

/**
 * Reads `file`. `known` is the registry's provider ids; `readerVersion` is this build's, which a
 * test may raise to see an older file refused.
 */
export function readOverride(file: string, known: ReadonlySet<string>, io: OverrideIo = nodeOverrideIo, readerVersion = CATALOG_VERSION): OverrideReading {
  let size: number;
  try {
    size = io.size(file);
  } catch (error) {
    const code = errorCode(error);
    return code === 'ENOENT' ? { kind: 'none' } : ignored('unreadable', null, code);
  }
  if (size > CATALOG_MAX_BYTES) return ignored('too-large');

  const reading = readJsonFile(file, io.readText);
  switch (reading.kind) {
    case 'missing':
      return { kind: 'none' };
    case 'unreadable':
      return ignored('unreadable', null, reading.code);
    case 'invalid-json':
      return ignored('not-json');
    case 'parsed':
      break;
  }

  const envelope = readEnvelope(reading.value, readerVersion);
  switch (envelope.kind) {
    case 'corrupt':
      return ignored('damaged');
    case 'newer':
      return ignored('newer');
    case 'older':
      return ignored('older');
    case 'ok':
      break;
  }

  const document = DocumentSchema.safeParse(reading.value);
  if (!document.success) return ignored('invalid', fieldOf(document.error.issues, []));
  const providers = new Map<string, ProviderOverride>();
  const unknownProviders: string[] = [];
  for (const [providerId, value] of Object.entries(document.data.providers ?? {})) {
    if (!known.has(providerId)) {
      if (catalogId(providerId) !== null && unknownProviders.length < MAX_NAMED_UNKNOWN) unknownProviders.push(providerId);
      continue;
    }
    const parsed = ProviderSchema.safeParse(value);
    if (!parsed.success) return ignored('invalid', fieldOf(parsed.error.issues, ['providers', providerId]));
    providers.set(providerId, {
      efforts: new Map(Object.entries(parsed.data.efforts ?? {}).map(([effort, change]) => [effort, {
        ...(change.label === undefined ? {} : optional('label', catalogName(change.label))),
        ...(change.caution === undefined ? {} : { caution: change.caution }),
      }])),
      models: Object.entries(parsed.data.models ?? {}).map(([key, change]) => [key, modelOverride(change)] as const),
    });
  }
  return { kind: 'applied', providers, unknownProviders };
}

function modelOverride(change: z.infer<typeof ModelSchema>): ModelOverride {
  const tiers = change.speedTiers?.map((entry) => (typeof entry === 'string' ? { id: entry } : {
    id: entry.id,
    ...(entry.name === undefined ? {} : optional('name', catalogName(entry.name))),
    ...(entry.description === undefined ? {} : { description: entry.description === null ? null : catalogDescription(entry.description) }),
  }));
  return {
    // An empty name is no name: the other layers' stays (C9).
    ...(change.name === undefined ? {} : optional('name', catalogName(change.name))),
    ...(change.description === undefined ? {} : { description: change.description === null ? null : catalogDescription(change.description) }),
    ...(change.resolvedId === undefined ? {} : { resolvedId: change.resolvedId }),
    ...(change.efforts === undefined ? {} : { efforts: change.efforts }),
    ...(change.listedDefaultEffort === undefined ? {} : { listedDefaultEffort: change.listedDefaultEffort }),
    // One tier per id: the first the file names.
    ...(tiers === undefined ? {} : { speedTiers: tiers.filter((entry, index) => tiers.findIndex((other) => other.id === entry.id) === index) }),
    ...(change.hidden === undefined ? {} : { hidden: change.hidden }),
  };
}

function optional<K extends string>(key: K, value: string | null): { [P in K]?: string } {
  return (value === null ? {} : { [key]: value }) as { [P in K]?: string };
}

function ignored(cause: OverrideCause, field: string | null = null, code: string | null = null): OverrideReading {
  return { kind: 'ignored', cause, field, code: code !== null && CODE.test(code) ? code : null };
}

/** `providers.codex.models.gpt-5.5.hidden`: the first fault's path, cleaned and clamped for display. */
function fieldOf(issues: readonly z.core.$ZodIssue[], prefix: readonly string[]): string | null {
  const first = issues[0];
  if (first === undefined) return null;
  return normalizeText([...prefix, ...first.path.map(String)].join('.'), 200) || null;
}
