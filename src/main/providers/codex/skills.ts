// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Codex's skills (docs/planning/_archive/M23.md, Design 9; C63, C64, C87; K1): `skills/list` over the
// instance's existing connection, for a session's folder, when the menu opens and before a send that
// chose a skill. What it lists is held here, in memory alone, for the adapter's run: each skill by its
// name, its description, its scope and its path as the CLI gave them. No skill file is read.
//
// A skill goes to the page by a selector: an opaque, stable encoding of the identity Codex listed —
// its name, its scope and its path, unambiguously — from which no path can be read back. Two skills of
// one name are two identities, and two selectors. At dispatch the selector is resolved against what
// was listed last; one no longer listed sends nothing (C87).
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CommandNameSchema, MAX_COMMAND_TEXT } from '@shared/contracts/composer';
import { cutTo } from '@shared/contracts/agent-events';
import type { ProviderCommand } from '@shared/provider-kit/sessions';

/** The most skills a listing keeps (C65): what is past it is left out. */
export const MAX_SKILLS = 256;
/** The longest path a skill may name and be kept for its dispatch. */
const MAX_SKILL_PATH = 4096;

/** A skill as Codex listed it, kept for its dispatch: its name and its path, never sent to a window. */
export interface ListedSkill {
  readonly name: string;
  readonly path: string;
}

const Skill = z.looseObject({
  name: z.unknown(),
  description: z.unknown().optional(),
  path: z.unknown(),
  scope: z.unknown().optional(),
  enabled: z.unknown().optional(),
});
const Reply = z.looseObject({ data: z.array(z.looseObject({ skills: z.array(z.unknown()).optional() })) });

/** A skill's selector: the identity's hash, cut to 32 hexadecimal digits, which no path can be read from. */
export function skillSelector(name: string, scope: string | null, path: string): string {
  return createHash('sha256').update(JSON.stringify([name, scope, path])).digest('hex').slice(0, 32);
}

/**
 * A `skills/list` reply (C63; K1): each enabled skill whose name is one token and whose path is a
 * string, as a row of the menu under Skills with its selector, and the identity each selector stands
 * for. Null for a reply that is not one.
 */
export function takeSkills(reply: unknown): { readonly rows: readonly ProviderCommand[]; readonly bySelector: ReadonlyMap<string, ListedSkill> } | null {
  const parsed = Reply.safeParse(reply);
  if (!parsed.success) return null;
  const rows: ProviderCommand[] = [];
  const bySelector = new Map<string, ListedSkill>();
  for (const entry of parsed.data.data.flatMap((folder) => folder.skills ?? [])) {
    if (rows.length >= MAX_SKILLS) break;
    const skill = Skill.safeParse(entry);
    if (!skill.success || skill.data.enabled === false) continue;
    const { name, description, path, scope } = skill.data;
    if (typeof name !== 'string' || !CommandNameSchema.safeParse(name).success) continue;
    if (typeof path !== 'string' || path === '' || path.length > MAX_SKILL_PATH || /\p{Cc}/u.test(path)) continue;
    const selector = skillSelector(name, typeof scope === 'string' ? scope : null, path);
    if (bySelector.has(selector)) continue;
    bySelector.set(selector, { name, path });
    const text = typeof description === 'string' && description.trim() !== '' ? cutTo(description.replace(/\p{Cc}/gu, ' ').trim(), MAX_COMMAND_TEXT).text : null;
    rows.push({ name, description: text, hint: null, group: 'skills', selector });
  }
  return { rows, bySelector };
}
