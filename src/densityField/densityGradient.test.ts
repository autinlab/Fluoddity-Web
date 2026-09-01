/**
 * Tests for the density-image gradient field.
 *
 * THE POINT OF THIS FILE is the orientation block. Everything else here is
 * ordinary arithmetic that would be caught by eye in the app; a vertically
 * mirrored density field would NOT be -- it is a plausible field that pushes
 * particles the wrong way, with no error and no overlay that disagrees (see the
 * header of `densityGradient.ts`). So the fixtures are deliberately
 * ASYMMETRIC: a fixture that is symmetric in y passes just as well flipped,
 * which makes it worse than no test at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DENSITY_BLUR_SIGMA, densityGradient } from './densityGradient.ts';
import type { RgbaImage } from '../share/qrRender.ts';

/** An image built from a per-pixel 0..255 grey function of (x, y), y DOWN. */
function greyImage(
  width: number,
  height: number,
  grey: (x: number, y: number) => number,
): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const v = grey(x, y);
      data[p] = v;
      data[p + 1] = v;
      data[p + 2] = v;
      data[p + 3] = 255;
    }
  }
  return { width, height, data };
}

/** Read (gx, gy) at a FIELD texel. Row 0 is the world's bottom edge. */
function texel(
  field: { width: number; data: Float32Array },
  col: number,
  row: number,
): readonly [number, number] {
  const i = (row * field.width + col) * 2;
  return [field.data[i]!, field.data[i + 1]!];
}

// ---------------------------------------------------------------------------
// ORIENTATION -- the whole reason this file exists
// ---------------------------------------------------------------------------

/**
 * The fixture: white in the image's TOP-LEFT quadrant only, black elsewhere.
 *
 * Chosen because it is asymmetric on BOTH axes, so it constrains the row flip
 * and the gx sign independently. A top-half-only fixture would leave gx
 * unconstrained; a left-half-only one would leave the flip unconstrained.
 */
const SIZE = 64;
function topLeftBright(): RgbaImage {
  return greyImage(SIZE, SIZE, (x, y) => (x < SIZE / 2 && y < SIZE / 2 ? 255 : 0));
}

test('the bright region lands in the world TOP-left, not the bottom-left', () => {
  const field = densityGradient(topLeftBright(), [SIZE, SIZE]);

  // Centroid of gradient magnitude. The gradient lives on the EDGES of the
  // bright block, so the centroid sits inside the quadrant that block occupies.
  let wSum = 0;
  let colSum = 0;
  let rowSum = 0;
  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      const [gx, gy] = texel(field, col, row);
      const m = Math.hypot(gx, gy);
      wSum += m;
      colSum += m * col;
      rowSum += m * row;
    }
  }
  assert.ok(wSum > 0, 'a black-and-white step must produce a gradient');
  const centroidCol = colSum / wSum;
  const centroidRow = rowSum / wSum;

  // Image row 0 is the TOP; field row 0 is the world's BOTTOM. So the bright
  // block must show up in the HIGH rows. Getting the flip wrong puts the
  // centroid below the midline and this fails -- which is the only automated
  // check standing between the port and a mirrored density field.
  assert.ok(
    centroidRow > SIZE / 2,
    `bright block is in the image's top half, so its gradient must sit in the ` +
      `field's HIGH rows (world +y). centroid row ${centroidRow.toFixed(1)} of ${SIZE}`,
  );
  assert.ok(
    centroidCol < SIZE / 2,
    `and in the LEFT half: centroid col ${centroidCol.toFixed(1)} of ${SIZE}`,
  );
});

test('gy points UP (toward the dense region) just below the horizontal edge', () => {
  const field = densityGradient(topLeftBright(), [SIZE, SIZE]);

  // White is image rows 0..31, i.e. field rows 32..63. The step therefore sits
  // between field rows 31 (dark) and 32 (bright). One row below it, inside the
  // left half, density increases upward -- so gy must be POSITIVE.
  const [, gy] = texel(field, SIZE / 4, 30);
  assert.ok(
    gy > 0,
    `below the edge the density rises with world +y, so gy > 0; got ${gy}`,
  );
});

