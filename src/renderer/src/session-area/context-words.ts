// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// What the context meter and its tooltip say (decision 0033). Every size is a count of tokens, and
// the tooltip says so in its header, over its number column and in its last line. A provider is
// named by its display name alone.

/** A count as the tooltip writes it: in groups of three. */
export const formatTokens = (tokens: number): string => tokens.toLocaleString('en-US');

export const CONTEXT_WORDS = {
  /** The tooltip's heading. */
  label: 'Context',
  /** The meter's accessible name. */
  meterName: 'Context window',
  unit: 'tokens',
  footer: 'Sizes are in tokens, about 4 characters of English text each.',
  /** No reading yet: the CLIs start their process at a turn, and report once it runs. */
  none: 'Context usage is out of date. It will be updated on your next message.',
  header: (used: number, window: number, percent: number): string => `${formatTokens(used)} / ${formatTokens(window)} tokens · ${percent}%`,
  valueText: (used: number, window: number, percent: number): string => `${formatTokens(used)} of ${formatTokens(window)} tokens, ${percent}%`,
  compactAt: (tokens: number, percent: number): string => `Compacts automatically at ${formatTokens(tokens)} tokens (${percent}%)`,
  compactOff: 'Automatic compaction is off.',
  notReported: (provider: string): string => `${provider} does not report when it compacts.`,
  sections: { parts: 'In context', messages: 'Message token breakdown', lastCall: 'Last call', calls: 'Whole chat' },
  rows: {
    toolResults: 'Tool results',
    toolCalls: 'Tool calls',
    answers: 'Answers',
    prompts: 'Your messages',
    attachments: 'Attachments',
    other: 'Other',
    input: 'Input',
    cacheRead: 'Cache read',
    cacheWrite: 'Cache write',
    output: 'Output',
    reasoning: 'Reasoning, in output',
  },
} as const;
