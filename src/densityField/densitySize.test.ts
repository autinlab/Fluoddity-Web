import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_DENSITY_DIM, densityFieldDimensions } from './densitySize.ts';

test('a canvas within the texel budget is used at full resolution', () => {
  assert.deepEqual(densityFieldDimensions([800, 600]), [800, 600]);
  // Exactly at the budget, which must not trip the cap.
  assert.deepEqual(densityFieldDimensions([MAX_DENSITY_DIM, MAX_DENSITY_DIM]), [
    MAX_DENSITY_DIM,
    MAX_DENSITY_DIM,
  ]);
});

test('the cap is on TOTAL texels, so a wide canvas may exceed the edge', () => {
  // 2000x400 is 800,000 texels, under the 1,048,576 budget -- so it is kept at
  // full resolution even though 2000 > MAX_DENSITY_DIM. Reading the cap as
  // min(w, 1024) would shrink this to 1024x400 and change the field's SHAPE,
  // which world<->uv normalization turns into a silent skew.
  assert.deepEqual(densityFieldDimensions([2000, 400]), [2000, 400]);
});

test('an over-budget canvas keeps its aspect and fits the budget', () => {
  const [w, h] = densityFieldDimensions([4096, 4096]);
  assert.ok(w * h <= MAX_DENSITY_DIM * MAX_DENSITY_DIM + w + h, `${w}x${h} exceeds the budget`);
  assert.equal(w, h, 'a square canvas must stay square');
});

test('the density cap is larger than the strafe field\'s, deliberately', async () => {
  // Pinned because the two look like the same constant and are not: the strafe
  // field holds soft brush strokes, this holds image structure. A well-meant
  // "unify these" would blur a tomogram's features before the physics saw them.
  const { MAX_FIELD_DIM } = await import('../strafeField/fieldSize.ts');
  assert.ok(
    MAX_DENSITY_DIM > MAX_FIELD_DIM,
    'the density field must resolve finer than the painted strafe field',
  );
});
