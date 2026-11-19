// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// An image the user drops on, or chooses at, the family editor — a new avatar's, or an avatar's main
// image or small version replaced — made into its files (decision 0036): decoded here, in the
// sandboxed page — main never decodes an image — then scaled by the Lanczos resampler to a PNG portrait
// of at most 512 px and a PNG small of 64 px, each from the image itself, as fat-g's own art is made.
// Nothing is scaled up: an image of 512 px or less keeps its side, a PNG of it its very bytes. Main
// checks them again by their headers.
import { ADDED_PORTRAIT_SIDE, ADDED_SMALL_SIDE } from '@shared/contracts/avatar-family';
import { imageSignature, MAX_IMAGE_BYTES, MAX_IMAGE_SIDE } from '@shared/contracts/images';
import { resampleSquare } from './lanczos';

/** The largest side the resampler reads: a larger image is first brought to it by Chromium, to bound the memory it takes. */
export const WORKING_SIDE_MAX = 4096;

/** Why an image was not taken. */
export type ImageRefusal =
  /** Not a PNG, a JPEG or a WebP, by its signature. */
  | 'unsupported'
  /** Past 5 MiB or 8,000 px a side. */
  | 'too-large'
  | 'not-square'
  /** Under the small's 64 px. */
  | 'too-small'
  /** Its header or its pixels could not be read. */
  | 'unreadable';

export type PreparedImage =
  | {
    readonly kind: 'prepared';
    /** The PNG portrait and small, as main is handed them. */
    readonly portrait: Uint8Array<ArrayBuffer>;
    readonly small: Uint8Array<ArrayBuffer>;
    /** The image's side as decoded, and the portrait's. */
    readonly sourceSide: number;
    readonly portraitSide: number;
  }
  | ImageRefused;

/** Why an image was not taken, and its sides where they were read. */
export interface ImageRefused { readonly kind: 'refused'; readonly reason: ImageRefusal; readonly width?: number; readonly height?: number }

/** An image made into a small version alone, for an avatar's small replaced. */
export type PreparedSmall = { readonly kind: 'prepared'; readonly small: Uint8Array<ArrayBuffer>; readonly sourceSide: number } | ImageRefused;

const TAKEN = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** A canvas of a side, released once `use` is done with it. */
async function withCanvas<T>(side: number, draw: (context: OffscreenCanvasRenderingContext2D, canvas: OffscreenCanvas) => Promise<T>): Promise<T> {
  const canvas = new OffscreenCanvas(side, side);
  try {
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('no canvas');
    return await draw(context, canvas);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** A square image's pixels, unpremultiplied, in sRGB. */
function pixelsOf(bitmap: ImageBitmap, side: number): Promise<Uint8ClampedArray> {
  return withCanvas(side, (context) => {
    context.drawImage(bitmap, 0, 0);
    return Promise.resolve(context.getImageData(0, 0, side, side).data);
  });
}

/** Pixels encoded as a PNG. */
function pngOf(pixels: Uint8ClampedArray<ArrayBuffer>, side: number): Promise<Uint8Array<ArrayBuffer>> {
  return withCanvas(side, async (context, canvas) => {
    context.putImageData(new ImageData(pixels, side, side), 0, 0);
    return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  });
}

/** An image as a new avatar's two files, or an avatar's main image with its small version. */
export async function prepareAvatarImage(file: Blob): Promise<PreparedImage> {
  const made = await prepare(file, true);
  if (made.kind === 'refused') return made;
  return { kind: 'prepared', portrait: made.portrait ?? made.bytes, small: made.small, sourceSide: made.sourceSide, portraitSide: made.portraitSide };
}

/** An image as an avatar's small version alone. */
export async function prepareSmallImage(file: Blob): Promise<PreparedSmall> {
  const made = await prepare(file, false);
  return made.kind === 'refused' ? made : { kind: 'prepared', small: made.small, sourceSide: made.sourceSide };
}

type Made =
  | { readonly kind: 'made'; readonly bytes: Uint8Array<ArrayBuffer>; readonly portrait: Uint8Array<ArrayBuffer> | null; readonly small: Uint8Array<ArrayBuffer>; readonly sourceSide: number; readonly portraitSide: number }
  | ImageRefused;

async function prepare(file: Blob, withPortrait: boolean): Promise<Made> {
  if (file.size > MAX_IMAGE_BYTES) return { kind: 'refused', reason: 'too-large' };
  if (file.size === 0) return { kind: 'refused', reason: 'unreadable' };
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return { kind: 'refused', reason: 'unreadable' };
  }
  const type = imageSignature(bytes);
  if (type === null || !TAKEN.has(type)) return { kind: 'refused', reason: 'unsupported' };

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes], { type }));
  } catch {
    return { kind: 'refused', reason: 'unreadable' };
  }
  try {
    const { width, height } = bitmap;
    if (width !== height) return { kind: 'refused', reason: 'not-square', width, height };
    if (width > MAX_IMAGE_SIDE) return { kind: 'refused', reason: 'too-large', width, height };
    if (width < ADDED_SMALL_SIDE) return { kind: 'refused', reason: 'too-small', width, height };

    const working = Math.min(width, WORKING_SIDE_MAX);
    const reduced = working === width ? bitmap : await createImageBitmap(bitmap, { resizeWidth: working, resizeHeight: working, resizeQuality: 'high' });
    let pixels: Uint8ClampedArray;
    try {
      pixels = await pixelsOf(reduced, working);
    } finally {
      if (reduced !== bitmap) reduced.close();
    }

    const portraitSide = Math.min(width, ADDED_PORTRAIT_SIDE);
    const portrait = !withPortrait ? null : type === 'image/png' && width <= ADDED_PORTRAIT_SIDE
      ? bytes
      : await pngOf(await resampleSquare(pixels, working, portraitSide), portraitSide);
    const small = await pngOf(await resampleSquare(pixels, working, ADDED_SMALL_SIDE), ADDED_SMALL_SIDE);
    return { kind: 'made', bytes, portrait, small, sourceSide: width, portraitSide };
  } catch {
    return { kind: 'refused', reason: 'unreadable' };
  } finally {
    bitmap.close();
  }
}
