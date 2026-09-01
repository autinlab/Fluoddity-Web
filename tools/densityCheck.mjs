/**
 * THE DENSITY IMAGE FIELD'S BROWSER VERIFICATION, and specifically its Y flip.
 *
 * WHY THIS IS NOT `npm test`. Two of the three things it checks exist only on a
 * GPU. `densityGradient.test.ts` pins the orientation of the FLOATS the host
 * builds; nothing in node can confirm that those floats, once uploaded to an
 * `rg16float` and sampled through `world_to_uv_bc`, push particles the way the
 * host intended. Between the pure leaf and the particle there is a row order, a
 * half-float conversion, a texture upload and a uv mapping, and every one of
 * them can be mirrored without erroring.
 *
 * WHY THIS IS NOT `browserCheck.mjs --shot`. That tool's only lever is the URL,
 * and there is no URL parameter that loads an image -- deliberately, because
 * `urlOptions.ts` treats everything in a query string as untrusted and an image
 * is not a value it can clamp. So this drives the app through the `?bus` hook
 * instead, the same escape hatch `configCheck.mjs` uses for the same reason.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT ASSERTS, AND WHY THESE THREE
 * ---------------------------------------------------------------------------
 * The fixture is an image bright in ITS OWN TOP-LEFT QUADRANT only -- asymmetric
 * on both axes, so a y-flip, an x-mirror and a transpose are each visible and
 * each distinguishable from the others. A centred blob would pass every one of
 * them.
 *
 *   1. ATTRACTION MOVES PARTICLES, and toward the bright quadrant. This is the
 *      end-to-end statement: pure leaf, f16 pack, upload, uv mapping and shader
 *      all agree.
 *   2. IT MOVES THEM TO THE RIGHT PLACE. The upper-left quadrant of the SCREEN
 *      is world +y/-x, which is where the image's top-left has to land. If the
 *      row flip in `densityGradient.ts` were missing, particles would pile into
 *      the LOWER-left instead -- a result that looks entirely reasonable on
 *      screen and is wrong.
 *   3. THE SIGN IS THE SIGN. A negative strength must empty that quadrant
 *      rather than fill it. Nothing else distinguishes "attract" from "repel",
 *      and inverting them is a one-character change in the shader.
 *
 * Assertion 2 is the one that could not be bought any other way, and it is why
 * the fixture is a corner rather than a half.
 *
 * ---------------------------------------------------------------------------
 * RUNNING IT
 * ---------------------------------------------------------------------------
 *   npm run dev
 *   node tools/densityCheck.mjs [--port 5173] [--preset Tangle] [--keep-shots DIR]
 *
 * Needs a real GPU and a HEADED Chrome -- headless returns a null adapter. Set
 * CHROME_PATH if Chrome is not at the default for this platform.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

const CHROME =
  process.env.CHROME_PATH ??
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : process.platform === 'win32'
      ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
      : '/usr/bin/google-chrome');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const port = Number(flag('--port', '5173'));
const preset = flag('--preset', 'Tangle');
const keepShots = flag('--keep-shots', null);

const userDataDir = mkdtempSync(path.join(tmpdir(), 'fluoddity-density-'));
let chrome = null;
const cleanup = () => {
  try {
    chrome?.kill();
  } catch {
    /* already gone */
  }
  try {
    rmSync(userDataDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
};

const failures = [];
const fail = (message) => {
  failures.push(message);
  console.error(`FAIL  ${message}`);
};
const pass = (message) => console.log(`ok    ${message}`);
const die = (message) => {
  console.error(message);
  cleanup();
  process.exit(1);
};

chrome = spawn(
  CHROME,
  [
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    '--enable-unsafe-webgpu',
    '--window-size=1280,900',
    // `?bus` exposes the Orchestrator; `?nopanel` keeps a 320px column out of
    // the quadrant statistics; `?nocalibrate` fixes the world size, which would
    // otherwise be chosen from this machine's speed and change what is compared.
    `http://localhost:${port}/?bus&nopanel&preset=${preset}&nocalibrate`,
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);

const browserWs = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Chrome did not report a debugging port')), 20000);
  chrome.stderr.on('data', (buf) => {
    const m = String(buf).match(/ws:\/\/\S+/);
    if (m) {
      clearTimeout(timer);
      resolve(m[0]);
    }
  });
  chrome.on('error', reject);
}).catch((e) => die(String(e)));

const ws = new WebSocket(browserWs);
await once(ws, 'open');