test('gx points LEFT (toward the dense region) just right of the vertical edge', () => {
  const field = densityGradient(topLeftBright(), [SIZE, SIZE]);

  // Bright is cols 0..31. Just to the right of the step, at a row inside the
  // bright band (field row 48 == image row 15), density increases leftward.
  const [gx] = texel(field, SIZE / 2 + 2, 48);
  assert.ok(gx < 0, `right of the edge density rises toward -x, so gx < 0; got ${gx}`);
});

test('vectors point toward increasing density, not away', () => {
  // A pure horizontal ramp, dark at the image's top and bright at its bottom.
  // In world terms that is bright at the BOTTOM, so gy must be NEGATIVE
  // everywhere -- the one-line statement of the sign convention.
  const ramp = greyImage(32, 32, (_x, y) => (y / 31) * 255);
  const field = densityGradient(ramp, [32, 32]);
  const [, gy] = texel(field, 16, 16);
  assert.ok(gy < 0, `image gets brighter downward, so world gy < 0; got ${gy}`);
});

// ---------------------------------------------------------------------------
// LETTERBOXING
// ---------------------------------------------------------------------------

test('a wide image is fitted with zeroed bars, not stretched', () => {
  // 64x16 image into a 32x32 field: aspect 4 into aspect 1, so it occupies a
  // 32x8 band centred vertically and the rest stays exactly zero.
  const wide = greyImage(64, 16, (x) => (x < 32 ? 255 : 0));
  const field = densityGradient(wide, [32, 32]);

  // Corners are in the bars.
  for (const row of [0, 1, 30, 31]) {
    for (const col of [0, 15, 31]) {
      const [gx, gy] = texel(field, col, row);
      assert.equal(gx, 0, `bar texel (${col},${row}) gx`);
      assert.equal(gy, 0, `bar texel (${col},${row}) gy`);
    }
  }

  // And the band itself carries the vertical edge the image actually has.
  const [gx] = texel(field, 16, 16);
  assert.ok(Math.abs(gx) > 0, 'the fitted band must carry the image gradient');
});

test('a square image into a square field uses every texel', () => {
  const field = densityGradient(topLeftBright(), [SIZE, SIZE]);
  assert.equal(field.width, SIZE);
  assert.equal(field.height, SIZE);
  assert.equal(field.data.length, SIZE * SIZE * 2);
});

// ---------------------------------------------------------------------------
// NORMALIZATION AND DEGENERATE INPUT
// ---------------------------------------------------------------------------

test('magnitudes are normalized so the strongest edge is about unit length', () => {
  const field = densityGradient(topLeftBright(), [SIZE, SIZE]);
  let peak = 0;
  for (let i = 0; i < field.data.length; i += 2) {
    peak = Math.max(peak, Math.hypot(field.data[i]!, field.data[i + 1]!));
  }
  // Exactly 1 at the strongest texel, and nothing above it -- an unnormalized
  // field would depend on the input's contrast and make one slider position
  // mean different things for different images.
  assert.ok(peak > 0.99 && peak <= 1.0 + 1e-6, `peak magnitude ${peak}`);
});

test('a faint image and a hard-edged one reach the same peak strength', () => {
  // The same step, at 10% contrast. Normalization is RELATIVE, so both arrive
  // with the same authority and one strength slider reads alike for each.
  const faint = greyImage(SIZE, SIZE, (x, y) =>
    x < SIZE / 2 && y < SIZE / 2 ? 128 + 12 : 128 - 12,
  );
  const strong = densityGradient(topLeftBright(), [SIZE, SIZE]);
  const weak = densityGradient(faint, [SIZE, SIZE]);

  const peakOf = (f: { data: Float32Array }): number => {
    let p = 0;
    for (let i = 0; i < f.data.length; i += 2) {
      p = Math.max(p, Math.hypot(f.data[i]!, f.data[i + 1]!));
    }
    return p;
  };
  assert.ok(Math.abs(peakOf(strong) - peakOf(weak)) < 1e-6);
});

