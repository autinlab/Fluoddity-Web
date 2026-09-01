/**
 * Tests for the f32 -> binary16 conversion.
 *
 * The decoder below is written INDEPENDENTLY rather than imported, and that is
 * the point of the file. A round trip through one author's encoder and the
 * same author's decoder closes perfectly even when both share a mistake -- the
 * same argument `README.md` makes for why `parity.fixture.json` is not
 * regenerated from the TypeScript. So the reference here is the IEEE-754
 * definition applied directly (sign, exponent, mantissa reassembled with
 * `Math.pow`), which shares no code path with the bit-shifting under test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { f32ToF16Bits, packF16 } from './halfFloat.ts';

/** binary16 bits -> the number they denote, straight from the spec. */
function decodeF16(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >>> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0x1f) return mantissa === 0 ? sign * Infinity : NaN;
  if (exponent === 0) return sign * mantissa * Math.pow(2, -24); // subnormal
  return sign * (1 + mantissa / 1024) * Math.pow(2, exponent - 15);
}

test('exactly representable values survive unchanged', () => {
  // Every one of these has an exact binary16, so any error is a bug rather
  // than rounding.
  for (const v of [0, 1, -1, 0.5, -0.5, 2, -2, 0.25, 1024, -1024, 0.125]) {
    assert.equal(decodeF16(f32ToF16Bits(v)), v, `${v}`);
  }
});

test('zero keeps its sign', () => {
  assert.equal(f32ToF16Bits(0), 0x0000);
  assert.equal(f32ToF16Bits(-0), 0x8000);
});

test('the field\'s own value range round-trips within fp16 precision', () => {
  // The gradient field is normalized to a peak of 1, so this sweep covers what
  // the texture actually carries. fp16 has 11 significant bits, so a relative
  // error of 2^-11 is the floor; anything worse is a conversion bug.
  for (let v = -1; v <= 1; v += 1 / 512) {
    const back = decodeF16(f32ToF16Bits(v));
    const tolerance = Math.max(Math.abs(v) * Math.pow(2, -10), Math.pow(2, -24));
    assert.ok(
      Math.abs(back - v) <= tolerance,
      `${v} -> ${back}, error ${Math.abs(back - v)} exceeds ${tolerance}`,
    );
  }
});

test('rounds to nearest, not toward zero', () => {
  // 1 + 2^-11 sits exactly halfway between 1 and the next binary16 above it
  // (1 + 2^-10). Truncation would give 1.0; round-to-nearest-even gives the
  // neighbour. A truncating converter passes every test above this one.
  const half = 1 + Math.pow(2, -11);
  assert.equal(decodeF16(f32ToF16Bits(half)), 1 + Math.pow(2, -10));
});

test('values too small for a normal become subnormals, not zero', () => {
  // 2^-20 is below the smallest normal binary16 (2^-14) but well inside the
  // subnormal range. A converter that skipped the subnormal arm would return
  // zero and silently erase the weakest parts of a faint density field.
  const tiny = Math.pow(2, -20);
  assert.equal(decodeF16(f32ToF16Bits(tiny)), tiny);
});

test('values below the subnormal range flush to a signed zero', () => {
  assert.equal(decodeF16(f32ToF16Bits(Math.pow(2, -30))), 0);
  assert.equal(f32ToF16Bits(-Math.pow(2, -30)), 0x8000);
});

test('overflow saturates to Infinity rather than wrapping', () => {
  // The wrap is the failure worth naming: a mangled exponent turns a huge
  // value into a tiny one, so an over-range field would read as almost no
  // field at all instead of as something obviously wrong.
  assert.equal(decodeF16(f32ToF16Bits(1e30)), Infinity);
  assert.equal(decodeF16(f32ToF16Bits(-1e30)), -Infinity);
});

test('Infinity and NaN keep their class', () => {
  assert.equal(decodeF16(f32ToF16Bits(Infinity)), Infinity);
  assert.equal(decodeF16(f32ToF16Bits(-Infinity)), -Infinity);
  assert.ok(Number.isNaN(decodeF16(f32ToF16Bits(NaN))));
});

test('packF16 converts a whole array and preserves length and order', () => {
  const src = new Float32Array([0, 1, -1, 0.5, 0.25]);
  const packed = packF16(src);
  assert.equal(packed.length, src.length);
  assert.deepEqual([...packed].map(decodeF16), [...src]);
});
