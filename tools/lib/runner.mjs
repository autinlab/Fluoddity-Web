/**
 * THE CANDIDATE EVALUATOR: one Chrome, one tab, many simulations.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS DOES NOT SLEEP, AND WHY THAT IS THE WHOLE POINT
 * ---------------------------------------------------------------------------
 * Every existing tool in this directory advances the simulation by waiting:
 * `await sleep(4000)`, then screenshot. `fieldCheck.mjs:53-68` records what that
 * costs -- its region metrics "moved less than the run-to-run variance of a
 * chaotic simulation", and one of them separated cleanly on one run and
 * INVERTED on the next with no code change. A parameter search scored that way
 * is a search over noise.
 *
 * The simulation is not the source of that variance. Every stochastic draw in
 * `entityUpdate.wgsl` is a pure hash of index and frame count; there is no
 * `Math.random` on the GPU and no clock anywhere in the step; the loop is
 * fixed-count (`particleSystem.ts:1158-1214`). The variance is entirely in HOW
 * MANY rAF FRAMES the machine delivered during the sleep.
 *
 * So this pauses the simulation and advances it by hand:
 *
 *     dispatch togglePause      -- rAF stops calling runFrame
 *     dispatch reset            -- zeroes _frameCount; the sentinel is consumed
 *                                  inside runFrame, which is exactly what
 *                                  probeFrame calls, so this is safe paused
 *     await probeFrame() x N    -- N * physicsSteps sub-steps, exactly
 *     screenshot
 *
 * `probeFrame` (`orchestrator.ts:3381`) exists for the calibration ladder and
 * is documented as "physics only, no camera, no assembler, no pick". That is
 * precisely what is wanted: it is the only way to advance the simulation
 * without going through rAF.
 *
 * ---------------------------------------------------------------------------
 * THE SETTLED STILL, WHICH WOULD OTHERWISE MAKE ALL OF THIS INVISIBLE
 * ---------------------------------------------------------------------------
 * A paused frame does not simply re-render the frozen state. The FIRST paused
 * frame is a "settle" that averages `physicsSteps` samples into the camera
 * accumulator, and `orchestrator.ts:908-913` then holds that texture: every
 * later paused frame "records NOTHING AT ALL -- no clear, no render", because
 * the physics the still depicts has been advanced past and cannot be
 * re-rendered.
 *
 * Which means stepping physics with `probeFrame` and screenshotting would show
 * the SAME PICTURE EVERY TIME -- silently, with no error, and looking entirely
 * plausible. Every candidate would score identically and the search would
 * report that no parameter matters.
 *
 * The hold is dropped when `fieldEdited` is true (`orchestrator.ts:831`), which
 * is why `clearStrafeField` is dispatched before each capture. It is listed
 * there deliberately -- "a held frame renders nothing, so anything that changes
 * what the picture should contain has to drop the still". Once dropped,
 * `settledView` is null and `settledViewMatches(null, v)` is false forever
 * after (`blurSchedule.test.ts:269`), so every subsequent paused frame renders
 * live. Clearing a field this harness never paints costs nothing.
 *
 * THE `layer` IS REQUIRED and there is no default. The command clears ONE named
 * layer since the Drawing Controls grew a button for each, and a dispatch
 * without one puts `undefined` in `clearFieldPending` -- which still drops the
 * still, because that is keyed on the set being non-empty, and then asks the
 * field to clear a layer that does not exist. 'walls' is the arbitrary choice
 * of two; neither is ever painted here.
 *
 * ---------------------------------------------------------------------------
 * WHAT MUST BE PINNED
 * ---------------------------------------------------------------------------
 * `worldSize`, `canvasAspect` and `physicsSteps` read as preferences and are
 * physics. `sqrt_world_size` divides essentially every force term; `canvasAspect`
 * changes the world extent and therefore the initial layout; `physicsSteps` is
 * the integration count and is what `probeFrame` multiplies by. `?nocalibrate`
 * keeps first-run calibration from choosing the first and third off this
 * machine's measured speed.
 */

import { launch, waitForBus, sleep } from './cdp.mjs';

/** Sub-steps advanced per `probeFrame()` call is `physicsSteps`; this is N. */
export const DEFAULT_STEPS = 400;

/**
 * The page-side half, installed once as `window.__fh`.
 *
 * It lives here as a string rather than as a file the page imports because the
 * page is served by Vite from `src/`, and putting harness code there would put
 * a test fixture inside the application. `densityCheck.mjs` builds its fixture
 * in-page for the same reason.
 */
