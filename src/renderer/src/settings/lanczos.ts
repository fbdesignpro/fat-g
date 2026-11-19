// SPDX-FileCopyrightText: 2026 Francois Bertrand and the fat-g contributors
// SPDX-License-Identifier: MIT

// The resampler of an added avatar (decision 0036): a square RGBA image scaled down to a square of
// another side by a separable Lanczos filter of three lobes, its support widened by the reduction so
// that every source pixel counts — the filter, the coefficients and the premultiplied colour Pillow's
// `LANCZOS` uses, by which fat-g's own art is made (docs/maintaining-avatar-art.md), so an avatar a
// user adds is filtered as the built-in ones were. Colour is filtered premultiplied by its alpha, so
// that a transparent pixel's colour bleeds into none, in the stored sRGB values as Pillow does.
//
// Pure but for the clock: the page is given back its thread every few milliseconds, so the editor
// stays live while a large image is scaled.

/** The filter's lobes. */
const LOBES = 3;

/** How long a stretch of work runs before the page is given its thread back, in milliseconds. */
const SLICE_MS = 12;

function lanczos(x: number): number {
  if (x === 0) return 1;
  if (x <= -LOBES || x >= LOBES) return 0;
  const pi = Math.PI * x;
  return (LOBES * Math.sin(pi) * Math.sin(pi / LOBES)) / (pi * pi);
}

/** For each target index, the first source index it reads and its weights, which add up to one. */
interface Coefficients {
  readonly first: Int32Array;
  readonly count: Int32Array;
  /** `span` weights for each target index, the unused ones zero. */
  readonly weights: Float64Array;
  readonly span: number;
}

function coefficients(source: number, target: number): Coefficients {
  const scale = source / target;
  const widen = Math.max(scale, 1);
  const support = LOBES * widen;
  const span = Math.ceil(support) * 2 + 1;
  const first = new Int32Array(target);
  const count = new Int32Array(target);
  const weights = new Float64Array(target * span);
  for (let index = 0; index < target; index += 1) {
    const centre = (index + 0.5) * scale;
    const low = Math.max(Math.trunc(centre - support + 0.5), 0);
    const taps = Math.min(Math.min(Math.trunc(centre + support + 0.5), source) - low, span);
    let total = 0;
    for (let tap = 0; tap < taps; tap += 1) {
      const weight = lanczos((tap + low - centre + 0.5) / widen);
      weights[index * span + tap] = weight;
      total += weight;
    }
    if (total !== 0) for (let tap = 0; tap < taps; tap += 1) weights[index * span + tap] = (weights[index * span + tap] ?? 0) / total;
    first[index] = low;
    count[index] = taps;
  }
  return { first, count, weights, span };
}

/**
 * The page's thread given back, by a message to itself rather than a timer: a window the user has
 * covered throttles its timers to one a second, which would leave a large image scaling for minutes.
 */
const yieldToPage = (): Promise<void> => new Promise((resolve) => {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => { channel.port1.close(); resolve(); };
  channel.port2.postMessage(null);
});

/**
 * A square RGBA image of `side` pixels, unpremultiplied as a canvas gives it, scaled to `target`; the
 * same pixels where the sides are equal.
 */
export async function resampleSquare(source: Uint8ClampedArray, side: number, target: number): Promise<Uint8ClampedArray<ArrayBuffer>> {
  if (source.length !== side * side * 4) throw new Error('not a square image of that side');
  if (target === side) return new Uint8ClampedArray(source);
  const horizontal = coefficients(side, target);
  const vertical = horizontal;
  let started = performance.now();
  const pause = async (): Promise<void> => {
    if (performance.now() - started < SLICE_MS) return;
    await yieldToPage();
    started = performance.now();
  };

  // Across: each source row to `target` premultiplied columns.
  const across = new Float32Array(side * target * 4);
  for (let row = 0; row < side; row += 1) {
    const rowAt = row * side * 4;
    for (let column = 0; column < target; column += 1) {
      const low = horizontal.first[column] ?? 0;
      const taps = horizontal.count[column] ?? 0;
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      for (let tap = 0; tap < taps; tap += 1) {
        const weight = horizontal.weights[column * horizontal.span + tap] ?? 0;
        const at = rowAt + (low + tap) * 4;
        const a = (source[at + 3] ?? 0) * weight;
        red += (source[at] ?? 0) * a;
        green += (source[at + 1] ?? 0) * a;
        blue += (source[at + 2] ?? 0) * a;
        alpha += a;
      }
      const out = (row * target + column) * 4;
      // Colour premultiplied by alpha out of 255.
      across[out] = red / 255;
      across[out + 1] = green / 255;
      across[out + 2] = blue / 255;
      across[out + 3] = alpha;
    }
    await pause();
  }

  // Down: each column of `across` to `target` rows, then unpremultiplied, rounded and clamped.
  const result = new Uint8ClampedArray(target * target * 4);
  for (let row = 0; row < target; row += 1) {
    const low = vertical.first[row] ?? 0;
    const taps = vertical.count[row] ?? 0;
    for (let column = 0; column < target; column += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      for (let tap = 0; tap < taps; tap += 1) {
        const weight = vertical.weights[row * vertical.span + tap] ?? 0;
        const at = ((low + tap) * target + column) * 4;
        red += (across[at] ?? 0) * weight;
        green += (across[at + 1] ?? 0) * weight;
        blue += (across[at + 2] ?? 0) * weight;
        alpha += (across[at + 3] ?? 0) * weight;
      }
      const out = (row * target + column) * 4;
      const opaque = Math.min(255, Math.max(0, alpha));
      result[out + 3] = Math.round(opaque);
      if (opaque <= 0) continue;
      result[out] = Math.round((red * 255) / opaque);
      result[out + 1] = Math.round((green * 255) / opaque);
      result[out + 2] = Math.round((blue * 255) / opaque);
    }
    await pause();
  }
  return result;
}
