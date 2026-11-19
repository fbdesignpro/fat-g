// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Loose wire shapes (z.looseObject: unknown keys are tolerated, never forwarded) and the reviewed
// authentication discriminators observed in the CLI bundled with Agent SDK 0.3.278.
import { z } from 'zod';

/** `claude auth status` JSON. Identity fields stay unknown here and are bounded when projected. */
export const AuthStatusSchema = z.looseObject({
  loggedIn: z.boolean(),
  authMethod: z.string().max(64).optional(),
  apiProvider: z.string().max(64).optional(),
  email: z.unknown().optional(),
  orgName: z.unknown().optional(),
  subscriptionType: z.unknown().optional(),
});
export type AuthStatus = z.infer<typeof AuthStatusSchema>;

/** The `initialize` reply's `account`: only the fields that decide eligibility. Display strings are ignored. */
export const SessionAccountSchema = z.looseObject({
  apiProvider: z.string().max(64).optional(),
  apiKeySource: z.string().max(128).optional(),
});

/** The experimental usage response. Everything below `rate_limits` is read field by field. */
export const UsageEnvelopeSchema = z.looseObject({
  rate_limits_available: z.boolean().optional(),
  rate_limits: z.unknown().optional(),
});

/** Only these sign-ins can carry subscription allocations — and only against the first party. */
export const SUBSCRIPTION_AUTH_METHODS: ReadonlySet<string> = new Set(['claude.ai', 'oauth_token']);
export const API_KEY_AUTH_METHODS: ReadonlySet<string> = new Set(['api_key', 'api_key_helper']);
export const CLOUD_AUTH_METHODS: ReadonlySet<string> = new Set(['third_party']);
export const SIGNED_OUT_AUTH_METHODS: ReadonlySet<string> = new Set(['none']);
export const FIRST_PARTY_PROVIDER = 'firstParty';
export const CLOUD_API_PROVIDERS: ReadonlySet<string> = new Set(['bedrock', 'vertex', 'foundry', 'anthropicAws', 'anthropicGoogleCloud', 'mantle', 'gateway']);
/** `account.apiKeySource` values that mean the session authenticates with an API key. */
export const API_KEY_SOURCES: ReadonlySet<string> = new Set(['ANTHROPIC_API_KEY', 'apiKeyHelper', '/login managed key']);

export type AuthClass = 'subscription' | 'api-key' | 'cloud-provider' | 'signed-out' | 'unknown';

/**
 * API-key and cloud classifications win over a conflicting first-party value. An unknown or
 * contradictory combination is `unknown` — never guessed to be a subscription.
 */
export function classifyAuth(status: Pick<AuthStatus, 'authMethod' | 'apiProvider'>): AuthClass {
  const { authMethod, apiProvider } = status;
  if (apiProvider !== undefined && CLOUD_API_PROVIDERS.has(apiProvider)) return 'cloud-provider';
  if (authMethod === undefined) return 'unknown';
  if (API_KEY_AUTH_METHODS.has(authMethod)) return 'api-key';
  if (CLOUD_AUTH_METHODS.has(authMethod)) return 'cloud-provider';
  if (SIGNED_OUT_AUTH_METHODS.has(authMethod)) return 'signed-out';
  if (SUBSCRIPTION_AUTH_METHODS.has(authMethod) && apiProvider === FIRST_PARTY_PROVIDER) return 'subscription';
  return 'unknown';
}
