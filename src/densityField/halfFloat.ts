/**
 * f32 -> IEEE-754 binary16, for `queue.writeTexture` into an `rg16float`.
 *
 * PURE and dependency-free, so it runs under `node --test`.
 *
 * ## WHY THIS EXISTS AT ALL
 *
 * There is no half-float type in JavaScript that this codebase can rely on.
 * `Float16Array`, `Math.f16round` and `DataView.setFloat16` are ES2025 and are
 * absent from the Node version this project's own CI pins (checked: all three
 * are `undefined` on Node 22). `writeTexture` into an `rg16float` needs the raw
 * 16-bit patterns, so the conversion has to be written out.
 *
 * ## WHY rg16float AND NOT SOMETHING EASIER
 *
 * Two easier formats were rejected for reasons that are properties of base
 * WebGPU rather than preferences:
 *
 *   * `rg32float` needs no conversion, and base WebGPU can neither FILTER nor
 *     blend it without an optional device feature. The density field is
 *     sampled with linear filtering at arbitrary world positions, so this would
 *     narrow the device matrix -- exactly the trade ARCHITECTURE.md invariant 7
 *     records for the canvas and the strafe field, which is why they are
 *     rg16float too. Matching them also means `CANVAS_FORMAT` covers this
 *     texture with no second constant.
 *   * `rgba8unorm` filters everywhere and needs no conversion either, but 8
 *     bits over a normalized [-1,1] is a resolution of 1/128. The field is
 *     scaled so its PEAK is 1, so a typical texel sits well below that, and
 *     quantizing there would flatten precisely the low-contrast structure a
 *     tomogram carries -- turning a smooth density ramp into terraces.
 *
 * fp16 carries 11 significant bits and a wide exponent, which loses nothing
 * that survived the blur.
 */

/** Scratch for reinterpreting a float's bits. Module-scope so the hot loop in
 *  `packF16` does not allocate per value. */
const f32Scratch = new Float32Array(1);
const u32Scratch = new Uint32Array(f32Scratch.buffer);

/**
 * One f32 to the 16 bits of its nearest binary16, as a number in 0..65535.
 *
 * Round-to-nearest-even, matching what the GPU would do converting the same
 * value. Overflow saturates to Infinity rather than wrapping to zero, which is
 * the failure worth avoiding: a wrapped exponent turns a large push into a
 * tiny one silently, where an Infinity is at least visible.
 */
export function f32ToF16Bits(value: number): number {
  f32Scratch[0] = value;
  const bits = u32Scratch[0]!;
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  const mantissa = bits & 0x7fffff;

  // Inf and NaN keep their class. A NaN must stay a NaN rather than becoming
  // Infinity: they behave differently in the shader's arithmetic, and a NaN
  // that arrives as a huge finite number is a push instead of a poison.
  if (exponent === 0xff) {
    return sign | 0x7c00 | (mantissa !== 0 ? 0x200 : 0);
  }

  // f32 bias is 127, f16 bias is 15.
  const e = exponent - 127 + 15;

  if (e >= 0x1f) return sign | 0x7c00; // overflow -> Inf
  if (e <= 0) {
    // Subnormal, or too small to represent at all. -10 is where even the
    // implicit leading bit shifts off the end of the 10-bit mantissa.
    if (e < -10) return sign;
    const withImplicit = mantissa | 0x800000;
    const shift = 14 - e;
    let m = withImplicit >>> shift;
    // Round half up on the bit that fell off. Carrying out of the mantissa
    // into the exponent field is CORRECT here and needs no special case: the
    // next representable value above the largest subnormal is the smallest
    // normal, and the bit patterns are contiguous.
    if ((withImplicit >>> (shift - 1)) & 1) m += 1;
    return sign | m;
  }

  // Normal. Same carry argument as above: rounding the mantissa up out of its
  // 10 bits increments the exponent, which is the right answer.
  let out = sign | (e << 10) | (mantissa >>> 13);
  if (mantissa & 0x1000) out += 1;
  return out;
}

/**
 * A whole `Float32Array` to the `Uint16Array` `writeTexture` wants.
 *
 * The return type names its buffer explicitly. Bare `Uint16Array` means
 * `Uint16Array<ArrayBufferLike>`, which includes `SharedArrayBuffer` and so is
 * not assignable to `GPUAllowSharedBufferSource` -- the array this actually
 * builds is backed by a plain `ArrayBuffer`, and saying so is what lets the
 * caller pass it straight to `writeTexture` without a cast.
 */
export function packF16(values: Float32Array): Uint16Array<ArrayBuffer> {
  const out = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = f32ToF16Bits(values[i]!);
  return out;
}
