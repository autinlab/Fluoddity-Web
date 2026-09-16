/**
 * THE GATE THE WHOLE SEARCH RESTS ON.
 *
 * A parameter search is only meaningful if the same parameters produce the same
 * picture. Everything else in the harness -- the metrics, the hill-climb, the
 * promotion of a winner -- is arithmetic over screenshots, and if two identical
 * runs disagree then all of it is fitting noise.
 *
 * `fieldCheck.mjs:53-68` is the primary-source warning: its region metrics
 * "moved less than the run-to-run variance of a chaotic simulation", and one
 * separated cleanly on one run and inverted on the next with no code change.
 * That tool advanced the simulation by sleeping. This one does not, and this
 * check is what proves the difference is real rather than hoped for.
 *
 * TWO ASSERTIONS, NOT ONE.
 *
 *   1. Two runs of identical parameters produce a BYTE-IDENTICAL screenshot.
 *   2. `diagnostics.frameCount` equals `steps * physicsSteps` exactly.
 *
 * The second is not redundant. `probeFrame()` reads `this.prefs.physicsSteps`
 * on every call (`orchestrator.ts:3382`), so two runs can agree with each other
 * while both quietly ran at a rate nobody asked for -- a calibrated one, say,
 * which is exactly what `?nocalibrate` is there to prevent. Matching
 * screenshots alone would not catch it.
 *
 * A THIRD, WHICH IS THE ADVERSARIAL ONE. Identical screenshots also happen when
 * the picture is frozen -- which is the specific failure the settled-still hold
 * would cause (see `lib/runner.mjs`'s header). So this also asserts that
 * CHANGING a parameter changes the screenshot. Without it, a completely dead
 * harness passes this file perfectly.
 *
 *   npm run dev
 *   node tools/determinismCheck.mjs [--port 5173] [--preset Tangle] [--steps 200]
 *
 * Needs a real GPU and a HEADED Chrome -- headless returns a null adapter.
 */

import { createHash } from 'node:crypto';

import { consoleErrors, flagReader } from './lib/cdp.mjs';
import { evaluateCandidate, openHarness } from './lib/runner.mjs';

const args = flagReader();
const port = args.num('--port', 5173);
const preset = args.str('--preset', 'Tangle');
const steps = args.num('--steps', 200);

const failures = [];
const fail = (m) => {
  failures.push(m);
  console.error(`FAIL  ${m}`);
};
const pass = (m) => console.log(`ok    ${m}`);

const digest = (b64) => createHash('sha256').update(b64 ?? '').digest('hex').slice(0, 16);

let harness = null;
try {
  console.log(`opening ${preset} at :${port} ...`);
  harness = await openHarness({ port, preset });
  const { session, pins } = harness;

  console.log(
    `pinned: physicsSteps=${pins.physicsSteps} worldSize=${pins.worldSize} canvasAspect=${pins.canvasAspect}`,
  );

  // A parameter set with the density channels quiet, so this measures the
  // engine's own reproducibility rather than the density field's.
  const baseline = [
    { field: 'sensorGain', value: 4.0 },
    { field: 'densitySense', value: 0.0 },
    { field: 'densityStrafe', value: 0.0 },
    { field: 'densityForce', value: 0.0 },
  ];

  const first = await evaluateCandidate(session, baseline, steps);
  const second = await evaluateCandidate(session, baseline, steps);

  const expected = steps * first.physicsSteps;
  if (first.frameCount === expected) {
    pass(`frame count is exactly steps x physicsSteps (${steps} x ${first.physicsSteps} = ${expected})`);
  } else {
    fail(
      `frame count was ${first.frameCount}, expected ${expected}. ` +
        `probeFrame advanced at a rate this run did not ask for -- check ?nocalibrate.`,
    );
  }

  if (second.frameCount !== first.frameCount) {
    fail(`the two runs reached different frame counts: ${first.frameCount} vs ${second.frameCount}`);
  }

  if (first.shot === null || second.shot === null) {
    fail('no screenshot came back at all');
  } else if (first.shot === second.shot) {
    pass(`identical parameters gave a byte-identical screenshot (sha ${digest(first.shot)})`);
  } else {
    fail(
      `identical parameters gave DIFFERENT screenshots (${digest(first.shot)} vs ${digest(second.shot)}). ` +
        `The step count is pinned, so something outside the physics is moving.`,
    );
  }

  // THE ADVERSARIAL HALF. A frozen picture passes everything above.
  const moved = await evaluateCandidate(session, [{ field: 'sensorGain', value: 0.4 }], steps);
  if (moved.shot === null) {
    fail('no screenshot for the changed-parameter run');
  } else if (moved.shot === first.shot) {
    fail(
      'changing sensorGain from 4.0 to 0.4 changed NOTHING in the screenshot. ' +
        'Either parameters are not being applied, or the paused settled still is ' +
        'being held and every capture is the same frozen frame.',
    );
  } else {
    pass(`changing a parameter changed the picture (sha ${digest(moved.shot)})`);
  }

  const errs = consoleErrors(session.logs);
  if (errs.length > 0) {
    for (const e of errs.slice(0, 10)) fail(`console: ${e.text}`);
  } else {
    pass('no console errors');
  }
} catch (e) {
  fail(String(e?.stack ?? e));
} finally {
  harness?.session.close();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s).`);
  process.exit(1);
}
console.log('\nOK - the harness is deterministic.');