const PAGE_HARNESS = `
(() => {
  const o = window.__fluoddity;
  const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
  const frames = async (n) => { for (let i = 0; i < n; i++) await raf(); };

  const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

  // Area-average down to n x n. Area, not nearest: a particle simulation is
  // sparse bright pixels on black, and point sampling a sparse field reports
  // whichever pixel a grid line happened to land on.
  const gridFrom = (ctx, sx, sy, sw, sh, n) => {
    const img = ctx.getImageData(sx, sy, sw, sh).data;
    const out = new Array(n * n).fill(0);
    const counts = new Array(n * n).fill(0);
    for (let y = 0; y < sh; y++) {
      const gy = Math.min(n - 1, Math.floor((y * n) / sh));
      for (let x = 0; x < sw; x++) {
        const gx = Math.min(n - 1, Math.floor((x * n) / sw));
        const i = (y * sw + x) * 4;
        const cell = gy * n + gx;
        out[cell] += luma(img[i], img[i + 1], img[i + 2]);
        counts[cell] += 1;
      }
    }
    for (let i = 0; i < out.length; i++) out[i] = counts[i] ? out[i] / counts[i] / 255 : 0;
    return out;
  };

  const loadImage = (src) =>
    new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('image decode failed'));
      im.src = src;
    });

  window.__fh = {
    /**
     * What \`setup()\` returns, WITHOUT pausing or waiting on frames.
     *
     * \`setup()\` exists for the reproducible path: it pauses, spends the settle
     * frame and drops the held still, which costs several rAF waits. A live tool
     * needs none of that, and those waits are exactly where a boot hangs while
     * the GPU is still recovering from a previous wedge -- turning a recoverable
     * blip into a dead run.
     */
    probe() {
      const p = o.preferences;
      return {
        paused: o.status().paused,
        physicsSteps: p.physicsSteps,
        worldSize: p.worldSize,
        canvasAspect: p.canvasAspect,
      };
    },

    /** Pause, spend the settle frame, then drop the still so renders go live. */
    async setup() {
      if (!o.status().paused) o.dispatch({ kind: 'togglePause' });
      await frames(3);            // the settle frame runs and arms the hold
      o.dispatch({ kind: 'clearStrafeField', layer: 'walls' });
      await frames(2);            // fieldEdited drops it; settledView is now null
      const p = o.preferences;
      return {
        paused: o.status().paused,
        physicsSteps: p.physicsSteps,
        worldSize: p.worldSize,
        canvasAspect: p.canvasAspect,
      };
    },

    /**
     * Apply parameters. \`editSetting\` carries the SETTING OBJECT, not a field
     * name, so the registry is imported in-page -- the same idiom as
     * \`configCheck.mjs:264-272\`. \`record: false\` keeps a 200-candidate sweep
     * from leaving 200 undo entries.
     */
    async apply(edits) {
      const spec = await import('/src/ui/settingsSpec.ts');
      const applied = [];
      for (const e of edits) {
        const setting = spec.SETTINGS.find((s) => s.field === e.field);
        if (!setting) throw new Error('no Setting named ' + e.field);
        o.dispatch({ kind: 'editSetting', setting, value: e.value, record: false });
        applied.push(e.field);
      }
      return applied;
    },

    /** Image Scale is not a Setting -- it belongs to the image. */
    setScale(value) {
      o.dispatch({ kind: 'setDensityScale', value });
      return o.status().densityScale;
    },

    /** Decode a data URL to RGBA and hand it to the density field. */
    async stimulus(dataUrl, name, maxDim) {
      const im = await loadImage(dataUrl);
      let w = im.naturalWidth, h = im.naturalHeight;
      const longest = Math.max(w, h);
      if (longest > maxDim) { const k = maxDim / longest; w = Math.round(w * k); h = Math.round(h * k); }
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(im, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      o.dispatch({
        kind: 'loadDensityImage',
        image: { width: w, height: h, data: new Uint8ClampedArray(data) },
        name,
      });
      return { width: w, height: h, name: o.status().densityImageName };
    },

    clearStimulus() {
      o.dispatch({ kind: 'clearDensityImage' });
      return o.status().densityImageName;
    },

    /**
     * Reset, advance exactly \`steps * physicsSteps\` sub-steps, force a live
     * render, and report the frame count reached so the caller can assert it.
     */
    async run(steps) {
      o.dispatch({ kind: 'reset' });
      for (let i = 0; i < steps; i++) await o.probeFrame();
      o.dispatch({ kind: 'clearStrafeField', layer: 'walls' });  // drop the still; see the header
      await frames(2);
      return { frameCount: o.diagnostics.frameCount, physicsSteps: o.preferences.physicsSteps };
    },

    /**
     * Advance to a sub-step count WITHOUT resetting first.
     *
     * \`liveUntil\` resets and then settles, which is right at the start of a
     * trial. This is for walking a single run past a series of checkpoints, so
     * a colony can be captured at 200 sub-steps AND at 800 without simulating
     * it twice -- and, more to the point, so a colony that locks the tab at 600
     * still leaves a scored frame behind from before it did.
     */
    async advanceTo(subSteps, capMs) {
      const o = window.__fluoddity;
      if (o.status().paused) o.dispatch({ kind: 'togglePause' });
      const deadline = performance.now() + capMs;
      while (o.diagnostics.frameCount < subSteps && performance.now() < deadline) {
        await new Promise((r) => requestAnimationFrame(() => r()));
      }
      const reached = o.diagnostics.frameCount;
      return { frameCount: reached, short: reached < subSteps };
    },

    /** The canvas element's viewport rect, for cropping a screenshot to it. */
    canvasRect() {
      const el = document.querySelector('canvas');
      if (!el) throw new Error('no canvas element');
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    },

    /**
     * WHERE THE WORLD ACTUALLY IS ON SCREEN, which is not the canvas element.
     *
     * ARCHITECTURE's view transform keeps three aspects apart, and this is
     * where conflating two of them bites. \`canvas_size\` is the simulation
     * texture and defines world space; \`window_size\` is the framebuffer; the
     * letterbox between them is derived. "Letterbox is fit, not fill. The whole
     * canvas is always visible; the slack becomes black bars."
     *
     * So a square 724x724 world inside a 1280x757 viewport is drawn as a
     * CENTRED 757x757 square with black bars either side. Cropping a screenshot
     * to the canvas ELEMENT would hand the scorer those bars as though they
     * were empty world, and -- worse -- would stretch the comparison grid
     * relative to the target's.
     *
     * Returns viewport (CSS) coordinates. Throws if the camera has moved, since
     * zoom 1 and pan 0 are what make "fit" the whole story.
     */
    worldRect() {
      const el = document.querySelector('canvas');
      if (!el) throw new Error('no canvas element');
      const cam = o.cameraState;
      if (Math.abs(cam.zoom - 1) > 1e-6 || Math.abs(cam.pan[0]) > 1e-6 || Math.abs(cam.pan[1]) > 1e-6) {
        throw new Error('the camera has moved (zoom ' + cam.zoom + ', pan ' + cam.pan + '); the world rect assumes zoom 1, pan 0');
      }
      const r = el.getBoundingClientRect();
      const [cw, ch] = o.diagnostics.canvasSize;
      const aspect = cw / ch;
      // The largest rect of the world's aspect that fits, centred.
      let w = r.width;
      let h = w / aspect;
      if (h > r.height) {
        h = r.height;
        w = h * aspect;
      }
      return { x: r.x + (r.width - w) / 2, y: r.y + (r.height - h) / 2, width: w, height: h, aspect };
    },

    /** A screenshot cropped to the WORLD, reduced to an n x n luma grid. */
    async gridFromShot(b64, n) {
      const im = await loadImage('data:image/png;base64,' + b64);
      const c = new OffscreenCanvas(im.width, im.height);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(im, 0, 0);
      const r = this.worldRect();
      // Screenshot pixels are CSS pixels times the device pixel ratio.
      const kx = im.width / window.innerWidth;
      const ky = im.height / window.innerHeight;
      const sx = Math.max(0, Math.round(r.x * kx));
      const sy = Math.max(0, Math.round(r.y * ky));
      const sw = Math.min(im.width - sx, Math.round(r.width * kx));
      const sh = Math.min(im.height - sy, Math.round(r.height * ky));
      return gridFrom(ctx, sx, sy, Math.max(1, sw), Math.max(1, sh), n);
    },

    /**
     * The target image, LETTERBOXED THE WAY THE DENSITY FIELD LETTERBOXES IT,
     * then reduced the same way.
     *
     * This is not cosmetic. \`densityGradient.ts\` composes \`letterboxScale\` to
     * fit the image inside a canvas-shaped field, keeping its aspect and
     * leaving the margin at zero -- so a portrait image occupies a centred
     * vertical strip of a square canvas and the particles outside it feel
     * nothing. The render grid is read from the whole square canvas.
     *
     * Reducing the target over its own bounds instead would compare a 32x32 of
     * a 635x896 picture against a 32x32 of a 724x724 one, cell for cell, with
     * the two describing different places. Every correlation would then be
     * measuring a registration error rather than the simulation, and would sit
     * near zero no matter how well the particles traced the structure. Which is
     * exactly what it did.
     */
    async gridFromDataUrl(dataUrl, n, aspect) {
      const im = await loadImage(dataUrl);
      // A canvas of the RENDER's shape, with the image fitted inside it.
      const H = 1024;
      const W = Math.max(1, Math.round(H * aspect));
      const c = new OffscreenCanvas(W, H);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      const k = Math.min(W / im.naturalWidth, H / im.naturalHeight);
      const dw = im.naturalWidth * k;
      const dh = im.naturalHeight * k;
      ctx.drawImage(im, (W - dw) / 2, (H - dh) / 2, dw, dh);
      return gridFrom(ctx, 0, 0, W, H, n);
    },

    /**
     * Mean Rec.709 luma per screen quadrant -- \`densityCheck.mjs:192-215\`'s
     * metric, kept because the self-test's known answer is stated in it.
     */
    async quadrantLuma(b64) {
      const im = await loadImage('data:image/png;base64,' + b64);
      const c = new OffscreenCanvas(im.width, im.height);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(im, 0, 0);
      const d = ctx.getImageData(0, 0, im.width, im.height).data;
      const hw = im.width >> 1, hh = im.height >> 1;
      const sums = [0, 0, 0, 0], counts = [0, 0, 0, 0];
      for (let y = 0; y < im.height; y++) {
        for (let x = 0; x < im.width; x++) {
          const q = (y < hh ? 0 : 2) + (x < hw ? 0 : 1);
          const i = (y * im.width + x) * 4;
          sums[q] += luma(d[i], d[i + 1], d[i + 2]);
          counts[q] += 1;
        }
      }
      return sums.map((s, i) => (counts[i] ? s / counts[i] : 0));
    },

    /**
     * The corner-bright fixture, as a data URL.
     *
     * Bright in ITS OWN TOP-LEFT QUADRANT only -- asymmetric on both axes, so a
     * y-flip, an x-mirror and a transpose are each distinguishable. This is
     * \`densityCheck.mjs:224-245\`'s fixture, rebuilt here so the self-test's
     * known answer is stated against the same picture that tool verifies the
     * orientation of. A centred blob would pass every one of those errors.
     */
    cornerFixture(size) {
      const c = new OffscreenCanvas(size, size);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, size >> 1, size >> 1);
      return c.convertToBlob({ type: 'image/png' }).then(
        (blob) =>
          new Promise((resolve) => {
            const fr = new FileReader();
            fr.onload = () => resolve(fr.result);
            fr.readAsDataURL(blob);
          }),
      );
    },

    /**
     * Compose labelled thumbnails into one contact sheet, returned as a data URL.
     *
     * In the page rather than in node for the reason \`fieldCheck.mjs\` decodes
     * screenshots there: the browser already has a PNG codec and a text
     * renderer, and shipping either into \`tools/\` would be a dependency for a
     * montage. The label is burned into the image because the sheet is read
     * detached from the JSONL beside it.
     */
    async contactSheet(items, cell, cols) {
      const rows = Math.ceil(items.length / cols);
      const pad = 4;
      const label = 18;
      const w = cols * (cell + pad) + pad;
      const h = rows * (cell + label + pad) + pad;
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#101010';
      ctx.fillRect(0, 0, w, h);
      ctx.font = '12px monospace';
      ctx.textBaseline = 'top';
      for (let i = 0; i < items.length; i++) {
        const cx = pad + (i % cols) * (cell + pad);
        const cy = pad + Math.floor(i / cols) * (cell + label + pad);
        const im = await loadImage(items[i].dataUrl);
        // Fit, not fill: a squashed thumbnail misrepresents the shape, which is
        // the only thing the sheet exists to show.
        const k = Math.min(cell / im.width, cell / im.height);
        const dw = im.width * k;
        const dh = im.height * k;
        ctx.drawImage(im, cx + (cell - dw) / 2, cy + (cell - dh) / 2, dw, dh);
        ctx.fillStyle = '#cccccc';
        ctx.fillText(items[i].label, cx + 2, cy + cell + 2);
      }
      const blob = await c.convertToBlob({ type: 'image/png' });
      return await new Promise((resolve) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.readAsDataURL(blob);
      });
    },

    /**
     * SETTLE LIVE, BUT TO A FRAME COUNT RATHER THAN A CLOCK.
     *
     * Two constraints pull against each other here.
     *
     * The frame loop must actually RUN, because picking is a GPU readback that
     * the loop dispatches, reads and resolves. \`run()\` above pauses and steps
     * with \`probeFrame\`, which never enters that loop -- so a click made against
     * it never adopts. Measured: every click returned a byte-identical frame and
     * the rule never moved.
     *
     * But sleeping a fixed number of MILLISECONDS makes trials incomparable. The
     * frames delivered in two seconds depend on GPU load, so a heavy colony gets
     * less simulation than a light one and then gets scored against it as though
     * they had run equally.
     *
     * So: run live, and wait on \`frameCount\`. Every trial gets the same number
     * of sub-steps, and the loop the picker needs is running the whole time.
     * \`capMs\` is a floor under a wedged tab, not a target.
     */
    async liveUntil(subSteps, capMs) {
      const o = window.__fluoddity;
      if (o.status().paused) o.dispatch({ kind: 'togglePause' });
      o.dispatch({ kind: 'reset' });
      const deadline = performance.now() + capMs;
      while (o.diagnostics.frameCount < subSteps && performance.now() < deadline) {
        await new Promise((r) => requestAnimationFrame(() => r()));
      }
      const reached = o.diagnostics.frameCount;
      return { frameCount: reached, short: reached < subSteps };
    },

    /** The v8 document for the current project -- what a preset file contains. */
    doc() { return o.projectDocument(); },

    /**
     * Read applied values back. \`?nopanel\` makes \`status().editConfig\` a frozen
     * empty, so the panel flag is flipped around the read exactly as
     * \`configCheck.mjs:330-340\` does.
     */
    readBack(fields) {
      const was = o.panelOpen;
      o.panelOpen = true;
      const s = o.status();
      o.panelOpen = was;
      const out = {};
      for (const f of fields) {
        out[f] = s.editConfig?.[f] ?? s.editWorld?.[f] ?? s.editPrefs?.[f] ?? null;
      }
      return out;
    },
  };
  return true;
})()
`;

