/**
 * THE SEARCH SPACE, derived from the real registry rather than restated.
 *
 * Bounds live in `src/ui/settingsSpec.ts` and nowhere else. Copying `lo`/`hi`
 * here would create a second source of truth that drifts silently -- the search
 * would keep proposing values a slider cannot reach, or stop short of ones it
 * can, and nothing would report either. `settingsSpec.ts` is a pure leaf with
 * zero imports, so it is importable straight from node; this module only names
 * WHICH fields to search and how to sample them.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS SEARCHED, AND WHAT IS PINNED
 * ---------------------------------------------------------------------------
 * The registry's own grouping is not the right split here, and two traps follow
 * from that:
 *
 * TRAP ONE -- three PREFS are physics. `worldSize`, `canvasAspect` and
 * `physicsSteps` read as editor preferences and are not: `sqrt_world_size`
 * divides essentially every force term in `entityUpdate.wgsl`, `canvasAspect`
 * changes the world extent and therefore the initial layout, and `physicsSteps`
 * is the integration count. They are PINNED, not searched -- moving them would
 * change what a "step" means between candidates and make two scores
 * incomparable.
 *
 * TRAP TWO -- two "Trails"/"Advanced" entries are physics. `trailPersistence`
 * and `trailDiffusion` ARE the field the sensors read (`canvas.wgsl`'s decay
 * and 5-tap blur). They are behaviour despite the group name, and despite
 * "Trail Stiffness" being displayed as the complement of the stored value.
 *
 * ---------------------------------------------------------------------------
 * THE 80-FLOAT RULE IS NOT SWEPT DIRECTLY
 * ---------------------------------------------------------------------------
 * The real high-dimensional object here is the rule: 10 FourierCenters x 8
 * floats, `LANE.rule` 0..79. Sampling it coordinate-wise is hopeless -- 80
 * dimensions, and `rule.wgsl:66-74` records that a 1-ULP difference in one
 * coefficient "produces a completely different rule".
 *
 * `mutationScale` x `mutationSeed` is the cheap two-parameter handle on that
 * whole space: the seed picks a point, the scale says how far from the authored
 * rule to go. Both are in the registry and both are searched. `randomizeBehavior`
 * remains available for a wholesale jump.
 *
 * NOTE ON `mutationSeed`: it is stored as a float64 and 194 of 196 shipped
 * configs need that width, because rounding a seed yields a different rule
 * entirely. It is sampled here on 0..1 and never rounded.
 */

import { SETTINGS } from '../../src/ui/settingsSpec.ts';
import {
  DENSITY_SCALE_MAX,
  DENSITY_SCALE_MIN,
} from '../../src/densityField/densityScale.ts';

/** Physics, in the order a reader should think about them. */
export const BEHAVIOUR_FIELDS = Object.freeze([
  // WHERE THE PARTICLES START, which decides whether they ever meet the image.
  //
  // Added after a first run on a real tomogram scored near zero on every
  // candidate for an obvious reason once seen: the preset starts its particles
  // in one place, its rule keeps them there, and a gradient field can only push
  // a particle that is standing in it. No amount of density strength reaches a
  // particle on the other side of the world.
  'initialConditions',
  // the image bias itself
  'densitySense',
  'densityStrafe',
  'densityForce',
  // what the particle perceives
  'sensorAngle',
  'sensorDistance',
  'sensorGain',
  // what it does about it
  'globalForceMult',
  'drag',
  'axialForce',
  'lateralForce',
  'strafePower',
  // the medium the perception travels through
  'trailPersistence',
  'trailDiffusion',
  // the rule, by proxy
  'mutationScale',
  'mutationSeed',
  'cohorts',
]);

/**
 * Look, not behaviour. Frozen unless a caller explicitly asks for them.
 *
 * `colorSensitivity` and `colorByCohort` are CONFIG rather than PREFS, but
 * `config.ts` documents both as "A RENDERING setting that happens to be
 * per-config" and the colour signal is explicitly never fed back into the
 * physics. So they belong here.
 */
export const APPEARANCE_FIELDS = Object.freeze([
  'colorSensitivity',
  'colorByCohort',
  'brightness',
  'tonemapSoftness',
  'motionBlurSamples',
  'bloomEnabled',
  'bloomThreshold',
  'bloomIntensity',
  'bloomRadius',
]);

/** Never searched, whatever else is asked for. See TRAP ONE. */
export const PINNED_FIELDS = Object.freeze(['worldSize', 'canvasAspect', 'physicsSteps']);

/**
 * `densityScale` is NOT a `Setting`, and that is a placement rather than an
 * oversight -- it is a property of the IMAGE, and a `.json` config carries no
 * image. Its bounds live beside it in `src/densityField/densityScale.ts`.
 */
export const DENSITY_SCALE_AXIS = Object.freeze({
  field: 'densityScale',
  kind: 'scale',
  lo: DENSITY_SCALE_MIN,
  hi: DENSITY_SCALE_MAX,
});