let nextId = 1;
const pending = new Map();
const logs = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    logs.push((msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '));
  }
});
const send = (method, params = {}, sid) => {
  const id = nextId++;
  const payload = { id, method, params };
  if (sid) payload.sessionId = sid;
  ws.send(JSON.stringify(payload));
  return new Promise((resolve) => pending.set(id, resolve));
};

const { result: targets } = await send('Target.getTargets');
const page = targets.targetInfos.find((t) => t.type === 'page');
if (!page) die('No page target.');
const attach = await send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
const sid = attach.result.sessionId;

await send('Runtime.enable', {}, sid);
await send('Page.enable', {}, sid);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Device acquisition plus eleven pipeline compilations, then some frames.
await sleep(6000);

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sid);
  if (r.result?.exceptionDetails) {
    die(`evaluate failed: ${JSON.stringify(r.result.exceptionDetails.exception ?? r.result.exceptionDetails)}`);
  }
  return r.result?.result?.value;
};

const ready = await evaluate('typeof window.__fluoddity === "object"');
if (!ready) die('window.__fluoddity is missing -- is the page built with ?bus?');

const shot = async (label) => {
  const r = await send('Page.captureScreenshot', { format: 'png' }, sid);
  const b64 = r.result?.data;
  if (!b64) die('screenshot failed');
  if (keepShots) writeFileSync(path.join(keepShots, `${label}.png`), Buffer.from(b64, 'base64'));
  return b64;
};

/**
 * Mean luma per quadrant, as [UL, UR, LL, LR].
 *
 * Decoded in the PAGE rather than here: the browser already has a PNG decoder,
 * and shipping one to node would be a dependency for four numbers.
 */
const quadrantLuma = async (b64) => {
  const out = await evaluate(`(async () => {
    const img = new Image();
    img.src = 'data:image/png;base64,${b64}';
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const hw = c.width >> 1, hh = c.height >> 1;
    const sum = [0, 0, 0, 0], n = [0, 0, 0, 0];
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const q = (y < hh ? 0 : 2) + (x < hw ? 0 : 1);
        const p = (y * c.width + x) * 4;
        sum[q] += 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2];
        n[q]++;
      }
    }
    return sum.map((s, i) => s / n[i]);
  })()`);
  return out;
};

/**
 * Load a density image bright in ITS OWN top-left quadrant, and set one channel.
 *
 * Built in the page as a plain RgbaImage -- the same value the drop binding
 * produces after decoding a file, so this exercises everything downstream of
 * `createImageBitmap` and nothing that only a real file could reach.
 */
const loadFixtureAndSet = async (field, value) => {
  const ok = await evaluate(`(async () => {
    const N = 256;
    const data = new Uint8ClampedArray(N * N * 4);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const p = (y * N + x) * 4;
        // Bright in the image's TOP-LEFT: rows 0..127, cols 0..127.
        const v = (x < N / 2 && y < N / 2) ? 255 : 0;
        data[p] = v; data[p + 1] = v; data[p + 2] = v; data[p + 3] = 255;
      }
    }
    const o = window.__fluoddity;
    o.dispatch({ kind: 'loadDensityImage', image: { width: N, height: N, data }, name: 'fixture' });
    const spec = await import('/src/ui/settingsSpec.ts');
    const setting = spec.settingFor(spec.CONFIG, ${JSON.stringify(field)});
    if (setting === null) return 'no such setting: ' + ${JSON.stringify(field)};
    o.dispatch({ kind: 'editSetting', setting, value: ${value} });
    return 'ok';
  })()`);
  if (ok !== 'ok') die(String(ok));
};

const clearImage = async () => {
  await evaluate(`window.__fluoddity.dispatch({ kind: 'clearDensityImage' })`);
};

const setField = async (field, value) => {
  await evaluate(`(async () => {
    const spec = await import('/src/ui/settingsSpec.ts');
    window.__fluoddity.dispatch({
      kind: 'editSetting',
      setting: spec.settingFor(spec.CONFIG, ${JSON.stringify(field)}),
      value: ${value},
    });
  })()`);
};

const reset = async () => {
  await evaluate(`window.__fluoddity.dispatch({ kind: 'reset' })`);
};

console.log(`density check -- preset=${preset}\n`);

// --- 1. the control: no image, so nothing biases anything -------------------
await reset();
await sleep(2500);
const control = await quadrantLuma(await shot('1-control'));
console.log(`control  UL=${control[0].toFixed(2)} UR=${control[1].toFixed(2)} LL=${control[2].toFixed(2)} LR=${control[3].toFixed(2)}`);

