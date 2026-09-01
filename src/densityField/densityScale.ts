/**
 * How much the dropped density image is enlarged, and the bounds on it.
 *
 * A leaf: three constants and a clamp, imported by the panel (which builds the
 * slider), the share codec (which must not trust a number out of a URL) and the
 * Orchestrator (which holds the value). One definition, so the slider's range
 * and the decoder's tolerance cannot drift apart -- the failure that produces is
 * a link whose image is drawn at a size the UI cannot express or undo.
 *
 * ## WHY THIS IS NOT A `ConfigData` LANE
 *
 * It is a property of the IMAGE, not of the physics. `misc3` being full is why
 * the question came up, but a spare lane would not have made it the right home:
 * a `.json` config carries no image (the texture is megabytes and belongs to no
 * Project), so a config recording how large to draw an image it does not contain
 * would be describing something that is not there.
 *
 * It rides the entity-update uniform instead, and it travels in the SHARE LINK
 * beside the image -- the one transport that does carry one.
 */

/** Fit the whole image inside the world. The letterbox case, and the default. */
export const DENSITY_SCALE_DEFAULT = 1.0;

/**
 * Smallest and largest enlargement the slider offers.
 *
 * 0.2 leaves the image a fifth of the world, surrounded by no field at all --
 * useful for biasing one region and leaving the rest of the population alone.
 *
 * 6 is where a feature the size of a virion membrane fills enough of the world
 * that individual particles resolve against it, which is the point of having the
 * control: at scale 1 a tomogram's structure can be finer than the particles
 * themselves, and the bias reads as texture rather than as shape.
 *
 * Both are generous rather than tight, for the reason the settings registry
 * gives for its own bounds: a value outside them is reachable by typing, and
 * the clamp below exists for links rather than for the UI.
 */
export const DENSITY_SCALE_MIN = 0.2;
export const DENSITY_SCALE_MAX = 6.0;

/**
 * A scale that is safe to put in a uniform.
 *
 * Rejects rather than clamps a non-finite value, returning the default: the
 * shader divides by this, and `NaN` propagates into a particle's position where
 * it stays for the rest of the session. Same argument `setZoom` makes for
 * refusing a non-finite zoom, and the same source -- a hand-edited link.
 */
export function clampDensityScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DENSITY_SCALE_DEFAULT;
  return Math.min(DENSITY_SCALE_MAX, Math.max(DENSITY_SCALE_MIN, value));
}
