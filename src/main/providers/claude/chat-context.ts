// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// How full a Claude chat's context window is (decision 0033; docs/research/chat-protocols.md), read
// beside the mapper. Two sources, both the CLI's own count:
//
//   the reply to `get_context_usage` (summary detail) — the count, the window, where the CLI compacts
//     by itself, the parts of what is used by the CLI's own labels, what the messages hold, and the
//     last call's usage. Of the parts, only the rows the CLI classes as used are read, by their
//     `kind`, never by their name; the reply's lists of memory files, tools, agents and skills hold
//     paths and configured names, and are never read.
//   an assistant frame of the session's own thread — the usage of the call that wrote it, which is
//     the count between two replies. A sub-agent's frame is its own context's; a frame whose call
//     read nothing is no count.
import { CONTEXT_LABEL, type ContextCalls, type ContextMessages, type ContextReading, MAX_CONTEXT_LABEL, MAX_CONTEXT_PARTS, MAX_CONTEXT_TOKENS } from '@shared/contracts/sessions';

const objectOf = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
/** A count of tokens, or null for anything else. */
const countOf = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_CONTEXT_TOKENS ? value : null);
/** The label a part is drawn by: the CLI's own words where they are plain, `Other` otherwise. */
const OTHER = 'Other';
const labelOf = (value: unknown): string => (typeof value === 'string' && value.length <= MAX_CONTEXT_LABEL && CONTEXT_LABEL.test(value) ? value : OTHER);

/** One call's usage, as the API names it: what was read anew, from the cache and into it, and given out. */
function callOf(usage: unknown): ContextCalls | null {
  const raw = objectOf(usage);
  if (raw === null) return null;
  const input = countOf(raw['input_tokens'] ?? 0);
  const cacheRead = countOf(raw['cache_read_input_tokens'] ?? 0);
  const cacheWrite = countOf(raw['cache_creation_input_tokens'] ?? 0);
  const output = countOf(raw['output_tokens'] ?? 0);
  if (input === null || cacheRead === null || cacheWrite === null || output === null) return null;
  return { input, cacheRead, cacheWrite, output };
}

/** The used rows of the reply's categories, in its order: one `Other` for every label that is not plain, and for those past the bound. */
function partsOf(categories: unknown): ContextReading['parts'] {
  if (!Array.isArray(categories)) return undefined;
  const parts: { label: string; tokens: number }[] = [];
  let other = 0;
  for (const row of categories) {
    const raw = objectOf(row);
    // By the CLI's own class (its types say to classify on it, never on the name): what is held, not deferred, kept free or free.
    if (raw === null || raw['kind'] !== 'used') continue;
    const tokens = countOf(raw['tokens']);
    if (tokens === null) continue;
    const label = labelOf(raw['name']);
    if (label === OTHER || parts.length >= MAX_CONTEXT_PARTS - 1) other += tokens;
    else parts.push({ label, tokens });
  }
  if (other > 0) parts.push({ label: OTHER, tokens: Math.min(other, MAX_CONTEXT_TOKENS) });
  return parts.length === 0 ? undefined : parts;
}

/** The messages' totals by kind; the lists by tool and by attachment are never read. */
function messagesOf(breakdown: unknown): ContextMessages | undefined {
  const raw = objectOf(breakdown);
  if (raw === null) return undefined;
  const of = (key: string): number => countOf(raw[key]) ?? 0;
  return {
    toolCalls: of('toolCallTokens'),
    toolResults: of('toolResultTokens'),
    answers: of('assistantMessageTokens'),
    prompts: of('userMessageTokens'),
    attachments: of('attachmentTokens'),
    other: Math.min(of('redirectedContextTokens') + of('unattributedTokens'), MAX_CONTEXT_TOKENS),
  };
}

/** The reading a `get_context_usage` reply gives, or null for a reply that names no count and window. */
export function takeContextReply(reply: unknown): ContextReading | null {
  const raw = objectOf(reply);
  if (raw === null) return null;
  const used = countOf(raw['totalTokens']);
  const window = countOf(raw['maxTokens']);
  if (used === null || window === null || window === 0) return null;
  const threshold = countOf(raw['autoCompactThreshold']);
  // The CLI says it compacts nothing by itself, or where it does; absent where it says neither.
  const compactAt = raw['isAutoCompactEnabled'] === false ? null : threshold !== null && threshold > 0 ? threshold : undefined;
  const parts = partsOf(raw['categories']);
  const messages = messagesOf(raw['messageBreakdown']);
  const lastCall = callOf(raw['apiUsage']);
  return {
    used,
    window,
    ...(compactAt === undefined ? {} : { compactAt }),
    ...(parts === undefined ? {} : { parts }),
    ...(messages === undefined ? {} : { messages }),
    ...(lastCall === null ? {} : { lastCall }),
  };
}

/**
 * The count an assistant frame of the session's own thread gives: what its call read — anew, from
 * the cache and into it — and wrote, which is what the context holds once it is written. Null for
 * any other frame, a sub-agent's, and one whose call read nothing.
 */
export function takeAssistantUsage(frame: unknown): { readonly used: number; readonly call: ContextCalls } | null {
  const raw = objectOf(frame);
  if (raw?.['type'] !== 'assistant') return null;
  const parent = raw['parent_tool_use_id'];
  if (parent !== undefined && parent !== null) return null;
  const call = callOf(objectOf(raw['message'])?.['usage']);
  if (call === null) return null;
  const read = call.input + (call.cacheRead ?? 0) + (call.cacheWrite ?? 0);
  if (read === 0) return null;
  const used = read + call.output;
  return used > MAX_CONTEXT_TOKENS ? null : { used, call };
}
