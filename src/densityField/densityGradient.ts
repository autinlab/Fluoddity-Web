/**
 * A density image -> the gradient vector field the particles read.
 *
 * PURE, in the way `share/shareImage.ts` and `config/shareLink.ts` are pure --
 * no DOM, no `createImageBitmap`, no GPU. It takes an `RgbaImage` and returns a
 * plain `Float32Array`, which is what lets every decision below run under
 * `node --test`. `ui/imageDrop.ts` owns everything that touches a `<canvas>` or
 * a `File`, and `densityField.ts` owns the texture.
 *
 * ---------------------------------------------------------------------------
 * THE Y FLIP, WHICH IS THE THIRD ONE IN THIS CODEBASE AND THE SAME HAZARD
 * ---------------------------------------------------------------------------
 * `world_to_uv` is `p / (2*extent) + 0.5`, so world **+y maps to increasing
 * uv.y**, and uv.y increasing is increasing TEXEL ROW. An image's row 0 is its
 * TOP. So the world's bottom edge is texel row 0, and an image written into the
 * texture in its natural row order arrives UPSIDE DOWN.
 *
 * Two consequences, and BOTH are applied here:
 *
 *   1. Rows are emitted flipped -- output row 0 is the image's LAST row.
 *   2. The vertical gradient is NEGATED. Sobel's `gy` measures d(luma)/d(row
 *      going down the picture); world +y is up. `gx` needs no such flip.
 *
 * This is the failure mode `README.md` calls the most dangerous in the port,
 * for a reason that applies here unchanged: a vertically mirrored density field
 * is still a completely plausible-looking field. Nothing errors, and there is
 * no overlay that would disagree. `densityGradient.test.ts` therefore pins it
 * with an ASYMMETRIC fixture -- bright in one corner only -- because a
 * symmetric one passes just as well upside down.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BLUR IS NOT OPTIONAL
 * ---------------------------------------------------------------------------
 * The intended input is scientific density data -- a cryo-ET slice, a
 * segmentation, a micrograph -- and cryo-ET in particular is dominated by
 * shot noise at the pixel scale. The gradient operator amplifies exactly that:
 * differentiating raw tomogram data gives a field whose magnitude is noise and
 * whose direction is random per texel, which drives particles into a jitter
 * that looks like a broken simulation rather than like a density bias.
 *
 * So the chain is smooth-THEN-differentiate, and the smoothing is a fixed
 * constant rather than a control, for the same reason `STRAFE_FIELD_GAIN` is:
 * there is one honest setting for it, and a second knob next to the strength
 * sliders would only be a way to turn the feature off twice.
 */

import type { RgbaImage } from '../share/qrRender.ts';
import { letterboxScale } from '../particleSystem/coords.ts';

/**
 * Gaussian sigma, in FIELD texels -- not image pixels.
 *
 * Measured after the resample, so the amount of smoothing is the same whether
 * the dropped image is 256px or 4000px across. Sigma in image pixels would mean
 * a big image arrived sharper than a small one, which is the opposite of what
 * anyone expects and would make the feature feel unpredictable across inputs.
 *
 * 2.0 is about the smallest that reliably survives cryo-ET noise while still
 * resolving a membrane bilayer as one edge rather than two.
 */
export const DENSITY_BLUR_SIGMA = 2.0;

/**
 * Percentile clip for the contrast stretch, at each end.
 *
 * Cryo-ET data occupies a narrow band of the available range, and a dropped
 * figure usually carries pure-white margins and black lettering that a
 * min/max normalization would spend the ENTIRE range on -- leaving the actual
 * density flat. Clipping 2% off each end throws those away.
 */
export const DENSITY_CLIP_PERCENTILE = 0.02;

/**
 * The gradient field, ready for `queue.writeTexture`.
 *
 * Interleaved `(gx, gy)` pairs, row-major, `width * height * 2` floats.
 *
 * **Row 0 is the world's BOTTOM edge** (uv.y = 0) and `gy` is in WORLD
 * orientation (+y up) -- see the Y-flip note in this file's header. Both
 * conventions are already applied; a caller uploads this as-is.
 *
 * Vectors point toward INCREASING density, and are scaled so a strong edge is
 * about unit length. A positive strength therefore ATTRACTS toward dense
 * regions, which is the sign the sliders are labelled for.
 */
