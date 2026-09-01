/**
 * How big the Density Image field's texture is.
 *
 * A leaf, for the same reason `strafeField/fieldSize.ts` is one: it is arithmetic
 * with no state and no GPU, so the module beside it can be untestable without
 * taking this with it.
 */

import { canvasDimensions } from '../particleSystem/sizing.ts';

/**
 * The cap, as a square-equivalent edge: `MAX_DENSITY_DIM^2` TEXELS, not that
 * width and height. Same reading as `MAX_FIELD_DIM` -- see `fieldSize.ts` on why
 * `min(w, cap)` would be a silent skew rather than an error.
 *
 * ## WHY THIS IS LARGER THAN THE STRAFE FIELD'S 512
 *
 * Not an oversight and not a copy that drifted. `fieldSize.ts` justifies its cap
 * by saying the strafe field "holds soft blobby pushes, not structure" -- true
 * there, because a human paints it with a soft round brush, so detail beyond the
 * cap is invisible while the VRAM is not.
 *
 * That argument does not transfer. A density image IS structure: the whole point
 * is that a membrane, a segmentation boundary or a capsid edge reaches the
 * particles as an edge. Capping this at 512 would blur a tomogram's features
 * together before the physics ever saw them, and the user would have no way to
 * tell that from the image simply not working.
 *
 * 1024^2 at rg16float is 2 MB flat, which buys four times the linear detail for
 * one extra megabyte -- and it is still a cap, so a 4000px figure does not
 * allocate 64 MB.
 */
export const MAX_DENSITY_DIM = 1024;

/**
 * Field (width, height) for a canvas: the canvas's SHAPE, with the area capped.
 *
 * The shape has to be the canvas's, not the image's, because the texture is
 * sampled through `world_to_uv_bc` -- the same mapping the canvas and the strafe
 * field use. The IMAGE's own aspect is preserved inside this box by
 * `densityGradient`, which letterboxes it and leaves the margin at zero. Doing
 * it that way means this feature adds no new coordinate math at all (invariant
 * 9): the shader's world->uv is the one that was already there.
 */
export function densityFieldDimensions(
  canvasSize: readonly [number, number],
): readonly [number, number] {
  const [width, height] = canvasSize;
  if (width * height <= MAX_DENSITY_DIM * MAX_DENSITY_DIM) return [width, height];
  return canvasDimensions(width / height, MAX_DENSITY_DIM);
}