test('a flat image yields a zero field rather than a division by zero', () => {
  // The failure this guards is not a wrong picture but a dead simulation: a
  // NaN reaching a particle's position poisons it permanently.
  const field = densityGradient(greyImage(16, 16, () => 128), [16, 16]);
  for (const v of field.data) assert.equal(v, 0);
});

test('every value is finite for a single-pixel image', () => {
  const field = densityGradient(greyImage(1, 1, () => 200), [16, 16]);
  for (const v of field.data) assert.ok(Number.isFinite(v), `got ${v}`);
});

test('a zero-sized field is handled rather than throwing', () => {
  const field = densityGradient(topLeftBright(), [0, 0]);
  assert.equal(field.data.length, 0);
});

// ---------------------------------------------------------------------------
// THE BLUR
// ---------------------------------------------------------------------------

test('the blur makes the gradient follow real structure instead of noise', () => {
  // A disc -- the "real" feature -- buried in strong per-pixel noise, which is
  // the situation a cryo-ET slice actually presents. The claim under test is
  // not that smoothing lowers the gradient (peak normalization would hide
  // that) but that it moves the gradient's energy ONTO the feature.
  //
  // NOTE the fixture is pseudo-random rather than a checkerboard. A perfect
  // checkerboard has ZERO Sobel response -- columns x-1 and x+1 share a parity,
  // so the taps cancel -- which makes it useless as a stand-in for noise.
  let seed = 12345;
  const rand = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const R = 16;
  const noisy = greyImage(64, 64, (x, y) => {
    const inside = Math.hypot(x - 32, y - 32) < R;
    return (inside ? 200 : 60) + (rand() - 0.5) * 160;
  });

  // Mean gradient magnitude in the annulus straddling the disc's edge, over
  // the mean everywhere else. High means "the field describes the disc"; near
  // 1 means "the field describes the noise".
  const edgeRatio = (f: { width: number; data: Float32Array }): number => {
    let edge = 0;
    let edgeN = 0;
    let flat = 0;
    let flatN = 0;
    for (let row = 0; row < 64; row++) {
      for (let col = 0; col < 64; col++) {
        const [gx, gy] = texel(f, col, row);
        const m = Math.hypot(gx, gy);
        // The field is y-flipped relative to the image, and the disc is
        // centred, so its radius is the same measured either way.
        const r = Math.hypot(col - 32, row - 32);
        if (r > R - 3 && r < R + 3) {
          edge += m;
          edgeN++;
        } else if (r < R - 8 || r > R + 8) {
          flat += m;
          flatN++;
        }
      }
    }
    return edge / edgeN / (flat / flatN);
  };

  const raw = edgeRatio(densityGradient(noisy, [64, 64], 0));
  const smoothed = edgeRatio(densityGradient(noisy, [64, 64], DENSITY_BLUR_SIGMA));

  // Noise amplitude is comparable to the step itself, which is the regime a
  // tomogram actually sits in -- unsmoothed, the disc barely rises above it.
  assert.ok(
    raw < 2.0,
    `unsmoothed, the disc should be lost in the noise; edge/flat ratio ${raw.toFixed(2)}`,
  );
  assert.ok(
    smoothed > raw * 3,
    `smoothing must concentrate the gradient on the real edge: ` +
      `raw ${raw.toFixed(2)} vs smoothed ${smoothed.toFixed(2)}`,
  );
});

test('the same input gives the same field every time', () => {
  const a = densityGradient(topLeftBright(), [SIZE, SIZE]);
  const b = densityGradient(topLeftBright(), [SIZE, SIZE]);
  assert.deepEqual([...a.data], [...b.data]);
});