/**
 * The URL every harness run opens. The four parameters are not optional.
 *
 * `hash` carries a share-link payload (`#b=...`). It is appended rather than
 * dispatched because `main.ts` decodes the fragment BEFORE the Orchestrator is
 * constructed -- a link is what the app OPENS, not something it switches to --
 * so this is the only way to start a run on a shared config with the same
 * fidelity a person clicking the link would get. `?preset` is dropped when a
 * hash is present, since the link supersedes it.
 */
export function harnessUrl(port, preset, hash = null) {
  // ?bus     the Orchestrator, which is the only way in
  // ?nopanel keeps a 320px column out of the screenshot statistics
  // ?nocalibrate pins worldSize/physicsSteps instead of measuring this GPU
  // ?nosplash the splash pauses the simulation, which fights `setup()`
  const query = hash
    ? `?bus&nopanel&nocalibrate&nosplash`
    : `?bus&nopanel&nocalibrate&nosplash&preset=${preset}`;
  const fragment = hash ? (hash.startsWith('#') ? hash : `#${hash}`) : '';
  return `http://localhost:${port}/${query}${fragment}`;
}

/**
 * Boot a page and install the harness. Returns the session plus the pinned
 * values it actually observed, which the caller should assert rather than trust.
 */
export async function openHarness({ port = 5173, preset = 'Tangle', hash = null, bootMs = 7000, shotTimeoutMs = 20000, live = false, profilePrefix } = {}) {
  const session = await launch(harnessUrl(port, preset, hash), { bootMs, shotTimeoutMs, ...(profilePrefix ? { profilePrefix } : {}) });
  try {
    await waitForBus(session);
    const installed = await session.evaluate(PAGE_HARNESS);
    if (installed !== true) throw new Error('the page harness did not install');
    if (live) {
      const pins = await session.evaluate('__fh.probe()');
      return { session, pins };
    }
    const pins = await session.evaluate('__fh.setup()');
    if (!pins?.paused) throw new Error('the simulation did not pause');
    return { session, pins };
  } catch (e) {
    session.close();
    throw e;
  }
}

/**
 * One candidate: apply, advance an exact number of sub-steps, capture.
 *
 * Returns the base64 screenshot and the frame count reached. The caller checks
 * the frame count -- it is the assertion that says the run advanced by what was
 * asked rather than by whatever rate was in force.
 */
export async function evaluateCandidate(session, edits, steps, { scale = null } = {}) {
  if (edits.length > 0) {
    await session.evaluate(`__fh.apply(${JSON.stringify(edits)})`);
  }
  if (scale !== null) {
    await session.evaluate(`__fh.setScale(${scale})`);
  }
  // Bounded too: a candidate can wedge inside `run` rather than at the capture.
  const ran = await session.evaluate(`__fh.run(${Math.trunc(steps)})`, { timeoutMs: 90000 });
  const shot = await session.screenshot();
  return { shot, frameCount: ran.frameCount, physicsSteps: ran.physicsSteps };
}

export { sleep };
