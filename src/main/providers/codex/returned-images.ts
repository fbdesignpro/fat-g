// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Codex's imageGeneration.result is inline base64. savedPath is only a claim; this adapter never
// reads provider storage. Bounds are checked before main allocates decoded bytes.
import { MAX_IMAGE_BASE64, type ReturnedImage } from '@shared/contracts/returned-images';

export function takeReturnedImage(raw: unknown): ReturnedImage {
  if (typeof raw !== 'object' || raw === null) return { kind: 'unavailable', reason: 'invalid' };
  const item = raw as Record<string, unknown>;
  if (item['status'] === 'failed' || item['failure'] != null) return { kind: 'unavailable', reason: 'failed' };
  if (item['status'] !== 'completed') return { kind: 'unavailable', reason: 'missing' };
  const result = item['result'];
  if (typeof result !== 'string' || result === '') return { kind: 'unavailable', reason: 'missing' };
  if (result.length > MAX_IMAGE_BASE64) return { kind: 'unavailable', reason: 'too-large' };
  return { kind: 'base64', data: result };
}