/**
 * SEARCH BOUNDS, NARROWER THAN THE SLIDER BOUNDS, AND WHY.
 *
 * The registry's `lo`/`hi` say what a control ACCEPTS. They do not say what the
 * simulation survives, and the gap between the two is not small. Measured on
 * this machine, jumping a single parameter to these values and running 750
 * sub-steps stops the tab responding -- `Page.captureScreenshot` never returns,
 * and shortly after neither does `Runtime.evaluate`, while the page's own rAF
 * is still firing and every pipeline still reports built:
 *
 *     axialForce       +1.47   -1.67      (registry allows -2 .. 2)
 *     lateralForce     +1.98   -1.99      (registry allows -2 .. 2)
 *     strafePower       0.48              (registry allows 0 .. 0.5)
 *     trailPersistence  0.53              (registry allows 0.5 .. 0.999)
 *
 * Innocent, checked one at a time and confirmed fine at their extremes:
 * `cohorts` at 61, `sensorDistance` at 4.88, `drag` at 0.96, `globalForceMult`
 * at 0.98, `densitySense` at 0.99.
 *
 * WHERE THE REPLACEMENT NUMBERS COME FROM. Not guesses -- the envelope of the
 * 22 shipped presets, widened. Every one of those was hand-tuned by someone
 * until it looked right, so their spread is evidence about where this engine is
 * actually alive:
 *
 *     field             presets use        searched here
 *     axialForce        0.022 .. 0.371     -0.5 .. 0.8
 *     lateralForce     -0.707 .. 0.515     -1.0 .. 0.9
 *     strafePower       0.169 .. 0.389      0.0 .. 0.42
 *     trailPersistence  0.728 .. 0.995      0.70 .. 0.995
 *     sensorDistance    0.652 .. 2.354      0.2 .. 3.5
 *     sensorGain        0.379 .. 4.346      0.0 .. 6.0
 *     cohorts           1 .. 21             1 .. 32
 *
 * This is the same argument `settingsSpec.ts:192-194` makes for its own bounds
 * -- "where a preset value approaches a bound, the bound is widened" -- applied
 * to a different question.
 *
 * THE DENSITY CHANNELS ARE NOT NARROWED. They are what the search is for, none
 * of them wedged anything at any value, and the shipped presets are all zero
 * there because the feature is newer than they are -- so the library's envelope
 * carries no information about them.
 *
 * `--full-range` turns this off and searches what the sliders allow. Expect
 * candidates to hang; the search records them and replaces the browser.
 */
export const SAFE_LIMITS = Object.freeze({
  axialForce: [-0.5, 0.8],
  lateralForce: [-1.0, 0.9],
  strafePower: [0.0, 0.42],
  trailPersistence: [0.7, 0.995],
  trailDiffusion: [0.2, 1.0],
  sensorDistance: [0.2, 3.5],
  sensorGain: [0.0, 6.0],
  cohorts: [1, 32],
});

function axisFor(field, fullRange) {
  if (field === DENSITY_SCALE_AXIS.field) return { ...DENSITY_SCALE_AXIS };
  const setting = SETTINGS.find((s) => s.field === field);
  if (!setting) throw new Error(`no Setting named "${field}" -- the registry has ${SETTINGS.length}`);
  const safe = fullRange ? undefined : SAFE_LIMITS[field];
  // Intersected with the registry, never widened past it: a search must not
  // propose a value a slider cannot hold, or a promoted preset would carry one.
  const lo = safe ? Math.max(setting.lo, safe[0]) : setting.lo;
  const hi = safe ? Math.min(setting.hi, safe[1]) : setting.hi;
  return {
    field,
    kind: setting.kind,
    source: setting.source,
    lo,
    hi,
    registryLo: setting.lo,
    registryHi: setting.hi,
    curve: setting.curve ?? 1,
    // A label's index is the value uploaded, so a CHOICE is an integer over its
    // options and must never be interpolated.
    integral: setting.kind === 'int' || setting.kind === 'gatedInt' || setting.kind === 'choice',
  };
}

/**
 * Build the axis list for a run.
 *
 * `only`/`without` are field-name filters so a caller can search three
 * parameters instead of sixteen without restating the bounds.
 */
export function buildSpace({ appearance = false, only = null, without = [], fullRange = false } = {}) {
  const names = [...BEHAVIOUR_FIELDS, DENSITY_SCALE_AXIS.field];
  if (appearance) names.push(...APPEARANCE_FIELDS);
  const wanted = only === null ? names : names.filter((n) => only.includes(n));
  if (only !== null) {
    const unknown = only.filter((n) => !names.includes(n));
    if (unknown.length > 0) throw new Error(`not searchable: ${unknown.join(', ')}`);
  }
  const kept = wanted.filter((n) => !without.includes(n) && !PINNED_FIELDS.includes(n));
  return kept.map((f) => axisFor(f, fullRange));
}

/** Place a 0..1 position on an axis, honouring its curve and integrality. */
export function denormalize(axis, position) {
  const p = Math.min(1, Math.max(0, position));
  const curved = axis.curve && axis.curve !== 1 ? Math.pow(p, axis.curve) : p;
  const value = axis.lo + (axis.hi - axis.lo) * curved;
  if (axis.integral) return Math.round(value);
  return value;
}