export interface GradientField {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;
}

/** Rec.709 luma. Any weighting works on the greyscale data this targets; this
 *  one is right for a colour figure and costs nothing. */
export function luminance(image: RgbaImage): Float32Array {
  const { width, height, data } = image;
  const out = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const p = i * 4;
    out[i] = 0.2126 * data[p]! + 0.7152 * data[p + 1]! + 0.0722 * data[p + 2]!;
  }
  return out;
}

/**
 * Resample into a `dstW x dstH` box by AREA AVERAGING.
 *
 * Not bilinear: dropping a 4000px figure onto a 512-texel field is a 8x
 * downscale, where bilinear reads four adjacent source pixels and ignores the
 * other sixty. On noisy data that is indistinguishable from point sampling --
 * it aliases the noise straight through into the gradient. Averaging every
 * source pixel that falls in a destination texel is the filter that actually
 * removes what it is meant to.
 *
 * Upscaling degenerates to nearest, which is correct here: there is no detail
 * to invent, and the blur that follows smooths the steps out anyway.
 */
function resampleArea(
  src: Float32Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Float32Array {
  const out = new Float32Array(dstW * dstH);
  for (let y = 0; y < dstH; y++) {
    const y0 = Math.floor((y * srcH) / dstH);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * srcH) / dstH));
    for (let x = 0; x < dstW; x++) {
      const x0 = Math.floor((x * srcW) / dstW);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * srcW) / dstW));
      let sum = 0;
      let n = 0;
      for (let sy = y0; sy < y1 && sy < srcH; sy++) {
        for (let sx = x0; sx < x1 && sx < srcW; sx++) {
          sum += src[sy * srcW + sx]!;
          n++;
        }
      }
      out[y * dstW + x] = n > 0 ? sum / n : 0;
    }
  }
  return out;
}

/**
 * Map to 0..1 against the 2nd and 98th percentiles, clamping outside.
 *
 * A histogram rather than a sort: 4096 buckets over the observed range is
 * exact enough to pick a percentile and is linear rather than n log n.
 *
 * A FLAT input yields all zeros rather than dividing by a zero span -- a
 * uniform image genuinely has no density structure, and Infinity here would
 * reach the GPU as a NaN position and permanently kill every particle it
 * touched.
 */
function contrastStretch(values: Float32Array): Float32Array {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const out = new Float32Array(values.length);
  if (!(hi > lo)) return out;

  const BUCKETS = 4096;
  const hist = new Int32Array(BUCKETS);
  const scale = BUCKETS / (hi - lo);
  for (const v of values) {
    const b = Math.min(BUCKETS - 1, Math.floor((v - lo) * scale));
    hist[b]!++;
  }

  const target = values.length * DENSITY_CLIP_PERCENTILE;
  let acc = 0;
  let loBucket = 0;
  for (; loBucket < BUCKETS - 1 && acc + hist[loBucket]! < target; loBucket++) {
    acc += hist[loBucket]!;
  }
  acc = 0;
  let hiBucket = BUCKETS - 1;
  for (; hiBucket > 0 && acc + hist[hiBucket]! < target; hiBucket--) {
    acc += hist[hiBucket]!;
  }

  const pLo = lo + loBucket / scale;
  const pHi = lo + (hiBucket + 1) / scale;
  // Percentiles can collapse onto one bucket when almost every pixel shares a
  // value -- a mostly-blank figure. Fall back to the full range rather than
  // dividing by ~0 and turning the little structure there is into a hard mask.
  const span = pHi - pLo > 1e-6 ? pHi - pLo : hi - lo;
  for (let i = 0; i < values.length; i++) {
    out[i] = Math.min(1, Math.max(0, (values[i]! - pLo) / span));
  }
  return out;
}

