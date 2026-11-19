// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// Each provider module's defaults, checked against the contract once, when the catalog service is
// created (docs/planning/_archive/M13.md, C24, C72). Defaults that fail are a defect of the build, never a
// state the user sees: the start stops, as it does for two providers with one id.
import { type CatalogDefaults, CatalogDefaultsSchema } from '@shared/contracts/catalog';
import type { ProviderDefinition } from '@shared/provider-kit/provider';

export class InvalidProviderDefaults extends Error {}

/** A logo's address: an image of the kinds a page draws, inline, and no larger than this (M100, C69). */
const LOGO = /^data:image\/(?:png|webp|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_LOGO_LENGTH = 256 * 1024;

/**
 * The definition's defaults, parsed, its logo added to the presentation; throws on the first that
 * does not match, on a logo that is not an inline image, or on a guide that is not `https:`.
 */
export function parseDefaults(definition: Pick<ProviderDefinition, 'descriptor' | 'catalogDefaults' | 'installationGuide' | 'logo' | 'streamImage'>): CatalogDefaults {
  const id = definition.descriptor.id;
  const parsed = CatalogDefaultsSchema.safeParse(definition.catalogDefaults);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new InvalidProviderDefaults(`provider ${id}: catalog defaults do not match the contract (${first?.code ?? 'invalid'} at ${first?.path.join('.') ?? ''})`);
  }
  if (!isHttps(definition.installationGuide)) throw new InvalidProviderDefaults(`provider ${id}: the installation guide is not an https: address`);
  const { logo, streamImage } = definition;
  for (const [name, image] of [['logo', logo], ['stream image', streamImage]] as const) {
    if (image !== undefined && (image.length > MAX_LOGO_LENGTH || !LOGO.test(image))) {
      throw new InvalidProviderDefaults(`provider ${id}: the ${name} is not an inline png, webp or jpeg image`);
    }
  }
  const { presentation } = parsed.data;
  return { ...parsed.data, presentation: {
    ...presentation,
    ...(logo === undefined ? {} : { logo }),
    ...(streamImage === undefined || presentation.stream === undefined ? {} : { stream: { ...presentation.stream, image: streamImage } }),
  } };
}

function isHttps(address: string): boolean {
  try {
    return new URL(address).protocol === 'https:';
  } catch {
    return false;
  }
}
