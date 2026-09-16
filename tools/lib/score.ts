/**
 * THE METRICS. Pure arithmetic over small luma grids, so it is testable.
 *
 * Nothing in `src/` or `tools/` measured a simulation before this. That is the
 * gap the search harness has to fill, and it is the part most likely to be
 * quietly wrong -- a metric that reports a number for every input looks like it
 * is working no matter what it is measuring. So the grid maths lives here,
 * separately from the browser, with a `node --test` beside it, the way every
 * other decidable leaf in this repo does (`blurSchedule`, `gating`, `dispatch`).
 *
 * ---------------------------------------------------------------------------
 * WHY EDGE ALIGNMENT IS PRIMARY AND OCCUPANCY IS NOT
 * ---------------------------------------------------------------------------
 * This is not a preference; it follows from what the density field physically
 * is. `densityGradient.ts` produces a peak-normalized SOBEL of a blurred,
 * contrast-stretched luminance. A gradient is zero wherever the blurred image
 * is locally flat -- INCLUDING deep inside a large uniform bright region. So a
 * white disc on black pushes particles across its rim and then stops pushing
 * them entirely.
 *
 * A correctly-working simulation therefore draws OUTLINES, not fills. Ranking
 * on "did luma land where the target is bright" would score exactly that
 * behaviour as a failure on any target with big flat areas, and the search
 * would spend its budget walking away from the physics working. Occupancy is
 * still reported -- it is the right metric for a target that is itself all
 * edges -- but it is never what candidates are ordered by.
 *
 * ---------------------------------------------------------------------------
 * THE REJECTOR
 * ---------------------------------------------------------------------------
 * Correlation loves two degenerate pictures: a uniform grey field (correlates
 * weakly with everything, but beats a bad candidate) and every particle
 * collapsed into one blob (a single cell can carry a surprising correlation on
 * a coarse grid). Neither is a simulation anyone wants. They are cheap to
 * detect from the render's own statistics and are thrown out before ranking
 * rather than being given a slightly lower score -- a rejected candidate should
 * never be able to win by having a lucky neighbour.
 */


/**
 * A square luma field, row-major, values on 0..1.
 *
 * A plain array rather than a `Float32Array` because it arrives from the page
 * as JSON over CDP, and converting it here would only be to convert it back.
 */
export type Grid = readonly number[];

export interface GridStats {
  readonly mean: number;
  readonly std: number;
  readonly max: number;
  /** Fraction of cells above a tenth of this picture's own peak. */
  readonly spread: number;
}

export interface CandidateScore {
  readonly edgeAlignment: number;
  readonly occupancy: number;
  /** Edge alignment with the low-frequency trend removed. Rank on this. */
  readonly structure: number;
  readonly mean: number;
  readonly std: number;
  readonly spread: number;
  readonly rejected: string | null;
  readonly rank: number;
}

/** Rec.709 luma of an 8-bit triple, on 0..1. Mirrors the in-page reducer. */
export function luma(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Clamped fetch, so the Sobel does not wrap a picture around its own edge. */
function at(grid: Grid, n: number, x: number, y: number): number {
  const cx = x < 0 ? 0 : x >= n ? n - 1 : x;
  const cy = y < 0 ? 0 : y >= n ? n - 1 : y;
  // `noUncheckedIndexedAccess` is on, and both indices are clamped above, so
  // the cell always exists -- the fallback is for the type system, not the run.
  return grid[cy * n + cx] ?? 0;
}

/**
 * Sobel gradient magnitude of an n x n grid.
 *
 * The same operator `densityGradient.ts` applies to the stimulus, so the target
 * is being described in the same terms the physics reads its input in.
 */
export function sobelMagnitude(grid: Grid, n: number): number[] {
  if (grid.length !== n * n) throw new Error(`grid is ${grid.length}, expected ${n * n}`);
  const out: number[] = new Array<number>(n * n).fill(0);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const tl = at(grid, n, x - 1, y - 1);
      const tc = at(grid, n, x, y - 1);
      const tr = at(grid, n, x + 1, y - 1);
      const ml = at(grid, n, x - 1, y);
      const mr = at(grid, n, x + 1, y);
      const bl = at(grid, n, x - 1, y + 1);
      const bc = at(grid, n, x, y + 1);
      const br = at(grid, n, x + 1, y + 1);
      const gx = tr + 2 * mr + br - (tl + 2 * ml + bl);
      const gy = bl + 2 * bc + br - (tl + 2 * tc + tr);
      out[y * n + x] = Math.hypot(gx, gy);
    }
  }
  return out;
}

