import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DENSITY_SCALE_DEFAULT,
  DENSITY_SCALE_MAX,
  DENSITY_SCALE_MIN,
  clampDensityScale,
} from './densityScale.ts';

test('a value in range is returned unchanged', () => {
  assert.equal(clampDensityScale(1.0), 1.0);
  assert.equal(clampDensityScale(2.5), 2.5);
  assert.equal(clampDensityScale(DENSITY_SCALE_MIN), DENSITY_SCALE_MIN);
  assert.equal(clampDensityScale(DENSITY_SCALE_MAX), DENSITY_SCALE_MAX);
});

test('out-of-range values clamp to the bounds', () => {
  assert.equal(clampDensityScale(0), DENSITY_SCALE_MIN);
  assert.equal(clampDensityScale(-3), DENSITY_SCALE_MIN);
  assert.equal(clampDensityScale(1000), DENSITY_SCALE_MAX);
});

test('a non-finite or non-numeric value becomes the DEFAULT, not a bound', () => {
  // The shader DIVIDES by this. A NaN reaching it poisons a particle's position
  // permanently, and clamping NaN in JavaScript does not remove it --
  // Math.min/max propagate it. Same reasoning as `setZoom`'s refusal.
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, '2', {}]) {
    assert.equal(clampDensityScale(bad), DENSITY_SCALE_DEFAULT, String(bad));
  }
});

test('the default is inside the bounds', () => {
  assert.ok(DENSITY_SCALE_DEFAULT >= DENSITY_SCALE_MIN);
  assert.ok(DENSITY_SCALE_DEFAULT <= DENSITY_SCALE_MAX);
  // 1.0 exactly, because that is the letterbox fit `densityGradient` builds --
  // any other default would mean a freshly dropped image was already scaled.
  assert.equal(DENSITY_SCALE_DEFAULT, 1.0);
});