/** The inverse, so a known-good config can be used as a starting point. */
export function normalize(axis, value) {
  if (axis.hi === axis.lo) return 0;
  const t = (value - axis.lo) / (axis.hi - axis.lo);
  const clamped = Math.min(1, Math.max(0, t));
  return axis.curve && axis.curve !== 1 ? Math.pow(clamped, 1 / axis.curve) : clamped;
}

/**
 * Latin-hypercube seeding: one sample per stratum per axis, shuffled
 * independently.
 *
 * Not uniform random, and not a grid. Uniform random leaves holes and clumps at
 * the sample counts affordable here; a grid is impossible -- sixteen axes at
 * even three levels each is 43 million candidates, and this evaluates a few per
 * second. A hypercube guarantees every axis is covered evenly at whatever
 * budget is affordable, which is the property that matters when the budget is
 * the binding constraint.
 */
export function latinHypercube(axes, count, rng = Math.random) {
  const rows = Array.from({ length: count }, () => ({}));
  for (const axis of axes) {
    const strata = Array.from({ length: count }, (_, i) => (i + rng()) / count);
    for (let i = strata.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [strata[i], strata[j]] = [strata[j], strata[i]];
    }
    for (let i = 0; i < count; i++) rows[i][axis.field] = strata[i];
  }
  return rows;
}

/**
 * Axes searched across their WHOLE range even in neighbourhood mode.
 *
 * The three density channels and the image scale are what the search is for,
 * every shipped preset has them at zero because the feature is newer than they
 * are, and none of them wedged anything at any value. A band around zero would
 * be a band around "the feature is off".
 */
export const FULL_BAND_FIELDS = Object.freeze([
  'densitySense',
  'densityStrafe',
  'densityForce',
  'densityScale',
  // A CHOICE has no neighbourhood. Its options are `['Grid','Random','Center',
  // 'Ring']` and a band around "Center" is just "Center" -- the value is an
  // index, not a magnitude, so interpolating between two of them means nothing.
  // Either it is searched across all four or it is not searched.
  'initialConditions',
]);

/**
 * SAMPLE AROUND THE LOADED PRESET, NOT ACROSS THE WHOLE BOX. This is the
 * setting that decides whether the search is usable at all.
 *
 * Measured here: a Latin hypercube over the full registry range wedged six of
 * seven candidates. Narrowing each axis to the shipped library's envelope did
 * not fix it, because the danger is not per-axis -- the corner of that envelope
 * hangs too, at values individual presets use happily. What hangs is a
 * COMBINATION, and combinations are most of a 17-dimensional box.
 *
 * A preset, on the other hand, is a point somebody tuned until it looked right,
 * so it is known-alive, and its neighbourhood mostly is too. Sampling a band
 * around it trades reach for a search that returns results. `--around` widens
 * the band, `--wide` recovers the full box, and the hang recovery is still
 * there for when either finds an edge.
 *
 * `base` is in normalized position space, so it already accounts for each
 * axis's curve.
 */
export function neighbourhood(axes, base, fraction, count, rng = Math.random) {
  const unit = latinHypercube(axes, count, rng);
  return unit.map((row) => {
    const out = {};
    for (const axis of axes) {
      if (FULL_BAND_FIELDS.includes(axis.field) || base[axis.field] === undefined) {
        out[axis.field] = row[axis.field];
        continue;
      }
      const centred = base[axis.field] + (row[axis.field] - 0.5) * fraction;
      // Reflect rather than clamp, for `perturb`'s reason: clamping piles mass
      // on the bounds and re-tests the same two points.
      let v = centred;
      if (v < 0) v = -v;
      if (v > 1) v = 2 - v;
      out[axis.field] = Math.min(1, Math.max(0, v));
    }
    return out;
  });
}

/** A neighbour of `positions`, each axis nudged by a gaussian of width `sigma`. */
export function perturb(axes, positions, sigma, rng = Math.random) {
  const out = {};
  for (const axis of axes) {
    // Box-Muller. A gaussian rather than a uniform box so most steps are small
    // and a few are large, which is what lets a hill-climb escape a shallow
    // local maximum without abandoning the neighbourhood.
    const u = Math.max(Number.EPSILON, rng());
    const v = rng();
    const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    const moved = positions[axis.field] + g * sigma;
    // Reflect at the walls rather than clamping: clamping piles probability
    // mass onto the bounds, and a search that keeps proposing exactly 0.0 and
    // exactly 1.0 spends its budget re-testing two points.
    let p = moved;
    if (p < 0) p = -p;
    if (p > 1) p = 2 - p;
    out[axis.field] = Math.min(1, Math.max(0, p));
  }
  return out;
}

/** Positions to the `{field, value}` edits the bus takes, plus the scale. */
export function toEdits(axes, positions) {
  const edits = [];
  let scale = null;
  for (const axis of axes) {
    const value = denormalize(axis, positions[axis.field]);
    if (axis.field === DENSITY_SCALE_AXIS.field) scale = value;
    else edits.push({ field: axis.field, value });
  }
  return { edits, scale };
}

/** A small, seedable PRNG, so a run can be replayed by quoting its seed. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