// --- 2. attraction ----------------------------------------------------------
//
// Strafe rather than Force: it is a direct displacement, so the result does not
// depend on the preset's drag or on whether its rule happens to resist. This
// check is about the FIELD's orientation, and the strafe channel is the one that
// isolates it.
await loadFixtureAndSet('densityStrafe', 0.75);
await sleep(3500);
const attracted = await quadrantLuma(await shot('2-attract'));
console.log(`attract  UL=${attracted[0].toFixed(2)} UR=${attracted[1].toFixed(2)} LL=${attracted[2].toFixed(2)} LR=${attracted[3].toFixed(2)}`);

// The image's top-left is the world's top-left is the screen's upper-left.
const ulGain = attracted[0] - control[0];
const otherGain = Math.max(attracted[1] - control[1], attracted[2] - control[2], attracted[3] - control[3]);
if (ulGain > 0 && ulGain > otherGain) {
  pass(`attraction concentrates particles in the upper-left (+${ulGain.toFixed(2)} vs +${otherGain.toFixed(2)} elsewhere)`);
} else {
  fail(
    `attraction should fill the UPPER-left quadrant. UL gained ${ulGain.toFixed(2)}, ` +
      `best other quadrant gained ${otherGain.toFixed(2)}. ` +
      `If the LOWER-left gained most, the row flip in densityGradient.ts is inverted.`,
  );
}

// The specific misreading worth naming: a missing row flip sends them down.
const llGain = attracted[2] - control[2];
if (llGain < ulGain) {
  pass(`the field is not y-mirrored (LL gained ${llGain.toFixed(2)} < UL ${ulGain.toFixed(2)})`);
} else {
  fail(`Y FLIP INVERTED: the lower-left gained ${llGain.toFixed(2)} against the upper-left's ${ulGain.toFixed(2)}`);
}

// --- 3. repulsion -----------------------------------------------------------
await clearImage();
await reset();
await sleep(2500);
await loadFixtureAndSet('densityStrafe', -0.75);
await sleep(3500);
const repelled = await quadrantLuma(await shot('3-repel'));
console.log(`repel    UL=${repelled[0].toFixed(2)} UR=${repelled[1].toFixed(2)} LL=${repelled[2].toFixed(2)} LR=${repelled[3].toFixed(2)}`);

if (repelled[0] < attracted[0]) {
  pass(`a negative strength repels where a positive one attracts (UL ${repelled[0].toFixed(2)} < ${attracted[0].toFixed(2)})`);
} else {
  fail(`SIGN INVERTED: repulsion left the upper-left at ${repelled[0].toFixed(2)}, not below attraction's ${attracted[0].toFixed(2)}`);
}

// --- 4. the sense channel, ADVISORY -----------------------------------------
//
// DOES NOT VOTE, and the reason is the same one `fieldCheck.mjs` gives for its
// pass 2. This channel's whole design is that the RULE decides what to do with
// the sensed gradient, and each cohort's rule is a different mutation -- so
// there is no direction to assert. Some cohorts climb the gradient, some flee
// it, and which is which changes with the preset and with the mutation seed.
//
// Asserting a direction here would be asserting that the feature does NOT work
// as designed. Asserting mere "something changed" is not much better: the
// simulation is chaotic, so a scalar summary moves by more than this between two
// runs of identical code (measured, and the reason that check was not kept).
//
// THE EVIDENCE FOR THIS CHANNEL IS THE SCREENSHOT, and saying so is better than
// dressing a coin flip up as a threshold. Run with --keep-shots and look at
// `4-sense`: a correct build shows different cohorts responding DIFFERENTLY to
// the same image -- some collapsing onto its edges, others ignoring them.
await setField('densityStrafe', 0.0);
await clearImage();
await reset();
await sleep(2000);
await loadFixtureAndSet('densitySense', 0.8);
await sleep(4000);
const sensed = await quadrantLuma(await shot('4-sense'));
console.log(
  `sense    UL=${sensed[0].toFixed(2)} UR=${sensed[1].toFixed(2)} ` +
    `LL=${sensed[2].toFixed(2)} LR=${sensed[3].toFixed(2)}   (advisory -- see the comment)`,
);

