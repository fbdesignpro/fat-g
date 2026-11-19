// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Codex's models, as `model/list` lists them (docs/planning/_archive/M13.md, C29, C68). Only the fields the
// catalog holds leave this module (C26); `additionalSpeedTiers` is not read — every model lists
// `fast` there today, while `serviceTiers` names the tier that asks for it.
import { z } from 'zod';
import { labelWord, type ModelLabel, NO_LABEL } from '@shared/contracts/avatar-overlay';
import {
  catalogDescription,
  catalogId,
  catalogIds,
  catalogName,
  MAX_EFFORTS,
  MAX_MODELS,
  MAX_SPEED_TIERS,
  type ModelReport,
  type ReportedModel,
} from '@shared/contracts/catalog';

/** `gpt-6.1-sol`: the version, then the model's word, if any (decision 0032). */
const CODEX_LABEL = /^gpt-(\d+(?:\.\d+)?)(?:-([a-z]+))?/;

export function codexSmallModelVersion(id: string): readonly number[] | null {
  const match = /^gpt-(\d+)(?:\.(\d+))?-luna(?:-(\d{8}))?$/.exec(id);
  return match === null ? null : [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

/** The overlay's default texts for a Codex model id: `gpt-6.1-sol` is `6.1` and `Sol`, `gpt-5.5` is `5.5` alone. */
export function codexModelLabel(id: string): ModelLabel {
  const match = CODEX_LABEL.exec(id);
  return match === null ? NO_LABEL : { version: match[1] ?? null, name: labelWord(match[2]) };
}

const text = z.string().nullish().transform((value) => value ?? null);
const RowSchema = z.looseObject({
  id: z.string(),
  model: text,
  displayName: text,
  description: text,
  hidden: z.boolean().nullish(),
  isDefault: z.boolean().nullish(),
  defaultReasoningEffort: text,
  supportedReasoningEfforts: z.array(z.looseObject({ reasoningEffort: z.string(), description: text })).nullish(),
  serviceTiers: z.array(z.looseObject({ id: z.string(), name: text, description: text })).nullish(),
});

/** The report, or null when no row can be read: that is never sent (C15). */
export function mapCodexModels(rows: readonly unknown[]): ModelReport | null {
  const models: ReportedModel[] = [];
  let dropped = Math.max(0, rows.length - MAX_MODELS);
  for (const raw of rows.slice(0, MAX_MODELS)) {
    const row = mapRow(raw);
    // A row that cannot be read is left out and counted; the others apply (C16).
    if (row === null || models.some((model) => model.key === row.key)) dropped += 1;
    else models.push(row);
  }
  return models.length === 0 ? null : { models, speedTierReason: null, dropped };
}

function mapRow(raw: unknown): ReportedModel | null {
  const parsed = RowSchema.safeParse(raw);
  if (!parsed.success) return null;
  const row = parsed.data;
  const key = catalogId(row.id);
  const resolvedId = row.model === null ? null : catalogId(row.model);
  const efforts = catalogIds((row.supportedReasoningEfforts ?? []).map((effort) => effort.reasoningEffort), MAX_EFFORTS);
  const listedDefaultEffort = row.defaultReasoningEffort === null ? null : catalogId(row.defaultReasoningEffort);
  const tierIds = catalogIds((row.serviceTiers ?? []).map((tier) => tier.id), MAX_SPEED_TIERS);
  // A value outside the bounds makes the row unreadable (C9).
  if (key === null || efforts === null || tierIds === null) return null;
  if ((row.model !== null && resolvedId === null) || (row.defaultReasoningEffort !== null && listedDefaultEffort === null)) return null;
  // What the CLI says of each level, kept where it is a clean description (decision 0013).
  const described = (row.supportedReasoningEfforts ?? []).flatMap((effort) => {
    const level = catalogId(effort.reasoningEffort);
    const said = effort.description === null ? null : catalogDescription(effort.description);
    return level === null || said === null || !efforts.includes(level) ? [] : [[level, said] as const];
  });
  return {
    key,
    resolvedId,
    name: row.displayName === null ? null : catalogName(row.displayName),
    description: row.description === null ? null : catalogDescription(row.description),
    efforts,
    ...(described.length === 0 ? {} : { effortDescriptions: Object.fromEntries(described) }),
    listedDefaultEffort,
    listedDefault: row.isDefault === true,
    hidden: row.hidden === true,
    // In the CLI's order, once per id (C8).
    speedTiers: tierIds.map((id) => {
      const tier = (row.serviceTiers ?? []).find((candidate) => candidate.id === id);
      return {
        id,
        name: (tier?.name === null || tier?.name === undefined ? null : catalogName(tier.name)) ?? catalogName(id) ?? id,
        description: tier?.description === null || tier?.description === undefined ? null : catalogDescription(tier.description),
      };
    }),
  };
}
