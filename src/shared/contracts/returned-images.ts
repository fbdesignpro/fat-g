// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

import { z } from 'zod';
import { MAX_IMAGE_BYTES } from './images';

export const MAX_IMAGE_BASE64 = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);
export const IMAGE_RETURN_FAILURES = ['failed', 'missing', 'too-large', 'invalid', 'unsupported', 'busy', 'not-saved'] as const;
export type ImageReturnFailure = (typeof IMAGE_RETURN_FAILURES)[number];
/** Transient provider-to-main content. Encoded bytes never reach a renderer or a stored JSON body. */
export const ReturnedImageSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('base64'), data: z.string().max(MAX_IMAGE_BASE64) }),
  z.strictObject({ kind: z.literal('unavailable'), reason: z.enum(IMAGE_RETURN_FAILURES) }),
]);
export type ReturnedImage = z.infer<typeof ReturnedImageSchema>;
export interface HistoryReturnedImage {
  readonly turnId: string;
  readonly itemId: string;
  readonly image: ReturnedImage;
}
export interface HistoryReturnedImage {
  readonly turnId: string;
  readonly itemId: string;
  readonly image: ReturnedImage;
}

export const returnedImageMessageId = (itemId: string): string => `image:${itemId}`;