// --- 5. clearing really clears ---------------------------------------------
await setField('densitySense', 0.0);
await clearImage();
await reset();
await sleep(2500);
const cleared = await quadrantLuma(await shot('5-cleared'));
const spread = Math.max(...cleared) - Math.min(...cleared);
const controlSpread = Math.max(...control) - Math.min(...control);
if (spread <= controlSpread * 2 + 1) {
  pass(`clearing the image restores an unbiased distribution (spread ${spread.toFixed(2)} vs control ${controlSpread.toFixed(2)})`);
} else {
  fail(`after clearing, the distribution is still skewed (spread ${spread.toFixed(2)} vs control ${controlSpread.toFixed(2)})`);
}

// --- 6. THE DROP GESTURE ITSELF ---------------------------------------------
//
// Everything above reaches the field by DISPATCHING `loadDensityImage`, which
// skips the entire user-facing entry point: the overlay, the drag depth counter,
// the file-type filter and the real `createImageBitmap` decode. That is most of
// the feature's code and all of the part a user actually touches.
//
// `DataTransfer` is constructible in Chrome, so a synthetic drop can carry a
// real `File` -- the same technique Playwright and Puppeteer use. That reaches
// `carriesFiles` (via `dataTransfer.types`), `chooseDroppedImage`, `decodeImage`
// and the dispatch, all through the production listeners.
//
// THE ONE THING THIS CANNOT ASSERT is that `preventDefault` stops the browser
// navigating away to the dropped file, because synthetic events do not navigate
// in the first place. That line is the most load-bearing one in
// `imageDropBinding.ts` and it is checked by hand, not here.

/** Fire a full drag sequence carrying one synthetic file. */
const dropFile = async ({ name, type, dataUrl, width }) => {
  return evaluate(`(async () => {
    const src = ${dataUrl === null ? `(() => {
      // A canvas larger than MAX_DECODE_DIM, so the resize branch runs.
      const c = document.createElement('canvas');
      c.width = ${width}; c.height = ${width};
      const g = c.getContext('2d');
      g.fillStyle = '#000'; g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width / 2, c.height / 2);
      return c.toDataURL('image/png');
    })()` : JSON.stringify(dataUrl)};
    const blob = ${type.startsWith('image/')
      ? `await (await fetch(src)).blob()`
      : `new Blob(['not an image'], { type: ${JSON.stringify(type)} })`};
    const file = new File([blob], ${JSON.stringify(name)}, { type: ${JSON.stringify(type)} });
    const dt = new DataTransfer();
    dt.items.add(file);
    const opts = { dataTransfer: dt, bubbles: true, cancelable: true };

    document.dispatchEvent(new DragEvent('dragenter', opts));
    document.dispatchEvent(new DragEvent('dragover', opts));
    const overlay = document.getElementById('image-drop-overlay');
    const duringDrag = overlay === null ? 'missing' : getComputedStyle(overlay).display;

    document.dispatchEvent(new DragEvent('drop', opts));
    // The decode is async and the handler does not await it.
    await new Promise((r) => setTimeout(r, 1200));
    const afterDrop = overlay === null ? 'missing' : getComputedStyle(overlay).display;

    return { duringDrag, afterDrop, loaded: window.__fluoddity.status().densityImageName };
  })()`);
};

// Reset to a known state: nothing loaded, no strength.
await setField('densitySense', 0.0);
await clearImage();
await sleep(500);

// A small real PNG, built in-page.
const tinyPng = await evaluate(`(() => {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#000'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#fff'; g.fillRect(0, 0, 32, 32);
  return c.toDataURL('image/png');
})()`);

const dropped = await dropFile({ name: 'membrane.png', type: 'image/png', dataUrl: tinyPng, width: 0 });
if (dropped.duringDrag === 'flex') {
  pass('dragging a file over the page shows the drop overlay');
} else {
  fail(`the overlay should be shown during a drag, was "${dropped.duringDrag}"`);
}
if (dropped.afterDrop === 'none') {
  pass('the overlay is hidden again after the drop');
} else {
  fail(`the overlay should be hidden after the drop, was "${dropped.afterDrop}"`);
}
if (dropped.loaded === 'membrane.png') {
  pass('a dropped PNG reaches the field through the real listeners');
} else {
  fail(`the drop should have loaded membrane.png, status says "${dropped.loaded}"`);
}

// A file the browser cannot turn into pixels. The load must NOT change, and the
// previous image must survive -- a rejected drop is not a reason to lose one.
const rejected = await dropFile({ name: 'notes.txt', type: 'text/plain', dataUrl: 'x', width: 0 });
if (rejected.loaded === 'membrane.png') {
  pass('an undecodable drop is refused and leaves the loaded image alone');
} else {
  fail(`a .txt drop should change nothing, status says "${rejected.loaded}"`);
}