/**
 * Pearson correlation. Returns 0, not NaN, when either side is constant.
 *
 * A constant side means "this picture has no structure to correlate", and the
 * honest score for that is no correlation. Propagating NaN would make it sort
 * unpredictably against real numbers, which is worse than being wrong in a
 * stated direction.
 */
export function pearson(a: Grid, b: Grid): number {
  if (a.length !== b.length) throw new Error('pearson needs equal lengths');
  const n = a.length;
  if (n === 0) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i] ?? 0;
    mb += b[i] ?? 0;
  }
  ma /= n;
  mb /= n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = (a[i] ?? 0) - ma;
    const y = (b[i] ?? 0) - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

/** Mean, standard deviation, peak, and the fraction of cells that are lit. */
export function gridStats(grid: Grid): GridStats {
  const n = grid.length;
  if (n === 0) return { mean: 0, std: 0, max: 0, spread: 0 };
  let mean = 0;
  let max = 0;
  for (const v of grid) {
    mean += v;
    if (v > max) max = v;
  }
  mean /= n;
  let variance = 0;
  for (const v of grid) variance += (v - mean) * (v - mean);
  variance /= n;
  // "Lit" is relative to this picture's own peak, not an absolute level: a dim
  // preset and a bright one should report the same spread for the same shape.
  const threshold = max * 0.1;
  let lit = 0;
  for (const v of grid) if (v > threshold) lit += 1;
  return { mean, std: Math.sqrt(variance), max, spread: lit / n };
}

/**
 * WHICH CELLS ARE ACTUALLY INSIDE THE IMAGE.
 *
 * `densityGradient.ts` fits the picture into a canvas-shaped field keeping its
 * aspect, and leaves the margin at ZERO. So a portrait image in a square world
 * has vertical bands down both sides where the field cannot push at all, and
 * particles there simply keep whatever distribution they started with.
 *
 * Scoring over the whole square then measures the margin. Measured here: a run
 * whose particles emptied the image strip and left the two margins untouched
 * scored an occupancy of -0.73, the strongest correlation of any run in the
 * session -- and it was entirely the letterbox boundary. Nothing about the
 * capsids was being detected at all. On this image the margin is 29% of the
 * width, which is more than enough to dominate a correlation.
 *
 * So every metric is computed over the covered cells only, and this is how they
 * are found. `imageAspect` and `worldAspect` are width/height.
 */
export function letterboxMask(
  n: number,
  imageAspect: number,
  worldAspect: number,
  scale = 1,
): boolean[] {
  // The same fit `letterboxScale` performs: the largest box of the image's
  // aspect that fits inside the world's, centred. In TEXTURE uv.
  let w = 1;
  let h = w * (worldAspect / imageAspect);
  if (h > 1) {
    h = 1;
    w = h * (imageAspect / worldAspect);
  }
  const x0 = (1 - w) / 2;
  const y0 = (1 - h) / 2;

  // IMAGE SCALE SHRINKS WHAT THE WORLD SEES. The shader samples
  // `world_to_uv(p / scale)`, so at scale 2 the world spans only the central
  // half of the texture in each axis. Enlarging the picture therefore pushes
  // the margins off-world entirely -- at a high enough scale there is no margin
  // to mask, and the whole frame is covered. Ignoring this would mask off real
  // cells and shrink the sample for no reason.
  const s = scale > 0 ? scale : 1;
  const mask: boolean[] = new Array<boolean>(n * n).fill(false);
  for (let gy = 0; gy < n; gy++) {
    for (let gx = 0; gx < n; gx++) {
      // Cell centres, so a cell straddling the edge is decided by where most
      // of it lies rather than by a corner.
      const cx = (gx + 0.5) / n;
      const cy = (gy + 0.5) / n;
      const ux = 0.5 + (cx - 0.5) / s;
      const uy = 0.5 + (cy - 0.5) / s;
      mask[gy * n + gx] = ux >= x0 && ux <= x0 + w && uy >= y0 && uy <= y0 + h;
    }
  }
  return mask;
}

