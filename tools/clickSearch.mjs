/**
 * THE HAND METHOD, AUTOMATED: click a particle that is already on an edge.
 *
 * A single-cohort config has no aiming stage, so ONE click commits and the whole
 * colony adopts the clicked particle's rule -- which `mutationScale` then
 * re-mutates, so every click is a new colony descended from the one you liked.
 * That is the entire loop, and it is why doing this by hand beat every sweep in
 * this directory: one click per generation against seven simulations.
 *
 * WHERE TO CLICK IS THE WHOLE ALGORITHM. A person picks the edge of a capsid by
 * eye. This picks the cell maximising `render x targetEdge` -- brightest where
 * the picture's gradient is strongest -- which is the same judgement written
 * down: adopt the rule of a particle that is already doing the right thing.
 *
 * Selection pressure is therefore SPATIAL, not parametric. Nothing here sweeps a
 * slider; the sliders are fixed for the whole run and only the rule moves.
 *
 *   npm run dev
 *   node tools/clickSearch.mjs --image IMG --out DIR [--clicks 20] [--steps 250]
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { flagReader, sleep } from './lib/cdp.mjs';
import { openHarness } from './lib/runner.mjs';
import { highPass, letterboxMask, scoreCandidate, sobelMagnitude } from './lib/score.ts';

const args = flagReader();
const port = args.num('--port', 5173);
const preset = args.str('--preset', 'TomoSegment');
const imagePath = args.str('--image', null);
const outDir = args.str('--out', null);
const clicks = args.num('--clicks', 20);
/**
 * Sub-steps every trial is settled to. A COUNT, not a duration: the app runs
 * live so that clicking works, but wall-clock settling would hand a heavy
 * colony less simulation than a light one and then compare their scores.
 */
const subSteps = args.num('--substeps', 800);
/**
 * CAPTURE THE COLONY ON THE WAY UP, NOT ONLY AT THE END.
 *
 * The regime that traces filaments sits directly against the regime that locks
 * the renderer, so scoring a single frame at the finish throws away every
 * colony that was interesting at 200 sub-steps and unstable by 800 -- and those
 * are two in five of them. Walking one run past several checkpoints keeps
 * whatever it managed before it died, at no extra simulation cost.
 */
const checkpoints = (args.str('--checkpoints', null) ?? `200,400,${subSteps}`)
  .split(',').map(Number).filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