/** One axis of a separable Gaussian, with edge clamping. */
function blurAxis(
  src: Float32Array,
  w: number,
  h: number,
  kernel: Float32Array,
  horizontal: boolean,
): Float32Array {
  const out = new Float32Array(src.length);
  const radius = (kernel.length - 1) / 2;
  const limit = horizontal ? w : h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const t = Math.min(limit - 1, Math.max(0, (horizontal ? x : y) + k));
        sum += kernel[k + radius]! * src[horizontal ? y * w + t : t * w + x]!;
      }
      out[y * w + x] = sum;
    }
  }
  return out;
}

/** Separable Gaussian blur. Separable because a 2D pass at sigma 2 is a 13x13
 *  kernel -- 169 taps per texel against 26. */
function gaussianBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma <= 0) return src;
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let total = 0;
  for (let k = -radius; k <= radius; k++) {
    const v = Math.exp(-(k * k) / (2 * sigma * sigma));
    kernel[k + radius] = v;
    total += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i]! /= total;
  return blurAxis(blurAxis(src, w, h, kernel, true), w, h, kernel, false);
}

/**
 * The field, from a dropped image and the texture size it has to fill.
 *
 * `fieldSize` is the DESTINATION texture's dimensions, which carry the canvas's
 * aspect. The image is fitted into it preserving its own aspect -- FIT, not
 * fill, which is the same choice the camera's letterbox makes and for the same
 * reason: the whole image stays visible and a round virion stays round. The
 * margin is left at zero, so particles outside the image feel nothing.
 *
 * `letterboxScale` is COMPOSED rather than reimplemented, per invariant 9:
 * this is aspect math, and the two places allowed to write it are `coords.ts`
 * and `common.wgsl`.
 */
export function densityGradient(
  image: RgbaImage,
  fieldSize: readonly [number, number],
  sigma: number = DENSITY_BLUR_SIGMA,
): GradientField {
  const [fw, fh] = fieldSize;
  const data = new Float32Array(fw * fh * 2);
  if (fw <= 0 || fh <= 0 || image.width <= 0 || image.height <= 0) {
    return { width: Math.max(0, fw), height: Math.max(0, fh), data };
  }

  // The image's sub-rectangle inside the field, in texels, centred.
  const [sx, sy] = letterboxScale(
    [image.width, image.height],
    [fw, fh],
  );
  const innerW = Math.max(1, Math.round(fw * sx));
  const innerH = Math.max(1, Math.round(fh * sy));
  const offX = Math.floor((fw - innerW) / 2);
  const offY = Math.floor((fh - innerH) / 2);

  // Resample FIRST, then stretch, then blur, then differentiate. Every step
  // after the resample therefore works in field texels, which is what makes
  // `sigma` mean the same thing for any input size.
  const lum = luminance(image);
  const small = resampleArea(lum, image.width, image.height, innerW, innerH);
  const norm = contrastStretch(small);
  const blurred = gaussianBlur(norm, innerW, innerH, sigma);

  // Sobel, into a scratch buffer that is still in IMAGE row order (row 0 =
  // top). The flip to world order happens on the way out, below.
  const gxs = new Float32Array(innerW * innerH);
  const gys = new Float32Array(innerW * innerH);
  let peak = 0;
  const at = (x: number, y: number): number =>
    blurred[Math.min(innerH - 1, Math.max(0, y)) * innerW + Math.min(innerW - 1, Math.max(0, x))]!;
  for (let y = 0; y < innerH; y++) {
    for (let x = 0; x < innerW; x++) {
      const gx =
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const gy =
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      const i = y * innerW + x;
      gxs[i] = gx;
      // NEGATED: `gy` above increases DOWN the picture, world +y is up.
      gys[i] = -gy;
      const m = gx * gx + gy * gy;
      if (m > peak) peak = m;
    }
  }

  // Scale so the strongest edge in the image is unit length. Relative, not
  // absolute: a faint tomogram and a hard-edged mask then reach the particles
  // with the same authority, so one strength slider reads the same across
  // inputs.
  //
  // A flat image returns HERE rather than falling through with a zero scale.
  // Multiplying by zero would leave `-0` in every lane the negation touched,
  // and while -0 is arithmetically identical to 0 on the GPU, it is the kind of
  // difference that makes a byte comparison in a later test fail for a reason
  // that has nothing to do with what the test is about.
  if (peak <= 0) return { width: fw, height: fh, data };
  const inv = 1 / Math.sqrt(peak);

  for (let y = 0; y < innerH; y++) {
    // THE ROW FLIP. Output row 0 is the world's bottom edge, so the image's
    // last row goes there. `offY` is applied in output space, which is
    // symmetric, so it needs no flip of its own.
    const dstY = fh - 1 - (offY + y);
    if (dstY < 0 || dstY >= fh) continue;
    for (let x = 0; x < innerW; x++) {
      const dstX = offX + x;
      if (dstX < 0 || dstX >= fw) continue;
      const s = y * innerW + x;
      const d = (dstY * fw + dstX) * 2;
      data[d] = gxs[s]! * inv;
      data[d + 1] = gys[s]! * inv;
    }
  }

  return { width: fw, height: fh, data };
}

