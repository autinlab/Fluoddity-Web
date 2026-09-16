/**
 * The scoring leaf, checked on synthetic grids.
 *
 * These are the assertions that say the metric measures what its name claims,
 * and they matter more than usual here: every one of these functions returns a
 * plausible number for every input, so a sign error or a transposed index would
 * produce a search that runs happily and converges on nothing.
 *
 * The grids are hand-written and asymmetric wherever orientation could hide --
 * the same reason `densityGradient.test.ts` uses a corner-bright fixture rather
 * than a centred blob.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  gridStats,
  highPass,
  letterboxMask,
  luma,
  MAX_SPREAD,
  pearson,
  scoreCandidate,
  sobelMagnitude,
} from './score.ts';

/** An n x n grid from a row-major string of digits, '0'..'9' scaled to 0..1. */
/** Read a cell, asserting it exists -- `noUncheckedIndexedAccess` is on. */
function cell(values: readonly number[], index: number): number {
  const v = values[index];
  assert.ok(v !== undefined, `no cell at ${index}`);
  return v;
}

function grid(rows: readonly string[]): { data: number[]; n: number } {
  const n = rows.length;
  const data: number[] = [];
  for (const row of rows) {
    assert.equal(row.length, n, 'grid fixtures must be square');
    for (const ch of row) data.push(Number(ch) / 9);
  }
  return { data, n };
}

test('luma is Rec.709 and lands on 0..1', () => {
  assert.equal(luma(0, 0, 0), 0);
  // The three coefficients sum to one only in decimal, not in binary, so white
  // lands a half-ULP short. A tolerance rather than a fudged constant.
  assert.ok(Math.abs(luma(255, 255, 255) - 1) < 1e-12);
  // Green carries most of the weight, which is what separates this from a mean.
  assert.ok(luma(0, 255, 0) > luma(255, 0, 0));
  assert.ok(luma(255, 0, 0) > luma(0, 0, 255));
});

test('pearson is 1 for a copy and -1 for an inversion', () => {
  const a = [0, 0.25, 0.5, 0.75, 1];
  const b = a.map((v) => 1 - v);
  assert.ok(Math.abs(pearson(a, a) - 1) < 1e-12);
  assert.ok(Math.abs(pearson(a, b) + 1) < 1e-12);
});

test('pearson returns 0 rather than NaN when a side is constant', () => {
  // A blank render must sort as "no correlation", not as NaN. NaN compares
  // false against everything and would place unpredictably among real scores.
  const flat = [0.5, 0.5, 0.5, 0.5];
  assert.equal(pearson(flat, [0, 1, 0, 1]), 0);
  assert.equal(pearson(flat, flat), 0);
  assert.equal(pearson([], []), 0);
});

test('pearson rejects mismatched lengths rather than reading past the end', () => {
  assert.throws(() => pearson([1, 2], [1, 2, 3]), /equal lengths/);
});

test('sobel is zero on a flat field -- the reason particles fill nothing', () => {
  // This is the property the whole "edge alignment is primary" decision rests
  // on. A uniformly bright region has no gradient, so the density field pushes
  // nothing there, so a correct simulation leaves it empty.
  const g = grid(['9999', '9999', '9999', '9999']);
  for (const v of sobelMagnitude(g.data, g.n)) assert.equal(v, 0);
});

test('sobel is zero in the interior of a filled region and non-zero on its rim', () => {
  // The block has to be at least 5 wide for an interior cell to exist at all --
  // every cell of a 2x2 block is on its own boundary. This is the same shape
  // the "a white disc stops pushing once you are inside it" claim describes.
  const g = grid([
    '000000000',
    '000000000',
    '009999900',
    '009999900',
    '009999900',
    '009999900',
    '009999900',
    '000000000',
    '000000000',
  ]);
  const mag = sobelMagnitude(g.data, g.n);
  const interior = cell(mag, 4 * 9 + 4);
  const rim = cell(mag, 2 * 9 + 4);
  assert.equal(interior, 0);
  assert.ok(rim > 0, `rim ${rim} should be lit`);
});