/** A floor under a wedged tab, not a target. */
const capMs = args.num('--cap-ms', 15000);
const scale = args.num('--scale', 2);
const grid = args.num('--grid', 48);
const mutation = args.num('--mutation', 0.25);
if (imagePath === null || outDir === null) {
  console.error('need --image <file> and --out <dir>');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const ext = path.extname(imagePath).slice(1).toLowerCase();
const dataUrl = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${readFileSync(imagePath).toString('base64')}`;

async function click(session, x, y) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await session.send('Input.dispatchMouseEvent', {
      type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1,
    });
  }
}

const log = path.join(outDir, 'clicks.jsonl');
let best = null;
let lastGood = null; // the most recent document that ran without wedging

/**
 * Bring a page up, load the image, and pin the sliders.
 *
 * Called again after a wedge, because a click can adopt a rule that stops the
 * tab responding -- by hand you notice and click past it in a second, but a
 * script has to rebuild the browser. `lastGood` is what makes that a resumption
 * rather than a restart: the run continues from the last colony that worked.
 */
async function boot(attempt = 0) {
  // RETRY WITH BACKOFF. A wedge leaves the driver unable to hand out a device
  // for a while, so the boot that follows one can fail through no fault of its
  // own -- and letting that end the run threw away fifty remaining trials.
  let h;
  try {
    h = await openHarness({ port, preset, live: true });
  } catch (e) {
    if (attempt >= 3) throw e;
    const wait = 8000 * (attempt + 1);
    console.error(`  (boot failed, waiting ${wait / 1000}s and retrying)`);
    await sleep(wait);
    return boot(attempt + 1);
  }
  const session = h.session;
  await session.evaluate(`__fh.stimulus(${JSON.stringify(dataUrl)}, ${JSON.stringify(path.basename(imagePath))}, 2048)`);
  await session.evaluate(
    `__fh.apply(${JSON.stringify([
      { field: 'cohorts', value: 1 },
      { field: 'initialConditions', value: 1 },
      { field: 'mutationScale', value: mutation },
      { field: 'densitySense', value: 1 },
      { field: 'densityStrafe', value: -1 },
      { field: 'densityForce', value: 0 },
    ])})`,
  );
  await session.evaluate(`__fh.setScale(${scale})`);
  await session.evaluate(`window.__fluoddity.dispatch({ kind: 'setMouseMode', mode: 'select' })`);
  if (lastGood !== null) {
    // Resume the surviving colony, through the app's own reader.
    await session.evaluate(
      `(async () => {
        const p = await import('/src/config/persistence.ts');
        window.__fluoddity.dispatch({ kind: 'loadSharedConfig', saved: p.fromDocument(${JSON.stringify(lastGood)}), name: 'resume' });
        return true;
      })()`,
      { timeoutMs: 60000 },
    );
    await sleep(400);
  }
  return h;
}

let harness = await boot();

try {
  let { session } = harness;
  const rect = await session.evaluate('__fh.worldRect()');
  const dims = await session.evaluate(
    `(async () => { const i = await new Promise((r, j) => { const m = new Image(); m.onload = () => r(m); m.onerror = j; m.src = ${JSON.stringify(dataUrl)}; }); return [i.naturalWidth, i.naturalHeight]; })()`,
  );
  const target = await session.evaluate(`__fh.gridFromDataUrl(${JSON.stringify(dataUrl)}, ${grid}, ${rect.aspect})`);
  const mask = letterboxMask(grid, dims[0] / dims[1], rect.aspect, scale);
  // WHERE THE CAPSIDS ARE, from the picture rather than from the particles.
  // The density field IS the gradient, so its strongest cells are the capsid
  // rims -- the place a person points at. Ranked once, then cycled, so twenty
  // trials do not all stab the same pixel.
  const edges = highPass(sobelMagnitude(target, grid), grid, 3);
  const hotspots = edges
    .map((v, i) => ({ i, v }))
    .filter((c) => mask[c.i])
    .sort((a, b) => b.v - a.v)
    .slice(0, 24)
    .map((c) => c.i);
  console.log(`${hotspots.length} density hotspots ranked from the image`);

  let wedges = 0;
  for (let n = 1; n <= clicks; n++) {
   try {
    // EACH TRIAL STARTS FROM A FRESH COLONY. Descending from one parent made
    // every trial a variation on the same animal -- the same seed reproduces the
    // same thing however many times it is run. `randomizeBehavior` zeroes the
    // rule and moves the seed together, which is what makes the GPU generate a
    // wholly new one rather than re-derive the old.
    await session.evaluate(`window.__fluoddity.dispatch({ kind: 'randomizeBehavior' })`);
    await sleep(200);
    await session.evaluate(`__fh.liveUntil(${subSteps}, ${capMs})`, { timeoutMs: capMs + 30000 });

    // Point at the capsid, then let the colony that answers be whatever the
    // random rule produced there.
    const cell = hotspots[(n - 1) % hotspots.length];
    const px = Math.round(rect.x + (((cell % grid) + 0.5) / grid) * rect.width);
    const py = Math.round(rect.y + ((Math.floor(cell / grid) + 0.5) / grid) * rect.height);
    await click(session, px, py);
    await sleep(500); // the pick is a GPU readback; adoption lands a frame or two on

    // Adoption resets the simulation itself, so walk it up through the
    // checkpoints and keep every frame it survives to.
    const marks = [];
    let died = null;
    for (const c of checkpoints) {
      try {
        const at = await session.evaluate(`__fh.advanceTo(${c}, ${capMs})`, { timeoutMs: capMs + 30000 });
        const shot = await session.screenshot();
        const g = await session.evaluate(`__fh.gridFromShot(${JSON.stringify(shot)}, ${grid})`);
        const sc = scoreCandidate(g, target, grid, mask);
        writeFileSync(
          path.join(outDir, `click-${String(n).padStart(2, '0')}-at${c}.png`),
          Buffer.from(shot, 'base64'),
        );
        marks.push({ at: c, frames: at.frameCount, structure: sc.structure, occupancy: sc.occupancy });
      } catch {
        // Locked before this checkpoint. Whatever it reached already counts.
        died = c;
        break;
      }
    }

    if (marks.length === 0) throw new Error('locked before the first checkpoint');

    const bestMark = marks.reduce((a, b) => (b.structure > a.structure ? b : a));
    const doc = died === null ? await session.evaluate('__fh.doc()').catch(() => null) : null;
    // THE DOCUMENT GOES IN EVERY LINE. Keeping it only for the running best
    // lost four winning rules from a fifty-trial run: they scored, they were
    // visible on the contact sheet, and there was nothing left to promote.
    appendFileSync(log, `${JSON.stringify({ n, marks, best: bestMark, diedAt: died, click: [px, py], document: doc })}\n`);
    console.log(
      `  trial ${String(n).padStart(2)}  best ${bestMark.structure.toFixed(4)} @${bestMark.at}` +
        `  [${marks.map((m) => m.structure.toFixed(3)).join(' ')}]${died ? `  locked before ${died}` : ''}`,
    );
    if (best === null || bestMark.structure > best.structure) {
      best = { n, structure: bestMark.structure, at: bestMark.at, document: doc };
    }
    if (doc !== null) lastGood = doc;
    if (died !== null) throw new Error(`locked at ${died}`); // force a clean rebuild
   } catch (e) {
    wedges += 1;
    // SAY WHICH FAILURE IT WAS. A page that still answers was never wedged --
    // the capture was, and killing the browser for that is throwing away a
    // working simulation.
    const alive = await harness.session.pageResponds().catch(() => false);
    console.error(
      `  click ${n}: ${alive ? 'the CAPTURE stalled but the page is alive' : 'the colony wedged the tab'}` +
        ' -- resuming from the last good one',
    );
    appendFileSync(log, `${JSON.stringify({ n, hung: true })}\n`);
    try { harness.session.close(); } catch { /* already gone */ }
    if (wedges > clicks) break;
    await sleep(3000);
    harness = await boot();
    session = harness.session;
   }
  }
  if (wedges > 0) console.log(`${wedges} colony(ies) wedged and were skipped.`);
} catch (e) {
  console.error(String(e?.message ?? e));
} finally {
  harness?.session.close();
}

if (best !== null) {
  writeFileSync(path.join(outDir, 'best.json'), `${JSON.stringify(best, null, 2)}\n`);
  console.log(`\nbest: click ${best.n}, structure ${best.structure.toFixed(4)}  -> ${outDir}/best.json`);
}
