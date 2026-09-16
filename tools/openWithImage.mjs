/**
 * OPEN THE APP WITH AN IMAGE ALREADY DROPPED, AND LEAVE IT OPEN.
 *
 * There is deliberately no URL parameter that loads an image -- `urlOptions.ts`
 * treats a query string as untrusted and an image is not a value it can clamp.
 * A share link carries one, but `SHARE_IMAGE_MAX_DIM` reduces it to 128px, which
 * is a real loss for a tomogram. So this drives the `?bus` hook instead and
 * hands over the picture at full resolution.
 *
 * UNLIKE EVERY OTHER TOOL HERE, IT DOES NOT PAUSE AND DOES NOT EXIT. The point
 * is a window a person can drive: the panel is left visible, the simulation is
 * left running, and the process idles so Chrome stays alive. Stop the task to
 * close the browser.
 *
 *   npm run dev
 *   node tools/openWithImage.mjs --image ~/Downloads/image.png [--preset TomoSegment] [--scale 2]
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { flagReader, launch, waitForBus } from './lib/cdp.mjs';

const args = flagReader();
const port = args.num('--port', 5173);
const preset = args.str('--preset', 'TomoSegment');
const scale = args.num('--scale', 2);
const image = args.str('--image', null);
/**
 * CLICKING ONLY DOES SOMETHING IF THE COHORTS DIFFER.
 *
 * `derive_entity_rule` mutates the authored rule once per cohort BY
 * `mutationScale`. At zero every cohort holds the identical rule, so adopting
 * one by clicking is a provable no-op -- the 80 rule floats come back
 * unchanged. Several shipped presets carry zero, `Cars` among them and
 * everything derived from it, which makes click-to-adopt look broken when it is
 * merely being asked to swap a rule for itself.
 *
 * So the population is set up here: several cohorts, and enough mutation that
 * they are genuinely different animals worth choosing between. Pass
 * `--mutation 0` to leave the preset's own value alone.
 */
const cohorts = args.num('--cohorts', 12);
const mutation = args.num('--mutation', 0.25);
const sense = args.num('--sense', 1);
const strafe = args.num('--strafe', -1);
const force = args.num('--force', 0);
const randomStart = !args.has('--keep-layout');
if (image === null) {
  console.error('need --image <file>');
  process.exit(1);
}

// No `?nopanel`: the whole point is that the sliders are reachable. `?bus` is
// how the image gets in; `?nocalibrate` keeps the first run from re-tuning the
// world size out from under the preset.
const url = `http://localhost:${port}/?bus&nocalibrate&nosplash&preset=${preset}`;
// A DISTINCT PROFILE, so the automated tools' cleanup cannot close this window.
// They match `fluoddity-cdp-`; this is deliberately not that.
const session = await launch(url, {
  windowSize: '1500,1000',
  bootMs: 7000,
  profilePrefix: 'fluoddity-live-',
});

try {
  await waitForBus(session);

  const ext = path.extname(image).slice(1).toLowerCase();
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  const dataUrl = `data:image/${mime};base64,${readFileSync(image).toString('base64')}`;

  // Decoded in the page, because `RgbaImage` is what the command carries and the
  // browser is what has a decoder. Same shape `ui/imageDrop.ts` produces.
  const loaded = await session.evaluate(
    `(async () => {
      const o = window.__fluoddity;
      const im = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i); i.onerror = () => rej(new Error('decode failed'));
        i.src = ${JSON.stringify(dataUrl)};
      });
      const c = new OffscreenCanvas(im.naturalWidth, im.naturalHeight);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(im, 0, 0);
      const data = ctx.getImageData(0, 0, im.naturalWidth, im.naturalHeight).data;
      o.dispatch({ kind: 'loadDensityImage', image: { width: im.naturalWidth, height: im.naturalHeight, data }, name: ${JSON.stringify(path.basename(image))} });
      o.dispatch({ kind: 'setDensityScale', value: ${scale} });
      const s = o.status();
      return { name: s.densityImageName, scale: s.densityScale, paused: s.paused, w: im.naturalWidth, h: im.naturalHeight };
    })()`,
    { timeoutMs: 60000 },
  );

  // The population, and the density channels that make the image bite.
  const edits = [
    { field: 'cohorts', value: cohorts },
    { field: 'densitySense', value: sense },
    { field: 'densityStrafe', value: strafe },
    { field: 'densityForce', value: force },
  ];
  if (mutation > 0) edits.push({ field: 'mutationScale', value: mutation });
  if (randomStart) edits.push({ field: 'initialConditions', value: 1 });

  await session.evaluate(
    `(async () => {
      const spec = await import('/src/ui/settingsSpec.ts');
      const o = window.__fluoddity;
      for (const e of ${JSON.stringify(edits)}) {
        const setting = spec.SETTINGS.find((x) => x.field === e.field);
        o.dispatch({ kind: 'editSetting', setting, value: e.value, record: false });
      }
      o.dispatch({ kind: 'setMouseMode', mode: 'select' });
      o.dispatch({ kind: 'reset' });
      return true;
    })()`,
    { timeoutMs: 60000 },
  );

  if (loaded.paused) await session.evaluate(`window.__fluoddity.dispatch({ kind: 'togglePause' })`);

  console.log(`preset   ${preset}`);
  console.log(`image    ${loaded.name}  ${loaded.w}x${loaded.h} at full resolution`);
  console.log(`scale    ${loaded.scale}`);
  console.log('');
  console.log(`cohorts  ${cohorts} at mutation ${mutation > 0 ? mutation : "(preset's own)"}`);
  console.log(`density  sense ${sense}, strafe ${strafe}, force ${force}${randomStart ? ', random start' : ''}`);
  console.log('');
  console.log('CLICK a region whose particles you like: the first click aims (that');
  console.log('cohort lights up), the second commits and the whole colony adopts');
  console.log('its rule. Arrows step between cohorts, Enter commits, right-click');
  console.log('cancels the aim. Stop this task to close the browser.');

  // Idle forever: the browser dies with this process.
  await new Promise(() => {});
} catch (e) {
  console.error(String(e?.message ?? e));
  session.close();
  process.exit(1);
}
