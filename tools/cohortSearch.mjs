/**
 * SELECT ON THE COLONY, USING THE APP'S OWN RULE ADOPTION.
 *
 * Every other search here varied sliders and held the rule fixed. This varies
 * the RULE and holds the sliders fixed, which is the axis that actually decides
 * whether a colony can follow an image.
 *
 * It works because the cohorts are already a population. `derive_entity_rule`
 * mutates the authored rule once per cohort at `mutationScale`, so a run with
 * twelve cohorts is twelve different rules sharing one screen, each having
 * organised its own particles. Clicking one adopts it for everybody -- which is
 * exactly the gesture a person uses, and the reason this is not a slider sweep.
 *
 * ---------------------------------------------------------------------------
 * EACH COHORT IS ADOPTED AND RE-SIMULATED. THE SHORTCUT DOES NOT WORK.
 * ---------------------------------------------------------------------------
 * The obvious economy is to light each cohort in turn over ONE run and capture
 * it, on the assumption that highlighting isolates it. Measured: it does not.
 * The bright structure in the frame is shared by every cohort and the highlight
 * only tints a faint minority of specks, so eight captures of one run scored
 * within 0.03 of each other and the contact sheet was the same picture eight
 * times.
 *
 * So a cohort is evaluated the only way that actually answers the question:
 * adopt its rule, run the simulation on it, score that, then undo the adoption
 * and try the next. N+1 simulations per generation instead of one, and the
 * scores mean what they say.
 *
 * ---------------------------------------------------------------------------
 * TWO THINGS THE COMMANDS REFUSE TO DO, AND THE WAY ROUND THEM
 * ---------------------------------------------------------------------------
 * `setHighlightedCohort` only ever RE-AIMS: it declines when nothing is lit, so
 * that a stray dispatch cannot put the app in a state nobody aimed at. So each
 * generation opens with one real click through CDP to light something, and the
 * stepper takes over from there.
 *
 * `confirmSelection` requires SELECT mode and, while the two-stage highlight is
 * running, a lit cohort. Both hold here by construction.
 *
 *   npm run dev
 *   node tools/cohortSearch.mjs --image IMG [--preset TomoSegment] [--cohorts 12]
 *                               [--generations 6] [--steps 900] --out DIR
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { flagReader, sleep } from './lib/cdp.mjs';
import { evaluateCandidate, openHarness } from './lib/runner.mjs';
import { letterboxMask, scoreCandidate } from './lib/score.ts';

const args = flagReader();
const port = args.num('--port', 5173);
const preset = args.str('--preset', 'TomoSegment');
const imagePath = args.str('--image', null);
const cohorts = args.num('--cohorts', 12);
const generations = args.num('--generations', 6);
const steps = args.num('--steps', 900);
const scale = args.num('--scale', 2);
/**
 * MUTATION SCALE IS WHAT MAKES THE COHORTS A POPULATION, and it is not optional.
 *
 * `derive_entity_rule` mutates the authored rule per cohort BY THIS AMOUNT. At
 * zero every cohort gets the same rule, so the twelve groups on screen are one
 * behaviour wearing twelve colours: the per-cohort scores land within a
 * thousandth of each other, adopting any of them is a no-op, and the search
 * cannot move. Several shipped presets carry zero here -- `Cars` does, and so
 * does everything derived from it -- which is exactly how this run first failed.
 */
const mutation = args.num('--mutation', 0.44);
/**
 * Held lower than most presets ship, because the colony has to survive being
 * mutated. A high `mutationScale` with the density channels maxed pushes some
 * cohorts into the regime that stops the tab responding; damping the global
 * force is what buys the room to mutate at all. 0.399 is the value that was
 * observed working by hand at mutation 0.44.
 */