test('sobel clamps at the border instead of wrapping', () => {
  // A bright left column against a dark rest. If the fetch wrapped, the
  // rightmost column would see the bright one and report a false edge.
  const g = grid(['9000', '9000', '9000', '9000']);
  const mag = sobelMagnitude(g.data, g.n);
  assert.equal(cell(mag, 0 * 4 + 3), 0);
  assert.ok(cell(mag, 0 * 4 + 1) > 0);
});

test('sobel rejects a grid whose length disagrees with n', () => {
  assert.throws(() => sobelMagnitude([1, 2, 3], 4), /expected 16/);
});

test('gridStats reports spread relative to the picture own peak', () => {
  // Same shape at two brightnesses must report the same spread, or a dim preset
  // would be rejected as "collapsed" purely for being dim.
  const bright = grid(['9900', '9900', '0000', '0000']);
  const dim = grid(['2200', '2200', '0000', '0000']);
  assert.equal(gridStats(bright.data).spread, gridStats(dim.data).spread);
  assert.equal(gridStats(bright.data).spread, 0.25);
});

test('gridStats on an empty grid does not divide by zero', () => {
  assert.deepEqual(gridStats([]), { mean: 0, std: 0, max: 0, spread: 0 });
});

test('a render tracing the target outline outscores one filling its interior', () => {
  // The headline claim of the scorer, stated as a test: given a solid square
  // target, the OUTLINE is the better answer, because that is what a gradient
  // field can actually produce.
  const target = grid(['000000', '011110', '011110', '011110', '011110', '000000']);
  const outline = grid(['000000', '099990', '090090', '090090', '099990', '000000']);
  const fill = grid(['000000', '099990', '099990', '099990', '099990', '000000']);

  const outlineScore = scoreCandidate(outline.data, target.data, target.n);
  const fillScore = scoreCandidate(fill.data, target.data, target.n);

  assert.equal(outlineScore.rejected, null);
  assert.equal(fillScore.rejected, null);
  assert.ok(
    outlineScore.edgeAlignment > fillScore.edgeAlignment,
    `outline ${outlineScore.edgeAlignment} should beat fill ${fillScore.edgeAlignment}`,
  );
  // ...and occupancy says the opposite, which is exactly why it is secondary.
  assert.ok(fillScore.occupancy > outlineScore.occupancy);
});

test('a blank render is rejected, not merely scored low', () => {
  const target = grid(['0990', '9009', '9009', '0990']);
  const blank = grid(['0000', '0000', '0000', '0000']);
  const s = scoreCandidate(blank.data, target.data, target.n);
  assert.equal(s.rejected, 'no structure');
  assert.equal(s.rank, Number.NEGATIVE_INFINITY);
});

test('a single-blob render is rejected', () => {
  const rows = Array.from({ length: 16 }, (_, y) =>
    Array.from({ length: 16 }, (_, x) => (x === 8 && y === 8 ? '9' : '0')).join(''),
  );
  const blob = grid(rows);
  const target = grid(Array.from({ length: 16 }, (_, y) => (y % 2 ? '9'.repeat(16) : '0'.repeat(16))));
  const s = scoreCandidate(blob.data, target.data, target.n);
  assert.equal(s.rejected, 'collapsed to a blob');
});

test('a uniform wash is rejected even though it correlates with nothing', () => {
  const rows = Array.from({ length: 8 }, (_, y) =>
    Array.from({ length: 8 }, (_, x) => String(5 + ((x + y) % 2))).join(''),
  );
  const wash = grid(rows);
  assert.ok(gridStats(wash.data).spread > MAX_SPREAD);
  const target = grid(Array.from({ length: 8 }, () => '09090909'));
  assert.equal(scoreCandidate(wash.data, target.data, target.n).rejected, 'uniform wash');
});

test('a rejected candidate cannot outrank any accepted one', () => {
  const target = grid(['000000', '011110', '011110', '011110', '011110', '000000']);
  const outline = grid(['000000', '099990', '090090', '090090', '099990', '000000']);
  const blank = grid(['000000', '000000', '000000', '000000', '000000', '000000']);
  const good = scoreCandidate(outline.data, target.data, target.n);
  const bad = scoreCandidate(blank.data, target.data, target.n);
  assert.ok(good.rank > bad.rank);
});