// Over MAX_DECODE_DIM, so `createImageBitmap`'s resize path runs. Bigger than
// 2048 on both axes and not square-aligned to the cap.
const big = await dropFile({ name: 'tomogram_big.png', type: 'image/png', dataUrl: null, width: 2600 });
if (big.loaded.includes('tomogram') || big.loaded.includes('…')) {
  pass(`an oversized image decodes through the downscale path (as "${big.loaded}")`);
} else {
  fail(`an oversized image should still load, status says "${big.loaded}"`);
}

await evaluate(`window.__fluoddity.dispatch({ kind: 'clearDensityImage' })`);
const afterClear = await evaluate(`window.__fluoddity.status().densityImageName`);
if (afterClear === '') {
  pass('clearing empties the status name');
} else {
  fail(`after clearing, status still says "${afterClear}"`);
}

// --- 7. THE SHARE LINK, ACROSS A REAL RELOAD --------------------------------
//
// THE ONE CHECK THAT IS THE POINT, in the sense `configCheck.mjs` means it: a
// dropped image travels in a share link and comes back after the page has been
// thrown away and rebuilt. Everything before this passes just as well against an
// in-memory value.
//
// It also covers the part that is easy to get wrong and impossible to see: the
// link's copy is quantized to 4 bits and stretched on the way out
// (`toGrayscaleThumbnail`), so this is where "the recipient gets what the sender
// had" is actually established rather than argued.

// Drop an image, set a distinctive scale, and build the link the Share menu
// would build. `sharedDensityImage()` is what the panel passes.
const link = await evaluate(`(async () => {
  const c = document.createElement('canvas');
  c.width = 96; c.height = 96;
  const g = c.getContext('2d');
  g.fillStyle = '#101010'; g.fillRect(0, 0, 96, 96);
  g.fillStyle = '#f0f0f0'; g.fillRect(0, 0, 48, 48);
  const blob = await (await fetch(c.toDataURL('image/png'))).blob();
  const dt = new DataTransfer();
  dt.items.add(new File([blob], 'shared_fixture.png', { type: 'image/png' }));
  const o = { dataTransfer: dt, bubbles: true, cancelable: true };
  document.dispatchEvent(new DragEvent('dragenter', o));
  document.dispatchEvent(new DragEvent('dragover', o));
  document.dispatchEvent(new DragEvent('drop', o));
  await new Promise((r) => setTimeout(r, 1200));

  window.__fluoddity.dispatch({ kind: 'setDensityScale', value: 3.25 });

  const sl = await import('/src/config/shareLink.ts');
  return sl.buildShareUrl(
    { origin: location.origin, pathname: location.pathname, search: '?bus&nopanel&nocalibrate' },
    window.__fluoddity.projectDocument(),
    window.__fluoddity.sharedDensityImage(),
  );
})()`);

if (typeof link === 'string' && link.includes('#b=')) {
  pass(`a share link was built carrying the image (${link.length} chars)`);
} else {
  die(`expected a #b= share link, got ${String(link).slice(0, 80)}`);
}
// The size is a design constraint, not a detail -- a link nobody can paste is
// not a share feature. Printed rather than asserted here because
// `shareLink.test.ts` owns the ceiling; this is the real-world number.
console.log(`link     ${link.length} chars with a 96px image`);

// THE RELOAD. Everything in the page is discarded.
await send('Page.navigate', { url: link }, sid);
await sleep(9000);

const restored = await evaluate(`(() => {
  if (typeof window.__fluoddity !== 'object') return { ready: false };
  const s = window.__fluoddity.status();
  return { ready: true, name: s.densityImageName, scale: s.densityScale };
})()`);

if (!restored.ready) {
  fail('the page did not come back up after navigating to the share link');
} else {
  if (restored.name !== '') {
    pass(`the image survived a full page reload via the share link (as "${restored.name}")`);
  } else {
    fail('after reloading the share link, no density image is loaded');
  }
  // 3.25 is exactly representable in float32, so this compares exactly -- a
  // scale that arrived rounded would mean the lane is the wrong width.
  if (restored.scale === 3.25) {
    pass('the image scale round-tripped through the link exactly');
  } else {
    fail(`the scale should have come back as 3.25, got ${String(restored.scale)}`);
  }
}

const errors = logs.filter((l) => /error|failed|Uncaught/i.test(l));
if (errors.length > 0) {
  fail(`the page logged errors:\n      ${errors.join('\n      ')}`);
}

cleanup();
if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log('\nOK');