const globalForce = args.num('--global-force', 0.399);
const grid = args.num('--grid', 48);
const outDir = args.str('--out', null);
if (imagePath === null || outDir === null) {
  console.error('need --image <file> and --out <dir>');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const ext = path.extname(imagePath).slice(1).toLowerCase();
const dataUrl = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${readFileSync(imagePath).toString('base64')}`;

/** A real click, because the highlight cannot be lit any other way. */
async function click(session, x, y) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await session.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      buttons: type === 'mousePressed' ? 1 : 0,
      clickCount: 1,
    });
  }
}

let harness = await openHarness({ port, preset });
const log = path.join(outDir, 'cohorts.jsonl');
let best = null;
let lastRuleHead = null;

try {
  const { session } = harness;
  await session.evaluate(`__fh.stimulus(${JSON.stringify(dataUrl)}, ${JSON.stringify(path.basename(imagePath))}, 2048)`);

  // The sliders are held FIXED for the whole run. Only the rule moves.
  await session.evaluate(
    `__fh.apply(${JSON.stringify([
      { field: 'initialConditions', value: 1 },
      { field: 'cohorts', value: cohorts },
      { field: 'densitySense', value: 1 },
      { field: 'densityStrafe', value: -1 },
      { field: 'densityForce', value: -1 },
      { field: 'mutationScale', value: mutation },
      { field: 'globalForceMult', value: globalForce },
    ])})`,
  );
  await session.evaluate(`__fh.setScale(${scale})`);
  await session.evaluate(`window.__fluoddity.dispatch({ kind: 'setMouseMode', mode: 'select' })`);

  const rect = await session.evaluate('__fh.worldRect()');
  const imgDims = await session.evaluate(
    `(async () => { const i = await new Promise((r, j) => { const m = new Image(); m.onload = () => r(m); m.onerror = j; m.src = ${JSON.stringify(dataUrl)}; }); return [i.naturalWidth, i.naturalHeight]; })()`,
  );
  const target = await session.evaluate(
    `__fh.gridFromDataUrl(${JSON.stringify(dataUrl)}, ${grid}, ${rect.aspect})`,
  );
  const mask = letterboxMask(grid, imgDims[0] / imgDims[1], rect.aspect, scale);

  for (let gen = 1; gen <= generations; gen++) {
   try {
    const run = await evaluateCandidate(session, [], steps);
    writeFileSync(path.join(outDir, `gen${gen}-all.png`), Buffer.from(run.shot, 'base64'));

    // Light something. Centre of the world, where there is always mass.
    await click(session, Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2));
    await sleep(400);
    let lit = await session.evaluate('window.__fluoddity.status().highlightedCohort');
    if (lit === undefined || lit === null || lit < 0) {
      // The centre may be empty; try a few other spots before giving up.
      for (const [fx, fy] of [[0.35, 0.35], [0.65, 0.35], [0.35, 0.65], [0.65, 0.65]]) {
        await click(session, Math.round(rect.x + rect.width * fx), Math.round(rect.y + rect.height * fy));
        await sleep(400);
        lit = await session.evaluate('window.__fluoddity.status().highlightedCohort');
        if (lit !== null && lit !== undefined && lit >= 0) break;
      }
    }
    if (lit === null || lit === undefined || lit < 0) {
      console.error(`gen ${gen}: nothing could be lit -- is highlighting on and are there particles?`);
      break;
    }

    // Adopt each cohort's rule in turn, RUN IT, score it, then undo.
    const scored = [];
    for (let k = 0; k < cohorts; k++) {
      await session.evaluate(`window.__fluoddity.dispatch({ kind: 'setHighlightedCohort', cohort: ${k} })`);
      await sleep(120);
      await session.evaluate(`window.__fluoddity.dispatch({ kind: 'confirmSelection' })`);
      await sleep(500); // the pick is a GPU readback; the adoption lands a frame or two later

      const trial = await evaluateCandidate(session, [], steps);
      const g = await session.evaluate(`__fh.gridFromShot(${JSON.stringify(trial.shot)}, ${grid})`);
      const sc = scoreCandidate(g, target, grid, mask);
      scored.push({ cohort: k, structure: sc.structure, edge: sc.edgeAlignment, spread: sc.spread });
      writeFileSync(path.join(outDir, `gen${gen}-cohort${String(k).padStart(2, '0')}.png`), Buffer.from(trial.shot, 'base64'));

      // PUT THE RULE BACK. Adoption records a history entry, so undo is the
      // reversal the app itself provides -- and it keeps every cohort in this
      // generation a trial against the SAME parent rather than a chain.
      await session.evaluate(`window.__fluoddity.dispatch({ kind: 'undo' })`);
      await sleep(300);

      // Undo drops the highlight, so the next cohort needs one lit again.
      await click(session, Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2));
      await sleep(350);
    }
    scored.sort((a, b) => b.structure - a.structure);
    const win = scored[0];
    console.log(
      `gen ${gen}  best cohort ${win.cohort}  structure ${win.structure.toFixed(4)}  ` +
        `(worst ${scored[scored.length - 1].structure.toFixed(4)})`,
    );

    // ADOPT IT. This is the click, through the same path a person's would take.
    await session.evaluate(`window.__fluoddity.dispatch({ kind: 'setHighlightedCohort', cohort: ${win.cohort} })`);
    await sleep(150);
    await session.evaluate(`window.__fluoddity.dispatch({ kind: 'confirmSelection' })`);
    await sleep(600);

    // Put the highlight out before the next generation captures its own frame,
    // or that capture is dimmed by a selection belonging to this one.
    await session.evaluate(
      `(() => { const o = window.__fluoddity; if (o.status().highlightedCohort >= 0) o.dispatch({ kind: 'cancelSelection' }); })()`,
    );
    await sleep(150);

    const doc = await session.evaluate('__fh.doc()');
    appendFileSync(log, `${JSON.stringify({ gen, winner: win, scored, document: doc })}\n`);
    const ruleHead = doc.configs[0].rule.slice(0, 4).map((x) => x.toFixed(4)).join(',');
    if (gen > 1 && ruleHead === lastRuleHead) {
      console.error(`  gen ${gen}: THE RULE DID NOT MOVE -- adoption was a no-op (mutationScale ${mutation}?)`);
    }
    lastRuleHead = ruleHead;
    if (best === null || win.structure > best.structure) best = { gen, ...win, document: doc };
   } catch (e) {
    // A mutated colony can wedge the tab. That costs this generation and the
    // browser, not the run -- and the surviving generations are still a search.
    console.error(`  gen ${gen}: HUNG (${String(e?.message ?? e).split('\n')[0]})`);
    appendFileSync(log, `${JSON.stringify({ gen, hung: true })}\n`);
    break;
   }
  }
} catch (e) {
  console.error(String(e?.message ?? e));
} finally {
  harness?.session.close();
}

if (best !== null) {
  writeFileSync(path.join(outDir, 'best.json'), `${JSON.stringify(best, null, 2)}\n`);
  console.log(`\nbest overall: generation ${best.gen}, cohort ${best.cohort}, structure ${best.structure.toFixed(4)}`);
  console.log(`documents and per-cohort scores -> ${log}`);
}