// ---------------------------------------------------------------------------
// THE SHAREABLE COPY
// ---------------------------------------------------------------------------

/**
 * A small greyscale copy of an image, for the share link.
 *
 * GREYSCALE AND SMALL, because a share link is a URL someone pastes into a
 * message box. The colour channels are thrown away for free -- `densityGradient`
 * only ever reads luminance, so a colour copy would be three times the bytes for
 * information the feature discards on arrival.
 *
 * The size cap is the real cost, and it is a genuine reduction: a link carries a
 * REDUCED copy of the image, not the original. That is acceptable here in a way
 * it would not be for, say, a screenshot, because the gradient is Gaussian-
 * smoothed at sigma 2 in field texels before anything reads it -- so structure
 * finer than a few texels is destroyed on the receiving end regardless.
 *
 * Area-averaged, not point-sampled, for the reason `resampleArea` states.
 */
export function toGrayscaleThumbnail(
  image: RgbaImage,
  maxDim: number,
): { readonly width: number; readonly height: number; readonly data: Uint8Array } {
  const longest = Math.max(image.width, image.height);
  const scale = longest > maxDim ? maxDim / longest : 1;
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));

  const small = resampleArea(luminance(image), image.width, image.height, width, height);

  // STRETCHED HERE, BEFORE THE BYTES ARE WRITTEN, and this is load-bearing
  // rather than tidy.
  //
  // The share codec quantizes these bytes to 16 levels (`SHARE_IMAGE_LEVELS`).
  // Sixteen levels across the FULL 0..255 range is only three or four levels
  // across the range a cryo-ET slice actually occupies -- and low-contrast
  // density data is the whole point of the feature, so that is the common case
  // rather than a corner. Measured on a low-contrast fixture, quantizing without
  // this first moved the recovered gradient by 9.4 degrees on average.
  //
  // Stretching first spends all sixteen levels on the range that carries signal,
  // which drops that to under a degree. The receiving end runs its own stretch
  // over already-stretched data, where it is very nearly a no-op -- so the two
  // do not fight, and an image that never goes through a link is unaffected
  // because nothing calls this on that path.
  const stretched = contrastStretch(small);

  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) {
    // Rounded, not truncated: truncating biases the whole image half a level
    // dark, which is invisible on its own and shifts every gradient built on it.
    data[i] = Math.min(255, Math.max(0, Math.round(stretched[i]! * 255)));
  }
  return { width, height, data };
}

/**
 * The inverse: a greyscale thumbnail back to the `RgbaImage` everything else
 * takes.
 *
 * Opaque alpha, and the same value in all three channels -- so the luminance
 * pass on the receiving side recovers exactly the byte that was sent, rather
 * than a weighted mix that would differ by a rounding step.
 */
export function fromGrayscale(
  width: number,
  height: number,
  gray: Uint8Array,
): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const v = gray[i] ?? 0;
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}
