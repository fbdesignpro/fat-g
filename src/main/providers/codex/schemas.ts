// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { z } from 'zod';

export const AccountResponseSchema = z.looseObject({
  account: z.unknown().nullable(),
  requiresOpenaiAuth: z.boolean(),
});

export const ChatGptAccountSchema = z.looseObject({
  type: z.literal('chatgpt'),
  email: z.string().max(320).nullable().optional(),
  planType: z.string().min(1).max(128).nullable().optional(),
});

export const ApiKeyAccountSchema = z.looseObject({ type: z.literal('apiKey') });

export const BedrockAccountSchema = z.looseObject({
  type: z.literal('amazonBedrock'),
  credentialSource: z.enum(['codexManaged', 'awsManaged']),
});

/** One `model/list` page (M13, C29): its rows are read one by one (models.ts). */
export const ModelListPageSchema = z.looseObject({
  data: z.array(z.unknown()),
  nextCursor: z.string().nullish(),
});

export const RateLimitsEnvelopeSchema = z.looseObject({
  rateLimits: z.unknown().nullable().optional(),
  rateLimitsByLimitId: z.unknown().nullable().optional(),
});
