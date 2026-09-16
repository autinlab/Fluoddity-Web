/**
 * THE PARAMETER SEARCH: run many simulations, score them, keep the good ones.
 *
 * ---------------------------------------------------------------------------
 * THE TWO IMAGES, AND WHY THEY ARE TWO
 * ---------------------------------------------------------------------------
 * `--stimulus` is the image dropped into the DENSITY FIELD. It is the input --
 * the thing that biases the particles -- and it is always present.
 *
 * `--target` is what the resulting render should LOOK LIKE. It is a separate
 * flag because these are separate roles, and collapsing them would only ever
 * ask "did the particles land on the picture that is pushing them". The
 * interesting question is "which parameters turn THIS stimulus into THAT
 * behaviour". When only `--stimulus` is given, `--target` defaults to it, which
 * recovers the simpler question as a special case.
 *
 * `--describe` replaces `--target` with a sentence. No metric reads "filaments
 * that braid and slowly rotate", so that mode runs one generation, writes a
 * labelled contact sheet, and stops for a reader to rank. The ranking seeds the
 * next generation. It is the same search; only the scorer is a person.
 *
 * ---------------------------------------------------------------------------
 * WHY HILL-CLIMBING AND NOT A SWEEP
 * ---------------------------------------------------------------------------
 * Seventeen axes. A grid at three levels each is 129 million candidates, and
 * this evaluates a few per second on one GPU. So: a Latin hypercube to cover
 * every axis evenly at whatever budget is affordable, then hill-climbing from
 * the best few with a shrinking step. The budget is the binding constraint and
 * the strategy is chosen for it.
 *
 * ---------------------------------------------------------------------------
 * NOTHING IS WRITTEN INTO THE REPOSITORY UNTIL YOU SAY SO
 * ---------------------------------------------------------------------------
 * Every candidate lands in `--out` as a PNG plus a line of JSONL carrying its
 * parameters, its scores and its full v8 document. `--promote` is a separate
 * invocation that takes one of those and writes `configs/<Name>.json`. A search
 * that auto-committed its winners would fill the library with near-duplicates
 * nobody chose.
 *
 * ---------------------------------------------------------------------------
 * RUNNING IT
 * ---------------------------------------------------------------------------
 *   npm run dev                       # required; this drives a real page
 *
 *   node tools/search.mjs --selftest
 *   node tools/search.mjs --stimulus a.png --target b.png --budget 200 --out DIR
 *   node tools/search.mjs --stimulus a.png --describe "..." --pop 12 --out DIR
 *   node tools/search.mjs --continue DIR
 *   node tools/search.mjs --promote DIR/cand-0007 --name Filaments
 *
 * Needs a real GPU and a HEADED Chrome -- headless returns a null adapter.
 * `CHROME_PATH` overrides the per-platform default.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';

import { consoleErrors, flagReader } from './lib/cdp.mjs';
import { formatPreset } from './lib/presetFormat.mjs';
import { evaluateCandidate, openHarness } from './lib/runner.mjs';
import { letterboxMask, scoreCandidate } from './lib/score.ts';
import {
  buildSpace,
  latinHypercube,
  mulberry32,
  neighbourhood,
  normalize,
  perturb,
  toEdits,
} from './lib/space.mjs';
import { fromDocument } from '../src/config/persistence.ts';

const args = flagReader();
const port = args.num('--port', 5173);
const preset = args.str('--preset', 'Tangle');
// A share link supersedes --preset: the fragment is decoded before the
// Orchestrator exists, so the link is what the page opens.
const link = args.str('--link', null);
const linkHash = link === null ? null : link.slice(link.indexOf('#'));
const steps = args.num('--steps', 400);
/** The luma grid both pictures are reduced to before they are compared. */
const GRID = args.num('--grid', 32);
/**
 * How many wedged candidates to absorb before giving up.
 *
 * A few are expected -- the space has bad corners. Many in a row means the
 * search has walked INTO such a corner and every neighbour is one too, and
 * relaunching the browser twenty more times will not discover anything.
 */
