/**
 * DensityField: a dropped image, as a gradient vector field on the GPU.
 *
 * WHAT IT IS
 * One `rg16float` texture at capped canvas resolution (`densitySize.ts`). Each
 * texel holds a world-space vector pointing toward increasing density, built on
 * the host from an image the user dropped (`densityGradient.ts`). Three
 * `ConfigData` channels read it -- two that move particles directly and one that
 * feeds the sensors, so the RULE decides what to do about it. See the accessor
 * block in `common.wgsl`.
 *
 * ## WHY IT IS SO MUCH SIMPLER THAN StrafeField
 *
 * It has no pipelines, no shader module, no blend state and no `reload()`,
 * because NOTHING ON THE GPU EVER WRITES IT. The strafe field is painted by a
 * fragment shader and therefore needs a render attachment, two pipelines and a
 * uniform buffer; this is uploaded whole by `queue.writeTexture` and only ever
 * read. `create()` is consequently synchronous -- there is nothing to await,
 * and making it async to match its neighbour would invent a failure mode
 * (a pipeline that did not compile) that cannot occur here.
 *
 * ## WHY IT IS NOT SAVED
 *
 * Same decision as the strafe field, and for a stronger version of the same
 * reason: the texture is megabytes of binary that belong to no Project. It is
 * live-only -- not serialized with a config, not in the undo timeline. What IS
 * saved is the three strength channels, so a config records how hard it would
 * respond to an image without carrying one. A config with a density strength and
 * a session with nothing dropped is a valid inert combination, not a broken one.
 *
 * ## WHY THE SOURCE IMAGE IS KEPT BY THE CALLER
 *
 * `upload()` takes a `GradientField`, which is sized to the canvas. World Size
 * and canvas aspect changes REBUILD the ParticleSystem and every canvas-sized
 * texture with it, so this texture is replaced too -- and a user's dropped image
 * silently vanishing on a World Size change would be a bug. The Orchestrator
 * therefore holds the source `RgbaImage` and re-derives the field at the new
 * size. That is why nothing here tries to resample its own texture: the source
 * data is upstream, and re-deriving from it is both correct and cheap.
 *
 * The Orchestrator drives this module; it holds no reference to any other.
 */

import { CANVAS_FORMAT } from '../particleSystem/particleSystem.ts';
import { densityFieldDimensions } from './densitySize.ts';
import type { GradientField } from './densityGradient.ts';
import { packF16 } from './halfFloat.ts';

export class DensityField {
  private readonly device: GPUDevice;

  /**
   * The field's OWN resolution, which is not the canvas's once the cap bites.
   * Rides in the entity-update uniform so `get_density_gradient` maps world->uv
   * against the texture it is actually sampling -- the same reason StrafeField
   * exposes its `size`, and the same mistake avoided (a stroke, or here an
   * image, skewed at large world sizes).
   */
  readonly size: readonly [number, number];

  private texture: GPUTexture;
  private textureView: GPUTextureView;

  /**
   * False until an image has been uploaded.
   *
   * The shader reads this through `density_active` and SKIPS the sample
   * entirely, rather than reading a zeroed texture. Both give the same answer;
   * skipping means an unused feature costs nothing in the hottest loop in the
   * app -- `advance()` runs 30x a frame over 600k entities, and this is three
   * texture samples per entity per sub-step when it is on.
   */
  private uploaded = false;

  constructor(device: GPUDevice, canvasSize: readonly [number, number]) {
    this.device = device;
    this.size = densityFieldDimensions(canvasSize);
    this.texture = this.allocate();
    this.textureView = this.texture.createView();
  }

  private allocate(): GPUTexture {
    return this.device.createTexture({
      label: 'density-field',
      size: { width: this.size[0], height: this.size[1] },
      // Same format as the canvas and the strafe field. Chosen for what BASE
      // WebGPU can do with it, not for precision: `rg16float` filters, and
      // `rg32float` cannot without an optional feature. See `halfFloat.ts` for
      // why that decision reaches all the way back to the host packing.
      format: CANVAS_FORMAT,
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        // COPY_DST is the one that matters and the one the strafe field does NOT
        // have: this texture is written by `queue.writeTexture` rather than by a
        // render pass, so without it every upload is a validation error.
        GPUTextureUsage.COPY_DST |
        // For verification only, matching the canvas and the strafe field: it is
        // what lets a browser check read the field back and confirm the
        // orientation on the GPU rather than only in the pure leaf.
        GPUTextureUsage.COPY_SRC,
    });
  }

  view(): GPUTextureView {
    return this.textureView;
  }

  /** Whether a real image is loaded. Drives `density_active` in the uniform. */
  get active(): boolean {
    return this.uploaded;
  }

  /**
   * Replace the field's contents.
   *
   * The field's dimensions must match this texture's -- the caller derives it
   * from `size`, so a mismatch is a wiring bug rather than user input, and
   * throwing names it at the call site instead of letting `writeTexture` reject
   * a row count with a message about bytes.
   */
  upload(field: GradientField): void {
    if (field.width !== this.size[0] || field.height !== this.size[1]) {
      throw new Error(
        `density field is ${this.size[0]}x${this.size[1]} but the gradient is ` +
          `${field.width}x${field.height} -- derive it from DensityField.size`,
      );
    }
    // Two f16 per texel: 4 bytes, so `bytesPerRow` is width*4. No 256-byte
    // alignment requirement here -- that applies to buffer copies, not to
    // `writeTexture` from host memory.
    this.device.queue.writeTexture(
      { texture: this.texture },
      packF16(field.data),
      { bytesPerRow: this.size[0] * 4, rowsPerImage: this.size[1] },
      { width: this.size[0], height: this.size[1] },
    );
    this.uploaded = true;
  }

  /**
   * Forget the image.
   *
   * Flips the flag rather than zeroing the texture. The shader stops sampling
   * the moment the flag is false, so writing a megabyte of zeros would be work
   * whose only effect is to make the next upload's first frame identical to what
   * it already would have been.
   */
  clear(): void {
    this.uploaded = false;
  }

  /**
   * Free the texture.
   *
   * Dropping a JS reference does not free GPU memory -- the same reason
   * `ParticleSystem.destroy()` exists, where each rebuild otherwise leaked
   * ~19 MB. At the cap this texture is 2 MB, and `rebuildSystem` replaces it on
   * every World Size change.
   */
  destroy(): void {
    this.texture.destroy();
    this.uploaded = false;
  }
}