/** Keep only the cells the mask selects. */
function masked(grid: Grid, mask: readonly boolean[] | null): number[] {
  if (mask === null) return grid.slice();
  const out: number[] = [];
  for (let i = 0; i < grid.length; i++) if (mask[i]) out.push(grid[i] ?? 0);
  return out;
}

/**
 * Remove the low-frequency trend from a grid, keeping local structure.
 *
 * THE THIRD WAY THIS SCORER GOT FOOLED, and the subtlest. After masking the
 * letterbox, a run whose particles formed a near-uniform lattice of isolated
 * dots -- carrying no resemblance to the picture whatever -- still scored an
 * occupancy of -0.42, because it had a gentle density gradient across the frame
 * and the picture has a gentle brightness gradient across the frame. Pearson
 * over a 48x48 grid is delighted by that: two smooth ramps correlate strongly
 * no matter what is happening at the scale anyone cares about.
 *
 * Subtracting a box-blurred copy leaves only what varies faster than `radius`,
 * which is where a capsid boundary lives and where a ramp does not.
 */
export function highPass(grid: Grid, n: number, radius: number): number[] {
  const out: number[] = new Array<number>(n * n).fill(0);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy < 0 || yy >= n || xx < 0 || xx >= n) continue;
          sum += grid[yy * n + xx] ?? 0;
          count += 1;
        }
      }
      out[y * n + x] = (grid[y * n + x] ?? 0) - (count > 0 ? sum / count : 0);
    }
  }
  return out;
}

/** Neighbourhood used to flatten the trend, in grid cells. */
export const HIGH_PASS_RADIUS = 3;

/** Below this standard deviation the render carries no structure at all. */
export const MIN_STD = 0.002;
/** Below this lit fraction everything has collapsed into one blob. */
export const MIN_SPREAD = 0.005;
/** Above this lit fraction the frame is a uniform wash. */
export const MAX_SPREAD = 0.98;

/**
 * Score one render against one target.
 *
 * `rank` is what the search orders by and is `edgeAlignment` unless the
 * candidate was rejected, in which case it is -Infinity -- a rejected candidate
 * must not be able to place, not merely place badly.
 */
export function scoreCandidate(
  renderGrid: Grid,
  targetGrid: Grid,
  n: number,
  mask: readonly boolean[] | null = null,
): CandidateScore {
  // The Sobel runs over the FULL grid before masking, so an edge at the image's
  // own border is computed from real neighbours rather than from the margin.
  const edges = sobelMagnitude(targetGrid, n);
  const r = masked(renderGrid, mask);
  const t = masked(targetGrid, mask);
  const e = masked(edges, mask);
  const stats = gridStats(r);
  const edgeAlignment = pearson(r, e);
  const occupancy = pearson(r, t);
  // The trend-free comparison, and the one to believe when the two disagree.
  // Computed on the FULL grid then masked, so the blur near the image border
  // averages real neighbours rather than wrapping in margin.
  const structure = pearson(
    masked(highPass(renderGrid, n, HIGH_PASS_RADIUS), mask),
    masked(highPass(edges, n, HIGH_PASS_RADIUS), mask),
  );

  let rejected: string | null = null;
  if (stats.std < MIN_STD) rejected = 'no structure';
  else if (stats.spread < MIN_SPREAD) rejected = 'collapsed to a blob';
  else if (stats.spread > MAX_SPREAD) rejected = 'uniform wash';

  return {
    edgeAlignment,
    occupancy,
    structure,
    mean: stats.mean,
    std: stats.std,
    spread: stats.spread,
    rejected,
    rank: rejected === null ? structure : Number.NEGATIVE_INFINITY,
  };
}
