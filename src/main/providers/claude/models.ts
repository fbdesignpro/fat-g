// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Claude's models, as its `initialize` reply lists them (docs/planning/_archive/M13.md, C27, C68): the reply
// every usage session already receives, so no request and no process is added (decision 0006).
// Only the fields the catalog holds leave this module; the reply's commands, agents, output styles
// and account never do (C26).
//
// Each row is keyed by the exact version it names, never by its alias (decision 0016):
// the CLI decides what `fable` or `default` means, and moves it when it updates, so a session, a
// preset or a recent keyed by an alias would run, and show, another version than it was made with.
import { z } from 'zod';
import { labelWord, type ModelLabel, NO_LABEL } from '@shared/contracts/avatar-overlay';
import {
  type CatalogSpeedTier,
  catalogDescription,
  catalogId,
  catalogIds,
  catalogName,
  MAX_EFFORTS,
  MAX_MODELS,
  type ModelReport,
  type ReportedModel,
} from '@shared/contracts/catalog';

/** The three values of the `initialize` reply the catalog reads, unparsed (src/main/providers/claude/session.ts). */
export interface ClaudeModelReply {
  readonly models: unknown;
  readonly fastModeState: unknown;
  readonly fastModeDisabledReason: unknown;
}

/**
 * Claude says yes or no to fast mode per model; a yes is this one tier (C68). Its warning is what
 * choosing it costs, shown where it is chosen (decision 0013): Claude bills fast mode as extra usage.
 */
export const FAST_TIER: CatalogSpeedTier = { id: 'fast', name: 'Fast', description: null, warning: 'Billed as extra usage, at a higher rate; with none left, replies run at standard speed.' };

/** `claude-opus-5-5`, `claude-haiku-4-5-20251001`, `claude-opus-5[1m]`: the family, the major, the minor (decision 0032). */
const CLAUDE_LABEL = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-(\d{8}))?(?:\[.*\])?$/;

/** The rolling alias is eligible even before the CLI supplies its resolved version. */
export function claudeSmallModelVersion(id: string): readonly number[] | null {
  if (id === 'haiku') return [0];
  const match = CLAUDE_LABEL.exec(id);
  return match?.[1] === 'haiku' ? [Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)] : null;
}

/** The overlay's default texts for a Claude model id: `claude-opus-5-5` is `5.5` and `Opus`. */
export function claudeModelLabel(id: string): ModelLabel {
  const match = CLAUDE_LABEL.exec(id);
  if (match === null) return NO_LABEL;
  return { version: match[3] === undefined ? (match[2] ?? null) : `${match[2]}.${match[3]}`, name: labelWord(match[1]) };
}

// Fields are omitted rather than false (Haiku has none of the `supports*`), so all but `value` may be.
const text = z.string().nullish().transform((value) => value ?? null);
const RowSchema = z.looseObject({
  value: z.string(),
  resolvedModel: text,
  displayName: text,
  description: text,
  supportedEffortLevels: z.array(z.string()).nullish(),
  supportsFastMode: z.boolean().nullish(),
});

/** A row's context mark, `[1m]`: the last bracketed part of its value or id, or null for none. */
const CONTEXT_MARK = /\[[^\]]*\]$/;

/**
 * The exact version a row names, its key (decision 0016): its resolved model, which
 * carries the value's context mark where the CLI left it out — `opus[1m]` resolves to
 * `claude-opus-5[1m]`, but `claude-fable-5-1[1m]` to `claude-fable-5-1` — so that a launch keeps
 * the context the row offered. A row the CLI resolves to nothing keeps its value.
 */
export function claudeModelKey(value: string, resolvedModel: string | null): string {
  if (resolvedModel === null) return value;
  if (CONTEXT_MARK.test(resolvedModel)) return resolvedModel;
  return `${resolvedModel}${CONTEXT_MARK.exec(value)?.[0] ?? ''}`;
}

/** The report, or null when the reply has no readable row: that is never sent (C15). */
export function mapClaudeModels(reply: ClaudeModelReply): ModelReport | null {
  if (!Array.isArray(reply.models)) return null;
  const models: ReportedModel[] = [];
  // Which of the rows kept so far came from the `default` row alone: another row naming its version gives it its words.
  const fromDefault: boolean[] = [];
  let dropped = Math.max(0, reply.models.length - MAX_MODELS);
  for (const raw of reply.models.slice(0, MAX_MODELS)) {
    const mapped = mapRow(raw);
    // A row that cannot be read is left out and counted; the others apply (C16).
    if (mapped === null) { dropped += 1; continue; }
    const { row, isDefault } = mapped;
    const at = models.findIndex((model) => model.key === row.key);
    if (at === -1) { models.push(row); fromDefault.push(isDefault); continue; }
    // Two rows naming one version are one model, in the first one's place: an alias beside the row
    // it stands for, `default` beside the model it means. The row that names it speaks for it,
    // and either row's listing as the default makes it the listed default.
    const first = models[at];
    if (first === undefined) continue;
    const words = fromDefault[at] === true && !isDefault ? row : first;
    models[at] = { ...words, listedDefault: first.listedDefault || row.listedDefault };
    fromDefault[at] = fromDefault[at] === true && isDefault;
  }
  if (models.length === 0) return null;
  // The reason is kept only while fast mode is not on: then it says why fat-g cannot ask (C67).
  const reason = reply.fastModeState !== 'on' && typeof reply.fastModeDisabledReason === 'string' ? catalogId(reply.fastModeDisabledReason) : null;
  return { models, speedTierReason: reason, dropped };
}

function mapRow(raw: unknown): { readonly row: ReportedModel; readonly isDefault: boolean } | null {
  const parsed = RowSchema.safeParse(raw);
  if (!parsed.success) return null;
  const row = parsed.data;
  const value = catalogId(row.value);
  const resolvedId = row.resolvedModel === null ? null : catalogId(row.resolvedModel);
  const efforts = catalogIds(row.supportedEffortLevels ?? [], MAX_EFFORTS);
  // A value outside the bounds makes the row unreadable (C9).
  if (value === null || (row.resolvedModel !== null && resolvedId === null) || efforts === null) return null;
  const key = catalogId(claudeModelKey(value, resolvedId));
  if (key === null) return null;
  // Claude lists no default effort and hides no model; its `default` row is the listed default (C7).
  const isDefault = value === 'default';
  return {
    isDefault,
    row: {
      key,
      resolvedId,
      name: row.displayName === null ? null : catalogName(row.displayName),
      description: row.description === null ? null : catalogDescription(row.description),
      efforts,
      listedDefaultEffort: null,
      listedDefault: isDefault,
      hidden: false,
      speedTiers: row.supportsFastMode === true ? [FAST_TIER] : [],
    },
  };
}