const MAX_HANGS = args.num('--max-hangs', 6);

const say = (m) => console.log(m);
const die = (m) => {
  console.error(m);
  process.exit(1);
};

const dataUrl = (file) =>
  `data:image/${path.extname(file).slice(1).toLowerCase() === 'jpg' ? 'jpeg' : path.extname(file).slice(1).toLowerCase()};base64,${readFileSync(file).toString('base64')}`;

// ---------------------------------------------------------------------------
// --promote: no browser needed, the document is already on disk
// ---------------------------------------------------------------------------
if (args.has('--promote')) {
  const which = args.str('--promote');
  const name = args.str('--name');
  if (!which || !name) die('--promote <DIR/cand-NNNN> --name <Name>');

  const dir = path.dirname(which);
  const stem = path.basename(which);
  const jsonl = path.join(dir, 'candidates.jsonl');
  if (!existsSync(jsonl)) die(`no candidates.jsonl in ${dir}`);

  const line = readFileSync(jsonl, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .find((c) => c.id === stem);
  if (!line) die(`${stem} is not in ${jsonl}`);

  // THROUGH THE REAL READER, not a shape check. A document that does not load
  // must fail here with the message the app itself would give, rather than
  // being written and failing later inside `sync:configs` or the browser.
  fromDocument(line.document, stem);

  const target = args.str('--out') ?? path.join('configs', `${name}.json`);
  if (existsSync(target) && !args.has('--force')) {
    die(`${target} exists. Pass --force to overwrite.`);
  }
  writeFileSync(target, formatPreset(line.document));
  say(`wrote ${target}`);
  say(`  structure ${line.scores?.structure?.toFixed(4) ?? 'n/a'}  edge ${line.scores?.edgeAlignment?.toFixed(4) ?? 'n/a'}`);
  say('');
  say('A file in configs/ is invisible to the app until the manifest is rebuilt:');
  say('  npm run sync:configs');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Everything below drives a browser
// ---------------------------------------------------------------------------
const outDir = args.str('--out', null);
const continuing = args.str('--continue', null);
const describe = args.str('--describe', null);
const selftest = args.has('--selftest');

if (!selftest && !outDir && !continuing) {
  die('need --out DIR (or --continue DIR, or --selftest)');
}

let harness = null;
const failures = [];
const fail = (m) => {
  failures.push(m);
  console.error(`FAIL  ${m}`);
};
const pass = (m) => say(`ok    ${m}`);

try {
  say(link === null ? `opening ${preset} at :${port} ...` : `opening a share link at :${port} ...`);
  harness = await openHarness({ port, preset, hash: linkHash, shotTimeoutMs: args.num('--shot-timeout', 20000) });
  const { session, pins } = harness;
  say(`pinned: physicsSteps=${pins.physicsSteps} worldSize=${pins.worldSize} canvasAspect=${pins.canvasAspect}`);

  // -------------------------------------------------------------------------
  // --selftest: a KNOWN ANSWER, which is the only kind of check that can tell a
  // working harness from a decorative one.
  //
  // "Twelve candidates that look different" passes even if the parameters are
  // being ignored and only `mutationSeed` is drifting. So instead: two runs
  // that differ ONLY in the sign of `densityStrafe`, against the corner-bright
  // fixture. Strafe rather than force, for `densityCheck.mjs:276-279`'s reason
  // -- it is a flat positional displacement that nothing damps, so the result
  // does not depend on the preset's drag or on what its rule decides to do.
  // -------------------------------------------------------------------------
  if (selftest) {
    const fixture = await session.evaluate('__fh.cornerFixture(256)');
    const loaded = await session.evaluate(
      `__fh.stimulus(${JSON.stringify(fixture)}, 'selftest-corner', 2048)`,
    );
    if (loaded.name !== 'selftest-corner') fail(`the stimulus did not load: ${JSON.stringify(loaded)}`);
    else pass(`stimulus loaded (${loaded.width}x${loaded.height})`);

    const quiet = [
      { field: 'densitySense', value: 0 },
      { field: 'densityForce', value: 0 },
      { field: 'densityStrafe', value: 0 },
    ];
    const control = await evaluateCandidate(session, quiet, steps, { scale: 1.0 });
    const attract = await evaluateCandidate(session, [{ field: 'densityStrafe', value: 0.75 }], steps);
    const repel = await evaluateCandidate(session, [{ field: 'densityStrafe', value: -0.75 }], steps);

    const q = async (shot) => session.evaluate(`__fh.quadrantLuma(${JSON.stringify(shot)})`);
    const [c, a, r] = [await q(control.shot), await q(attract.shot), await q(repel.shot)];
    const label = ['upper-left', 'upper-right', 'lower-left', 'lower-right'];
    const show = (name, v) => say(`      ${name.padEnd(8)} ${v.map((x) => x.toFixed(4)).join('  ')}`);
    say(`      ${' '.repeat(8)} ${label.map((l) => l.padEnd(6).slice(0, 6)).join('  ')}`);
    show('control', c);
    show('attract', a);
    show('repel', r);

    // The image's bright corner is its OWN top-left, and the screen's
    // upper-left quadrant is world +y/-x, which is where it has to land.
    const gains = a.map((v, i) => v - c[i]);
    if (gains[0] > 0 && gains[0] > Math.max(gains[1], gains[2], gains[3])) {
      pass(`attraction filled the upper-left quadrant (+${gains[0].toFixed(4)})`);
    } else {
      fail(
        `attraction did not fill the upper-left: gains ${gains.map((g) => g.toFixed(4)).join(', ')}. ` +
          `If the LOWER-left gained most, the row flip in densityGradient.ts is inverted; ` +
          `if nothing moved, the parameters are not reaching the simulation.`,
      );
    }
    if (r[0] < a[0]) {
      pass(`repulsion emptied it again (${r[0].toFixed(4)} < ${a[0].toFixed(4)})`);
    } else {
      fail(`a negative densityStrafe did not empty the bright quadrant -- the sign is inverted`);
    }

    await session.evaluate('__fh.clearStimulus()');
    const errs = consoleErrors(session.logs);
    if (errs.length > 0) for (const e of errs.slice(0, 10)) fail(`console: ${e.text}`);
    else pass('no console errors');
  } else {
    // -----------------------------------------------------------------------
    // The search proper
    // -----------------------------------------------------------------------
    const dir = continuing ?? outDir;
    mkdirSync(dir, { recursive: true });
    const runPath = path.join(dir, 'run.json');
    const jsonlPath = path.join(dir, 'candidates.jsonl');

    let run;
    if (continuing) {
      if (!existsSync(runPath)) die(`no run.json in ${dir} -- --continue needs a started run`);
      run = JSON.parse(readFileSync(runPath, 'utf8'));
      run.generation += 1;
    } else {
      const stimulus = args.str('--stimulus', null);
      if (!stimulus) die('--stimulus <image> is required');
      run = {
        preset,
        steps,
        grid: GRID,
        stimulus: path.resolve(stimulus),
        target: path.resolve(args.str('--target', stimulus)),
        describe,
        seed: args.num('--seed', 1),
        budget: args.num('--budget', 60),
        pop: args.num('--pop', 12),
        generation: 1,
        only: args.str('--only', null)?.split(',') ?? null,
        appearance: args.has('--appearance'),
        fullRange: args.has('--full-range'),
        // 0 < around <= 1 is a band around the preset; --wide is the whole box.
        around: args.has('--wide') ? 1 : args.num('--around', 0.2),
      };
    }

    const axes = buildSpace({ appearance: run.appearance, only: run.only, fullRange: run.fullRange });
    say(`${axes.length} axes${run.fullRange ? ' (FULL registry range -- expect hangs)' : ''}:`);
    for (const a of axes) {
      const narrowed = a.registryLo !== undefined && (a.lo !== a.registryLo || a.hi !== a.registryHi);
      say(`  ${a.field.padEnd(18)} ${a.lo.toFixed(3).padStart(8)} .. ${a.hi.toFixed(3).padStart(7)}${narrowed ? `   (registry ${a.registryLo} .. ${a.registryHi})` : ''}`);
    }

    const loaded = await session.evaluate(
      `__fh.stimulus(${JSON.stringify(dataUrl(run.stimulus))}, ${JSON.stringify(path.basename(run.stimulus))}, 2048)`,
    );
    pass(`stimulus ${loaded.name} (${loaded.width}x${loaded.height})`);

    // THE SIMULATION canvas's aspect, not the window's. The density field is
    // sized from the simulation canvas, so that is the shape the stimulus is
    // letterboxed into -- and `worldRect` crops the render to the matching
    // region of the screenshot. Both grids then describe the same square.
    const rect = await session.evaluate('__fh.worldRect()');
    const canvasAspect = rect.aspect;
    const targetGrid = run.describe
      ? null
      : await session.evaluate(
          `__fh.gridFromDataUrl(${JSON.stringify(dataUrl(run.target))}, ${run.grid}, ${canvasAspect})`,
        );
    if (targetGrid) {
      pass(`target letterboxed to aspect ${canvasAspect.toFixed(3)} and reduced to ${run.grid}x${run.grid}`);
    }

    const rng = mulberry32(run.seed + run.generation * 7919);

    // The session is rebound when a candidate wedges the browser, so everything
    // below reads it through a holder rather than closing over the original.
    let live = session;

    // Where this generation's candidates come from. Generation 1 is a hypercube
    // over the whole space; later generations climb from whatever placed best,
    // with the step halved each time.
    let positionsList;
    if (run.generation === 1) {
      const count = run.describe ? run.pop : run.budget;
      if (run.around >= 1) {
        say('sampling the whole box (--wide)');
        positionsList = latinHypercube(axes, count, rng);
      } else {
        // The preset's own values, read back through the panel payload, are the
        // centre of the band. `?nopanel` empties those, so `readBack` flips the
        // flag around the read the way `configCheck.mjs:330-340` does.
        const current = await live.evaluate(
          `__fh.readBack(${JSON.stringify(axes.map((a) => a.field))})`,
        );
        const base = {};
        for (const axis of axes) {
          const v = current[axis.field];
          if (typeof v === 'number' && Number.isFinite(v)) base[axis.field] = normalize(axis, v);
        }
        say(`sampling a +/-${(run.around / 2).toFixed(2)} band around ${preset} on ${Object.keys(base).length} axes`);
        positionsList = neighbourhood(axes, base, run.around, count, rng);
      }
    } else {
      const parents = pickParents(dir, axes, run);
      const perGen = run.describe ? run.pop : run.budget;
      // THE CLIMB STARTS AT HALF THE SEEDING BAND AND HALVES EACH GENERATION.
      //
      // Tied to `around` rather than a constant, because it was a constant and
      // that was wrong: generation 1 sampled a +/-0.10 band around a preset,
      // then generation 2 perturbed by a gaussian of width 0.25 and walked
      // straight out of the region where the simulation survives. Every
      // candidate in that generation wedged. A hill-climb whose first step is
      // wider than the region it is climbing in is not a hill-climb.
      const sigma = (run.around / 2) / Math.pow(2, run.generation - 2);
      say(`climbing from ${parents.length} parent(s), sigma ${sigma.toFixed(3)}`);
      positionsList = Array.from({ length: perGen }, (_, i) =>
        perturb(axes, parents[i % parents.length], sigma, rng),
      );
    }


    const reopen = async () => {
      try {
        live.close();
      } catch {
        /* it is already wedged; the process group is killed regardless */
      }
      // A moment for the driver to release the wedged context before another
      // process asks it for a device.
      await new Promise((r) => setTimeout(r, 3000));
      const fresh = await openHarness({ port, preset, hash: linkHash, shotTimeoutMs: args.num('--shot-timeout', 20000) });
      live = fresh.session;
      harness = fresh;
      await live.evaluate(
        `__fh.stimulus(${JSON.stringify(dataUrl(run.stimulus))}, ${JSON.stringify(path.basename(run.stimulus))}, 2048)`,
      );
      say('  (browser replaced)');
    };

    const runOne = async (id, edits, scale) => {
      const result = await evaluateCandidate(live, edits, run.steps, { scale });
      const renderGrid = await live.evaluate(
        `__fh.gridFromShot(${JSON.stringify(result.shot)}, ${run.grid})`,
      );
      // Masked to the cells the picture actually covers. The margin is zero
      // field, so particles there keep their starting distribution, and letting
      // it into the correlation measures the letterbox instead of the image.
      const mask =
        targetGrid === null
          ? null
          : letterboxMask(run.grid, loaded.width / loaded.height, canvasAspect, scale ?? 1);
      const scores = targetGrid ? scoreCandidate(renderGrid, targetGrid, run.grid, mask) : null;
      const document = await live.evaluate('__fh.doc()');
      return { result, renderGrid, scores, document };
    };

    const sheetItems = [];
    let best = null;
    let hung = 0;
    for (let i = 0; i < positionsList.length; i++) {
      const id = `cand-g${run.generation}-${String(i).padStart(4, '0')}`;
      const { edits, scale } = toEdits(axes, positionsList[i]);

      let attempt;
      try {
        attempt = await runOne(id, edits, scale);
      } catch (e) {
        // A CANDIDATE THAT WEDGES THE GPU COSTS ONE CANDIDATE, NOT THE RUN.
        //
        // This is not hypothetical and it is not a harness bug: a 17-axis space
        // contains corners where the simulation submits work the driver never
        // finishes. The symptom is specific -- `Page.captureScreenshot` stops
        // returning, and shortly afterwards so does `Runtime.evaluate`, while
        // the page's own rAF is still firing and every pipeline still reports
        // built. Nothing is recoverable inside that tab.
        //
        // So the browser is replaced. The candidate is recorded as `hung` with
        // its parameters intact, which is the useful part: it maps where the
        // dangerous region is rather than merely surviving it.
        hung += 1;
        console.error(`  ${id}  HUNG (${e.message.split('\n')[0]})`);
        appendFileSync(
          jsonlPath,
          `${JSON.stringify({
            id,
            generation: run.generation,
            positions: positionsList[i],
            params: Object.fromEntries(edits.map((e2) => [e2.field, e2.value])),
            densityScale: scale,
            scores: null,
            hung: true,
          })}\n`,
        );
        await reopen();
        if (hung >= MAX_HANGS) {
          // Reopened FIRST: the contact sheet is drawn in the page, and leaving
          // the loop on a wedged browser would lose the sheet for the
          // candidates that did succeed. Their JSONL lines are already on disk.
          fail(`${hung} candidates wedged the GPU -- stopping rather than thrashing the browser`);
          break;
        }
        continue;
      }

      const { result, renderGrid, scores, document } = attempt;
      const expected = run.steps * result.physicsSteps;
      if (result.frameCount !== expected) {
        fail(`${id} advanced ${result.frameCount} sub-steps, expected ${expected}`);
      }

      writeFileSync(path.join(dir, `${id}.png`), Buffer.from(result.shot, 'base64'));
      appendFileSync(
        jsonlPath,
        `${JSON.stringify({
          id,
          generation: run.generation,
          positions: positionsList[i],
          params: Object.fromEntries(edits.map((e) => [e.field, e.value])),
          densityScale: scale,
          scores,
          document,
        })}\n`,
      );

      sheetItems.push({
        dataUrl: `data:image/png;base64,${result.shot}`,
        label: scores ? `${i} s=${scores.structure.toFixed(3)}${scores.rejected ? ' X' : ''}` : `${i}`,
      });

      if (scores && (best === null || scores.rank > best.scores.rank)) {
        best = { id, scores };
      }
      const note = scores
        ? `struct ${scores.structure.toFixed(4)}  edge ${scores.edgeAlignment.toFixed(4)}  occ ${scores.occupancy.toFixed(4)}  spread ${scores.spread.toFixed(3)}${scores.rejected ? `  REJECTED (${scores.rejected})` : ''}`
        : 'captured';
      say(`  ${id}  ${note}`);
    }

    const sheetPath = path.join(dir, `sheet-g${run.generation}.png`);
    if (sheetItems.length > 0) {
      try {
        const sheetUrl = await live.evaluate(
          `__fh.contactSheet(${JSON.stringify(sheetItems)}, 240, 4)`,
        );
        writeFileSync(sheetPath, Buffer.from(String(sheetUrl).split(',')[1], 'base64'));
        say('');
        say(`contact sheet -> ${sheetPath}`);
      } catch (e) {
        // Advisory, not fatal. Every candidate's PNG and JSONL line is already
        // on disk; the sheet is a convenience for reading them together.
        say(`(contact sheet could not be drawn: ${e.message.split('\n')[0]})`);
      }
    } else {
      say('');
      say('no candidate survived, so there is no contact sheet');
    }
    writeFileSync(runPath, `${JSON.stringify(run, null, 2)}\n`);
    if (best) {
      say(`best: ${best.id}  structure ${best.scores.structure.toFixed(4)}  (edge ${best.scores.edgeAlignment.toFixed(4)})`);
      say(`promote it with:  node tools/search.mjs --promote ${path.join(dir, best.id)} --name <Name>`);
    }
    if (run.describe) {
      say('');
      say(`described target: "${run.describe}"`);
      say('Read the contact sheet, then write the indices you liked best, in order:');
      say(`  echo '{"ranking":[3,7,1]}' > ${path.join(dir, 'ranking.json')}`);
      say(`  node tools/search.mjs --continue ${dir}`);
    }

    if (hung > 0) say(`${hung} candidate(s) wedged the GPU and were recorded as hung.`);

    const errs = consoleErrors(live.logs);
    if (errs.length > 0) for (const e of errs.slice(0, 10)) fail(`console: ${e.text}`);
  }
} catch (e) {
  fail(String(e?.stack ?? e));
} finally {
  harness?.session.close();
}

/**
 * The positions the next generation climbs from.
 *
 * A described run reads `ranking.json` -- the reader's ordering of the previous
 * sheet -- because there is no number to sort by. A scored run sorts by `rank`,
 * which is `-Infinity` for a rejected candidate, so a blank frame can never
 * become a parent no matter how thin the field is.
 */
function pickParents(dir, axes, run) {
  const all = readFileSync(path.join(dir, 'candidates.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((c) => c.generation === run.generation - 1);
  if (all.length === 0) throw new Error('the previous generation wrote no candidates');

  const rankPath = path.join(dir, 'ranking.json');
  if (run.describe) {
    if (!existsSync(rankPath)) {
      throw new Error(
        `a described run needs ${rankPath}. Read sheet-g${run.generation - 1}.png and write ` +
          `{"ranking":[<indices, best first>]} there.`,
      );
    }
    const order = JSON.parse(readFileSync(rankPath, 'utf8')).ranking;
    const chosen = order
      .map((i) => all.find((c) => c.id.endsWith(String(i).padStart(4, '0'))))
      .filter(Boolean);
    if (chosen.length === 0) throw new Error(`none of ${JSON.stringify(order)} names a candidate`);
    return chosen.slice(0, 3).map((c) => c.positions);
  }

  const scored = all.filter((c) => c.scores !== null).sort((a, b) => b.scores.rank - a.scores.rank);
  const alive = scored.filter((c) => Number.isFinite(c.scores.rank));
  if (alive.length === 0) {
    throw new Error('every candidate in the previous generation was rejected -- widen the space');
  }
  // Re-normalizing rather than trusting the stored positions keeps this honest
  // if the axis list changed between generations.
  return alive.slice(0, 3).map((c) => {
    const p = {};
    for (const axis of axes) {
      p[axis.field] =
        c.positions[axis.field] ??
        normalize(axis, c.params[axis.field] ?? c.densityScale ?? axis.lo);
    }
    return p;
  });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s).`);
  process.exit(1);
}
say('\nOK');
