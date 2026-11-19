// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import type { ProviderDefinition } from '@shared/provider-kit/provider';
import { createClaudeDefinition, type ClaudeDefinitionOptions } from './claude';
import { createCodexDefinition, type CodexDefinitionOptions } from './codex';

/** Keyed by provider. Production passes none of this; smoke passes explicit fixtures for both. */
export interface BuiltInProviderOptions {
  readonly claude?: ClaudeDefinitionOptions;
  readonly codex?: Omit<CodexDefinitionOptions, 'applicationVersion'>;
}

/** The one production built-in list, in display order. */
export function builtInProviders(applicationVersion: string, options: BuiltInProviderOptions = {}): readonly ProviderDefinition[] {
  return [createClaudeDefinition(options.claude), createCodexDefinition({ applicationVersion, ...options.codex })];
}