test('letterboxMask covers everything when the aspects agree', () => {
  const m = letterboxMask(8, 1, 1);
  assert.equal(m.filter(Boolean).length, 64);
});

test('a portrait image in a square world masks off vertical margins', () => {
  // 635x896 into a square: the image keeps full height and 70.9% of the width.
  const n = 32;
  const m = letterboxMask(n, 635 / 896, 1);
  const covered = m.filter(Boolean).length / m.length;
  assert.ok(Math.abs(covered - 0.709) < 0.04, `covered ${covered}`);
  // Full height in the middle column, margin at the far left and right.
  assert.equal(m[0 * n + Math.floor(n / 2)], true);
  assert.equal(m[0 * n + 0], false);
  assert.equal(m[0 * n + (n - 1)], false);
});

test('a landscape image in a square world masks off horizontal margins', () => {
  const n = 16;
  const m = letterboxMask(n, 2, 1);
  assert.equal(m[Math.floor(n / 2) * n + 0], true);
  assert.equal(m[0 * n + 0], false);
});

test('the margin can dominate a correlation, and the mask removes it', () => {
  // THE MEASURED FAILURE, as a test. The target is blank in the margins and
  // structured in the middle; the render is the exact inverse of the margin
  // occupancy and carries NO relation to the middle. Unmasked, that scores as a
  // strong correlation. Masked, it correctly scores as nothing.
  const n = 16;
  const mask = letterboxMask(n, 0.5, 1); // middle half covered
  const target: number[] = [];
  const render: number[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const inside = mask[y * n + x];
      target.push(inside ? 0.8 : 0.0);
      // Bright in the margin, uniformly mid inside -- no structure to find.
      render.push(inside ? 0.5 : 1.0);
    }
  }
  const unmasked = scoreCandidate(render, target, n);
  const withMask = scoreCandidate(render, target, n, mask);
  assert.ok(unmasked.occupancy < -0.9, `unmasked ${unmasked.occupancy}`);
  assert.equal(withMask.occupancy, 0);
});

test('image scale pushes the letterbox margin off-world', () => {
  // 635x896 into a square leaves 29% of the width as margin at scale 1. At
  // scale 2 the world only sees the central half of the texture, which is
  // entirely inside the picture, so nothing is masked off.
  const n = 32;
  const at1 = letterboxMask(n, 635 / 896, 1, 1).filter(Boolean).length;
  const at2 = letterboxMask(n, 635 / 896, 1, 2).filter(Boolean).length;
  assert.ok(at1 < n * n, `scale 1 should mask something, got ${at1}`);
  assert.equal(at2, n * n);
});

test('highPass removes a smooth ramp and keeps a local feature', () => {
  const n = 16;
  const ramp: number[] = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) ramp.push(x / n);
  const flat = highPass(ramp, n, 3);
  // A linear ramp is its own neighbourhood mean away from the borders.
  assert.ok(Math.abs(flat[8 * n + 8] ?? 1) < 1e-9);

  const spot = ramp.slice();
  spot[8 * n + 8] = 1.0;
  const kept = highPass(spot, n, 3);
  // The spot sits inside its own neighbourhood, so it lifts the mean it is
  // measured against and keeps a little under the 0.5 it was raised by.
  assert.ok((kept[8 * n + 8] ?? 0) > 0.4, `spot kept ${kept[8 * n + 8]}`);
  // ...and far more than a cell the spot did not touch.
  assert.ok((kept[8 * n + 8] ?? 0) > 10 * Math.abs(kept[2 * n + 2] ?? 0));
});

test('a smooth gradient cannot fake structure', () => {
  // THE MEASURED FAILURE, as a test. Two ramps at right angles correlate
  // strongly under a plain Pearson and not at all once the trend is removed.
  const n = 24;
  const target: number[] = [];
  const render: number[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      target.push(x / n);
      render.push(1 - x / n);
    }
  }
  const s = scoreCandidate(render, target, n);
  assert.ok(Math.abs(s.occupancy) > 0.9, `occupancy ${s.occupancy}`);
  assert.ok(Math.abs(s.structure) < 0.2, `structure ${s.structure}`);
});
